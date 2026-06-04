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
 * EVT-Decision-Graph: pruning guards.
 *
 * > 100 leaves → warning.
 * > 1000 leaves → throws unless allowLargeGraph = true.
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { DecisionGraphRunner } from '../../src/finance/decision-graph/decision-graph-runner.js';

function runner() { return new DecisionGraphRunner({}); }

// ── Warning threshold ─────────────────────────────────────────────────────

test('_validateLeafCount: exactly 100 leaves → no warning', () => {
  let warned = false;
  const orig = console.warn;
  console.warn = () => { warned = true; };
  try {
    runner()._validateLeafCount(100);
  } finally {
    console.warn = orig;
  }
  assert.ok(!warned, 'should not warn for exactly 100 leaves');
});

test('_validateLeafCount: 101 leaves → emits warning', () => {
  let warned = false;
  const orig = console.warn;
  console.warn = (msg) => { if (String(msg).includes('101')) warned = true; };
  try {
    runner()._validateLeafCount(101);
  } finally {
    console.warn = orig;
  }
  assert.ok(warned, 'should warn for 101 leaves');
});

test('_validateLeafCount: 999 leaves → only warning, no throw', () => {
  const orig = console.warn;
  console.warn = () => {};
  try {
    assert.doesNotThrow(() => runner()._validateLeafCount(999));
  } finally {
    console.warn = orig;
  }
});

// ── Error threshold ───────────────────────────────────────────────────────

test('_validateLeafCount: exactly 1000 leaves → no throw', () => {
  const orig = console.warn;
  console.warn = () => {};
  try {
    assert.doesNotThrow(() => runner()._validateLeafCount(1000));
  } finally {
    console.warn = orig;
  }
});

test('_validateLeafCount: 1001 leaves → throws', () => {
  const orig = console.warn;
  console.warn = () => {};
  try {
    assert.throws(
      () => runner()._validateLeafCount(1001),
      /exceeds maximum/,
    );
  } finally {
    console.warn = orig;
  }
});

test('_validateLeafCount: 1001 leaves with allowLargeGraph → does not throw', () => {
  const orig = console.warn;
  console.warn = () => {};
  try {
    assert.doesNotThrow(() => runner()._validateLeafCount(1001, true));
  } finally {
    console.warn = orig;
  }
});

test('_validateLeafCount: 10000 leaves with allowLargeGraph → does not throw', () => {
  const orig = console.warn;
  console.warn = () => {};
  try {
    assert.doesNotThrow(() => runner()._validateLeafCount(10000, true));
  } finally {
    console.warn = orig;
  }
});

// ── Integration with run() ────────────────────────────────────────────────

test('run() throws for a DG that expands to > 1000 leaves', async () => {
  // 6 × 6 × 6 × 6 = 1296 leaves → should throw
  const dp = (id) => ({
    id, label: id, paramKey: id,
    options: [0, 1, 2, 3, 4, 5].map(v => ({ value: v, label: String(v) })),
    weights: null,
  });
  const dg = {
    id: 'dg:big', baseScenarioId: 'p:test',
    decisionPoints: [dp('a'), dp('b'), dp('c'), dp('d')],
    objective: 'finalBalance', mcDrawsPerLeaf: 1, mcSeed: 1,
  };
  const baseEntry = {
    id: 'p:test', name: 'T', simStart: '2026-01-01T00:00:00.000Z',
    simEnd: '2028-01-01T00:00:00.000Z', layer: 'scenario',
    params: [], persons: [], accounts: [], events: [], handlers: [],
    actions: [], reducers: [], toolsets: [], initialState: {},
  };
  const r = new DecisionGraphRunner({
    scenarioRegistry: { get: () => baseEntry },
    mcRunnerFactory: () => ({ async run() { return { runs: [], summary: {} }; } }),
  });
  const orig = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(async () => r.run(dg), /exceeds maximum/);
  } finally {
    console.warn = orig;
  }
});
