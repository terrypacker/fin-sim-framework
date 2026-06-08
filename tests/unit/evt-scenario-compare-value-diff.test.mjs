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
 * EVT-Scenario-Compare: value-level journal diff (Phase B.5).
 *
 * Tests the pure utility functions added in §5.4:
 *   - mergeEntryFieldRows    — field-aligns two stateDiff arrays
 *   - pairEntriesWithinDay   — now attaches fieldRows to each pair
 *   - firstDivergenceDate    — detects first day with non-zero Δ or unmatched row
 *   - runningNetWorthSeries  — incremental balance accumulator
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import {
  mergeEntryFieldRows,
  pairEntriesWithinDay,
  buildJournalOverlay,
  firstDivergenceDate,
  runningNetWorthSeries,
  journalPairKey,
} from '../../src/finance/scenario-compare/scenario-compare-utils.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function mkDiff(field, before, after) {
  const delta = typeof before === 'number' && typeof after === 'number' ? after - before : null;
  return { field, before, after, delta };
}

function mkEntry(dateStr, actionType, stateDiff = [], opts = {}) {
  return {
    date:   new Date(dateStr),
    event:  { nodeId: opts.evNodeId ?? null, type: actionType },
    action: {
      nodeId: opts.acNodeId ?? null,
      type:   actionType,
      name:   actionType,
      data:   { personKey: opts.personKey ?? null },
    },
    reducer:   { name: 'TestReducer' },
    stateDiff: stateDiff,
  };
}

// ── mergeEntryFieldRows ───────────────────────────────────────────────────────

test('EVT-Scenario-Compare-ValueDiff: mergeEntryFieldRows — both null → empty', () => {
  assert.deepEqual(mergeEntryFieldRows(null, null), []);
});

test('EVT-Scenario-Compare-ValueDiff: mergeEntryFieldRows — both with no stateDiff → empty', () => {
  assert.deepEqual(mergeEntryFieldRows({}, {}), []);
});

test('EVT-Scenario-Compare-ValueDiff: mergeEntryFieldRows — same field in both, numeric deltas', () => {
  const a = { stateDiff: [mkDiff('account.balance', 1000, 1200)] };
  const b = { stateDiff: [mkDiff('account.balance', 1000, 1500)] };
  const rows = mergeEntryFieldRows(a, b);

  assert.strictEqual(rows.length, 1);
  const r = rows[0];
  assert.strictEqual(r.field, 'account.balance');
  assert.strictEqual(r.aDelta, 200);
  assert.strictEqual(r.bDelta, 500);
  assert.strictEqual(r.deltaOfDelta, 300);   // 500 - 200
  assert.strictEqual(r.aBefore, 1000);
  assert.strictEqual(r.aAfter,  1200);
  assert.strictEqual(r.bBefore, 1000);
  assert.strictEqual(r.bAfter,  1500);
});

test('EVT-Scenario-Compare-ValueDiff: mergeEntryFieldRows — field only in A (b treated as 0)', () => {
  const a = { stateDiff: [mkDiff('foo.balance', 100, 300)] };
  const rows = mergeEntryFieldRows(a, null);

  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].bDelta, null);
  assert.strictEqual(rows[0].deltaOfDelta, -200);  // (0) - 200 = -200
});

test('EVT-Scenario-Compare-ValueDiff: mergeEntryFieldRows — field only in B (a treated as 0)', () => {
  const b = { stateDiff: [mkDiff('bar.balance', 500, 800)] };
  const rows = mergeEntryFieldRows(null, b);

  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].aDelta, null);
  assert.strictEqual(rows[0].deltaOfDelta, 300);   // 300 - (0) = 300
});

test('EVT-Scenario-Compare-ValueDiff: mergeEntryFieldRows — field in both with zero deltaOfDelta', () => {
  const diff = [mkDiff('x.balance', 0, 50)];
  const rows = mergeEntryFieldRows({ stateDiff: diff }, { stateDiff: diff });
  assert.strictEqual(rows[0].deltaOfDelta, 0);
});

test('EVT-Scenario-Compare-ValueDiff: mergeEntryFieldRows — sorted by |deltaOfDelta| descending', () => {
  const a = {
    stateDiff: [
      mkDiff('small.balance', 0, 10),
      mkDiff('large.balance', 0, 5),
    ],
  };
  const b = {
    stateDiff: [
      mkDiff('small.balance', 0, 15),
      mkDiff('large.balance', 0, 100),
    ],
  };
  const rows = mergeEntryFieldRows(a, b);
  assert.strictEqual(rows[0].field, 'large.balance');  // |95| > |5|
  assert.strictEqual(rows[1].field, 'small.balance');
});

test('EVT-Scenario-Compare-ValueDiff: mergeEntryFieldRows — non-numeric delta → deltaOfDelta null', () => {
  const a = { stateDiff: [{ field: 'flag', before: false, after: true, delta: null }] };
  const b = { stateDiff: [{ field: 'flag', before: false, after: true, delta: null }] };
  const rows = mergeEntryFieldRows(a, b);
  assert.strictEqual(rows[0].deltaOfDelta, null);
});

test('EVT-Scenario-Compare-ValueDiff: mergeEntryFieldRows — NaN→NaN rows are filtered out', () => {
  // earningsBasis fields initialised to NaN; NaN === NaN is false so diffStates
  // records them as changed — mergeEntryFieldRows should drop them as noise.
  const nan = NaN;
  const a = {
    stateDiff: [
      { field: 'account.earningsBasis', before: nan, after: nan, delta: nan },
      { field: 'account.balance',       before: 0,   after: 500, delta: 500 },
    ],
  };
  const b = {
    stateDiff: [
      { field: 'account.earningsBasis', before: nan, after: nan, delta: nan },
      { field: 'account.balance',       before: 0,   after: 600, delta: 600 },
    ],
  };
  const rows = mergeEntryFieldRows(a, b);
  assert.ok(!rows.some(r => r.field === 'account.earningsBasis'), 'NaN row should be filtered');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].field, 'account.balance');
  assert.strictEqual(rows[0].deltaOfDelta, 100);
});

test('EVT-Scenario-Compare-ValueDiff: mergeEntryFieldRows — NaN delta treated as null, not propagated', () => {
  const a = { stateDiff: [{ field: 'x.balance', before: 0, after: NaN, delta: NaN }] };
  const b = { stateDiff: [{ field: 'x.balance', before: 0, after: 100, delta: 100 }] };
  // after: NaN on A side but after: 100 on B → row is kept (B has finite value)
  const rows = mergeEntryFieldRows(a, b);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].aDelta, null);          // NaN delta → null
  assert.strictEqual(rows[0].bDelta, 100);
  assert.strictEqual(rows[0].deltaOfDelta, 100);     // 100 - (null→0) = 100
});

// ── pairEntriesWithinDay now attaches fieldRows ───────────────────────────────

test('EVT-Scenario-Compare-ValueDiff: pairEntriesWithinDay — paired entries have fieldRows', () => {
  const sd  = [mkDiff('checking.balance', 0, 100)];
  const ea  = mkEntry('2027-01-01', 'WAGES', sd, { evNodeId: 'ev1', acNodeId: 'ac1' });
  const eb  = mkEntry('2027-01-01', 'WAGES', [mkDiff('checking.balance', 0, 150)], { evNodeId: 'ev1', acNodeId: 'ac1' });
  const pairs = pairEntriesWithinDay([ea], [eb]);

  assert.strictEqual(pairs.length, 1);
  assert.strictEqual(pairs[0].kind, 'paired');
  assert.ok(Array.isArray(pairs[0].fieldRows));
  assert.strictEqual(pairs[0].fieldRows.length, 1);
  assert.strictEqual(pairs[0].fieldRows[0].field, 'checking.balance');
  assert.strictEqual(pairs[0].fieldRows[0].deltaOfDelta, 50);  // 150 - 100
});

test('EVT-Scenario-Compare-ValueDiff: pairEntriesWithinDay — a-only entry has fieldRows from A', () => {
  const sd  = [mkDiff('ira.balance', 10000, 10500)];
  const ea  = mkEntry('2027-06-01', 'RMD', sd);
  const pairs = pairEntriesWithinDay([ea], []);

  assert.strictEqual(pairs[0].kind, 'a-only');
  assert.strictEqual(pairs[0].fieldRows.length, 1);
  assert.strictEqual(pairs[0].fieldRows[0].aDelta, 500);
  assert.strictEqual(pairs[0].fieldRows[0].bDelta, null);
  assert.strictEqual(pairs[0].fieldRows[0].deltaOfDelta, -500);  // 0 - 500
});

// ── firstDivergenceDate ───────────────────────────────────────────────────────

test('EVT-Scenario-Compare-ValueDiff: firstDivergenceDate — empty overlay → null', () => {
  assert.strictEqual(firstDivergenceDate([]), null);
});

test('EVT-Scenario-Compare-ValueDiff: firstDivergenceDate — all identical paired rows → null', () => {
  const sd   = [mkDiff('account.balance', 0, 100)];
  const ea   = mkEntry('2027-01-01', 'WAGES', sd, { evNodeId: 'e1', acNodeId: 'a1' });
  const eb   = mkEntry('2027-01-01', 'WAGES', sd, { evNodeId: 'e1', acNodeId: 'a1' });
  const overlay = buildJournalOverlay([ea], [eb]);
  assert.strictEqual(firstDivergenceDate(overlay), null);
});

test('EVT-Scenario-Compare-ValueDiff: firstDivergenceDate — day with a-only → that date', () => {
  const ea  = mkEntry('2027-03-15', 'SS_APPLY');
  const overlay = buildJournalOverlay([ea], []);
  assert.strictEqual(firstDivergenceDate(overlay), '2027-03-15');
});

test('EVT-Scenario-Compare-ValueDiff: firstDivergenceDate — day with non-zero deltaOfDelta → that date', () => {
  const sdA  = [mkDiff('roth.balance', 0, 200)];
  const sdB  = [mkDiff('roth.balance', 0, 350)];
  const ea   = mkEntry('2028-06-01', 'ROTH_CONV', sdA, { evNodeId: 'e1', acNodeId: 'a1' });
  const eb   = mkEntry('2028-06-01', 'ROTH_CONV', sdB, { evNodeId: 'e1', acNodeId: 'a1' });
  const overlay = buildJournalOverlay([ea], [eb]);
  assert.strictEqual(firstDivergenceDate(overlay), '2028-06-01');
});

test('EVT-Scenario-Compare-ValueDiff: firstDivergenceDate — returns earliest diverging day', () => {
  // Day 1: matching; Day 2: diverging
  const sdSame = [mkDiff('x.balance', 0, 100)];
  const sdDiff = [mkDiff('y.balance', 0, 50)];
  const ea1 = mkEntry('2027-01-01', 'ACT', sdSame, { evNodeId: 'e1', acNodeId: 'a1' });
  const eb1 = mkEntry('2027-01-01', 'ACT', sdSame, { evNodeId: 'e1', acNodeId: 'a1' });
  const eb2 = mkEntry('2027-06-01', 'ACT', sdDiff);  // b-only

  const overlay = buildJournalOverlay([ea1], [eb1, eb2]);
  assert.strictEqual(firstDivergenceDate(overlay), '2027-06-01');
});

// ── runningNetWorthSeries ─────────────────────────────────────────────────────

test('EVT-Scenario-Compare-ValueDiff: runningNetWorthSeries — empty → empty', () => {
  assert.deepEqual(runningNetWorthSeries([]), []);
});

test('EVT-Scenario-Compare-ValueDiff: runningNetWorthSeries — single entry with one balance field', () => {
  const entries = [mkEntry('2027-01-01', 'WAGES', [mkDiff('checking.balance', 0, 5000)])];
  const result  = runningNetWorthSeries(entries);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0], 5000);
});

test('EVT-Scenario-Compare-ValueDiff: runningNetWorthSeries — accumulates across entries', () => {
  const e1 = mkEntry('2027-01-01', 'WAGES',   [mkDiff('checking.balance', 0, 5000)]);
  const e2 = mkEntry('2027-01-02', 'SAVINGS',  [mkDiff('savings.balance', 0, 2000)]);
  const e3 = mkEntry('2027-01-03', 'INTEREST', [mkDiff('savings.balance', 2000, 2100)]);

  const result = runningNetWorthSeries([e1, e2, e3]);
  assert.strictEqual(result[0], 5000);   // checking only
  assert.strictEqual(result[1], 7000);   // checking + savings
  assert.strictEqual(result[2], 7100);   // checking + updated savings
});

test('EVT-Scenario-Compare-ValueDiff: runningNetWorthSeries — non-balance fields are ignored', () => {
  const e = mkEntry('2027-01-01', 'TAX', [
    mkDiff('ordinaryIncomeYTD', 0, 50000),    // not a .balance field
    mkDiff('checking.balance',  0, 10000),
  ]);
  const result = runningNetWorthSeries([e]);
  assert.strictEqual(result[0], 10000);   // only .balance sum
});

test('EVT-Scenario-Compare-ValueDiff: runningNetWorthSeries — null after values are skipped', () => {
  const e = {
    date:      new Date('2027-01-01'),
    action:    { type: 'X', name: 'X', data: {} },
    stateDiff: [{ field: 'account.balance', before: 100, after: null, delta: null }],
  };
  const result = runningNetWorthSeries([e]);
  assert.strictEqual(result[0], 0);   // null `after` not applied
});

test('EVT-Scenario-Compare-ValueDiff: runningNetWorthSeries — entries with no stateDiff return accumulated total', () => {
  const e1 = mkEntry('2027-01-01', 'ACT', [mkDiff('savings.balance', 0, 3000)]);
  const e2 = mkEntry('2027-01-02', 'ACT', null);   // null stateDiff
  const result = runningNetWorthSeries([e1, e2]);
  assert.strictEqual(result[1], 3000);
});

// ── journalPairKey priority tiers ─────────────────────────────────────────────

test('EVT-Scenario-Compare-ValueDiff: journalPairKey — priority 1: nodeId-based key', () => {
  const e = mkEntry('2027-01-01', 'WAGES', [], { evNodeId: 'ev-42', acNodeId: 'ac-7', personKey: 'alice' });
  const key = journalPairKey(e);
  assert.ok(key.startsWith('nid::'), `expected nid:: prefix, got ${key}`);
  assert.ok(key.includes('ev-42'), 'should include event nodeId');
  assert.ok(key.includes('ac-7'),  'should include action nodeId');
  assert.ok(key.includes('alice'), 'should include personKey scope');
});

test('EVT-Scenario-Compare-ValueDiff: journalPairKey — priority 2: type-based fallback when no nodeIds', () => {
  const e = mkEntry('2027-01-01', 'WAGES', [], { personKey: 'bob' });
  const key = journalPairKey(e);
  assert.ok(key.startsWith('typ::'), `expected typ:: prefix, got ${key}`);
  assert.ok(key.includes('WAGES'), 'should include action type');
  assert.ok(key.includes('bob'),   'should include personKey scope');
});

test('EVT-Scenario-Compare-ValueDiff: journalPairKey — same inputs produce same key', () => {
  const opts = { evNodeId: 'e1', acNodeId: 'a1', personKey: 'carol' };
  const e1 = mkEntry('2027-01-01', 'SS_APPLY', [], opts);
  const e2 = mkEntry('2027-01-02', 'SS_APPLY', [], opts);  // different date, same structural key
  assert.strictEqual(journalPairKey(e1), journalPairKey(e2));
});
