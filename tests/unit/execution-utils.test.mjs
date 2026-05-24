/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildExecutionId,
  parentIdOf,
  nodeIdOf,
  executionIndexOf,
} from '../../src/simulation-framework/execution-utils.js';

import { Simulation } from '../../src/simulation-framework/simulation.js';

// ─── buildExecutionId ─────────────────────────────────────────────────────────

describe('buildExecutionId', () => {
  test('root node (no parent) produces a single segment', () => {
    assert.strictEqual(buildExecutionId(null, 'e1', 1), 'e1.1');
  });

  test('root node second execution increments the index', () => {
    assert.strictEqual(buildExecutionId(null, 'e1', 2), 'e1.2');
  });

  test('child appends segment with colon separator', () => {
    assert.strictEqual(buildExecutionId('e1.1', 'h1', 1), 'e1.1:h1.1');
  });

  test('grandchild builds full path', () => {
    assert.strictEqual(buildExecutionId('e1.1:h1.1', 'a1', 1), 'e1.1:h1.1:a1.1');
  });

  test('great-grandchild builds four-segment path', () => {
    assert.strictEqual(buildExecutionId('e1.1:h1.1:a1.1', 'r1', 1), 'e1.1:h1.1:a1.1:r1.1');
  });

  test('second execution of same handler under same event', () => {
    assert.strictEqual(buildExecutionId('e1.1', 'h1', 2), 'e1.1:h1.2');
  });

  test('empty string parentId treated as truthy — use null for roots', () => {
    assert.strictEqual(buildExecutionId(null, 'e2', 5), 'e2.5');
  });
});

// ─── parentIdOf ───────────────────────────────────────────────────────────────

describe('parentIdOf', () => {
  test('returns null for a root segment', () => {
    assert.strictEqual(parentIdOf('e1.1'), null);
  });

  test('strips last segment from a two-segment path', () => {
    assert.strictEqual(parentIdOf('e1.1:h1.1'), 'e1.1');
  });

  test('strips last segment from a three-segment path', () => {
    assert.strictEqual(parentIdOf('e1.1:h1.1:a1.1'), 'e1.1:h1.1');
  });

  test('strips last segment from a four-segment path', () => {
    assert.strictEqual(parentIdOf('e1.1:h1.1:a1.1:r1.1'), 'e1.1:h1.1:a1.1');
  });
});

// ─── nodeIdOf ─────────────────────────────────────────────────────────────────

describe('nodeIdOf', () => {
  test('extracts config node id from a root id', () => {
    assert.strictEqual(nodeIdOf('e1.1'), 'e1');
  });

  test('extracts config node id from a deep path', () => {
    assert.strictEqual(nodeIdOf('e1.1:h2.3'), 'h2');
  });

  test('extracts config node id from a four-segment path', () => {
    assert.strictEqual(nodeIdOf('e1.1:h1.1:a1.1:r1.1'), 'r1');
  });
});

// ─── executionIndexOf ─────────────────────────────────────────────────────────

describe('executionIndexOf', () => {
  test('extracts index 1 from a root id', () => {
    assert.strictEqual(executionIndexOf('e1.1'), 1);
  });

  test('extracts index 3 from a two-segment path', () => {
    assert.strictEqual(executionIndexOf('e1.1:h2.3'), 3);
  });

  test('extracts index from the last segment of a four-segment path', () => {
    assert.strictEqual(executionIndexOf('e1.1:h1.1:a1.1:r1.7'), 7);
  });
});

// ─── Simulation._nextExecutionId / _popExecutionId / _currentExecutionId ──────

describe('Simulation execution ID helpers', () => {
  test('_nextExecutionId builds correct root id for first event', () => {
    const sim = new Simulation(new Date());
    const id = sim._nextExecutionId('e1');
    assert.strictEqual(id, 'e1.1');
  });

  test('_currentExecutionId returns the top of the stack', () => {
    const sim = new Simulation(new Date());
    sim._nextExecutionId('e1');
    assert.strictEqual(sim._currentExecutionId(), 'e1.1');
  });

  test('nested _nextExecutionId builds child path using parent as prefix', () => {
    const sim = new Simulation(new Date());
    sim._nextExecutionId('e1');           // e1.1 pushed
    const childId = sim._nextExecutionId('h1');  // e1.1:h1.1 pushed
    assert.strictEqual(childId, 'e1.1:h1.1');
  });

  test('_popExecutionId removes top of stack and returns it', () => {
    const sim = new Simulation(new Date());
    sim._nextExecutionId('e1');
    sim._nextExecutionId('h1');
    const popped = sim._popExecutionId();
    assert.strictEqual(popped, 'e1.1:h1.1');
    assert.strictEqual(sim._currentExecutionId(), 'e1.1');
  });

  test('_popExecutionId on empty stack returns null', () => {
    const sim = new Simulation(new Date());
    assert.strictEqual(sim._popExecutionId(), null);
  });

  test('_currentExecutionId on empty stack returns null', () => {
    const sim = new Simulation(new Date());
    assert.strictEqual(sim._currentExecutionId(), null);
  });

  test('second execution of same node increments its counter', () => {
    const sim = new Simulation(new Date());
    const id1 = sim._nextExecutionId('e1');
    sim._popExecutionId();
    const id2 = sim._nextExecutionId('e1');
    assert.strictEqual(id1, 'e1.1');
    assert.strictEqual(id2, 'e1.2');
  });

  test('sibling nodes under same parent get independent counters', () => {
    const sim = new Simulation(new Date());
    sim._nextExecutionId('e1');
    const h1 = sim._nextExecutionId('h1');
    sim._popExecutionId();
    const h2 = sim._nextExecutionId('h2');
    assert.strictEqual(h1, 'e1.1:h1.1');
    assert.strictEqual(h2, 'e1.1:h2.1');
  });

  test('full four-level ancestry builds correctly', () => {
    const sim = new Simulation(new Date());
    sim._nextExecutionId('e1');   // e1.1
    sim._nextExecutionId('h1');   // e1.1:h1.1
    sim._nextExecutionId('a1');   // e1.1:h1.1:a1.1
    const rId = sim._nextExecutionId('r1');  // e1.1:h1.1:a1.1:r1.1
    assert.strictEqual(rId, 'e1.1:h1.1:a1.1:r1.1');
    assert.strictEqual(parentIdOf(rId), 'e1.1:h1.1:a1.1');
    assert.strictEqual(nodeIdOf(rId), 'r1');
    assert.strictEqual(executionIndexOf(rId), 1);
  });

  test('_executionCounts and _executionStack reset on rewind', () => {
    const sim = new Simulation(new Date(2025, 0, 1));
    sim._nextExecutionId('e1');
    sim._nextExecutionId('h1');
    assert.ok(sim._executionCounts.size > 0);
    assert.ok(sim._executionStack.length > 0);

    sim.history.resetForReplay();
    assert.strictEqual(sim._executionCounts.size, 0);
    assert.strictEqual(sim._executionStack.length, 0);
  });
});
