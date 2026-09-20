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
 * mpc-run-schedule.test.mjs
 *
 * DESIGN 81 phase 1 — the params, the two selectors, the SPENDING hooks and the reducer's
 * own arithmetic. Nothing here runs a simulation; the end-to-end gates are in
 * `mpc-run-absent.test.mjs`.
 *
 * MRS-1  `resolveActiveMpcRun` — absent, off, unselected, dangling, empty, live
 * MRS-2  `activeDecisionsAt` — before / on / between / after, and latest-per-key
 * MRS-3  D6 — a row bites at the first advance ON OR AFTER its date, not at the instant
 * MRS-4  D5 — `scheduleKey` returns a stable anchor, never an index
 * MRS-5  D12 — `applyAt` is a FULL replacement band table, built from the authored base
 * MRS-6  The reducer's no-op discipline — an undecided period adds no field
 * MRS-7  The reducer stamps `mpcDecisionApplied` exactly once per crossed date
 * MRS-8  A lever with no `applyAt` warns loudly rather than playing back silently short
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { resolveActiveMpcRun, activeDecisionsAt } from '../../src/finance/mpc/run-schedule.js';
import { LEVER_SCHEDULE, bandKey, bandKeyAge }    from '../../src/finance/mpc/lever-schedule.js';
import { MpcDecisionScheduleReducer }             from '../../src/finance/mpc/mpc-decision-schedule-reducer.js';

const D = (y, m = 1, d = 1) => new Date(Date.UTC(y, m - 1, d)).toISOString();
const MS = (y, m = 1, d = 1) => Date.UTC(y, m - 1, d);

const ROWS = [
  { date: D(2030), lever: 'SPENDING', key: bandKey(52), value: 4000 },
  { date: D(2033), lever: 'SPENDING', key: bandKey(55), value: 9000 },
  { date: D(2036), lever: 'SPENDING', key: bandKey(55), value: 7000 },
];

const paramsOf = (over = {}) => ({
  mpcRuns:      { 'run:a': { source: { epochs: 3 }, decisions: ROWS } },
  mpcActiveRun: 'run:a',
  ...over,
});

/** Captures `console.warn` for the cases whose whole content is a warning. */
function capturingWarnings(fn) {
  const seen = [];
  const real = console.warn;
  console.warn = (...a) => seen.push(a.join(' '));
  try { return { value: fn(), seen }; } finally { console.warn = real; }
}

// ─── MRS-1 ───────────────────────────────────────────────────────────────────

test('MRS-1: no bag, no selection ⇒ null — design 81 adds nothing to a scenario that does not use it', () => {
  assert.equal(resolveActiveMpcRun({}), null);
  assert.equal(resolveActiveMpcRun(undefined), null);
});

test('MRS-1: a bag with entries but no selection ⇒ null — the gate is the SELECTION (D4)', () => {
  // This is the case that makes the bag safe to accumulate: ten recorded runs, none playing.
  assert.equal(resolveActiveMpcRun(paramsOf({ mpcActiveRun: null })), null);
  assert.equal(resolveActiveMpcRun(paramsOf({ mpcActiveRun: '' })), null);
});

test('MRS-1: `mpcRunEnabled: false` is inert but KEEPS the selection', () => {
  const p = paramsOf({ mpcRunEnabled: false });
  assert.equal(resolveActiveMpcRun(p), null);
  assert.equal(p.mpcActiveRun, 'run:a');            // the whole point of the switch
});

test('MRS-1: a dangling selection warns and degrades to the base plan (§15)', () => {
  const { value, seen } = capturingWarnings(() => resolveActiveMpcRun(paramsOf({ mpcActiveRun: 'run:gone' })));
  assert.equal(value, null);
  assert.match(seen.join('\n'), /run:gone.*not an entry/s);
});

test('MRS-1: a live selection resolves to sorted, dated rows', () => {
  const run = resolveActiveMpcRun(paramsOf());
  assert.equal(run.runId, 'run:a');
  assert.equal(run.decisions.length, 3);
  assert.deepEqual(run.decisions.map(r => r.dateMs), [MS(2030), MS(2033), MS(2036)]);
  assert.equal(run.source.epochs, 3);
});

test('MRS-1: a malformed row is dropped with a warning, not silently', () => {
  const bad = { 'run:a': { decisions: [{ lever: 'SPENDING', key: bandKey(52), value: 1 }, ...ROWS] } };
  const { value, seen } = capturingWarnings(
    () => resolveActiveMpcRun({ mpcRuns: bad, mpcActiveRun: 'run:a' }));
  assert.equal(value.decisions.length, 3);
  assert.match(seen.join('\n'), /missing a date, lever or key/);
});

// ─── MRS-2 / MRS-3 ───────────────────────────────────────────────────────────

test('MRS-2: `activeDecisionsAt` selects the latest row per key at or before "now"', () => {
  const run = resolveActiveMpcRun(paramsOf());
  assert.equal(activeDecisionsAt(run, MS(2029)), null);                 // before every row

  const at2031 = activeDecisionsAt(run, MS(2031));
  assert.equal(at2031.throughMs, MS(2030));
  assert.deepEqual(at2031.byLever.get('SPENDING').map(r => [r.key, r.value]), [[bandKey(52), 4000]]);

  const at2034 = activeDecisionsAt(run, MS(2034));
  assert.equal(at2034.throughMs, MS(2033));
  assert.deepEqual(at2034.byLever.get('SPENDING').map(r => [r.key, r.value]),
    [[bandKey(52), 4000], [bandKey(55), 9000]]);

  // 2036 re-decides band@55 — the later row supersedes the earlier one on the SAME key,
  // which is a forward-effective revision, not the harvest's last-epoch-wins collapse.
  const at2040 = activeDecisionsAt(run, MS(2040));
  assert.equal(at2040.throughMs, MS(2036));
  assert.deepEqual(at2040.byLever.get('SPENDING').map(r => [r.key, r.value]),
    [[bandKey(52), 4000], [bandKey(55), 7000]]);
});

test('MRS-3: a row takes effect ON its date, and a mid-period row does not bite early (D6)', () => {
  const run = resolveActiveMpcRun(paramsOf());
  assert.equal(activeDecisionsAt(run, MS(2033) - 1)?.throughMs, MS(2030));  // the instant before
  assert.equal(activeDecisionsAt(run, MS(2033))?.throughMs,     MS(2033));  // on the date
});

test('MRS-2: degenerate inputs are null, not a throw', () => {
  assert.equal(activeDecisionsAt(null, MS(2030)), null);
  assert.equal(activeDecisionsAt({ decisions: [] }, MS(2030)), null);
  assert.equal(activeDecisionsAt(resolveActiveMpcRun(paramsOf()), NaN), null);
});

// ─── MRS-4 / MRS-5 ───────────────────────────────────────────────────────────

test('MRS-4: `scheduleKey` returns the age anchor, never the index-keyed param path (D5)', () => {
  const v = { paramKey: 'spendingExpenseBands[19].monthlyAmount', _startAge: 69 };
  assert.equal(LEVER_SCHEDULE.SPENDING.scheduleKey(v), 'band@69');
  assert.equal(bandKeyAge('band@69'), 69);
  assert.equal(bandKeyAge('spendingExpenseBands[19].monthlyAmount'), null);
});

test('MRS-5: `applyAt` returns a FULL band table built from the authored base (D12)', () => {
  const baseParams = { spendingExpenseBands: [
    { startAge: 48, monthlyAmount: 4000 },
    { startAge: 55, monthlyAmount: 5000 },
  ] };
  const rows = [{ key: bandKey(55), value: 9000 }];
  const patch = LEVER_SCHEDULE.SPENDING.applyAt({ rows, baseParams });

  // A replacement, not a merge map: the same shape `this.bands` already is, so `bandForAge`
  // and the re-pin logic need learn no second vocabulary.
  assert.deepEqual(patch.mpcSpendingBands, [
    { startAge: 48, monthlyAmount: 4000 },       // never decided ⇒ preserved from the base
    { startAge: 55, monthlyAmount: 9000 },
  ]);
  // The authored table is NOT mutated — a run writes back into no param (D5).
  assert.equal(baseParams.spendingExpenseBands[1].monthlyAmount, 5000);
});

test('MRS-5: a decision on an age the base has no band for INSERTS one, in sorted order', () => {
  const baseParams = { spendingExpenseBands: [{ startAge: 48, monthlyAmount: 4000 }] };
  const patch = LEVER_SCHEDULE.SPENDING.applyAt({
    rows: [{ key: bandKey(70), value: 3000 }, { key: bandKey(55), value: 9000 }], baseParams,
  });
  // `bandForAge` walks in order and BREAKS at the first band that has not started, so an
  // out-of-order insert would make every later band unreachable.
  assert.deepEqual(patch.mpcSpendingBands.map(b => b.startAge), [48, 55, 70]);
});

test('MRS-5: `applyAt` is idempotent and order-independent — it rebuilds from the base', () => {
  const baseParams = { spendingExpenseBands: [{ startAge: 48, monthlyAmount: 4000 }] };
  const rows = [{ key: bandKey(55), value: 9000 }];
  const a = LEVER_SCHEDULE.SPENDING.applyAt({ rows, baseParams });
  const b = LEVER_SCHEDULE.SPENDING.applyAt({ rows, baseParams, state: a });
  assert.deepEqual(a, b);
});

test('MRS-5: rows that name nothing applicable ⇒ null, so the reducer emits no patch', () => {
  const baseParams = { spendingExpenseBands: [{ startAge: 48, monthlyAmount: 4000 }] };
  assert.equal(LEVER_SCHEDULE.SPENDING.applyAt({ rows: [], baseParams }), null);
  assert.equal(LEVER_SCHEDULE.SPENDING.applyAt({ rows: [{ key: 'nope', value: 1 }], baseParams }), null);
});

// ─── MRS-6 / MRS-7 / MRS-8 ───────────────────────────────────────────────────

const ADVANCE = (y) => ({ type: 'US_PERIOD_ADVANCE', date: new Date(MS(y)) });
const BASE_PARAMS = { spendingExpenseBands: [{ startAge: 48, monthlyAmount: 4000 }] };

function reducerOf(over = {}) {
  return new MpcDecisionScheduleReducer({
    run: resolveActiveMpcRun(paramsOf()), baseParams: BASE_PARAMS, ...over,
  });
}

test('MRS-6: a period before every decision adds NO field — no diff, no journal entry', () => {
  const out = reducerOf().reduce({ foo: 1 }, ADVANCE(2029), null);
  assert.deepEqual(Object.keys(out).sort(), ['foo', 'next']);   // `next` is the no-op convention
  assert.equal('mpcSpendingBands' in out, false);
  assert.equal('mpcDecisionApplied' in out, false);
});

test('MRS-7: crossing a date stamps once; the next undeciding period adds nothing', () => {
  const r = reducerOf();
  const after = r.reduce({}, ADVANCE(2031), null);
  assert.deepEqual(after.mpcSpendingBands, [{ startAge: 48, monthlyAmount: 4000 },
                                            { startAge: 52, monthlyAmount: 4000 }]);
  assert.equal(after.mpcDecisionApplied.date, D(2030));   // the date it became LIVE
  assert.deepEqual(after.mpcDecisionApplied.levers, ['SPENDING']);
  assert.equal(after.mpcDecisionApplied.runId, 'run:a');

  // A second advance inside the same decision changes nothing at all.
  const again = r.reduce(after, ADVANCE(2032), null);
  assert.deepEqual(again.mpcSpendingBands, after.mpcSpendingBands);
  assert.equal(again.mpcDecisionApplied, after.mpcDecisionApplied);   // same object ⇒ no diff

  // Crossing the NEXT date re-stamps.
  const later = r.reduce(again, ADVANCE(2034), null);
  assert.equal(later.mpcDecisionApplied.date, D(2033));
  assert.equal(later.mpcSpendingBands.find(b => b.startAge === 55).monthlyAmount, 9000);
});

test('MRS-7: "now" falls back to the period start when the action carries no date', () => {
  const state = { currentPeriods: { US: { startMs: MS(2034) } } };
  const out = reducerOf().reduce(state, { type: 'US_PERIOD_ADVANCE' }, null);
  assert.equal(out.mpcDecisionApplied.date, D(2033));
});

test('MRS-8: a lever with no `applyAt` warns loudly rather than playing back short', () => {
  // `ROTH` is the real unhooked lever as of phase 2 — it folds into `rothConversionSchedule`
  // at COMPILE (§6.3), so it will never gain an `applyAt`, which is what makes it the stable
  // fixture here. (This test named BOND_LADDER until phase 2b hooked it.)
  const run = resolveActiveMpcRun({
    mpcRuns: { r: { decisions: [{ date: D(2030), lever: 'ROTH', key: 'rothConversionAmount', value: 50000 }] } },
    mpcActiveRun: 'r',
  });
  const r = new MpcDecisionScheduleReducer({ run, baseParams: BASE_PARAMS });
  const { value: out, seen } = capturingWarnings(() => r.reduce({}, ADVANCE(2031), null));
  assert.equal('mpcDecisionApplied' in out, false);
  assert.match(seen.join('\n'), /ROTH.*no `applyAt` hook/s);
});
