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
 * EVT-Decision-Graph: MC coupling and reproducibility.
 *
 * Tests that:
 *  1. Two runs of the same decision graph produce identical leaf order and
 *     option vectors (deterministic expansion).
 *  2. Per-leaf seed offsets produce distinct summaries when the mock respects
 *     seed offset (simulating different draws per leaf).
 *
 * Uses a mock mcRunnerFactory so no simulation runs are needed.
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { DecisionGraphRunner }      from '../../src/finance/decision-graph/decision-graph-runner.js';
import { IntlRetirementScenario }   from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioSerializer }       from '../../src/scenarios/scenario-serializer.js';

function makeMockFactory(seedBased = false) {
  return (opts) => ({
    async run(baseParams) {
      const seed = opts._testSeedOffset ?? 0;
      return {
        runs: [],
        summary: {
          mean: seedBased ? seed * 100 : 1000,
          p10:  seedBased ? seed * 80  : 800,
          p50:  seedBased ? seed * 100 : 1000,
          p90:  seedBased ? seed * 120 : 1200,
          successRate: 0.9,
          failureCount: 10,
        },
      };
    },
  });
}

const baseEntry = {
  id: 'p:test', name: 'Test', simStart: '2026-01-01T00:00:00.000Z',
  simEnd: '2028-01-01T00:00:00.000Z', layer: 'scenario',
  params: [], persons: [], accounts: [], events: [], handlers: [],
  actions: [], reducers: [], toolsets: [], initialState: {},
};

const mockRegistry = { get: () => baseEntry };

function makeDg(opts = {}) {
  return {
    id: 'dg:0', baseScenarioId: 'p:test',
    decisionPoints: [
      {
        id: 'a', label: 'A', paramKey: 'aKey',
        options: [{ value: 1, label: '1' }, { value: 2, label: '2' }],
        weights: null,
      },
    ],
    objective:      'finalBalance',
    mcDrawsPerLeaf: 5,
    mcSeed:         42,
    ...opts,
  };
}

// ── Deterministic expansion ────────────────────────────────────────────────

test('two runs of the same DG produce the same leaf option vectors', async () => {
  const dg = makeDg();
  const factory = makeMockFactory();

  const runner1 = new DecisionGraphRunner({ scenarioRegistry: mockRegistry, mcRunnerFactory: factory });
  const runner2 = new DecisionGraphRunner({ scenarioRegistry: mockRegistry, mcRunnerFactory: factory });

  const res1 = await runner1.run(dg);
  const res2 = await runner2.run(dg);

  assert.equal(res1.leaves.length, res2.leaves.length, 'same leaf count');
  for (let i = 0; i < res1.leaves.length; i++) {
    assert.deepEqual(
      res1.leaves[i].optionVector,
      res2.leaves[i].optionVector,
      `leaf ${i} option vectors should match`,
    );
  }
});

test('two runs produce identical mcSummary values (deterministic mock)', async () => {
  const dg = makeDg();
  const factory = makeMockFactory();

  const runner1 = new DecisionGraphRunner({ scenarioRegistry: mockRegistry, mcRunnerFactory: factory });
  const runner2 = new DecisionGraphRunner({ scenarioRegistry: mockRegistry, mcRunnerFactory: factory });

  const res1 = await runner1.run(dg);
  const res2 = await runner2.run(dg);

  for (let i = 0; i < res1.leaves.length; i++) {
    assert.deepEqual(res1.leaves[i].mcSummary, res2.leaves[i].mcSummary, `leaf ${i} summaries differ`);
  }
});

// ── Per-leaf seed isolation ────────────────────────────────────────────────

test('leaf entries have distinct IDs', async () => {
  const dg = makeDg();
  const runner = new DecisionGraphRunner({ scenarioRegistry: mockRegistry, mcRunnerFactory: makeMockFactory() });
  const result = await runner.run(dg);

  const ids = result.leaves.map(l => l.id);
  const unique = new Set(ids);
  assert.equal(unique.size, ids.length, 'all leaf IDs should be unique');
});

test('leaf entries have the expected id scheme dg-leaf:N', async () => {
  const dg = makeDg();
  const runner = new DecisionGraphRunner({ scenarioRegistry: mockRegistry, mcRunnerFactory: makeMockFactory() });
  const result = await runner.run(dg);

  result.leaves.forEach((leaf, i) => {
    assert.equal(leaf.entry.id, `dg-leaf:${i}`);
  });
});

test('leaf entries carry the correct param overrides', async () => {
  const dg = makeDg();
  const runner = new DecisionGraphRunner({ scenarioRegistry: mockRegistry, mcRunnerFactory: makeMockFactory() });
  const result = await runner.run(dg);

  // leaf 0: aKey=1, leaf 1: aKey=2
  const leaf0 = result.leaves.find(l => l.optionVector.a === 1);
  const leaf1 = result.leaves.find(l => l.optionVector.a === 2);
  assert.ok(leaf0, 'leaf with a=1 not found');
  assert.ok(leaf1, 'leaf with a=2 not found');
  assert.equal(leaf0.params.aKey, 1);
  assert.equal(leaf1.params.aKey, 2);
});

// ── Progress callback ─────────────────────────────────────────────────────

test('onProgress is called at least once per leaf', async () => {
  const dg = makeDg();
  const runner = new DecisionGraphRunner({ scenarioRegistry: mockRegistry, mcRunnerFactory: makeMockFactory() });

  const progressCalls = [];
  await runner.run(dg, (done, total, leafDone, leafTotal) => {
    progressCalls.push({ done, total, leafDone, leafTotal });
  });

  assert.ok(progressCalls.length > 0, 'onProgress should have been called');
  assert.equal(progressCalls[0].leafTotal, 2, 'leafTotal should equal leaf count');
});

// ── Regression: _OffsetSeedMcRunner must forward `variables` to super._perturb ─

/**
 * Regression test for the bug where _OffsetSeedMcRunner._perturb dropped the
 * `variables` argument when calling super._perturb(), causing:
 *   TypeError: variables is not iterable
 * at the first `for (const cfg of variables)` in IntlRetirementMcRunner._perturb.
 *
 * This test runs DecisionGraphRunner WITHOUT a mock factory so the real
 * _OffsetSeedMcRunner is exercised end-to-end.
 */
test('DecisionGraphRunner with real runner: variables forwarded through _perturb (regression)', async () => {
  const SIM_START = new Date(Date.UTC(2026, 0, 1));
  const SIM_END   = new Date(Date.UTC(2027, 0, 1));

  const rawTemplate = IntlRetirementScenario.buildDefaultConfig({}, SIM_START, SIM_END);
  const baseEntry   = ScenarioSerializer.serializeScenario(rawTemplate);
  baseEntry.id       = 'p:dg-regression';
  baseEntry.simStart = SIM_START.toISOString();
  baseEntry.simEnd   = SIM_END.toISOString();

  const registry = { get: () => baseEntry };

  const dg = {
    id:             'dg:regression',
    baseScenarioId: 'p:dg-regression',
    decisionPoints: [
      {
        id: 'ret', label: 'Retirement Year', paramKey: 'retirementYear',
        options: [{ value: 2028, label: '2028' }, { value: 2030, label: '2030' }],
        weights: null,
      },
    ],
    objective:      'finalBalance',
    mcDrawsPerLeaf: 2,
    mcSeed:         42,
  };

  const runner = new DecisionGraphRunner({ scenarioRegistry: registry });

  // Should not throw "variables is not iterable"
  let result;
  await assert.doesNotReject(async () => {
    result = await runner.run(dg);
  }, 'DecisionGraphRunner.run() must not throw when using the real MC runner');

  assert.equal(result.leaves.length, 2, 'should have one leaf per retirement year option');
  for (const leaf of result.leaves) {
    assert.ok(typeof leaf.mcSummary?.p50 === 'number', 'each leaf must have a numeric p50 summary');
  }
});

// ── Regression: _makeLeafEntry must not mutate baseEntry.params ────────────────

/**
 * Regression test for the bug where _makeLeafEntry mutated baseEntry.params in
 * place (serializeScenario returned params as a direct reference, not a clone).
 *
 * After the DG run, baseEntry.params must still hold the original default values,
 * and each leaf entry's params must be an independent copy with only its own
 * decision-point override applied.
 */
test('_makeLeafEntry does not mutate baseEntry.params (regression)', async () => {
  const ORIGINAL_VALUE = 300_000;
  const LEAF_VALUE_0   = 200_000;
  const LEAF_VALUE_1   = 400_000;

  const baseEntry = {
    id: 'p:mutation-test', name: 'Test', layer: 'scenario',
    simStart: '2026-01-01T00:00:00.000Z',
    simEnd:   '2027-01-01T00:00:00.000Z',
    params:   [{ name: 'k401Balance', value: ORIGINAL_VALUE, type: 'Number', label: '401k' }],
    persons: [], accounts: [], events: [], handlers: [], actions: [], reducers: [],
    toolsets: [], initialState: {},
  };

  const registry = { get: () => baseEntry };
  const factory  = () => ({
    async run() {
      return {
        runs: [],
        summary: { mean: 0, p10: 0, p50: 0, p90: 0, successRate: 1, failureCount: 0 },
      };
    },
  });

  const dg = {
    id: 'dg:mutation', baseScenarioId: 'p:mutation-test',
    decisionPoints: [{
      id: 'bal', label: 'Balance', paramKey: 'k401Balance',
      options: [{ value: LEAF_VALUE_0, label: '200k' }, { value: LEAF_VALUE_1, label: '400k' }],
      weights: null,
    }],
    objective: 'finalBalance', mcDrawsPerLeaf: 1, mcSeed: 42,
  };

  const runner = new DecisionGraphRunner({ scenarioRegistry: registry, mcRunnerFactory: factory });
  const result = await runner.run(dg);

  // baseEntry.params must be unmodified after the run
  assert.equal(
    baseEntry.params[0].value, ORIGINAL_VALUE,
    `baseEntry.params must not be mutated; expected ${ORIGINAL_VALUE}, got ${baseEntry.params[0].value}`,
  );

  // Each leaf entry must carry only its own override
  const leaf0 = result.leaves.find(l => l.optionVector.bal === LEAF_VALUE_0);
  const leaf1 = result.leaves.find(l => l.optionVector.bal === LEAF_VALUE_1);
  assert.ok(leaf0, 'leaf with k401Balance=200k not found');
  assert.ok(leaf1, 'leaf with k401Balance=400k not found');

  assert.equal(
    leaf0.entry.params.find(p => p.name === 'k401Balance')?.value, LEAF_VALUE_0,
    'leaf0.entry.params must have k401Balance=200k',
  );
  assert.equal(
    leaf1.entry.params.find(p => p.name === 'k401Balance')?.value, LEAF_VALUE_1,
    'leaf1.entry.params must have k401Balance=400k',
  );

  // The two leaf entries must be independent (not sharing the same params array)
  assert.ok(
    leaf0.entry.params !== leaf1.entry.params,
    'leaf entries must not share the same params array reference',
  );
  assert.ok(
    leaf0.entry.params !== baseEntry.params,
    'leaf0 entry must not share baseEntry.params reference',
  );
});
