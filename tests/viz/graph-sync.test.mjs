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
 * graph-sync.test.mjs
 *
 * Tests for GraphSync — the bus subscriber that keeps ConfigGraphBuilder in
 * sync with SERVICE_ACTION events.
 *
 * Uses a lightweight graph stub instead of a real ConfigGraphBuilder so these
 * tests have no DOM dependency.
 *
 * Run with: npm run test:viz
 */

import { GraphSync } from '../../src/visualization/graph-sync.js';
import { EventBus } from '../../src/simulation-framework/event-bus.js';
import { ServiceActionEvent } from '../../src/simulation-framework/bus-messages.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeBus() {
  return new EventBus();
}

/**
 * Lightweight graph stub that mirrors the ConfigGraphBuilder surface used by
 * GraphSync.  replaceNode updates in-place by index so tests can assert on
 * object identity without worrying about array replacement.
 */
function makeGraph() {
  const nodes = [];
  const edges = [];
  const renderCalls = { count: 0 };
  return {
    nodes,
    edges,
    renderCalls,
    getNode(id) { return nodes.find(n => n.id === id); },
    addNode(node) {
      if (nodes.find(n => n.id === node.id)) throw new Error(`Duplicate node: ${node.id}`);
      nodes.push(node);
    },
    replaceNode(id, node) {
      const idx = nodes.findIndex(n => n.id === id);
      if (idx >= 0) nodes[idx] = node;
    },
    removeNode(id) {
      const idx = nodes.findIndex(n => n.id === id);
      if (idx >= 0) nodes.splice(idx, 1);
      for (let i = edges.length - 1; i >= 0; i--) {
        if (edges[i].from === id || edges[i].to === id) edges.splice(i, 1);
      }
    },
    addEdge(edge) { edges.push(edge); },
    removeEdge(edge) {
      const idx = edges.findIndex(e => e.from === edge.from && e.to === edge.to);
      if (idx >= 0) edges.splice(idx, 1);
    },
    render() { renderCalls.count++; },
  };
}

function makeRegistry(bus) {
  return { bus };
}

/** Publish a ServiceActionEvent on the bus. */
function publish(bus, actionType, classType, item) {
  bus.publish(new ServiceActionEvent({ actionType, classType, item, originalItem: null }));
}

// ─── CREATE: events ───────────────────────────────────────────────────────────

test('CREATE EventSeries: adds node with kind=event and eventType=Series', () => {
  const bus = makeBus();
  const graph = makeGraph();
  new GraphSync({ graph, registry: makeRegistry(bus) });

  const event = { id: 'e1', name: 'Monthly' };
  publish(bus, 'CREATE', 'EventSeries', event);

  expect(graph.getNode('e1')).toBeDefined();
  expect(graph.getNode('e1').kind).toBe('event');
  expect(graph.getNode('e1').eventType).toBe('Series');
});

test('CREATE OneOffEvent: adds node with kind=event and eventType=OneOff', () => {
  const bus = makeBus();
  const graph = makeGraph();
  new GraphSync({ graph, registry: makeRegistry(bus) });

  const event = { id: 'e1', name: 'Bonus' };
  publish(bus, 'CREATE', 'OneOffEvent', event);

  expect(graph.getNode('e1')).toBeDefined();
  expect(graph.getNode('e1').kind).toBe('event');
  expect(graph.getNode('e1').eventType).toBe('OneOff');
});

test('CREATE event: idempotent — second CREATE with same id is ignored', () => {
  const bus = makeBus();
  const graph = makeGraph();
  new GraphSync({ graph, registry: makeRegistry(bus) });

  const event = { id: 'e1', name: 'Monthly' };
  publish(bus, 'CREATE', 'EventSeries', event);
  // Publishing again must not throw (e.g. due to duplicate-node guard)
  expect(() => publish(bus, 'CREATE', 'EventSeries', event)).not.toThrow();
  expect(graph.nodes.filter(n => n.id === 'e1').length).toBe(1);
});

// ─── CREATE: handlers ─────────────────────────────────────────────────────────

test('CREATE HandlerEntry: adds node to graph', () => {
  const bus = makeBus();
  const graph = makeGraph();
  new GraphSync({ graph, registry: makeRegistry(bus) });

  const handler = { id: 'h1', kind: 'handler', name: 'H', handledEvents: [], generatedActions: [] };
  publish(bus, 'CREATE', 'HandlerEntry', handler);

  expect(graph.getNode('h1')).toBeDefined();
});

test('CREATE HandlerEntry: adds edge from existing event to handler', () => {
  const bus = makeBus();
  const graph = makeGraph();
  new GraphSync({ graph, registry: makeRegistry(bus) });

  const event = { id: 'e1', kind: 'event', eventType: 'Series', name: 'Evt' };
  graph.addNode(event);

  const handler = { id: 'h1', kind: 'handler', name: 'H', handledEvents: [event], generatedActions: [] };
  publish(bus, 'CREATE', 'HandlerEntry', handler);

  expect(graph.edges).toContainEqual({ from: 'e1', to: 'h1' });
});

test('CREATE HandlerEntry: no edge added for event not yet in graph', () => {
  const bus = makeBus();
  const graph = makeGraph();
  new GraphSync({ graph, registry: makeRegistry(bus) });

  const event = { id: 'e1' }; // NOT added to graph
  const handler = { id: 'h1', kind: 'handler', name: 'H', handledEvents: [event], generatedActions: [] };
  publish(bus, 'CREATE', 'HandlerEntry', handler);

  expect(graph.edges.length).toBe(0);
});

test('CREATE HandlerEntry: adds edge from handler to generatedAction', () => {
  const bus = makeBus();
  const graph = makeGraph();
  new GraphSync({ graph, registry: makeRegistry(bus) });

  const action = { id: 'a1', kind: 'action', name: 'Act' };
  graph.addNode(action); // already in graph

  const handler = { id: 'h1', kind: 'handler', name: 'H', handledEvents: [], generatedActions: [action] };
  publish(bus, 'CREATE', 'HandlerEntry', handler);

  expect(graph.edges).toContainEqual({ from: 'h1', to: 'a1' });
});

test('CREATE HandlerEntry: auto-adds generatedAction node if not already in graph', () => {
  const bus = makeBus();
  const graph = makeGraph();
  new GraphSync({ graph, registry: makeRegistry(bus) });

  const action = { id: 'a1', kind: 'action', name: 'Act' };
  const handler = { id: 'h1', kind: 'handler', name: 'H', handledEvents: [], generatedActions: [action] };
  publish(bus, 'CREATE', 'HandlerEntry', handler);

  expect(graph.getNode('a1')).toBeDefined();
  expect(graph.edges).toContainEqual({ from: 'h1', to: 'a1' });
});

// ─── CREATE: actions ──────────────────────────────────────────────────────────

test('CREATE AmountAction: adds action node', () => {
  const bus = makeBus();
  const graph = makeGraph();
  new GraphSync({ graph, registry: makeRegistry(bus) });

  const action = { id: 'a1', kind: 'action', name: 'Pay' };
  publish(bus, 'CREATE', 'AmountAction', action);

  expect(graph.getNode('a1')).toBeDefined();
});

test('CREATE action: idempotent — second CREATE with same id is ignored', () => {
  const bus = makeBus();
  const graph = makeGraph();
  new GraphSync({ graph, registry: makeRegistry(bus) });

  const action = { id: 'a1', kind: 'action', name: 'Pay' };
  publish(bus, 'CREATE', 'AmountAction', action);
  expect(() => publish(bus, 'CREATE', 'AmountAction', action)).not.toThrow();
  expect(graph.nodes.filter(n => n.id === 'a1').length).toBe(1);
});

// ─── CREATE: reducers ─────────────────────────────────────────────────────────

test('CREATE reducer: adds reducer node', () => {
  const bus = makeBus();
  const graph = makeGraph();
  new GraphSync({ graph, registry: makeRegistry(bus) });

  const reducer = { id: 'r1', kind: 'reducer', name: 'R', reducedActions: [], generatedActions: [] };
  publish(bus, 'CREATE', 'NumericSumReducer', reducer);

  expect(graph.getNode('r1')).toBeDefined();
});

test('CREATE reducer: adds edge from reducedAction to reducer', () => {
  const bus = makeBus();
  const graph = makeGraph();
  new GraphSync({ graph, registry: makeRegistry(bus) });

  const action = { id: 'a1', kind: 'action', name: 'Act' };
  graph.addNode(action);

  const reducer = { id: 'r1', kind: 'reducer', name: 'R', reducedActions: [action], generatedActions: [] };
  publish(bus, 'CREATE', 'NumericSumReducer', reducer);

  expect(graph.edges).toContainEqual({ from: 'a1', to: 'r1' });
});

test('CREATE reducer: auto-adds reducedAction node if not already in graph', () => {
  const bus = makeBus();
  const graph = makeGraph();
  new GraphSync({ graph, registry: makeRegistry(bus) });

  const action = { id: 'a1', kind: 'action', name: 'Act' };
  const reducer = { id: 'r1', kind: 'reducer', name: 'R', reducedActions: [action], generatedActions: [] };
  publish(bus, 'CREATE', 'NumericSumReducer', reducer);

  expect(graph.getNode('a1')).toBeDefined();
});

// ─── UPDATE ───────────────────────────────────────────────────────────────────

test('UPDATE: replaces node in graph', () => {
  const bus = makeBus();
  const graph = makeGraph();
  new GraphSync({ graph, registry: makeRegistry(bus) });

  const action = { id: 'a1', kind: 'action', name: 'Old Name', x: 10, y: 20 };
  graph.addNode(action);

  const updated = { id: 'a1', kind: 'action', name: 'New Name' };
  publish(bus, 'UPDATE', 'AmountAction', updated);

  expect(graph.getNode('a1').name).toBe('New Name');
});

test('UPDATE: preserves x/y position from existing node', () => {
  const bus = makeBus();
  const graph = makeGraph();
  new GraphSync({ graph, registry: makeRegistry(bus) });

  const action = { id: 'a1', kind: 'action', name: 'Act', x: 150, y: 300 };
  graph.addNode(action);
  action.x = 150;
  action.y = 300;

  const replacement = { id: 'a1', kind: 'action', name: 'Act v2' };
  publish(bus, 'UPDATE', 'AmountAction', replacement);

  expect(graph.getNode('a1').x).toBe(150);
  expect(graph.getNode('a1').y).toBe(300);
});

test('UPDATE: preserves breakpoint flag from existing node', () => {
  const bus = makeBus();
  const graph = makeGraph();
  new GraphSync({ graph, registry: makeRegistry(bus) });

  const reducer = { id: 'r1', kind: 'reducer', name: 'R', x: 0, y: 0 };
  graph.addNode(reducer);
  reducer.breakpoint = true;

  const replacement = { id: 'r1', kind: 'reducer', name: 'R v2' };
  publish(bus, 'UPDATE', 'NoOpReducer', replacement);

  expect(graph.getNode('r1').breakpoint).toBe(true);
});

test('UPDATE: preserves fired and stateChanged flags from existing node', () => {
  const bus = makeBus();
  const graph = makeGraph();
  new GraphSync({ graph, registry: makeRegistry(bus) });

  const handler = { id: 'h1', kind: 'handler', name: 'H', x: 0, y: 0 };
  graph.addNode(handler);
  handler.fired = true;
  handler.stateChanged = true;
  handler.stateChanges = [{ field: 'cash', before: 0, after: 100, delta: 100 }];

  const replacement = { id: 'h1', kind: 'handler', name: 'H v2' };
  publish(bus, 'UPDATE', 'HandlerEntry', replacement);

  const node = graph.getNode('h1');
  expect(node.fired).toBe(true);
  expect(node.stateChanged).toBe(true);
  expect(node.stateChanges).toHaveLength(1);
});

test('UPDATE: preserves own-property kind/eventType for event nodes', () => {
  const bus = makeBus();
  const graph = makeGraph();
  new GraphSync({ graph, registry: makeRegistry(bus) });

  // Simulate an event node that had kind/eventType set during CREATE
  const event = { id: 'e1', name: 'Monthly', kind: 'event', eventType: 'Series', x: 0, y: 0 };
  graph.addNode(event);

  // service.updateEvent returns the same mutated object, but GraphSync.UPDATE
  // must also handle fresh-object replacements robustly
  const replacement = { id: 'e1', name: 'Monthly (updated)' };
  publish(bus, 'UPDATE', 'EventSeries', replacement);

  expect(graph.getNode('e1').kind).toBe('event');
  expect(graph.getNode('e1').eventType).toBe('Series');
});

test('UPDATE: no-op when node not present in graph', () => {
  const bus = makeBus();
  const graph = makeGraph();
  new GraphSync({ graph, registry: makeRegistry(bus) });

  // Should not throw
  expect(() => publish(bus, 'UPDATE', 'AmountAction', { id: 'unknown' })).not.toThrow();
  expect(graph.nodes.length).toBe(0);
});

// ─── DELETE ───────────────────────────────────────────────────────────────────

test('DELETE: removes node from graph', () => {
  const bus = makeBus();
  const graph = makeGraph();
  new GraphSync({ graph, registry: makeRegistry(bus) });

  const action = { id: 'a1', kind: 'action', name: 'Act' };
  graph.addNode(action);

  publish(bus, 'DELETE', 'AmountAction', { id: 'a1' });

  expect(graph.getNode('a1')).toBeUndefined();
});

test('DELETE: removes incident edges', () => {
  const bus = makeBus();
  const graph = makeGraph();
  new GraphSync({ graph, registry: makeRegistry(bus) });

  const event = { id: 'e1', kind: 'event', eventType: 'Series', name: 'Evt' };
  const handler = { id: 'h1', kind: 'handler', name: 'H' };
  graph.addNode(event);
  graph.addNode(handler);
  graph.addEdge({ from: 'e1', to: 'h1' });

  publish(bus, 'DELETE', 'EventSeries', { id: 'e1' });

  expect(graph.getNode('e1')).toBeUndefined();
  expect(graph.edges.length).toBe(0);
});

test('DELETE: no-op when node not present in graph', () => {
  const bus = makeBus();
  const graph = makeGraph();
  new GraphSync({ graph, registry: makeRegistry(bus) });

  expect(() => publish(bus, 'DELETE', 'AmountAction', { id: 'nonexistent' })).not.toThrow();
});

// ─── render() ─────────────────────────────────────────────────────────────────

test('graph.render() is called after every SERVICE_ACTION', () => {
  const bus = makeBus();
  const graph = makeGraph();
  new GraphSync({ graph, registry: makeRegistry(bus) });

  const before = graph.renderCalls.count;
  publish(bus, 'CREATE', 'EventSeries', { id: 'e1', name: 'M' });
  expect(graph.renderCalls.count).toBeGreaterThan(before);
});
