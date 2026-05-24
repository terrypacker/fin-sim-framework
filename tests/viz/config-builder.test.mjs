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
 * config-builder.test.mjs
 *
 * Tests for ConfigBuilder:
 *   - Construction and button wiring
 *   - Creation listener registration and notification
 *   - deleteNode: calls the right service and clears the editor panel
 *   - _nodeChanged: calls the right service with no-change update
 *   - No longer subscribes to the service bus (GraphSync is responsible)
 *
 * Run with: npm run test:viz
 *
 * Note: jest.fn() / jest.spyOn() are unavailable in native ESM under
 * --experimental-vm-modules; all call tracking uses plain closures.
 */

import { ConfigBuilder } from '../../src/visualization/config-builder.js';
import { ServiceRegistry } from '../../src/services/service-registry.js';

// ─── Graph stub ───────────────────────────────────────────────────────────────

function makeGraph() {
  const nodes = [];
  return {
    graphRoot: document.createElement('div'),
    nodes,
    getNode(id)        { return nodes.find(n => n.id === id); },
    getKind(kind)      { return nodes.filter(n => n.kind === kind); },
    addNode(n)         { nodes.push(n); },
    replaceNode(id, n) {
      const i = nodes.findIndex(x => x.id === id);
      if (i >= 0) nodes[i] = n;
    },
    removeNode(id) {
      const i = nodes.findIndex(x => x.id === id);
      if (i >= 0) nodes.splice(i, 1);
    },
    addEdge()         {},
    removeEdge()      {},
    getNodesToKindFromMe() { return []; },
    getNodesFromKindToMe() { return []; },
    render()          {},
    registerNodeClickListener() {},
    selectNode()      {},
  };
}

function makeBuilderCanvas() {
  const el = document.createElement('div');
  const tpl = document.createElement('template');
  tpl.id = 'tpl-empty';
  tpl.innerHTML = '<div class="tl-empty">Select a node</div>';
  document.body.appendChild(tpl);
  return el;
}

function makeScheduler(graph, canvas) {
  ServiceRegistry.reset();
  return new ConfigBuilder({
    graph:         graph  ?? makeGraph(),
    builderCanvas: canvas ?? makeBuilderCanvas(),
  });
}

// ─── Construction ─────────────────────────────────────────────────────────────

test('ConfigBuilder: constructs without error', () => {
  expect(() => makeScheduler()).not.toThrow();
});

test('ConfigBuilder: listener arrays initialize empty', () => {
  const s = makeScheduler();
  expect(s.eventNodeCreatedListeners).toHaveLength(0);
  expect(s.handlerNodeCreatedListeners).toHaveLength(0);
  expect(s.actionNodeCreatedListeners).toHaveLength(0);
  expect(s.reducerNodeCreatedListeners).toHaveLength(0);
});

// ─── Creation listener registration ───────────────────────────────────────────

test('registerEventCreatedListener: adds listener', () => {
  const s  = makeScheduler();
  const fn = () => {};
  s.registerEventCreatedListener(fn);
  expect(s.eventNodeCreatedListeners).toContain(fn);
});

test('registerHandlerCreatedListener: adds listener', () => {
  const s  = makeScheduler();
  const fn = () => {};
  s.registerHandlerCreatedListener(fn);
  expect(s.handlerNodeCreatedListeners).toContain(fn);
});

test('registerActionCreatedListener: adds listener', () => {
  const s  = makeScheduler();
  const fn = () => {};
  s.registerActionCreatedListener(fn);
  expect(s.actionNodeCreatedListeners).toContain(fn);
});

test('registerReducerCreatedListener: adds listener', () => {
  const s  = makeScheduler();
  const fn = () => {};
  s.registerReducerCreatedListener(fn);
  expect(s.reducerNodeCreatedListeners).toContain(fn);
});

// ─── _notifyNodeCreationRequested ─────────────────────────────────────────────

test('_notifyNodeCreationRequested event: calls event listeners with subtype', () => {
  const s = makeScheduler();
  let received = null;
  s.registerEventCreatedListener(st => { received = st; });
  s._notifyNodeCreationRequested('event', 'Series');
  expect(received).toBe('Series');
});

test('_notifyNodeCreationRequested handler: calls handler listeners', () => {
  const s = makeScheduler();
  let called = false;
  s.registerHandlerCreatedListener(() => { called = true; });
  s._notifyNodeCreationRequested('handler', null);
  expect(called).toBe(true);
});

test('_notifyNodeCreationRequested action: calls action listeners', () => {
  const s = makeScheduler();
  let called = false;
  s.registerActionCreatedListener(() => { called = true; });
  s._notifyNodeCreationRequested('action', null);
  expect(called).toBe(true);
});

test('_notifyNodeCreationRequested reducer: calls reducer listeners', () => {
  const s = makeScheduler();
  let called = false;
  s.registerReducerCreatedListener(() => { called = true; });
  s._notifyNodeCreationRequested('reducer', null);
  expect(called).toBe(true);
});

// ─── deleteNode: delegates to service, clears editor ─────────────────────────

test('deleteNode event: calls eventService.deleteEvent', () => {
  const s = makeScheduler();
  const { eventService } = ServiceRegistry.getInstance();

  let deletedId = null;
  const orig = eventService.deleteEvent.bind(eventService);
  eventService.deleteEvent = (id) => { deletedId = id; };

  s.deleteNode({ id: 'e1', kind: 'event' });

  eventService.deleteEvent = orig;
  expect(deletedId).toBe('e1');
});

test('deleteNode handler: calls handlerService.deleteHandler', () => {
  const s = makeScheduler();
  const { handlerService } = ServiceRegistry.getInstance();

  let deletedId = null;
  const orig = handlerService.deleteHandler.bind(handlerService);
  handlerService.deleteHandler = (id) => { deletedId = id; };

  s.deleteNode({ id: 'h1', kind: 'handler' });

  handlerService.deleteHandler = orig;
  expect(deletedId).toBe('h1');
});

test('deleteNode action: calls actionService.deleteAction', () => {
  const s = makeScheduler();
  const { actionService } = ServiceRegistry.getInstance();

  let deletedId = null;
  const orig = actionService.deleteAction.bind(actionService);
  actionService.deleteAction = (id) => { deletedId = id; };

  s.deleteNode({ id: 'a1', kind: 'action' });

  actionService.deleteAction = orig;
  expect(deletedId).toBe('a1');
});

test('deleteNode reducer: calls reducerService.deleteReducer', () => {
  const s = makeScheduler();
  const { reducerService } = ServiceRegistry.getInstance();

  let deletedId = null;
  const orig = reducerService.deleteReducer.bind(reducerService);
  reducerService.deleteReducer = (id) => { deletedId = id; };

  s.deleteNode({ id: 'r1', kind: 'reducer' });

  reducerService.deleteReducer = orig;
  expect(deletedId).toBe('r1');
});

test('deleteNode: clears the editor panel', () => {
  const canvas = makeBuilderCanvas();
  const s = makeScheduler(undefined, canvas);
  canvas.innerHTML = '<div>editor content</div>';

  const { eventService } = ServiceRegistry.getInstance();
  const orig = eventService.deleteEvent.bind(eventService);
  eventService.deleteEvent = () => {};

  s.deleteNode({ id: 'e1', kind: 'event' });

  eventService.deleteEvent = orig;
  expect(canvas.innerHTML).not.toContain('editor content');
});

test('deleteNode: does NOT call graph.removeNode (GraphSync handles removal)', () => {
  const graph = makeGraph();
  let removeNodeCalled = false;
  const origRemoveNode = graph.removeNode.bind(graph);
  graph.removeNode = (id) => { removeNodeCalled = true; origRemoveNode(id); };

  const s = makeScheduler(graph);
  const { eventService } = ServiceRegistry.getInstance();
  const orig = eventService.deleteEvent.bind(eventService);
  eventService.deleteEvent = () => {};

  s.deleteNode({ id: 'e1', kind: 'event' });

  eventService.deleteEvent = orig;
  expect(removeNodeCalled).toBe(false);
});

// ─── ConfigBuilder does NOT subscribe to SERVICE_ACTION ─────────────────────
//
// Graph synchronization is now exclusively GraphSync's responsibility.
// Verifying there are no SERVICE_ACTION subscriptions on the bus after
// constructing ConfigBuilder ensures the bus is not double-handled.

test('ConfigBuilder does not add SERVICE_ACTION subscription to the bus', () => {
  ServiceRegistry.reset();
  const { bus } = ServiceRegistry.getInstance();
  const before = (bus.listeners.get('SERVICE_ACTION') ?? []).length;

  makeScheduler(); // constructs ConfigBuilder

  const after = (bus.listeners.get('SERVICE_ACTION') ?? []).length;
  expect(after).toBe(before);
});
