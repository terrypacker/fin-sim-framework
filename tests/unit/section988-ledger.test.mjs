/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * section988-ledger.test.mjs — design 87 G5, the lot ledger.
 *
 *   LED-1..3   the split: business ordinary, personal capital, the $200 exclusion, and
 *              the §988(e) asymmetry that disallows a personal LOSS outright.
 *   LED-4..5   the two conventions. LED-5 is design 87 §5 G11's own worked example, the
 *              one the doc uses to show per-account and commingled give different answers.
 *   LED-6..8   what the ledger must refuse to invent: a gain with no rate, a holding
 *              period pro-rata cannot know, and state leaking between comparison runs.
 *   LED-9..13  the audit trail. It is a SECOND rendering of the same walk, so the thing
 *              worth testing is that it cannot drift from the first: its identities close,
 *              its columns re-derive the totals, it does not change them by existing, a
 *              deliberately corrupted row is caught rather than absorbed, and the file
 *              stays readable by something simpler than a spreadsheet.
 *   LED-14..16 the seeded-basis assumption: a stated rate reaches the calculation, an
 *              observed acquisition is never re-priced by either mechanism, and the sweep
 *              shows where extra basis lands rather than only what it totals.
 *
 * Run with: node --test tests/unit/section988-ledger.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runLedger, compareConventions, allocateGain, auditChecks, footAudit, toAuditCsv,
  sweepSeedRate,
  LEDGER_METHOD, POOLING, PERSONAL_DE_MINIMIS_USD,
} from '../../scripts/lib/section988-ledger.mjs';
import { computeSection988Gain } from '../../src/finance/account-rules/loan-classes.js';

/** A classified, rate-attached row, as the ingest hands them over. */
const row = (date, account, kind, amount, rate, extra = {}) => ({
  date, account, kind, amount, description: `${kind} ${amount}`,
  rate: rate == null ? null : { usdPerAud: rate },
  seq: 0, ...extra,
});

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.01, `${msg}: ${a} vs ${b}`);

test('LED-1 gain is proceeds less the basis the units carried', () => {
  const r = runLedger([
    row('2020-01-01', 'offset', 'ACQUIRE', 10000, 0.70),
    row('2021-01-01', 'offset', 'DISPOSE', -10000, 0.75, { businessFraction: 1 }),
  ]);
  assert.equal(r.dispositions.length, 1);
  const d = r.dispositions[0];
  near(d.basis, 7000, 'basis stamped at acquisition');
  near(d.proceeds, 7500, 'proceeds at disposal');
  near(d.gross, 500, 'AUD strengthened, so holding it gained USD');
  near(d.ordinary, 500, 'wholly business => ordinary §988');
  near(r.residual[0].units, 0, 'pool emptied');
});

test('LED-2 the personal share is capital, and $200 excludes it', () => {
  // §1.988-1(a)(9) takes personal transactions out of §988 entirely; §988(e)(2) then
  // excludes what survives, per transaction.
  const small = allocateGain(150, 0, 400);
  assert.equal(small.capitalGain, 0);
  near(small.deMinimisExcluded, 150, 'under the floor: excluded from the whole subtitle');

  const large = allocateGain(500, 0, 400);
  near(large.capitalGain, 500, 'over the floor: the WHOLE gain is capital, not the excess');
  assert.equal(large.deMinimisExcluded, 0);

  // The floor is per transaction, so it applies to the personal SLICE of a mixed one.
  const mixed = allocateGain(1000, 0.9, 400);
  near(mixed.ordinary, 900, 'business share is ordinary');
  near(mixed.deMinimisExcluded, 100, 'personal share is under $200 on its own');
  assert.equal(mixed.capitalGain, 0);
  assert.equal(PERSONAL_DE_MINIMIS_USD, 200);
});

test('LED-3 a personal LOSS is disallowed, and matches the debt-side rule', () => {
  const loss = allocateGain(-1000, 0.25, 400);
  near(loss.ordinary, -250, 'the business quarter is a deductible ordinary loss');
  near(loss.disallowedPersonalLoss, 750, 'the personal three-quarters is disallowed outright');
  assert.equal(loss.deMinimisExcluded, 0, 'the $200 floor is written for GAIN only');

  // The cash ledger and the DEBT path in loan-classes.js are separate implementations of
  // the same asymmetry. They must never drift apart, so pin them to each other.
  // loan-classes quotes AUD-per-USD, so a LOSS needs bookingRate > spotRate.
  const debt = computeSection988Gain(1000, 1 / 0.70, 1 / 0.75, 0.25);
  assert.ok(debt.gross < 0, 'fixture really is a loss on the debt side too');
  const cash = allocateGain(debt.gross, 0.25, null);
  near(cash.ordinary, debt.recognized, 'recognised ordinary agrees');
  near(cash.disallowedPersonalLoss, debt.disallowedLoss, 'disallowed personal loss agrees');
});

test('LED-4 FIFO and pro-rata consume different basis from the same pool', () => {
  const history = [
    row('2020-01-01', 'offset', 'ACQUIRE', 100, 1.00),   // dear lot
    row('2021-01-01', 'offset', 'ACQUIRE', 100, 0.50),   // cheap lot
    row('2022-01-01', 'offset', 'DISPOSE', -100, 0.80, { businessFraction: 1 }),
  ];
  const fifo = runLedger(history, { method: LEDGER_METHOD.FIFO });
  const pro = runLedger(history, { method: LEDGER_METHOD.PRO_RATA });

  near(fifo.dispositions[0].basis, 100, 'FIFO takes the oldest lot whole');
  near(pro.dispositions[0].basis, 75, 'pro-rata takes half of each: (100+50) x 100/200');

  // Whatever is not consumed stays in the pool, so the two always sum to the same total.
  for (const r of [fifo, pro]) {
    near(r.dispositions[0].basis + r.residual[0].basis, 150, 'basis is conserved');
  }
});

test('LED-5 pooling changes the answer — design 87 G11\'s worked example', () => {
  // The doc's own numbers: A 100 units / $100, B 100 units / $50, move 50 A->B, then
  // dispose 50 from B. Per-account the transfer carries $50 of basis out of A under
  // (a)(1)(iii)(E), so B holds 150 units / $100 and the disposal takes $33.33. Commingled
  // there is one pool of 200 / $150 and the same disposal takes $37.50.
  const history = [
    row('2020-01-01', 'A', 'ACQUIRE', 100, 1.00),
    row('2020-01-01', 'B', 'ACQUIRE', 100, 0.50),
    row('2020-06-01', 'A', 'INTERNAL', -50, 1.00, { description: 'Transfer Transfer:[B]' }),
    row('2020-06-01', 'B', 'INTERNAL', 50, 1.00, { description: 'Transfer Transfer:[A]' }),
    row('2021-01-01', 'B', 'DISPOSE', -50, 1.00, { businessFraction: 1 }),
  ];

  const perAccount = runLedger(history, { pooling: POOLING.PER_ACCOUNT, method: LEDGER_METHOD.PRO_RATA });
  near(perAccount.dispositions[0].basis, 33.33, 'per-account: 100 x 50/150');

  const commingled = runLedger(history, { pooling: POOLING.COMMINGLED, method: LEDGER_METHOD.PRO_RATA });
  near(commingled.dispositions[0].basis, 37.50, 'commingled: 150 x 50/200');
});

test('LED-6 a disposition with no rate is skipped, never zeroed', () => {
  // Zeroing would report the year as complete while understating it by exactly the size
  // of the row — the failure mode this whole pair of tools exists to prevent.
  const r = runLedger([
    row('2020-01-01', 'offset', 'ACQUIRE', 10000, 0.70),
    row('2026-08-12', 'offset', 'DISPOSE', -1000, null, { businessFraction: 1 }),
  ]);
  assert.equal(r.dispositions.length, 0, 'not computed');
  assert.equal(r.skipped.length, 1, 'and reported so it cannot pass unnoticed');
  near(r.residual[0].units, 10000, 'the units were not consumed either');
});

test('LED-7 pro-rata reports no holding period, because it cannot have one', () => {
  const history = [
    row('2015-01-01', 'offset', 'ACQUIRE', 100, 0.70),
    row('2021-01-01', 'offset', 'DISPOSE', -100, 0.90, { businessFraction: 0 }),
  ];
  const fifo = runLedger(history, { method: LEDGER_METHOD.FIFO });
  assert.equal(fifo.dispositions[0].longTerm, true, 'FIFO knows which units left, so it can say');

  const pro = runLedger(history, { method: LEDGER_METHOD.PRO_RATA });
  assert.equal(pro.dispositions[0].heldDays, null);
  assert.equal(pro.dispositions[0].longTerm, null,
    'null, not false — pro-rata cannot identify the units, so it has no answer to give');
});

test('LED-8 comparing conventions leaves no state behind', () => {
  // The runs walk the SAME row objects. A marker written onto a row made every later run
  // skip work the first had done, so the comparison measured the contamination instead of
  // the conventions — and the numbers looked entirely plausible.
  const history = [
    row('2020-01-01', 'A', 'ACQUIRE', 100, 1.00),
    row('2020-06-01', 'A', 'INTERNAL', -50, 1.00, { description: 'Transfer Transfer:[B]' }),
    row('2020-06-01', 'B', 'INTERNAL', 50, 1.00, { description: 'Transfer Transfer:[A]' }),
    row('2021-01-01', 'B', 'DISPOSE', -50, 1.20, { businessFraction: 1 }),
  ];
  const standalone = runLedger(history, { pooling: POOLING.PER_ACCOUNT, method: LEDGER_METHOD.FIFO });
  const compared = compareConventions(history)
    .runs.find((r) => r.pooling === POOLING.PER_ACCOUNT && r.method === LEDGER_METHOD.FIFO);

  near(compared.recognised,
    standalone.byYear.reduce((s, y) => s + y.ordinary + y.capitalGain, 0),
    'a convention must give the same answer alone as it does in the comparison');

  // And running the same convention twice over the same rows must not drift.
  const again = runLedger(history, { pooling: POOLING.PER_ACCOUNT, method: LEDGER_METHOD.FIFO });
  near(again.dispositions[0].basis, standalone.dispositions[0].basis, 're-running is stable');
});

/* ─────────────────────────────── the audit trail ──────────────────────────────── */

/** A history with all four kinds, both branches of the split, and a real transfer. */
const auditHistory = () => [
  row('2020-01-01', 'A', 'ACQUIRE', 100000, 0.70, { basisSource: 'assumed' }),
  row('2020-03-01', 'A', 'IGNORE', 0, 0.71),
  row('2020-06-01', 'A', 'INTERNAL', -40000, 0.72, { description: 'Transfer Transfer:[B]' }),
  row('2020-06-01', 'B', 'INTERNAL', 40000, 0.72, { description: 'Transfer Transfer:[A]' }),
  row('2021-01-01', 'A', 'DISPOSE', -30000, 0.80, { businessFraction: 1 }),
  row('2021-06-01', 'B', 'DISPOSE', -20000, 0.65, { businessFraction: 0.25 }),
  row('2022-01-01', 'B', 'DISPOSE', -1000, 0.72, { businessFraction: 0 }),
];

test('LED-9 a DISPOSE carries two rates, and they reproduce the whole gain', () => {
  // The reason both are emitted. `spotRate` prices the proceeds at the disposal date;
  // `basisRate` is what the units that left were carrying — the pool's weighted average
  // under pro-rata. An ACQUIRE has only the one rate, and it is both.
  const r = runLedger(auditHistory(), { audit: true });

  const acquire = r.audit.find((a) => a.kind === 'ACQUIRE');
  assert.equal(acquire.spotRate, 0.70);
  assert.equal(acquire.basisRate, 0.70, 'an acquisition sets basis AT the spot rate');

  const d = r.audit.find((a) => a.kind === 'DISPOSE');
  near(d.spotRate, 0.80, 'proceeds are priced on the disposal date');
  near(d.basisRate, 0.70, 'the units left carrying what they were acquired at');
  near(d.gross, 30000 * (0.80 - 0.70), 'units x the rate move IS the gain');
  near(auditChecks(d).gross, 0, 'and the identity is emitted as a zero residual');

  // A transfer does NOT re-mark to market: the credit arrives at the carried rate, not
  // at the day's spot, which is the whole content of §1.988-2(a)(1)(iii)(E).
  const credit = r.audit.find((a) => a.kind === 'INTERNAL' && a.amount > 0);
  near(credit.basisRate, 0.70, 'carryover basis');
  near(credit.spotRate, 0.72, 'the day\'s rate is recorded but not used');
});

test('LED-10 the trail foots to the ledger it explains', () => {
  // The failure this guards: a column recorded from one place and totalled from another.
  // A per-row sheet that quietly disagrees with its totals is worse than none, because
  // it is the one that gets believed.
  for (const method of Object.values(LEDGER_METHOD)) {
    const r = runLedger(auditHistory(), { method, audit: true });
    const { breaks, rowChecks } = footAudit(r);
    assert.deepEqual(breaks, [], `${method}: every total re-derives from the CSV columns`);
    assert.deepEqual(rowChecks, { gross: 0, split: 0, pool: 0 }, `${method}: every row closes`);
  }
});

test('LED-11 recording the trail does not change the answer', () => {
  // An audit that perturbs what it measures is not an audit. Pool state is snapshotted by
  // value before every consume, and the four buckets are read from the same `allocateGain`
  // the ledger used — neither can nudge a total, and this pins that.
  const plain = runLedger(auditHistory());
  const audited = runLedger(auditHistory(), { audit: true, auditIgnored: true });

  assert.equal(plain.audit, null, 'off by default — the compare sweep has no use for it');
  assert.deepEqual(audited.byYear, plain.byYear, 'identical totals');
  assert.deepEqual(audited.residual, plain.residual, 'identical pools');

  // `auditIgnored` reaches rows that move nothing, so they can be accounted for rather
  // than silently absent. They must still contribute no money.
  assert.ok(audited.audit.some((a) => a.kind === 'IGNORE' || a.kind === ''),
    'a no-op row is present when asked for');
  near(audited.audit.reduce((s, a) => s + (a.recognised ?? 0), 0),
    plain.byYear.reduce((s, y) => s + y.ordinary + y.capitalGain, 0),
    'and adds nothing to the recognised total');
});

test('LED-12 the checks catch a corrupted row rather than absorbing it', () => {
  // A trail whose residuals are always zero because nothing computes them is the failure
  // mode of every self-checking artifact. Break each identity in turn; each must be seen
  // by its OWN column and not by the other two.
  const r = runLedger(auditHistory(), { audit: true });
  const target = () => r.audit.find((a) => a.kind === 'DISPOSE');

  const clean = footAudit(runLedger(auditHistory(), { audit: true }));
  assert.deepEqual(clean.rowChecks, { gross: 0, split: 0, pool: 0 });

  const bent = { ...target(), basisRate: target().basisRate + 0.01 };
  assert.ok(Math.abs(auditChecks(bent).gross) > 0.005, 'a wrong rate breaks the rate identity');
  assert.equal(auditChecks(bent).split, auditChecks(target()).split, 'and only that one');

  const misallocated = { ...target(), ordinary: target().ordinary + 1 };
  assert.ok(Math.abs(auditChecks(misallocated).split) > 0.005, 'a bucket that lost money is seen');

  const leaked = { ...target(), poolBasisAfter: target().poolBasisAfter + 1 };
  assert.ok(Math.abs(auditChecks(leaked).pool) > 0.005, 'basis appearing from nowhere is seen');
});

test('LED-13 the CSV is machine-readable to the last two columns', () => {
  // Description and Note are last BECAUSE they are the only fields that can hold a comma —
  // bank narrations always do. Everything before them must survive a naive `cut -d,`, so
  // the numeric part of the sheet is greppable and not just spreadsheet-openable.
  const r = runLedger(auditHistory(), { audit: true });
  const csv = toAuditCsv(r.audit).replace(/^﻿/, '');
  const lines = csv.trim().split('\n');
  const headers = lines[0].split(',');

  assert.equal(headers.indexOf('Description'), headers.length - 2);
  assert.equal(headers.indexOf('Note'), headers.length - 1);
  assert.equal(lines.length - 1, r.audit.length, 'one line per recorded row');

  for (const line of lines.slice(1)) {
    const upToDescription = line.split(',').slice(0, headers.length - 2).join(',');
    assert.ok(!upToDescription.includes('"'),
      `no quoting before Description, so cut -d, works: ${upToDescription}`);
  }
});

/* ─────────────── the seeded-basis assumption: stated, and swept ────────────────── */

test('LED-14 a stated basis rate prices the acquisition, not the row date', () => {
  // The two rates on an ACQUIRE come apart exactly here: the currency APPEARED at 0.70
  // and was acquired at 0.90. Without this the ledger would keep using the appearance
  // date while the ingest reported the stated rate, and the two tools would disagree
  // about the same file without either of them saying so.
  const history = [
    row('2020-01-01', 'A', 'ACQUIRE', 10000, 0.70, {
      basisSource: 'assumed', basisFrom: 'stated-rate', basisRate: { usdPerAud: 0.90 },
    }),
    row('2021-01-01', 'A', 'DISPOSE', -10000, 0.75, { businessFraction: 1 }),
  ];
  const r = runLedger(history, { audit: true });
  near(r.seededBasisUsd, 9000, 'basis is 10000 x the STATED rate');
  near(r.dispositions[0].gross, -1500, 'and the disposal is measured against it');

  const acquire = r.audit.find((a) => a.kind === 'ACQUIRE');
  near(acquire.spotRate, 0.70, 'the appearance rate is still recorded');
  near(acquire.basisRate, 0.90, 'beside the rate that actually became basis');
  near(auditChecks(acquire).pool, 0, 'and the pool still foots');
});

test('LED-15 an observed acquisition is never re-priced', () => {
  // Both by a stated rate — attachRates refuses to attach one — and by the sweep. An
  // observed acquisition is a measurement; sweeping it would measure the export rather
  // than the assumption, and the sweep would answer a question nobody asked.
  const history = [
    row('2020-01-01', 'A', 'ACQUIRE', 10000, 0.70, { basisSource: 'assumed' }),
    row('2020-01-01', 'B', 'ACQUIRE', 10000, 0.70),
    row('2021-01-01', 'A', 'DISPOSE', -10000, 0.75, { businessFraction: 1 }),
    row('2021-01-01', 'B', 'DISPOSE', -10000, 0.75, { businessFraction: 1 }),
  ];
  const swept = runLedger(history, { seedRate: 0.90 });
  const a = swept.dispositions.find((d) => d.account === 'A');
  const b = swept.dispositions.find((d) => d.account === 'B');
  near(a.basis, 9000, 'the ASSUMED row moves to the swept rate');
  near(b.basis, 7000, 'the observed one does not move at all');
});

test('LED-16 the sweep reports where the extra basis went, not just a total', () => {
  // A loss-making position: raising basis makes the loss BIGGER, and the personal share
  // of a §988 loss is disallowed outright. Reported as one recognised number that looks
  // like steady improvement; the four columns show most of it is worth nothing.
  const history = [
    row('2020-01-01', 'A', 'ACQUIRE', 100000, 0.70, { basisSource: 'assumed' }),
    row('2021-01-01', 'A', 'DISPOSE', -100000, 0.60, { businessFraction: 0.25 }),
  ];
  const [base, low, high] = sweepSeedRate(history, [null, 0.70, 0.90]);

  assert.equal(base.seedRate, null, 'the baseline is computed the same way, not quoted');
  assert.deepEqual(
    { o: low.ordinary, d: low.disallowedPersonalLoss },
    { o: base.ordinary, d: base.disallowedPersonalLoss },
    'sweeping AT the file\'s own rate reproduces the file',
  );

  assert.ok(high.seededBasisUsd > base.seededBasisUsd, 'a higher rate buys more basis');
  assert.ok(high.recognised < base.recognised, 'which makes the recognised loss larger');
  // and three quarters of that larger loss is personal, so it is disallowed outright.
  near(high.disallowedPersonalLoss - base.disallowedPersonalLoss,
    (0.90 - 0.70) * 100000 * 0.75, 'the disallowed bucket absorbs the personal share');
  near(high.ordinary - base.ordinary,
    -(0.90 - 0.70) * 100000 * 0.25, 'only the business share is deductible');
});
