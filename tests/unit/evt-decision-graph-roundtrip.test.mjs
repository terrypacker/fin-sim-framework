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
 * EVT-Decision-Graph: serialization round-trips.
 *
 * Verifies that DecisionGraph objects survive JSON serialization and that
 * DecisionGraphStorage correctly saves and loads them.
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { DecisionGraph, DecisionPoint } from '../../src/finance/decision-graph/decision-graph-models.js';
import { DecisionGraphStorage }         from '../../src/finance/decision-graph/decision-graph-storage.js';

// ── DecisionGraph / DecisionPoint model ───────────────────────────────────

test('DecisionGraph round-trips through JSON.stringify / JSON.parse', () => {
  const dg = new DecisionGraph({
    id: 'dg:0', name: 'Test Analysis',
    baseScenarioId: 'p:intl-retirement',
    decisionPoints: [
      new DecisionPoint({
        id: 'ssAge', label: 'SS Claim Age', paramKey: 'primarySsClaimAge',
        options: [{ value: 62, label: '62' }, { value: 67, label: '67' }, { value: 70, label: '70' }],
        weights: [0.25, 0.5, 0.25],
      }),
    ],
    objective:      'finalBalance',
    mcDrawsPerLeaf: 50,
    mcSeed:         42,
  });

  const json = JSON.stringify(dg);
  const back = JSON.parse(json);

  assert.equal(back.id, 'dg:0');
  assert.equal(back.name, 'Test Analysis');
  assert.equal(back.baseScenarioId, 'p:intl-retirement');
  assert.equal(back.objective, 'finalBalance');
  assert.equal(back.mcDrawsPerLeaf, 50);
  assert.equal(back.mcSeed, 42);
  assert.equal(back.decisionPoints.length, 1);
  assert.equal(back.decisionPoints[0].id, 'ssAge');
  assert.equal(back.decisionPoints[0].paramKey, 'primarySsClaimAge');
  assert.equal(back.decisionPoints[0].options.length, 3);
  assert.equal(back.decisionPoints[0].options[1].value, 67);
  assert.deepEqual(back.decisionPoints[0].weights, [0.25, 0.5, 0.25]);
});

test('DecisionGraph.leafCount() is correct for single point', () => {
  const dg = new DecisionGraph({
    id: 'dg:1', baseScenarioId: 'x',
    decisionPoints: [
      new DecisionPoint({ id: 'a', label: 'A', paramKey: 'k', options: [{ value: 1 }, { value: 2 }, { value: 3 }] }),
    ],
  });
  assert.equal(dg.leafCount(), 3);
});

test('DecisionGraph.leafCount() is correct for 3 × 2 × 4', () => {
  const dg = new DecisionGraph({
    id: 'dg:2', baseScenarioId: 'x',
    decisionPoints: [
      new DecisionPoint({ id: 'a', label: 'A', paramKey: 'a', options: Array(3).fill({ value: 0, label: '0' }) }),
      new DecisionPoint({ id: 'b', label: 'B', paramKey: 'b', options: Array(2).fill({ value: 0, label: '0' }) }),
      new DecisionPoint({ id: 'c', label: 'C', paramKey: 'c', options: Array(4).fill({ value: 0, label: '0' }) }),
    ],
  });
  assert.equal(dg.leafCount(), 24);  // 3 × 2 × 4
});

test('DecisionGraph.leafCount() returns 1 for no decision points', () => {
  const dg = new DecisionGraph({ id: 'dg:3', baseScenarioId: 'x', decisionPoints: [] });
  assert.equal(dg.leafCount(), 1);
});

test('DecisionGraph defaults are applied when not provided', () => {
  const dg = new DecisionGraph({ id: 'dg:4', baseScenarioId: 'x' });
  assert.equal(dg.name, 'Unnamed Analysis');
  assert.equal(dg.objective, 'finalBalance');
  assert.equal(dg.mcDrawsPerLeaf, 100);
  assert.equal(dg.mcSeed, 42);
  assert.deepEqual(dg.decisionPoints, []);
});

// ── DecisionGraphStorage round-trips ─────────────────────────────────────

test('DecisionGraphStorage saves and loads a graph', () => {
  const storage = new DecisionGraphStorage(); // uses InMemoryStorage in Node

  const dg = new DecisionGraph({
    id: 'dg:0', name: 'Test', baseScenarioId: 'p:intl-retirement',
    decisionPoints: [
      new DecisionPoint({ id: 'a', label: 'A', paramKey: 'aKey', options: [{ value: 1, label: '1' }] }),
    ],
    objective: 'successRate', mcDrawsPerLeaf: 50,
  });

  storage.save({ graphs: [dg] });
  const loaded = storage.load();

  assert.equal(loaded.graphs.length, 1);
  assert.equal(loaded.graphs[0].id, 'dg:0');
  assert.equal(loaded.graphs[0].name, 'Test');
  assert.equal(loaded.graphs[0].objective, 'successRate');
  assert.equal(loaded.graphs[0].mcDrawsPerLeaf, 50);
  assert.equal(loaded.graphs[0].decisionPoints.length, 1);
  assert.equal(loaded.graphs[0].decisionPoints[0].options[0].value, 1);
});

test('DecisionGraphStorage saves and loads multiple graphs', () => {
  const storage = new DecisionGraphStorage();

  const graphs = [
    new DecisionGraph({ id: 'dg:0', name: 'First',  baseScenarioId: 'x', decisionPoints: [] }),
    new DecisionGraph({ id: 'dg:1', name: 'Second', baseScenarioId: 'y', decisionPoints: [] }),
  ];

  storage.save({ graphs });
  const loaded = storage.load();

  assert.equal(loaded.graphs.length, 2);
  assert.equal(loaded.graphs[0].name, 'First');
  assert.equal(loaded.graphs[1].name, 'Second');
});

test('DecisionGraphStorage returns empty graphs array when nothing stored', () => {
  const storage = new DecisionGraphStorage();
  const loaded = storage.load();
  assert.deepEqual(loaded, { graphs: [] });
});

test('DecisionGraphStorage overwrites previous data on save', () => {
  const storage = new DecisionGraphStorage();

  storage.save({ graphs: [new DecisionGraph({ id: 'dg:0', name: 'Old', baseScenarioId: 'x' })] });
  storage.save({ graphs: [new DecisionGraph({ id: 'dg:0', name: 'New', baseScenarioId: 'x' })] });

  const loaded = storage.load();
  assert.equal(loaded.graphs.length, 1);
  assert.equal(loaded.graphs[0].name, 'New');
});
