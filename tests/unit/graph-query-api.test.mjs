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

import { Graph }          from '../../src/graph/graph.js';
import { Edge, EDGE_TYPES } from '../../src/graph/edge.js';
import { GraphQueryApi }  from '../../src/graph/graph-query-api.js';
import { SimGraphNode }   from '../../src/graph/sim-graph-node.js';
import { EXECUTION_EDGE_TYPES } from '../../src/simulation-framework/execution-graph.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function configNode(id, kind) {
  return new SimGraphNode({ id, kind, layer: 'config', name: id });
}

function execNode(id, kind, definitionId) {
  return new SimGraphNode({ id, kind, layer: 'execution', name: id, definitionId });
}

/**
 * Build a minimal scenario graph:
 *
 *   Config layer:
 *     ev1 --HANDLED_BY--> h1 --GENERATES_ACTION--> a1 --REDUCES_ACTION--> r1
 *
 *   Execution layer (one run):
 *     ev1#1 --EXECUTES--> h1#1 --EXECUTES--> a1#1 --EXECUTES--> r1#1
 *     ev1#1 --INSTANCE_OF--> ev1
 *     h1#1  --INSTANCE_OF--> h1
 *     a1#1  --INSTANCE_OF--> a1
 *     r1#1  --INSTANCE_OF--> r1
 */
function buildGraph() {
  const g = new Graph();

  // Config nodes
  g.addNode(configNode('ev1', 'event'));
  g.addNode(configNode('h1',  'handler'));
  g.addNode(configNode('a1',  'action'));
  g.addNode(configNode('r1',  'reducer'));

  // Config edges
  g.addEdge(new Edge({ from: 'ev1', to: 'h1', type: EDGE_TYPES.HANDLED_BY }));
  g.addEdge(new Edge({ from: 'h1',  to: 'a1', type: EDGE_TYPES.GENERATES_ACTION }));
  g.addEdge(new Edge({ from: 'a1',  to: 'r1', type: EDGE_TYPES.REDUCES_ACTION }));

  // Execution nodes
  g.addNode(execNode('ev1#1', 'event',   'ev1'));
  g.addNode(execNode('h1#1',  'handler', 'h1'));
  g.addNode(execNode('a1#1',  'action',  'a1'));
  g.addNode(execNode('r1#1',  'reducer', 'r1'));

  // Execution EXECUTES edges (parent → child)
  g.addEdge(new Edge({ from: 'ev1#1', to: 'h1#1', type: EXECUTION_EDGE_TYPES.EXECUTES }));
  g.addEdge(new Edge({ from: 'h1#1',  to: 'a1#1', type: EXECUTION_EDGE_TYPES.EXECUTES }));
  g.addEdge(new Edge({ from: 'a1#1',  to: 'r1#1', type: EXECUTION_EDGE_TYPES.EXECUTES }));

  // Execution INSTANCE_OF edges (execution node → config definition)
  g.addEdge(new Edge({ from: 'ev1#1', to: 'ev1', type: EXECUTION_EDGE_TYPES.INSTANCE_OF }));
  g.addEdge(new Edge({ from: 'h1#1',  to: 'h1',  type: EXECUTION_EDGE_TYPES.INSTANCE_OF }));
  g.addEdge(new Edge({ from: 'a1#1',  to: 'a1',  type: EXECUTION_EDGE_TYPES.INSTANCE_OF }));
  g.addEdge(new Edge({ from: 'r1#1',  to: 'r1',  type: EXECUTION_EDGE_TYPES.INSTANCE_OF }));

  return g;
}

function api() {
  return new GraphQueryApi(buildGraph());
}

// ─── getDefinition ────────────────────────────────────────────────────────────

describe('GraphQueryApi.getDefinition', () => {
  test('returns config node for execution event instance', () => {
    const def = api().getDefinition('ev1#1');
    assert.ok(def, 'should return a node');
    assert.strictEqual(def.id, 'ev1');
    assert.strictEqual(def.layer, 'config');
  });

  test('returns config node for execution reducer instance', () => {
    const def = api().getDefinition('r1#1');
    assert.strictEqual(def.id, 'r1');
  });

  test('returns null for a config node (not an instance)', () => {
    assert.strictEqual(api().getDefinition('ev1'), null);
  });

  test('returns null for unknown id', () => {
    assert.strictEqual(api().getDefinition('does-not-exist'), null);
  });
});

// ─── getInstances ─────────────────────────────────────────────────────────────

describe('GraphQueryApi.getInstances', () => {
  test('returns execution instances for an event definition', () => {
    const instances = api().getInstances('ev1');
    assert.strictEqual(instances.length, 1);
    assert.strictEqual(instances[0].id, 'ev1#1');
    assert.strictEqual(instances[0].layer, 'execution');
  });

  test('returns all instances when multiple exist', () => {
    const g = buildGraph();
    // Second run: add a second event instance
    g.addNode(execNode('ev1#2', 'event', 'ev1'));
    g.addEdge(new Edge({ from: 'ev1#2', to: 'ev1', type: EXECUTION_EDGE_TYPES.INSTANCE_OF }));
    const instances = new GraphQueryApi(g).getInstances('ev1');
    assert.strictEqual(instances.length, 2);
    const ids = instances.map(n => n.id).sort();
    assert.deepStrictEqual(ids, ['ev1#1', 'ev1#2']);
  });

  test('returns empty array for unknown definition', () => {
    assert.deepStrictEqual(api().getInstances('no-such-def'), []);
  });
});

// ─── traceExecution ───────────────────────────────────────────────────────────

describe('GraphQueryApi.traceExecution', () => {
  test('returns full descendant tree from root event instance', () => {
    const chain = api().traceExecution('ev1#1');
    const ids = chain.map(n => n.id);
    assert.ok(ids.includes('ev1#1'), 'should include start node');
    assert.ok(ids.includes('h1#1'));
    assert.ok(ids.includes('a1#1'));
    assert.ok(ids.includes('r1#1'));
    assert.strictEqual(chain.length, 4);
  });

  test('returns only subtree from mid-chain node', () => {
    const chain = api().traceExecution('h1#1');
    const ids = chain.map(n => n.id);
    assert.ok(!ids.includes('ev1#1'), 'should not include parent');
    assert.ok(ids.includes('h1#1'));
    assert.ok(ids.includes('a1#1'));
    assert.ok(ids.includes('r1#1'));
  });

  test('returns just the node when it has no children', () => {
    const chain = api().traceExecution('r1#1');
    assert.strictEqual(chain.length, 1);
    assert.strictEqual(chain[0].id, 'r1#1');
  });
});

// ─── traceCausality ───────────────────────────────────────────────────────────

describe('GraphQueryApi.traceCausality', () => {
  test('returns root-first chain from a leaf reducer instance', () => {
    const chain = api().traceCausality('r1#1');
    const ids = chain.map(n => n.id);
    assert.deepStrictEqual(ids, ['ev1#1', 'h1#1', 'a1#1', 'r1#1']);
  });

  test('returns root-first chain from a mid-chain node', () => {
    const chain = api().traceCausality('h1#1');
    const ids = chain.map(n => n.id);
    assert.deepStrictEqual(ids, ['ev1#1', 'h1#1']);
  });

  test('returns just the node when it is the root', () => {
    const chain = api().traceCausality('ev1#1');
    assert.strictEqual(chain.length, 1);
    assert.strictEqual(chain[0].id, 'ev1#1');
  });
});

// ─── getConfigPath ────────────────────────────────────────────────────────────

describe('GraphQueryApi.getConfigPath', () => {
  test('returns all config nodes reachable from an event definition', () => {
    const path = api().getConfigPath('ev1');
    const ids = path.map(n => n.id).sort();
    assert.deepStrictEqual(ids, ['a1', 'ev1', 'h1', 'r1']);
  });

  test('all returned nodes are in the config layer', () => {
    const path = api().getConfigPath('ev1');
    assert.ok(path.every(n => n.layer === 'config'));
  });

  test('returns just the start node when it has no outgoing config edges', () => {
    const path = api().getConfigPath('r1');
    assert.strictEqual(path.length, 1);
    assert.strictEqual(path[0].id, 'r1');
  });
});

// ─── diffExecution ────────────────────────────────────────────────────────────

describe('GraphQueryApi.diffExecution', () => {
  test('returns no missing/extra when execution matches config exactly', () => {
    const { missing, extra } = api().diffExecution('ev1', 'r1#1');
    assert.deepStrictEqual(missing, []);
    assert.deepStrictEqual(extra,   []);
  });

  test('reports missing when a config node did not fire', () => {
    // Build a graph where the reducer never ran (no r1#1 in execution chain)
    const g = buildGraph();
    g.addNode(execNode('ev1#2', 'event',   'ev1'));
    g.addNode(execNode('h1#2',  'handler', 'h1'));
    g.addEdge(new Edge({ from: 'ev1#2', to: 'h1#2', type: EXECUTION_EDGE_TYPES.EXECUTES }));
    g.addEdge(new Edge({ from: 'ev1#2', to: 'ev1',  type: EXECUTION_EDGE_TYPES.INSTANCE_OF }));
    g.addEdge(new Edge({ from: 'h1#2',  to: 'h1',   type: EXECUTION_EDGE_TYPES.INSTANCE_OF }));

    const { missing, extra } = new GraphQueryApi(g).diffExecution('ev1', 'h1#2');
    // Config path has ev1, h1, a1, r1; execution chain has ev1, h1 → missing a1, r1
    assert.ok(missing.includes('a1'), `expected a1 in missing, got ${missing}`);
    assert.ok(missing.includes('r1'), `expected r1 in missing, got ${missing}`);
    assert.deepStrictEqual(extra, []);
  });

  test('reports extra when execution chain includes node outside config path', () => {
    // Build a graph where h1#1 somehow maps to a definition not in ev1's config path
    const g = buildGraph();
    g.addNode(configNode('x1', 'handler'));
    g.addNode(execNode('x1#1', 'handler', 'x1'));
    // Insert x1#1 into the chain: ev1#1 → x1#1
    g.addEdge(new Edge({ from: 'ev1#1', to: 'x1#1', type: EXECUTION_EDGE_TYPES.EXECUTES }));
    g.addEdge(new Edge({ from: 'x1#1',  to: 'x1',   type: EXECUTION_EDGE_TYPES.INSTANCE_OF }));

    const { extra } = new GraphQueryApi(g).diffExecution('ev1', 'x1#1');
    assert.ok(extra.includes('x1'), `expected x1 in extra, got ${extra}`);
  });
});

// ─── Incremental index maintenance via Graph observer ─────────────────────────

describe('GraphQueryApi incremental indexes', () => {
  test('addNode after first query is reflected without rebuild', () => {
    const g = new Graph();
    const q = new GraphQueryApi(g);
    // warm indexes
    assert.deepStrictEqual(q.getByKind('event'), []);
    // add after warmup
    g.addNode(configNode('ev2', 'event'));
    assert.strictEqual(q.getByKind('event').length, 1);
    assert.strictEqual(q.getByKind('event')[0].id, 'ev2');
  });

  test('removeNode is reflected in kind and layer indexes', () => {
    const g = buildGraph();
    const q = new GraphQueryApi(g);
    // warm
    assert.ok(q.getByKind('event').length > 0);
    g.removeNode('ev1');
    assert.ok(!q.getByKind('event').some(n => n.id === 'ev1'));
    assert.ok(!q.getByLayer('config').some(n => n.id === 'ev1'));
  });

  test('updateNode kind change updates kindIndex', () => {
    const g = new Graph();
    const node = configNode('n1', 'handler');
    g.addNode(node);
    const q = new GraphQueryApi(g);
    // warm
    assert.strictEqual(q.getByKind('handler').length, 1);
    assert.strictEqual(q.getByKind('event').length,   0);
    // mutate via updateNode
    const updated = { ...node, kind: 'event' };
    g.updateNode('n1', updated);
    assert.strictEqual(q.getByKind('handler').length, 0);
    assert.strictEqual(q.getByKind('event').length,   1);
  });

  test('clearLayer removes all nodes from indexes', () => {
    const g = buildGraph();
    const q = new GraphQueryApi(g);
    assert.ok(q.getByLayer('execution').length > 0);
    g.clearLayer('execution');
    assert.deepStrictEqual(q.getByLayer('execution'), []);
  });

  test('_validateIndexes raises no warnings on consistent state', () => {
    const g = buildGraph();
    const q = new GraphQueryApi(g);
    // warm, then add + remove to exercise incremental path
    q.getByKind('handler');
    g.addNode(configNode('extra', 'reducer'));
    g.removeNode('extra');
    const warns = [];
    const orig = console.warn;
    console.warn = (...args) => warns.push(args);
    q._validateIndexes();
    console.warn = orig;
    assert.strictEqual(warns.length, 0, `unexpected warnings: ${JSON.stringify(warns)}`);
  });
});
