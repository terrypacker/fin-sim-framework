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
 * wash-sale-golden.test.mjs — design 94 §8.1o. What the `wash-sale-harvest` golden is FOR,
 * asserted directly.
 *
 * ── why this exists alongside the fixture ────────────────────────────────────
 *
 * The fixture pins the end state, so it catches any change to this plan. What it cannot do
 * is say which of its 161 keys is the point: break §1091 and the diff reads as "these
 * fields moved", not "the wash-sale disallowance stopped happening". Worse, most ways of
 * breaking it make the golden LOOK healthier — a disallowance that silently stops firing
 * removes a tax payment and raises terminal net worth, which is the shape of a diff a
 * reader is inclined to accept.
 *
 * So this file names the mechanism. Each assertion is a link in the chain §8.1o found
 * untested end to end: two reducers write the ledger, the settle schedules the filing and
 * snapshots the return, the April filing resolves the window and assesses the difference,
 * and the payment leaves the account.
 *
 * ── what it deliberately does not assert ─────────────────────────────────────
 *
 * Nothing about the SIZE of the disallowance beyond its sign and its presence. That number
 * is a property of this plan — the crash's depth, the glidepath's slope, the size of the
 * wrappers — and pinning it here would duplicate the fixture while adding a second thing
 * to update whenever the plan is retuned. The fixture holds the number; this holds the
 * mechanism.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { specByName }   from '../helpers/golden-specs.js';
import { getGoldenRun } from '../helpers/golden-harness.js';

const run     = getGoldenRun(specByName('wash-sale-harvest'));
const journal = run.sim.journal.journal;
/** A journal action's payload — the fields live under `data` once it is journalled. */
const payload = (e) => e.action?.data ?? e.action ?? {};
const ofType  = (type) => journal.filter(e => e.action?.type === type).map(payload);
const filings = ofType('US_TAX_FILE_APPLY');

// The §1091(d) twin: same plan, one more taxable book, so the replacement is taxable and the
// loss is DEFERRED into its basis rather than destroyed (§8.1p).
const twin        = getGoldenRun(specByName('wash-sale-two-books'));
const twinFilings = twin.sim.journal.journal
  .filter(e => e.action?.type === 'US_TAX_FILE_APPLY').map(payload);

describe('the wash-sale-harvest golden reaches §1091 end to end (§8.1o)', () => {
  test('the plan actually harvests — otherwise every assertion below is vacuous', () => {
    // The scenario-shaped trap: a golden whose strategy silently stops firing still passes
    // every assertion about what it does not do (see mpc-lever-tests-scenario-shaped).
    assert.ok(ofType('STOCK_HARVEST_APPLY').length >= 3,
      'TAX_LOSS_HARVEST must fire — a book with no realized loss cannot wash anything');
  });

  test('a §1091 window opens, so the settle schedules an April filing', () => {
    // `TAX_FILE_US` is scheduled ONLY when `washPendingLosses` is non-empty at the settle
    // (§8.1m), so the existence of these filings is itself the assertion that both writers'
    // entries reached state.
    assert.ok(filings.length >= 2, `expected several April filings, got ${filings.length}`);
    assert.deepEqual([...new Set(filings.map(f => typeof f.taxYear))], ['number']);
  });

  test('one filing DISALLOWS a loss and assesses a balance due, which is paid', () => {
    const washed = filings.filter(f => f.disallowed > 0);
    assert.equal(washed.length, 1, 'this plan has exactly one matched wash');
    const [f] = washed;
    assert.ok(f.delta > 0, `removing a disallowed loss must raise the liability, got ${f.delta}`);
    assert.equal(f.ledger.length, 1);
    assert.equal(f.ledger[0].matchedFraction, 1, 'the replacement covers every unit sold');

    // The money leaves the account, on the filing date rather than the settle's.
    const paidInApril = journal.filter(e =>
      e.action?.type === 'US_TAX_PAYMENT_DEBIT'
      && new Date(e.date).getUTCMonth() === 3
      && Math.abs(payload(e).amount - f.delta) < 0.005);
    assert.equal(paidInApril.length, 1, 'the balance due is chained as an April payment');
  });

  test('BOTH writers reach the ledger — the harvester and the rebalancer', () => {
    // §8.1n's finding was that `washPendingLosses` had one writer and needed two. The
    // rebalancer writes on a period boundary (1 January / 1 July) as it relocates equity
    // into a wrapper; the harvester writes on 31 December. So the DATE of an entry says
    // which reducer wrote it, and this golden must contain both kinds.
    const entryDates = [
      ...(run.state.washSaleLedger ?? []).map(e => new Date(e.ms)),
      ...(run.state.washPendingLosses ?? []).map(e => new Date(e.ms)),
    ];
    assert.ok(entryDates.length >= 2, 'the fixture must hold entries from more than one year');
    const isYearEnd = (d) => d.getUTCMonth() === 11 && d.getUTCDate() === 31;
    assert.ok(entryDates.some(isYearEnd),  'no harvester entry (31 December)');
    assert.ok(entryDates.some(d => !isYearEnd(d)), 'no rebalancer entry (a period boundary)');
  });

  test('the filings that match NOTHING still file, and cost nothing', () => {
    // The branch that retires the snapshot with a zero delta. Without it the same year is
    // re-filed every April against a state that has moved on (§8.1l).
    const quiet = filings.filter(f => f.disallowed === 0);
    assert.ok(quiet.length >= 1);
    for (const f of quiet) assert.equal(f.delta, 0);

    // Exactly ONE snapshot survives the run, and it is the LAST CLOSED year's: the
    // 31-December settle left it for an April filing the run ends before, while the
    // 1-January advance has already moved the live period on. Every earlier snapshot was
    // retired by the filing it served — a stale one means a year would be re-filed.
    const snapshot = run.state.usPendingReturn;
    assert.ok(snapshot, 'the final year opened a window, so its return is still unfiled');
    const snapshotYear = new Date(snapshot.currentPeriods.US.startMs).getUTCFullYear();
    const liveYear     = new Date(run.state.currentPeriods.US.startMs).getUTCFullYear();
    assert.equal(snapshotYear, liveYear - 1,
      'the surviving snapshot must be the year just closed, not an unretired older one');
  });

  test('an entry whose return is not yet filed is still PENDING at simEnd', () => {
    // The carry, in the fixture: the last harvest's loss belongs to a return that the run
    // ends before April of. Pinning it is what stops `remaining` being quietly dropped.
    const pending = run.state.washPendingLosses ?? [];
    assert.equal(pending.length, 1);
    assert.ok(pending[0].group && pending[0].units > 0 && pending[0].ms > 0,
      'a pending entry must name its identity group, its units and its sale date');
  });

  test('the audit ledger records the disallowance against the year it was FILED', () => {
    const ledger = run.state.washSaleLedger ?? [];
    assert.equal(ledger.length, 1);
    const [row] = ledger;
    assert.equal(row.filedYear, new Date(row.ms).getUTCFullYear(),
      '§1091 disallows on the return for the year of SALE, not the year of filing');
    assert.ok(row.disallowedShort + row.disallowedLong > 0);
  });
});

describe('the §1091(d) twin defers the loss into basis (§8.1p)', () => {
  test('the disallowance is DEFERRED, not destroyed — and the ledger says so', () => {
    const washed = twinFilings.filter(f => f.disallowed > 0);
    assert.equal(washed.length, 1);
    const [f] = washed;
    // Every row is a taxable match here, so the deferred total IS the disallowance: nothing
    // in this plan was matched against an IRA or Roth. That is the contrast with
    // `wash-sale-harvest`, whose single row carries no `deferred` at all.
    const deferred = f.ledger.reduce((s2, r) => s2 + (r.deferred ?? 0), 0);
    assert.ok(f.ledger.length >= 2, 'two books harvesting past each other produce several rows');
    assert.equal(+deferred.toFixed(2), +f.disallowed.toFixed(2));
    assert.equal(filings.filter(x => x.disallowed > 0)[0].ledger[0].deferred, undefined,
      'the sheltered golden defers nothing — the two goldens must not be measuring one thing');
  });

  test('§1091(a) still bites: the loss leaves the return and the balance due is paid', () => {
    // Deferral is about where the money GOES, not about whether the deduction survives. A
    // reading that let a taxable wash cost nothing today would be the rule inverted.
    const [f] = twinFilings.filter(x => x.disallowed > 0);
    assert.ok(f.delta > 0, `a disallowed loss must raise the liability, got ${f.delta}`);
  });

  test('every deferred dollar found a lot to land in', () => {
    // `washDeferralUnplaced` is written only when a basis transfer had nowhere to go — the
    // replacement was sold, swept or compacted in the four months before the filing. It
    // should be absent, and if it ever is not, the fixture will say how much was lost.
    assert.equal(twin.state.washDeferralUnplaced, undefined);
    const adjustments = twinFilings.flatMap(f => f.basisAdjustments ?? []);
    assert.ok(adjustments.length >= 2);
    for (const a of adjustments) {
      assert.ok(a.amount > 0 && a.units > 0);
      assert.ok(Array.isArray(twin.state[a.stateKey]?.holdings),
        `${a.stateKey} must be an account the reducer could write to`);
    }
  });

  test('the wash is large enough that a defect in applying it could not hide', () => {
    // Materiality, stated carefully because the two halves are worth very different amounts.
    //
    // The DISALLOWANCE is real money the year it happens: it is six figures here, and the
    // April balance due is the cash. The basis TRANSFER is only worth something when the
    // replacement is eventually sold — measured by stubbing `_applyBasisTransfers`, the
    // fixture moves 123 fields but terminal net worth moves by about \$154 on a \$6.7m book,
    // because most of the re-based lots are never disposed of inside the horizon. That is
    // what "timing, not money" means when the horizon is finite, and it is why this golden
    // exists to pin the MECHANISM rather than to defend a number.
    const [f] = twinFilings.filter(x => x.disallowed > 0);
    assert.ok(f.disallowed > 10_000,
      'a plan whose disallowance is trivial cannot detect a defect in how it is applied');
  });
});
