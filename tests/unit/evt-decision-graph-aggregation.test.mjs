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
 * EVT-Decision-Graph: ranked and weighted-expectation aggregation.
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { DecisionGraphRunner } from '../../src/finance/decision-graph/decision-graph-runner.js';

function runner() { return new DecisionGraphRunner({}); }

function makeResult(objective, leavesData, decisionPoints = []) {
  return {
    graphId: 'dg:0',
    baseScenarioId: 'p:test',
    objective,
    decisionPoints,
    leaves: leavesData.map((d, i) => ({
      id:           `dg-leaf:${i}`,
      label:        `Leaf${i}`,
      optionVector: d.ov ?? {},
      params:       {},
      entry:        {},
      mcSummary:    { ...d },
    })),
  };
}

// ── Ranked mode ───────────────────────────────────────────────────────────

test('ranked mode: sorts by p50 descending for finalBalance objective', () => {
  const result = makeResult('finalBalance', [
    { p50: 100, successRate: 0.9 },
    { p50: 300, successRate: 0.8 },
    { p50: 200, successRate: 0.85 },
  ]);
  const ranked = runner().summarize(result, 'ranked');
  assert.equal(ranked[0].mcSummary.p50, 300);
  assert.equal(ranked[1].mcSummary.p50, 200);
  assert.equal(ranked[2].mcSummary.p50, 100);
});

test('ranked mode: sorts by successRate descending for successRate objective', () => {
  const result = makeResult('successRate', [
    { p50: 100, successRate: 0.7 },
    { p50: 300, successRate: 0.95 },
    { p50: 200, successRate: 0.8 },
  ]);
  const ranked = runner().summarize(result, 'ranked');
  assert.equal(ranked[0].mcSummary.successRate, 0.95);
  assert.equal(ranked[1].mcSummary.successRate, 0.8);
  assert.equal(ranked[2].mcSummary.successRate, 0.7);
});

test('ranked mode: sorts by -p50Deficit for cumulativeDeficit objective', () => {
  const result = makeResult('cumulativeDeficit', [
    { p50: 100, p50Deficit: 50000 },
    { p50: 100, p50Deficit: 10000 },
    { p50: 100, p50Deficit: 30000 },
  ]);
  const ranked = runner().summarize(result, 'ranked');
  // lower deficit = better = higher score (-10000 > -30000 > -50000)
  assert.equal(ranked[0].mcSummary.p50Deficit, 10000);
  assert.equal(ranked[1].mcSummary.p50Deficit, 30000);
  assert.equal(ranked[2].mcSummary.p50Deficit, 50000);
});

test('ranked mode: does not mutate the original leaves array', () => {
  const result = makeResult('finalBalance', [
    { p50: 100 }, { p50: 300 }, { p50: 200 },
  ]);
  const originalOrder = result.leaves.map(l => l.mcSummary.p50);
  runner().summarize(result, 'ranked');
  const afterOrder = result.leaves.map(l => l.mcSummary.p50);
  assert.deepEqual(afterOrder, originalOrder, 'original array should not be mutated');
});

test('ranked mode: single leaf returns that leaf', () => {
  const result = makeResult('finalBalance', [{ p50: 500 }]);
  const ranked = runner().summarize(result, 'ranked');
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].mcSummary.p50, 500);
});

test('ranked mode: empty leaves returns empty array', () => {
  const result = makeResult('finalBalance', []);
  const ranked = runner().summarize(result, 'ranked');
  assert.equal(ranked.length, 0);
});

// ── Weighted-expectation mode ─────────────────────────────────────────────

test('weightedExpectation: uniform weights give arithmetic mean', () => {
  const dp = { id: 'a', paramKey: 'aKey', options: [{ value: 1 }, { value: 2 }], weights: null };
  const result = makeResult(
    'finalBalance',
    [{ p50: 100, ov: { a: 1 } }, { p50: 300, ov: { a: 2 } }],
    [dp],
  );
  const we = runner().summarize(result, 'weightedExpectation');
  // E[x] = 0.5*100 + 0.5*300 = 200
  assert.ok(Math.abs(we.expectedValue - 200) < 0.01, `Expected 200, got ${we.expectedValue}`);
});

test('weightedExpectation: explicit weights respected', () => {
  const dp = {
    id: 'a', paramKey: 'aKey',
    options: [{ value: 1 }, { value: 2 }],
    weights: [0.3, 0.7],
  };
  const result = makeResult(
    'finalBalance',
    [{ p50: 100, ov: { a: 1 } }, { p50: 300, ov: { a: 2 } }],
    [dp],
  );
  const we = runner().summarize(result, 'weightedExpectation');
  // E[x] = 0.3*100 + 0.7*300 = 30 + 210 = 240
  assert.ok(Math.abs(we.expectedValue - 240) < 0.01, `Expected 240, got ${we.expectedValue}`);
});

test('weightedExpectation: returns normalized leaf weights summing to 1', () => {
  const dp = { id: 'a', paramKey: 'aKey', options: [{ value: 1 }, { value: 2 }, { value: 3 }], weights: null };
  const result = makeResult(
    'finalBalance',
    [{ p50: 100, ov: { a: 1 } }, { p50: 200, ov: { a: 2 } }, { p50: 300, ov: { a: 3 } }],
    [dp],
  );
  const we = runner().summarize(result, 'weightedExpectation');
  const total = we.leaves.reduce((s, l) => s + l.weight, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `Weights should sum to 1, got ${total}`);
});

test('weightedExpectation: 2×2 uniform gives product of uniform weights', () => {
  const dpA = { id: 'a', paramKey: 'aKey', options: [{ value: 1 }, { value: 2 }], weights: null };
  const dpB = { id: 'b', paramKey: 'bKey', options: [{ value: 3 }, { value: 4 }], weights: null };
  const result = makeResult(
    'finalBalance',
    [
      { p50: 100, ov: { a: 1, b: 3 } },
      { p50: 200, ov: { a: 1, b: 4 } },
      { p50: 300, ov: { a: 2, b: 3 } },
      { p50: 400, ov: { a: 2, b: 4 } },
    ],
    [dpA, dpB],
  );
  const we = runner().summarize(result, 'weightedExpectation');
  // Each leaf weight = 0.5 * 0.5 = 0.25
  // E[x] = 0.25*(100+200+300+400) = 0.25*1000 = 250
  assert.ok(Math.abs(we.expectedValue - 250) < 0.01, `Expected 250, got ${we.expectedValue}`);
  for (const l of we.leaves) {
    assert.ok(Math.abs(l.weight - 0.25) < 1e-9, `Expected weight 0.25, got ${l.weight}`);
  }
});

// ── Default mode ──────────────────────────────────────────────────────────

test('summarize defaults to ranked mode', () => {
  const result = makeResult('finalBalance', [{ p50: 100 }, { p50: 300 }]);
  const out = runner().summarize(result); // no mode arg
  assert.equal(out[0].mcSummary.p50, 300, 'default should be ranked');
});
