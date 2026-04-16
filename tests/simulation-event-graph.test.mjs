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
 * simulation-event-graph.test.mjs
 * Tests for SimulationEventGraph and ActionNode
 * Run with: node --test tests/simulation-event-graph.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import {
  SimulationEventGraph,
  ActionNode
} from '../assets/js/simulation-framework/simulation-event-graph.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let nextId = 0;

function makeNode(overrides = {}) {
  const id = overrides.id ?? nextId++;
  return new ActionNode({
    id,
    type:        overrides.type        ?? 'ACTION',
    date:        overrides.date        ?? new Date(2025, 0, 1),
    parent:      overrides.parent      ?? null,
    children:    overrides.children    ?? [],
    action:      overrides.action      ?? { type: 'ACTION' },
    reducer:     overrides.reducer     ?? 'anonymous',
    stateBefore: overrides.stateBefore ?? null,
    stateAfter:  overrides.stateAfter  ?? {},
    sourceEvent: overrides.sourceEvent ?? {}
  });
}

// ─── ActionNode construction ──────────────────────────────────────────────────

test('ActionNode: all fields are assigned from constructor', () => {
  const date   = new Date(2025, 3, 1);
  const action = { type: 'FOO', amount: 5 };
  const before = { counter: 0 };
  const after  = { counter: 5 };
  const src    = { type: 'SOURCE' };

  const node = new ActionNode({
    id: 7, type: 'FOO', date,
    parent: 3, children: [8, 9],
    action, reducer: 'R', stateBefore: before, stateAfter: after, sourceEvent: src
  });

  assert.strictEqual(node.id,          7);
  assert.strictEqual(node.type,        'FOO');
  assert.strictEqual(node.date,        date);
  assert.strictEqual(node.parent,      3);
  assert.deepStrictEqual(node.children, [8, 9]);
  assert.strictEqual(node.action,      action);
  assert.strictEqual(node.reducer,     'R');
  assert.strictEqual(node.stateBefore, before);
  assert.strictEqual(node.stateAfter,  after);
  assert.strictEqual(node.sourceEvent, src);
});

// ─── addActionNode ────────────────────────────────────────────────────────────

test('SimulationEventGraph: addActionNode stores node by id', () => {
  const g    = new SimulationEventGraph();
  const node = makeNode({ id: 0 });

  g.addActionNode(node);
  assert.strictEqual(g.getNode(0), node);
});

test('SimulationEventGraph: addActionNode with null parent does not crash', () => {
  const g    = new SimulationEventGraph();
  const node = makeNode({ id: 0, parent: null });

  assert.doesNotThrow(() => g.addActionNode(node));
});

test('SimulationEventGraph: addActionNode links child id into parent.children', () => {
  const g      = new SimulationEventGraph();
  const parent = makeNode({ id: 0 });
  const child  = makeNode({ id: 1, parent: 0 });

  g.addActionNode(parent);
  g.addActionNode(child);

  assert.ok(parent.children.includes(1), 'parent.children should contain child id');
});

test('SimulationEventGraph: child with non-existent parent id does not crash', () => {
  const g    = new SimulationEventGraph();
  const node = makeNode({ id: 5, parent: 999 }); // 999 never added

  assert.doesNotThrow(() => g.addActionNode(node));
});

test('SimulationEventGraph: multiple children are all linked to parent', () => {
  const g      = new SimulationEventGraph();
  const parent = makeNode({ id: 0 });
  const c1     = makeNode({ id: 1, parent: 0 });
  const c2     = makeNode({ id: 2, parent: 0 });
  const c3     = makeNode({ id: 3, parent: 0 });

  g.addActionNode(parent);
  g.addActionNode(c1);
  g.addActionNode(c2);
  g.addActionNode(c3);

  assert.deepStrictEqual(parent.children, [1, 2, 3]);
});

// ─── getNode ──────────────────────────────────────────────────────────────────

test('SimulationEventGraph.getNode: returns correct node for a known id', () => {
  const g    = new SimulationEventGraph();
  const node = makeNode({ id: 42, type: 'SPECIAL' });

  g.addActionNode(node);
  const retrieved = g.getNode(42);

  assert.strictEqual(retrieved, node);
  assert.strictEqual(retrieved.type, 'SPECIAL');
});

test('SimulationEventGraph.getNode: returns undefined for unknown id', () => {
  const g = new SimulationEventGraph();
  assert.strictEqual(g.getNode(999), undefined);
});

// ─── getRootActions ───────────────────────────────────────────────────────────

test('SimulationEventGraph.getRootActions: returns nodes with parent === null', () => {
  const g    = new SimulationEventGraph();
  const root = makeNode({ id: 0, parent: null  });
  const child = makeNode({ id: 1, parent: 0    });

  g.addActionNode(root);
  g.addActionNode(child);

  const roots = g.getRootActions();
  assert.strictEqual(roots.length, 1);
  assert.strictEqual(roots[0], root);
});

test('SimulationEventGraph.getRootActions: multiple roots when no nodes share parents', () => {
  const g  = new SimulationEventGraph();
  const r1 = makeNode({ id: 0, parent: null });
  const r2 = makeNode({ id: 1, parent: null });
  const r3 = makeNode({ id: 2, parent: null });

  g.addActionNode(r1);
  g.addActionNode(r2);
  g.addActionNode(r3);

  assert.strictEqual(g.getRootActions().length, 3);
});

test('SimulationEventGraph.getRootActions: returns empty array on empty graph', () => {
  const g = new SimulationEventGraph();
  assert.deepStrictEqual(g.getRootActions(), []);
});

// ─── traceActionChain ─────────────────────────────────────────────────────────

test('SimulationEventGraph.traceActionChain: returns single node for leaf', () => {
  const g    = new SimulationEventGraph();
  const node = makeNode({ id: 0 });

  g.addActionNode(node);
  const chain = g.traceActionChain(0);

  assert.strictEqual(chain.length, 1);
  assert.strictEqual(chain[0], node);
});

test('SimulationEventGraph.traceActionChain: returns DFS order for a linear chain', () => {
  const g  = new SimulationEventGraph();
  const n0 = makeNode({ id: 0, type: 'ROOT',  parent: null });
  const n1 = makeNode({ id: 1, type: 'CHILD', parent: 0   });
  const n2 = makeNode({ id: 2, type: 'LEAF',  parent: 1   });

  g.addActionNode(n0);
  g.addActionNode(n1);
  g.addActionNode(n2);

  const chain = g.traceActionChain(0);
  const types = chain.map(n => n.type);

  assert.deepStrictEqual(types, ['ROOT', 'CHILD', 'LEAF']);
});

test('SimulationEventGraph.traceActionChain: visits all branches depth-first', () => {
  //   ROOT
  //   ├── LEFT
  //   └── RIGHT
  const g     = new SimulationEventGraph();
  const root  = makeNode({ id: 0, type: 'ROOT',  parent: null });
  const left  = makeNode({ id: 1, type: 'LEFT',  parent: 0   });
  const right = makeNode({ id: 2, type: 'RIGHT', parent: 0   });

  g.addActionNode(root);
  g.addActionNode(left);
  g.addActionNode(right);

  const chain = g.traceActionChain(0);
  const types = chain.map(n => n.type);

  assert.ok(types.includes('ROOT'),  'chain should include ROOT');
  assert.ok(types.includes('LEFT'),  'chain should include LEFT');
  assert.ok(types.includes('RIGHT'), 'chain should include RIGHT');
  assert.strictEqual(chain.length, 3);
  assert.strictEqual(types[0], 'ROOT', 'ROOT should be first');
});

test('SimulationEventGraph.traceActionChain: returns empty array for unknown id', () => {
  const g = new SimulationEventGraph();
  assert.deepStrictEqual(g.traceActionChain(999), []);
});

// ─── traceActionsUp ───────────────────────────────────────────────────────────

test('SimulationEventGraph.traceActionsUp: single root returns array with that node', () => {
  const g    = new SimulationEventGraph();
  const node = makeNode({ id: 0, parent: null });

  g.addActionNode(node);
  const chain = g.traceActionsUp(0);

  assert.strictEqual(chain.length, 1);
  assert.strictEqual(chain[0], node);
});

test('SimulationEventGraph.traceActionsUp: returns root-to-leaf order', () => {
  const g  = new SimulationEventGraph();
  const r  = makeNode({ id: 0, type: 'ROOT',  parent: null });
  const m  = makeNode({ id: 1, type: 'MID',   parent: 0   });
  const l  = makeNode({ id: 2, type: 'LEAF',  parent: 1   });

  g.addActionNode(r);
  g.addActionNode(m);
  g.addActionNode(l);

  // Called on the leaf; should walk up and reverse to root-first
  const chain = g.traceActionsUp(2);
  const types = chain.map(n => n.type);

  assert.deepStrictEqual(types, ['ROOT', 'MID', 'LEAF']);
});

test('SimulationEventGraph.traceActionsUp: returns empty array for unknown id', () => {
  const g = new SimulationEventGraph();
  assert.deepStrictEqual(g.traceActionsUp(999), []);
});
