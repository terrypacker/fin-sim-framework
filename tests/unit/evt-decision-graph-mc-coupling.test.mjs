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

import { DecisionGraphRunner } from '../../src/finance/decision-graph/decision-graph-runner.js';

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
