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
 * section988-ingest-roundtrip.test.mjs — the emit → edit → re-ingest loop.
 *
 * `--emit-classified` is how a few thousand real bank rows get classified by hand: emit,
 * fix the flagged ones in a spreadsheet, feed the file back as the source. That makes the
 * round trip load-bearing, and every failure mode here is SILENT — the file still parses,
 * the report still prints, and hours of manual classification are quietly gone.
 *
 *   RT-1..3   an override survives the trip, and a REJECTED one is echoed back rather
 *             than erased (the trip must not launder a typo into "never classified").
 *   RT-4..5   one sheet carries the whole pool: accounts split apart again for footing,
 *             ordering survives a newest-first export, and reconciliation finds a pairing
 *             whenever one exists rather than stranding a credit as "unknown basis".
 *   RT-6..7   a date a spreadsheet rewrote is fatal, not skipped.
 *   RT-8..9   an ASSUMED basis stays visible across edit cycles, and is refused on any
 *             kind where it could not mean anything.
 *   RT-10..13 stating WHAT the assumption is — BasisDate (a day, or a window to average)
 *             and BasisRate. They must price the row without touching its transaction
 *             date, round-trip as the text that was typed, and fail loudly rather than
 *             fall back to the very default they were overriding.
 *
 * Run with: node --test tests/unit/section988-ingest-roundtrip.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readAccountCsv, classifyRow, toClassifiedCsv, classificationStatus,
  groupByAccount, footLedger, reconcileInternal, seededBasis, attachRates,
  STATUS, KIND, BASIS_FROM,
} from '../../scripts/lib/section988-source.mjs';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);

/** The counter-account a row's description names, for asserting on pairings. */
const namedIn = (row) => /Transfer:\[([^\]]+)\]/i.exec(row.description)?.[1];

const dir = mkdtempSync(join(tmpdir(), 'sec988-'));
let seq = 0;
const writeCsv = (text) => {
  const file = join(dir, `t${seq++}.csv`);
  writeFileSync(file, text);
  return file;
};

/** Ingest + classify + emit, exactly as the script does. */
const cycle = (text, account = 'offset') => {
  const { rows } = readAccountCsv(writeCsv(text), account);
  const classified = rows.map((r) => ({ ...r, ...classifyRow(r, []) }));
  return { classified, csv: toClassifiedCsv(classified) };
};

const HEAD = 'Status,Kind,BusinessFraction,Date,Account,Description,Amount,Balance';

test('RT-1 a valid override survives the round trip', () => {
  const first = cycle(`${HEAD}\n,DISPOSE,0.4,2020-01-02,offset,card payment,-100,900\n`);
  assert.equal(classificationStatus(first.classified[0]), STATUS.OK);

  // Re-ingest what was emitted. The point is the SECOND generation: an override that
  // only survives one hop would decay silently over a few edit passes.
  const second = cycle(first.csv);
  assert.equal(second.classified[0].kind, 'DISPOSE');
  assert.equal(second.classified[0].businessFraction, 0.4);
  assert.equal(second.classified[0].via, 'csv-override');
  assert.equal(second.csv, first.csv, 'emit must be a fixed point once every row is OK');
});

test('RT-2 a REJECTED override is echoed back, not erased', () => {
  // `classifyRow` refuses these and returns kind:null. Emitting that null would blank the
  // cell — the typo would vanish and the row would read as one nobody had ever touched.
  const cases = [
    ['DISPOSAL', '', 'invalid Kind'],
    ['DISPOSE', '', 'needs BusinessFraction'],
    ['ACQUIRE', '0.5', 'BusinessFraction set on'],
  ];
  for (const [kind, fraction, why] of cases) {
    const { classified, csv } = cycle(
      `${HEAD}\n,${kind},${fraction},2020-01-02,offset,row,-100,900\n`);
    assert.equal(classificationStatus(classified[0]), STATUS.REJECTED, `${kind} should reject`);

    const cells = csv.split('\n')[1];
    assert.match(cells, new RegExp(`^${STATUS.REJECTED},${kind},${fraction},`),
      `what was typed must come back: ${kind}/${fraction || 'blank'}`);
    assert.match(csv, new RegExp(why), 'and the reason must come back with it');
  }
});

test('RT-3 status separates the three not-done cases', () => {
  const { classified } = cycle(
    `${HEAD}\n`
    + `,ACQUIRE,,2020-01-02,offset,done,100,1100\n`
    + `,,,2020-01-03,offset,nobody described this,-100,1000\n`);
  assert.deepEqual(classified.map(classificationStatus), [STATUS.OK, STATUS.UNMATCHED]);

  // DECIDE is a rule that matched deliberately WITHOUT classifying.
  const rules = [{ index: 0, decide: 'needs the card statement', decideOnly: true, match: 'card' }];
  const row = { description: 'card payment', amount: -100 };
  const decided = { ...row, ...classifyRow(row, rules) };
  assert.equal(classificationStatus(decided), STATUS.DECIDE);
  assert.notEqual(classificationStatus(decided), STATUS.UNMATCHED,
    'DECIDE wants a per-row answer; UNMATCHED wants a new rule — do not collapse them');
});

test('RT-4 one sheet carries several accounts and splits apart again', () => {
  // The emitted file merges the pool so it can be edited in one pass. Nothing may be
  // lost or reassigned on the way back in.
  const { classified } = cycle(
    `${HEAD}\n`
    + `,ACQUIRE,,2020-01-02,savings,in,500,5500\n`
    + `,DISPOSE,0,2020-01-03,offset,out,-100,900\n`
    + `,ACQUIRE,,2020-01-04,savings,in,200,5700\n`,
    'ignored-cli-label');

  const groups = groupByAccount(classified);
  assert.deepEqual(groups.map((g) => g.account).sort(), ['offset', 'savings']);
  assert.equal(groups.find((g) => g.account === 'savings').rows.length, 2);
  assert.equal(classified.every((r) => r.account !== 'ignored-cli-label'), true,
    'a per-row Account column must beat the --csv label');
});

test('RT-5 footing is per account, so a merged sheet invents no breaks', () => {
  // `balance` is a per-account running total. Footing the merged sheet as one ledger
  // would break on every switch between accounts — a wall of phantom failures.
  const merged = `${HEAD}\n`
    + `,ACQUIRE,,2020-01-02,savings,in,500,5500\n`
    + `,DISPOSE,0,2020-01-03,offset,out,-100,900\n`
    + `,DISPOSE,0,2020-01-04,savings,out,-200,5300\n`
    + `,ACQUIRE,,2020-01-05,offset,in,50,950\n`;
  const { classified } = cycle(merged);

  assert.equal(footLedger(classified).length > 0, true,
    'control: footing the merged sheet as ONE ledger does break');
  const perAccount = groupByAccount(classified).flatMap((g) => footLedger(g.rows));
  assert.deepEqual(perAccount, [], 'but per account it foots');

  // And a genuine break is still caught, in the right account.
  const { classified: bad } = cycle(merged.replace(',-200,5300', ',-200,5999'));
  const breaks = groupByAccount(bad).flatMap((g) => footLedger(g.rows).map(() => g.account));
  assert.deepEqual(breaks, ['savings']);
});

test('RT-5b a newest-first export survives the round trip', () => {
  // Two rows on ONE date, in a newest-first export: the balance steps through them in
  // DESCENDING line order. Sorting the emit by line number put them back the wrong way
  // round, and the next ingest read the balance moving backwards — 72 phantom footing
  // breaks on real data, not one of them a missing row. Hence `seq`, which is position in
  // true order rather than in the file.
  const newestFirst = writeCsv(
    'Date,Description,Amount,Balance\n'
    + '2/1/2024,second of the day,30,150\n'   // line 2, but happened SECOND
    + '2/1/2024,first of the day,20,120\n'    // line 3, but happened FIRST
    + '1/1/2024,oldest,100,100\n');           // line 4, oldest of all

  const { rows } = readAccountCsv(newestFirst, 'savings');
  assert.deepEqual(rows.map((r) => r.description),
    ['oldest', 'first of the day', 'second of the day'], 'read into true order');
  assert.deepEqual(rows.map((r) => r.seq), [0, 1, 2], 'seq follows true order, not the file');
  assert.deepEqual(footLedger(rows), [], 'and it foots');

  // Now the trip: emit in the order the script sorts, and read it back.
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.seq - b.seq);
  const round = readAccountCsv(writeCsv(toClassifiedCsv(sorted)), 'savings');
  assert.deepEqual(footLedger(round.rows), [], 'still foots after a round trip');

  const bySourceLine = [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.sourceLine - b.sourceLine);
  assert.ok(footLedger(readAccountCsv(writeCsv(toClassifiedCsv(bySourceLine)), 'savings').rows).length > 0,
    'control: tie-breaking on sourceLine is what broke it');
});

test('RT-5c chained same-day transfers reconcile to the right legs', () => {
  // A -> B -> C, one amount, one date. Every credit matches every debit on amount and
  // date, so the only thing that tells the legs apart is that two halves of ONE transfer
  // name each other's accounts and can never name the same third account. Without that,
  // B's credit paired with A's debit (both naming B) and the true pair was reported as
  // currency of unknown basis — on the largest transfer in the file.
  const t = (account, description, amount) => ({
    account, description, amount, date: '2025-01-20', kind: KIND.INTERNAL,
  });
  const rows = [
    t('rewardTP', 'Transfer Transfer:[Offset 877644419]', 60000),
    t('isaver', 'Transfer Transfer:[Offset 877644419]', -60000),
    t('offset', 'Transfer Transfer:[ISaver 870697593]', 60000),
    t('offset', 'Transfer Transfer:[Reward Saver TP 426295125]', -60000),
  ];
  const { matched, unmatchedCredits } = reconcileInternal(rows);
  assert.equal(unmatchedCredits.length, 0, 'both credits have a partner');
  assert.equal(matched.length, 2);
  for (const { credit, debit } of matched) {
    assert.notEqual(namedIn(credit), namedIn(debit),
      'two legs of one transfer cannot name the same third account');
  }
});

test('RT-5d a credit is unmatched only when NO assignment could pair it', () => {
  // Three separate transfers of one amount on one date. Greedy takes the first free
  // partner for each credit in turn and strands the last one, then reports it as unknown
  // basis — the most serious thing this tool says, about money that reconciles perfectly.
  const t = (account, description, amount) => ({
    account, description, amount, date: '2025-02-14', kind: KIND.INTERNAL,
  });
  const rows = [
    t('rewardTP', 'Transfer Transfer:[Offset 877644419]', 4000),
    t('rewardJP', 'Transfer Transfer:[ISaver 870697593]', 4000),
    t('offset', 'Transfer Transfer:[ISaver 870697593]', 4000),
    t('isaver', 'Transfer Transfer:[Reward Saver JP 424732942]', -4000),
    t('isaver', 'Transfer Transfer:[Offset 877644419]', -4000),
    t('offset', 'Transfer Transfer:[Reward Saver TP 426295125]', -4000),
  ];
  const { matched, unmatchedCredits, unmatchedDebits } = reconcileInternal(rows);
  assert.equal(matched.length, 3, 'a perfect assignment exists, so all three pair');
  assert.deepEqual(unmatchedCredits, []);
  assert.deepEqual(unmatchedDebits, []);

  // And a credit with genuinely no counterparty is still reported.
  const orphan = t('offset', 'Transfer Transfer:[ISaver 870697593]', 9999);
  assert.equal(reconcileInternal([...rows, orphan]).unmatchedCredits.length, 1,
    'control: an unpairable credit is still unknown basis');
});

test('RT-8 an assumed basis survives the trip and stays visible', () => {
  // The whole point of the marker: flipping an unmatched INTERNAL credit to ACQUIRE is
  // right and conservative, but the row then looks exactly like a real acquisition. If
  // the marker did not round-trip, the assumption would quietly become a fact after one
  // edit cycle — which is the failure it exists to prevent.
  const first = cycle(
    `${HEAD},BasisSource\n`
    + `,ACQUIRE,,2016-06-10,offset,opening deposit,39500,39500,assumed\n`
    + `,ACQUIRE,,2016-06-27,offset,wages,8430,47930,\n`);

  assert.equal(first.classified[0].basisSource, 'assumed');
  assert.equal(first.classified[1].basisSource, undefined, 'an ordinary acquisition is unmarked');

  const second = cycle(first.csv);
  assert.equal(second.classified[0].basisSource, 'assumed', 'survives a second generation');
  assert.equal(second.csv, first.csv, 'and the emit is a fixed point');

  // seededBasis reports it in both currencies, and ignores the observed row.
  second.classified[0].rate = { usdPerAud: 0.7395 };
  second.classified[1].rate = { usdPerAud: 0.7395 };
  const seeded = seededBasis(second.classified);
  assert.equal(seeded.rows, 1, 'only the assumed row counts');
  assert.equal(seeded.aud, 39500);
  assert.ok(Math.abs(seeded.usd - 29210.25) < 0.01, 'stamped at the date it first appears');
});

test('RT-9 "assumed" is refused anywhere it cannot mean anything', () => {
  // A DISPOSE consumes basis rather than establishing any. An INTERNAL carries basis over
  // from its other leg — so the honest move for a leg whose partner is invisible is to
  // make it an ACQUIRE and say so, not to leave it INTERNAL and annotate it.
  for (const kind of ['DISPOSE', 'INTERNAL', 'IGNORE']) {
    const fraction = kind === 'DISPOSE' ? '0' : '';
    const { classified } = cycle(
      `${HEAD},BasisSource\n,${kind},${fraction},2016-06-10,offset,row,-100,900,assumed\n`);
    assert.equal(classificationStatus(classified[0]), STATUS.REJECTED, `${kind} must reject`);
    assert.match(classified[0].error, /only meaningful on an ACQUIRE/);
  }
  const { classified } = cycle(
    `${HEAD},BasisSource\n,ACQUIRE,,2016-06-10,offset,row,100,100,guessed\n`);
  assert.equal(classificationStatus(classified[0]), STATUS.REJECTED, 'and the value is a closed set');
  assert.match(classified[0].error, /must be observed or assumed/);
});

test('RT-6 a date the spreadsheet rewrote is fatal', () => {
  // Excel rewrites the Date column in the machine's locale on save. Before this guard the
  // row still loaded — it just dropped out of the FX gate and the turnover measurement,
  // which both filter on `date`. A silent exemption from the only checks that see it.
  assert.throws(
    () => readAccountCsv(writeCsv(`${HEAD}\n,,,04-May-2016,offset,mangled,100,100\n`), 'offset'),
    /cannot read the date "04-May-2016"/);
});

test('RT-7 the formats a spreadsheet legitimately writes still load', () => {
  const { classified } = cycle(
    `${HEAD}\n`
    + `,,,5/4/2016,offset,us locale,100,100\n`
    + `,,,2016-05-05,offset,iso,100,200\n`
    + `,,,,,,,\n`);           // trailing padding must stay skippable, not become fatal
  assert.deepEqual(classified.map((r) => r.date), ['2016-05-04', '2016-05-05']);
});

/* ───────────── stating WHAT the assumption is: BasisDate / BasisRate ───────────── */

/** A tiny rate table, enough for resolve() and a two-observation window. */
const rates = () => ({
  lastDate: '2016-06-30',
  _dates: ['2013-12-31', '2014-01-02', '2016-06-10'],
  _obs: new Map([['2013-12-31', 0.8929], ['2014-01-02', 0.8871], ['2016-06-10', 0.7395]]),
  resolve(d) {
    if (this._obs.has(d)) return { usdPerAud: this._obs.get(d), quotedDate: d, carriedFrom: null };
    const prior = this._dates.filter((x) => x < d).pop();
    if (!prior || d > this.lastDate) return null;
    return { usdPerAud: this._obs.get(prior), quotedDate: prior, carriedFrom: prior };
  },
});

const HEAD_BASIS = `${HEAD},BasisSource,BasisDate,BasisRate`;

test('RT-10 a stated basis date or rate is used, and never touches the row date', () => {
  // The reason these are separate columns. The transaction date orders the ledger walk,
  // drives footing and decides which lots FIFO consumes; re-dating a row to reach a better
  // rate corrupts three things to fix one, and the result still looks plausible.
  const { classified } = cycle(
    `${HEAD_BASIS}\n`
    + `,ACQUIRE,,2016-06-10,offset,a,39500,39500,assumed,2014-01-01,\n`
    + `,ACQUIRE,,2016-06-10,offset,b,40000,79500,assumed,,0.87\n`
    + `,ACQUIRE,,2016-06-10,offset,c,6000,85500,assumed,2013-12-31..2014-01-02,\n`
    + `,ACQUIRE,,2016-06-10,offset,d,1000,86500,assumed,,\n`);
  const { basisIssues } = attachRates(classified, rates());
  assert.deepEqual(basisIssues, [], 'all four resolve');

  for (const r of classified) assert.equal(r.date, '2016-06-10', 'the transaction date is untouched');

  assert.equal(classified[0].basisFrom, BASIS_FROM.STATED_DATE);
  near(classified[0].basisRate.usdPerAud, 0.8929, 'carried from the prior business day');
  assert.equal(classified[1].basisFrom, BASIS_FROM.STATED_RATE);
  near(classified[1].basisRate.usdPerAud, 0.87, 'stated outright');
  assert.equal(classified[2].basisFrom, BASIS_FROM.AVERAGED);
  near(classified[2].basisRate.usdPerAud, (0.8929 + 0.8871) / 2, 'the window is averaged');
  assert.equal(classified[2].basisRate.observations, 2, 'and says how many points backed it');
  assert.equal(classified[3].basisFrom, BASIS_FROM.ROW_DATE);
  assert.equal(classified[3].basisRate, undefined, 'no override means no second rate at all');

  // seededBasis must report the rate that will ACTUALLY be the basis, not the market rate
  // on the day the money appeared — otherwise the standing disclosure shows one number
  // while the ledger quietly uses another.
  const seeded = seededBasis(classified);
  const stated = seeded.entries.find((e) => e.aud === 40000);
  near(stated.usdPerAud, 0.87, 'reports what was stated');
  near(stated.rowDateRate, 0.7395, 'and what it would otherwise have been');
});

test('RT-11 a basis override survives the round trip as the text that was typed', () => {
  const first = cycle(
    `${HEAD_BASIS}\n`
    + `,ACQUIRE,,2016-06-10,offset,a,39500,39500,assumed,2013-12-31..2014-01-02,\n`
    + `,ACQUIRE,,2016-06-10,offset,b,40000,79500,assumed,,0.87\n`);
  const second = cycle(first.csv);
  assert.equal(second.classified[0].overrideBasisDate, '2013-12-31..2014-01-02');
  assert.equal(second.classified[1].overrideBasisRate, '0.87');
  assert.equal(second.csv, first.csv, 'and the emit is a fixed point');
});

test('RT-12 a basis override is refused wherever it could not mean anything', () => {
  // Each of these is a stated intention that could not be carried out. Refusing is the
  // only outcome that does not compute a basis nobody asked for while the column sits in
  // the file looking like it took effect.
  const cases = [
    [`,DISPOSE,0,2016-06-10,offset,r,-100,900,,2014-01-01,`, /only meaningful on an ACQUIRE/],
    [`,ACQUIRE,,2016-06-10,offset,r,100,100,,2014-01-01,`, /requires BasisSource "assumed"/],
    [`,ACQUIRE,,2016-06-10,offset,r,100,100,assumed,2014-01-01,0.87`, /both set/],
    [`,ACQUIRE,,2016-06-10,offset,r,100,100,assumed,,nonsense`, /must be a positive number/],
    [`,ACQUIRE,,2016-06-10,offset,r,100,100,assumed,,-0.5`, /must be a positive number/],
    [`,ACQUIRE,,2016-06-10,offset,r,100,100,assumed,last tuesday,`, /cannot read BasisDate/],
    [`,ACQUIRE,,2016-06-10,offset,r,100,100,assumed,2016-01-01..2014-01-01,`, /runs backwards/],
  ];
  for (const [line, expected] of cases) {
    const { classified, csv } = cycle(`${HEAD_BASIS}\n${line}\n`);
    assert.equal(classificationStatus(classified[0]), STATUS.REJECTED, line);
    assert.match(classified[0].error, expected);
    // Echoed back, like every other refused override. Erasing it would launder the typo
    // into "never filled in" and the next sheet would look untouched.
    assert.ok(csv.includes(line.split(',')[9]) || line.split(',')[9] === '', 'the typed text comes back');
  }
});

test('RT-13 an unusable stated basis is reported, never silently defaulted', () => {
  // The fallback is the row date — precisely the default the author was overriding. Silent
  // is the one unacceptable outcome, so attachRates hands these back for GATE 5 to print.
  const { classified } = cycle(
    `${HEAD_BASIS}\n`
    + `,ACQUIRE,,2016-06-10,offset,slip,39500,39500,assumed,,87\n`
    + `,ACQUIRE,,2016-06-10,offset,gap,1000,40500,assumed,1990-01-01,\n`);
  const { basisIssues } = attachRates(classified, rates());
  assert.equal(basisIssues.length, 2);
  assert.match(basisIssues[0].why, /outside everything the series has ever printed/,
    '0.87 typed as 87 multiplies basis by a hundred — caught, not applied');
  assert.match(basisIssues[1].why, /no published rate for BasisDate/);
  for (const b of basisIssues) assert.equal(b.row.basisRate, undefined, 'nothing was attached');
});
