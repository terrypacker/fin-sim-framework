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
 * EVT-Decision-Graph Phase C: persistence, weights model, CSV export.
 */

import { test }   from 'node:test';
import assert     from 'node:assert/strict';

import { DecisionGraph, DecisionPoint }      from '../../src/finance/decision-graph/decision-graph-models.js';
import { DecisionGraphResultStorage }        from '../../src/finance/decision-graph/decision-graph-result-storage.js';
import { buildDecisionGraphCsv }             from '../../src/finance/decision-graph/decision-graph-csv.js';
import { DecisionGraphRunner }               from '../../src/finance/decision-graph/decision-graph-runner.js';
import { makeLeafEntry, resolveLeafEntry }   from '../../src/finance/decision-graph/leaf-entry.js';
import { InMemoryStorage }                  from '../../src/storage/in-memory-storage.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeLeaf(i, p50, sr, optionVector = {}) {
  return {
    id:           `dg-leaf:${i}`,
    label:        `Leaf${i}`,
    optionVector,
    params:       {},
    entry:        {},
    mcSummary:    { p10: p50 * 0.7, p50, p90: p50 * 1.3, successRate: sr },
  };
}

function makeResult(dps = [], leaves = []) {
  return {
    graphId:        'dg:0',
    baseScenarioId: 'p:test',
    objective:      'finalBalance',
    decisionPoints: dps,
    leaves,
  };
}

// ── Task 9: DecisionGraph.persistLeaves model default ─────────────────────────

test('persistLeaves defaults to false', () => {
  const dg = new DecisionGraph({ id: 'dg:0', baseScenarioId: 'p:test' });
  assert.equal(dg.persistLeaves, false);
});

test('persistLeaves: true is stored when set explicitly', () => {
  const dg = new DecisionGraph({ id: 'dg:0', baseScenarioId: 'p:test', persistLeaves: true });
  assert.equal(dg.persistLeaves, true);
});

// ── Task 9: DecisionGraphResultStorage ────────────────────────────────────────

function makeStorage() {
  // Own backend per store: the default is a process-wide shared adapter, so a
  // fresh DecisionGraphResultStorage no longer implies fresh state.
  return new DecisionGraphResultStorage(new InMemoryStorage());
}

test('ResultStorage: loadResult returns null for unknown id', () => {
  const s = makeStorage();
  assert.equal(s.loadResult('dg:99'), null);
});

test('ResultStorage: saveResult then loadResult round-trips', () => {
  const s = makeStorage();
  const result = { graphId: 'dg:0', leaves: [{ id: 'dg-leaf:0' }] };
  s.saveResult('dg:0', result);
  const loaded = s.loadResult('dg:0');
  assert.deepEqual(loaded, result);
});

test('ResultStorage: multiple ids stored independently', () => {
  const s = makeStorage();
  s.saveResult('dg:0', { v: 1 });
  s.saveResult('dg:1', { v: 2 });
  assert.equal(s.loadResult('dg:0').v, 1);
  assert.equal(s.loadResult('dg:1').v, 2);
});

test('ResultStorage: overwriting a result replaces the previous', () => {
  const s = makeStorage();
  s.saveResult('dg:0', { v: 'old' });
  s.saveResult('dg:0', { v: 'new' });
  assert.equal(s.loadResult('dg:0').v, 'new');
});

test('ResultStorage: clearResult removes the entry', () => {
  const s = makeStorage();
  s.saveResult('dg:0', { v: 1 });
  s.clearResult('dg:0');
  assert.equal(s.loadResult('dg:0'), null);
});

test('ResultStorage: clearResult on unknown id is a no-op', () => {
  const s = makeStorage();
  s.clearResult('dg:99');
  assert.equal(s.loadResult('dg:99'), null);
});

// ── Task 10: DecisionPoint.weights model default ──────────────────────────────

test('DecisionPoint.weights defaults to null', () => {
  const dp = new DecisionPoint({ id: 'ss', label: 'SS age', paramKey: 'ssAge', options: [] });
  assert.equal(dp.weights, null);
});

test('DecisionPoint.weights is stored when set', () => {
  const dp = new DecisionPoint({
    id: 'ss', label: 'SS age', paramKey: 'ssAge',
    options: [{ value: 62 }, { value: 67 }],
    weights: [0.3, 0.7],
  });
  assert.deepEqual(dp.weights, [0.3, 0.7]);
});

// ── Task 10: Weighted expectation respects DecisionPoint.weights ──────────────

test('weightedExpectation uses DecisionPoint.weights when set', () => {
  const dp = new DecisionPoint({
    id: 'age', label: 'Age', paramKey: 'age',
    options: [{ value: 62 }, { value: 67 }, { value: 70 }],
    weights: [0.2, 0.5, 0.3],
  });
  const leaves = [
    makeLeaf(0, 1000, 0.9, { age: 62 }),
    makeLeaf(1, 2000, 0.9, { age: 67 }),
    makeLeaf(2, 3000, 0.9, { age: 70 }),
  ];
  const result = makeResult([dp], leaves);
  const runner = new DecisionGraphRunner({});
  const we = runner.summarize(result, 'weightedExpectation');
  // E = 0.2*1000 + 0.5*2000 + 0.3*3000 = 200 + 1000 + 900 = 2100
  assert.ok(Math.abs(we.expectedValue - 2100) < 0.01, `Expected 2100, got ${we.expectedValue}`);
});

// ── Task 11: buildDecisionGraphCsv ────────────────────────────────────────────

test('CSV: empty ranked returns empty string', () => {
  const result = makeResult([], []);
  assert.equal(buildDecisionGraphCsv(result, []), '');
});

test('CSV: header row contains Rank, DP labels, and metric columns', () => {
  const dp  = new DecisionPoint({ id: 'ss', label: 'SS Age', paramKey: 'ssAge', options: [] });
  const result = makeResult([dp], []);
  const leaf = makeLeaf(0, 1500000, 0.88, { ss: 67 });
  const csv  = buildDecisionGraphCsv(result, [leaf]);
  const [header] = csv.split('\n');
  assert.ok(header.includes('Rank'),         'header has Rank');
  assert.ok(header.includes('SS Age'),       'header has DP label');
  assert.ok(header.includes('P10'),          'header has P10');
  assert.ok(header.includes('P50'),          'header has P50');
  assert.ok(header.includes('P90'),          'header has P90');
  assert.ok(header.includes('Success Rate'), 'header has Success Rate');
});

test('CSV: first data row rank is 1', () => {
  const result = makeResult([], [makeLeaf(0, 2000000, 0.9)]);
  const csv = buildDecisionGraphCsv(result, result.leaves);
  const [, dataRow] = csv.split('\n');
  assert.ok(dataRow.startsWith('1,'), `First data row should start with rank 1, got: ${dataRow}`);
});

test('CSV: decision-point option labels appear in the data rows', () => {
  const dp = new DecisionPoint({
    id: 'ss', label: 'SS Age', paramKey: 'ssAge',
    options: [{ value: 62, label: '62' }, { value: 67, label: '67' }],
  });
  const leaf0 = makeLeaf(0, 2000000, 0.9, { ss: 62 });
  const leaf1 = makeLeaf(1, 1800000, 0.85, { ss: 67 });
  const result = makeResult([dp], [leaf0, leaf1]);
  const ranked = new DecisionGraphRunner({}).summarize(result, 'ranked');
  const csv = buildDecisionGraphCsv(result, ranked);
  const rows = csv.split('\n');
  assert.ok(rows[1].includes('62') || rows[1].includes('67'), 'data row has option label');
});

test('CSV: success rate is formatted as percentage', () => {
  const result = makeResult([], [makeLeaf(0, 1000, 0.875)]);
  const csv = buildDecisionGraphCsv(result, result.leaves);
  const [, row] = csv.split('\n');
  assert.ok(row.includes('87.5%'), `Expected 87.5%, row: ${row}`);
});

test('CSV: RFC 4180 — values with commas are quoted', () => {
  const dp = new DecisionPoint({
    id: 'x', label: 'Choice, A or B', paramKey: 'x',
    options: [{ value: 1, label: 'A, large' }],
  });
  const leaf = makeLeaf(0, 1000, 0.9, { x: 1 });
  const result = makeResult([dp], [leaf]);
  const csv = buildDecisionGraphCsv(result, [leaf]);
  assert.ok(csv.includes('"Choice, A or B"'), 'DP label with comma is quoted');
  assert.ok(csv.includes('"A, large"'),        'option label with comma is quoted');
});

test('CSV: RFC 4180 — values with double-quotes are escaped', () => {
  const dp = new DecisionPoint({
    id: 'x', label: 'The "best" choice', paramKey: 'x',
    options: [{ value: 1, label: '1' }],
  });
  const leaf = makeLeaf(0, 1000, 0.9, { x: 1 });
  const result = makeResult([dp], [leaf]);
  const csv = buildDecisionGraphCsv(result, [leaf]);
  assert.ok(csv.includes('"The ""best"" choice"'), 'double-quotes are escaped');
});

test('CSV: null result.decisionPoints treated as no DP columns', () => {
  const result = { graphId: 'dg:0', objective: 'finalBalance', decisionPoints: null, leaves: [] };
  const leaf = makeLeaf(0, 1000, 0.9);
  const csv = buildDecisionGraphCsv(result, [leaf]);
  const [header] = csv.split('\n');
  // Should have Rank, P10, P50, P90, Success Rate — no DP columns
  assert.equal(header, 'Rank,P10,P50,P90,Success Rate');
});

test('CSV: multiple leaves ranked correctly — best leaf is rank 1', () => {
  const result = makeResult([], [
    makeLeaf(0, 500000,  0.8),
    makeLeaf(1, 2000000, 0.95),
    makeLeaf(2, 1000000, 0.88),
  ]);
  const runner = new DecisionGraphRunner({});
  const ranked = runner.summarize(result, 'ranked');
  const csv = buildDecisionGraphCsv(result, ranked);
  const rows = csv.split('\n');
  // Row 1 (rank 1) should have p50 = 2000000 → rounded = 2000000
  assert.ok(rows[1].startsWith('1,'), `rank 1 row: ${rows[1]}`);
  assert.ok(rows[1].includes('2000000'), `rank 1 row has p50=2000000: ${rows[1]}`);
});

// ── Leaf-entry stripping: persisted results must not carry serialized scenarios ─
//
// A leaf entry is a full serialized scenario (~350 KB in production), so a
// 50-leaf result would persist ~17 MB — enough to blow the localStorage quota on
// its own. saveResult drops them; resolveLeafEntry rebuilds on demand.

function makeBaseEntry() {
  return {
    id: 'p:strip-test', name: 'Base', layer: 'scenario',
    simStart: '2026-01-01T00:00:00.000Z',
    simEnd:   '2027-01-01T00:00:00.000Z',
    params:   [{ name: 'k401Balance', value: 300_000, type: 'Number', label: '401k' }],
    persons: [], accounts: [], events: [], handlers: [], actions: [], reducers: [],
    toolsets: [], initialState: {},
  };
}

/** Run a 2-leaf DG with a stubbed MC runner; returns { result, baseEntry }. */
async function runTwoLeafDg() {
  const baseEntry = makeBaseEntry();
  const runner = new DecisionGraphRunner({
    scenarioRegistry: { get: () => baseEntry },
    mcRunnerFactory:  () => ({
      async run() {
        return { runs: [], summary: { mean: 0, p10: 0, p50: 0, p90: 0, successRate: 1, failureCount: 0 } };
      },
    }),
  });
  const result = await runner.run({
    id: 'dg:strip', baseScenarioId: 'p:strip-test',
    decisionPoints: [{
      id: 'bal', label: 'Balance', paramKey: 'k401Balance',
      options: [{ value: 200_000, label: '200k' }, { value: 400_000, label: '400k' }],
      weights: null,
    }],
    objective: 'finalBalance', mcDrawsPerLeaf: 1, mcSeed: 42,
  });
  return { result, baseEntry };
}

test('stripLeafEntries removes entry from every leaf', () => {
  const result = makeResult([], [makeLeaf(0, 100, 1), makeLeaf(1, 200, 1)]);
  const stripped = DecisionGraphResultStorage.stripLeafEntries(result);

  assert.equal(stripped.leaves.length, 2);
  for (const leaf of stripped.leaves) {
    assert.ok(!('entry' in leaf), 'persisted leaf must not carry an entry');
  }
  // Everything needed to rebuild survives.
  assert.equal(stripped.baseScenarioId, 'p:test');
  assert.deepEqual(stripped.leaves.map(l => l.id), ['dg-leaf:0', 'dg-leaf:1']);
  assert.deepEqual(stripped.leaves.map(l => l.params), [{}, {}]);
  // The input is not mutated.
  assert.ok('entry' in result.leaves[0], 'stripLeafEntries must not mutate its input');
});

test('stripLeafEntries leaves an entry-less result deep-equal to the original', () => {
  const result = { graphId: 'dg:0', leaves: [{ id: 'dg-leaf:0' }] };
  assert.deepEqual(DecisionGraphResultStorage.stripLeafEntries(result), result);
});

test('stripLeafEntries passes through a result with no leaves array', () => {
  assert.deepEqual(DecisionGraphResultStorage.stripLeafEntries({ v: 1 }), { v: 1 });
  assert.equal(DecisionGraphResultStorage.stripLeafEntries(null), null);
});

test('ResultStorage: saveResult strips leaf entries', () => {
  const s = makeStorage();
  s.saveResult('dg:0', makeResult([], [makeLeaf(0, 100, 1)]));
  const loaded = s.loadResult('dg:0');
  assert.ok(!('entry' in loaded.leaves[0]), 'loaded leaf must not carry an entry');
});

test('resolveLeafEntry returns the inline entry when present', () => {
  const inline = { id: 'dg-leaf:0' };
  assert.equal(resolveLeafEntry({ id: 'dg-leaf:0', entry: inline }, makeBaseEntry()), inline);
});

test('resolveLeafEntry returns null when the entry is absent and no baseEntry is given', () => {
  assert.equal(resolveLeafEntry({ id: 'dg-leaf:0', params: {} }, null), null);
  assert.equal(resolveLeafEntry(null, makeBaseEntry()), null);
});

test('a rebuilt leaf entry is identical to the one the runner produced', async () => {
  const { result, baseEntry } = await runTwoLeafDg();

  // This is the invariant the whole optimization rests on: dropping `entry` at
  // save time loses nothing, because it is fully derivable from what remains.
  for (const leaf of result.leaves) {
    const rebuilt = makeLeafEntry(baseEntry, leaf, leaf.id);
    assert.deepEqual(rebuilt, leaf.entry,
      `rebuilt entry for ${leaf.id} must equal the runner's inline entry`);
  }
});

test('leaf entries survive a full save → load → resolve round-trip', async () => {
  const { result, baseEntry } = await runTwoLeafDg();
  const original = result.leaves.map(l => l.entry);

  const s = makeStorage();
  s.saveResult('dg:strip', result);
  const loaded = s.loadResult('dg:strip');

  loaded.leaves.forEach((leaf, i) => {
    assert.ok(!('entry' in leaf), 'stored leaf must not carry an entry');
    assert.deepEqual(resolveLeafEntry(leaf, baseEntry), original[i],
      `resolved entry for ${leaf.id} must equal the pre-save entry`);
  });
});

test('stripping a leaf entry is a large saving on the persisted payload', async () => {
  const { result } = await runTwoLeafDg();
  const full     = JSON.stringify(result).length;
  const stripped = JSON.stringify(DecisionGraphResultStorage.stripLeafEntries(result)).length;
  assert.ok(stripped < full / 2,
    `stripped payload (${stripped}) should be well under half of full (${full})`);
});
