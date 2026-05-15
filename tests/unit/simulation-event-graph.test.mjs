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
 * Tests for ExecutionGraph and GraphRecorder (Phase 6)
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Graph }          from '../../src/graph/graph.js';
import { ExecutionGraph, EXECUTION_EDGE_TYPES } from '../../src/simulation-framework/execution-graph.js';
import { GraphRecorder }  from '../../src/simulation-framework/graph-recorder.js';

function makeGraph() {
  return new ExecutionGraph(new Graph());
}

// ─── ExecutionGraph: addNode / getNode ───────────────────────────────────────

test('ExecutionGraph: addNode stores node and getNode retrieves it', () => {
  const eg   = makeGraph();
  const node = { id: 'n1', kind: 'event', layer: 'execution', name: 'ANNUAL', definitionId: null };

  eg.addNode(node);
  assert.strictEqual(eg.getNode('n1'), node);
});

test('ExecutionGraph: getExecutionNodes returns only execution-layer nodes', () => {
  const eg = makeGraph();
  eg.addNode({ id: 'cfg', layer: 'config',    kind: 'event', name: 'DEF' });
  eg.addNode({ id: 'run', layer: 'execution', kind: 'event', name: 'RUN' });

  const execNodes = eg.getExecutionNodes();
  assert.strictEqual(execNodes.length, 1);
  assert.strictEqual(execNodes[0].id, 'run');
});

// ─── ExecutionGraph: addEdge / getChildren / getParent ───────────────────────

test('ExecutionGraph: addEdge links parent→child via EXECUTES', () => {
  const eg = makeGraph();
  eg.addNode({ id: 'p', layer: 'execution', kind: 'event',   name: 'P' });
  eg.addNode({ id: 'c', layer: 'execution', kind: 'handler', name: 'C' });

  eg.addEdge('p', 'c', EXECUTION_EDGE_TYPES.EXECUTES);

  const children = eg.getChildren('p');
  assert.strictEqual(children.length, 1);
  assert.strictEqual(children[0].id, 'c');
});

test('ExecutionGraph: getParent returns parent node via EXECUTES edge', () => {
  const eg = makeGraph();
  eg.addNode({ id: 'p', layer: 'execution', kind: 'event',   name: 'P' });
  eg.addNode({ id: 'c', layer: 'execution', kind: 'handler', name: 'C' });
  eg.addEdge('p', 'c', EXECUTION_EDGE_TYPES.EXECUTES);

  assert.strictEqual(eg.getParent('c').id, 'p');
  assert.strictEqual(eg.getParent('p'), null);
});

test('ExecutionGraph: getDefinition returns config node via INSTANCE_OF edge', () => {
  const eg = makeGraph();
  eg.addNode({ id: 'def',  layer: 'config',    kind: 'event', name: 'DEF' });
  eg.addNode({ id: 'inst', layer: 'execution', kind: 'event', name: 'RUN' });
  eg.addEdge('inst', 'def', EXECUTION_EDGE_TYPES.INSTANCE_OF);

  assert.strictEqual(eg.getDefinition('inst').id, 'def');
});

test('ExecutionGraph: addEdge with missing node returns null (no crash)', () => {
  const eg = makeGraph();
  eg.addNode({ id: 'p', layer: 'execution', kind: 'event', name: 'P' });
  assert.strictEqual(eg.addEdge('p', 'missing', EXECUTION_EDGE_TYPES.EXECUTES), null);
});

// ─── ExecutionGraph: traceUp ─────────────────────────────────────────────────

test('ExecutionGraph: traceUp returns root-to-leaf ancestry', () => {
  const eg = makeGraph();
  eg.addNode({ id: 'e', layer: 'execution', kind: 'event',   name: 'E' });
  eg.addNode({ id: 'h', layer: 'execution', kind: 'handler', name: 'H' });
  eg.addNode({ id: 'a', layer: 'execution', kind: 'action',  name: 'A' });
  eg.addEdge('e', 'h', EXECUTION_EDGE_TYPES.EXECUTES);
  eg.addEdge('h', 'a', EXECUTION_EDGE_TYPES.EXECUTES);

  const chain = eg.traceUp('a');
  assert.deepStrictEqual(chain.map(n => n.id), ['e', 'h', 'a']);
});

// ─── GraphRecorder: beginNode / endNode ──────────────────────────────────────

test('GraphRecorder: beginNode returns a UUID and stores the node', () => {
  const gr  = new GraphRecorder(makeGraph());
  const id  = gr.beginNode({ kind: 'event', name: 'ANNUAL', definitionId: null, parentNodeId: null, date: new Date() });

  assert.ok(typeof id === 'string' && id.length > 0, 'should return non-empty UUID');
  assert.ok(gr._eg.getNode(id), 'node should be in graph');
});

test('GraphRecorder: beginNode with explicit uuid uses it as node id', () => {
  const gr  = new GraphRecorder(makeGraph());
  const uuid = crypto.randomUUID();
  const id   = gr.beginNode({ uuid, kind: 'action', name: 'SELL', definitionId: null, parentNodeId: null, date: new Date() });

  assert.strictEqual(id, uuid);
  assert.ok(gr._eg.getNode(uuid));
});

test('GraphRecorder: beginNode adds EXECUTES edge from parent', () => {
  const gr     = new GraphRecorder(makeGraph());
  const evtId  = gr.beginNode({ kind: 'event',   name: 'E', definitionId: null, parentNodeId: null, date: new Date() });
  const hndId  = gr.beginNode({ kind: 'handler', name: 'H', definitionId: null, parentNodeId: evtId, date: new Date() });

  const children = gr._eg.getChildren(evtId);
  assert.strictEqual(children.length, 1);
  assert.strictEqual(children[0].id, hndId);
});

test('GraphRecorder: beginNode adds INSTANCE_OF edge when definitionId exists', () => {
  const eg  = makeGraph();
  eg.addNode({ id: 'e1', layer: 'config', kind: 'event', name: 'DEF' });
  const gr  = new GraphRecorder(eg);

  const runId = gr.beginNode({ kind: 'event', name: 'E', definitionId: 'e1', parentNodeId: null, date: new Date() });

  assert.strictEqual(gr._eg.getDefinition(runId)?.id, 'e1');
});

test('GraphRecorder: endNode updates stateDiff on the node', () => {
  const gr    = new GraphRecorder(makeGraph());
  const id    = gr.beginNode({ kind: 'reducer', name: 'R', definitionId: null, parentNodeId: null, date: new Date() });
  const diff  = [{ field: 'cash', before: 100, after: 200, delta: 100 }];

  gr.endNode(id, { stateDiff: diff });

  const node = gr._eg.getNode(id);
  assert.deepStrictEqual(node.meta.stateDiff, diff);
});

// ─── GraphRecorder: getCurrentNodeId / stack ─────────────────────────────────

test('GraphRecorder: getCurrentNodeId returns innermost open node', () => {
  const gr  = new GraphRecorder(makeGraph());
  const id1 = gr.beginNode({ kind: 'event',  name: 'E', definitionId: null, parentNodeId: null, date: new Date() });
  const id2 = gr.beginNode({ kind: 'action', name: 'A', definitionId: null, parentNodeId: id1,  date: new Date() });

  assert.strictEqual(gr.getCurrentNodeId(), id2);
  gr.endNode(id2);
  assert.strictEqual(gr.getCurrentNodeId(), id1);
  gr.endNode(id1);
  assert.strictEqual(gr.getCurrentNodeId(), null);
});

// ─── GraphRecorder: SCHEDULES deferred resolution ────────────────────────────

test('GraphRecorder: resolvePendingSchedules adds SCHEDULES edge', () => {
  const gr   = new GraphRecorder(makeGraph());
  const evtA = gr.beginNode({ kind: 'event', name: 'TRIGGER', definitionId: null, parentNodeId: null, date: new Date() });
  const hndA = gr.beginNode({ kind: 'handler', name: 'H', definitionId: null, parentNodeId: evtA, date: new Date() });

  gr.recordPendingSchedule({ targetDefinitionId: 'NEXT_EVENT', scheduledFor: new Date() });
  gr.endNode(hndA);
  gr.endNode(evtA);

  const evtB = gr.beginNode({ kind: 'event', name: 'NEXT_EVENT', definitionId: null, parentNodeId: null, date: new Date() });
  gr.resolvePendingSchedules('NEXT_EVENT', evtB);

  const edges = gr._eg._graph.getEdges({ type: EXECUTION_EDGE_TYPES.SCHEDULES });
  assert.strictEqual(edges.length, 1);
  assert.strictEqual(edges[0].from, hndA);
  assert.strictEqual(edges[0].to,   evtB);
});

test('GraphRecorder: unresolved schedule is not dropped on non-matching event', () => {
  const gr   = new GraphRecorder(makeGraph());
  const evtA = gr.beginNode({ kind: 'event', name: 'E', definitionId: null, parentNodeId: null, date: new Date() });
  gr.recordPendingSchedule({ targetDefinitionId: 'FAR_FUTURE', scheduledFor: new Date() });
  gr.endNode(evtA);

  const evtB = gr.beginNode({ kind: 'event', name: 'OTHER', definitionId: null, parentNodeId: null, date: new Date() });
  gr.resolvePendingSchedules('OTHER', evtB);

  assert.strictEqual(gr._pendingSchedules.length, 1, 'unmatched schedule should remain pending');
});

// ─── GraphRecorder: EMITS edges ──────────────────────────────────────────────

test('GraphRecorder: addEmitsEdge links reducer to emitted action', () => {
  const gr      = new GraphRecorder(makeGraph());
  const reducerId = gr.beginNode({ kind: 'reducer', name: 'R', definitionId: null, parentNodeId: null, date: new Date() });
  const actionId  = gr.beginNode({ kind: 'action',  name: 'A', definitionId: null, parentNodeId: null, date: new Date() });

  gr.addEmitsEdge(reducerId, actionId);

  const edges = gr._eg._graph.getEdges({ type: EXECUTION_EDGE_TYPES.EMITS });
  assert.strictEqual(edges.length, 1);
  assert.strictEqual(edges[0].from, reducerId);
  assert.strictEqual(edges[0].to,   actionId);
});
