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
 *
 * TODO Skeleton test to be filled out in #136
 *
 * Run with: npm run test:viz
 *
 * Note: jest.fn() / jest.spyOn() are unavailable in native ESM under
 * --experimental-vm-modules; all call tracking uses plain closures.
 */

import { GraphBuilderPresenter } from '../../src/visualization/graph-builder/graph-builder-presenter.js';
import { ServiceRegistry } from '../../src/services/service-registry.js';
import {
  GraphRenderer
} from "../../src/visualization/components/graph-renderer.js";


// ─── DOM helpers ──────────────────────────────────────────────────────────────
function makeElements() {
  const builderCanvas = document.createElement('div');
  const graphRoot  = document.createElement('div');
  graphRoot.id = 'graphRoot';
  const graphViewPort = document.createElement('div');
  graphViewPort.id = 'graphViewport';
  const graphEdges = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  graphEdges.id = 'graphEdges';
  const graphNodes = document.createElement('div');
  graphNodes.id = 'graphNodes';
  const selectionBox = document.createElement('div');
  selectionBox.classList.add('selection-box');

  const nodeDetailsTemplate = document.createElement('template');

  document.body.appendChild(graphRoot);
  graphRoot.appendChild(graphViewPort);
  graphViewPort.appendChild(graphEdges);
  graphViewPort.appendChild(graphNodes);
  graphViewPort.appendChild(selectionBox);

  nodeDetailsTemplate.innerHTML = '<div class="g-node">\n'
      + '    <div class="g-header">\n'
      + '      <span class="g-header-text"></span>\n'
      + '      <span class="node-state-badge badge-green" data-id="stateChangeIndicator" style="display:none"></span>\n'
      + '      <span class="node-fired-badge badge-green" data-id="firedIndicator"></span>\n'
      + '    </div>\n'
      + '    <div class="g-title">\n'
      + '      <span class="g-title-text"></span>\n'
      + '    </div>\n'
      + '\n'
      + '    <div class="g-port in"></div>\n'
      + '    <div class="g-port out"></div>\n'
      + '  </div>'
  document.body.appendChild(nodeDetailsTemplate);
  return { builderCanvas, graphRoot, graphNodes, graphEdges , nodeDetailsTemplate};
}

// ─── Graph Renderer stub ───────────────────────────────────────────────────────────────
function makeGraphRenderer(elements = makeElements()) {
  const registry = ServiceRegistry.getInstance();
  return new GraphRenderer({
    parent: null,
    graph: registry.graph,
    graphQueryApi: registry.graphQueryApi,
    graphRoot: elements.graphRoot,
    graphNodes: elements.graphNodes,
    graphEdges: elements.graphEdges,
    nodeDetailsTemplate: elements.nodeDetailsTemplate,
    displayNodeStateChanges: (changes) => {}
  });
}

function makeBuilderPresenter(graphRenderer = makeGraphRenderer()) {
  ServiceRegistry.resetAll();
  const registry = ServiceRegistry.getInstance();
  return new GraphBuilderPresenter({
    graphRenderer,
    eventService:   registry.eventService,
    handlerService: registry.handlerService,
    actionService:  registry.actionService,
    reducerService: registry.reducerService,
  });
}

function makeEmptyTemplate() {
  const tpl = document.createElement('template');
  tpl.id = 'tpl-empty';
  tpl.innerHTML = `
    <div class="tl-empty">Select a node</div>`;
  return tpl;
}

// ─── Construction ─────────────────────────────────────────────────────────────

test('GraphBuilderPresenter: constructs without error', () => {
  expect(() => makeBuilderPresenter()).not.toThrow();
});

test('GraphBuilderPresenter: listener arrays initialize empty', () => {
  const s = makeBuilderPresenter();
  expect(s.eventNodeCreatedListeners).toHaveLength(0);
  expect(s.handlerNodeCreatedListeners).toHaveLength(0);
  expect(s.actionNodeCreatedListeners).toHaveLength(0);
  expect(s.reducerNodeCreatedListeners).toHaveLength(0);
});

// ─── Creation listener registration ───────────────────────────────────────────

test('registerEventCreatedListener: adds listener', () => {
  const s  = makeBuilderPresenter();
  const fn = () => {};
  s.registerEventCreatedListener(fn);
  expect(s.eventNodeCreatedListeners).toContain(fn);
});

test('registerHandlerCreatedListener: adds listener', () => {
  const s  = makeBuilderPresenter();
  const fn = () => {};
  s.registerHandlerCreatedListener(fn);
  expect(s.handlerNodeCreatedListeners).toContain(fn);
});

test('registerActionCreatedListener: adds listener', () => {
  const s  = makeBuilderPresenter();
  const fn = () => {};
  s.registerActionCreatedListener(fn);
  expect(s.actionNodeCreatedListeners).toContain(fn);
});

test('registerReducerCreatedListener: adds listener', () => {
  const s  = makeBuilderPresenter();
  const fn = () => {};
  s.registerReducerCreatedListener(fn);
  expect(s.reducerNodeCreatedListeners).toContain(fn);
});

// ─── _notifyNodeCreationRequested ─────────────────────────────────────────────

test('_notifyNodeCreationRequested event: calls event listeners with subtype', () => {
  const s = makeBuilderPresenter();
  let received = null;
  s.registerEventCreatedListener(st => { received = st; });
  s._notifyNodeCreationRequested('event', 'Series');
  expect(received).toBe('Series');
});

test('_notifyNodeCreationRequested handler: calls handler listeners', () => {
  const s = makeBuilderPresenter();
  let called = false;
  s.registerHandlerCreatedListener(() => { called = true; });
  s._notifyNodeCreationRequested('handler', null);
  expect(called).toBe(true);
});

test('_notifyNodeCreationRequested action: calls action listeners', () => {
  const s = makeBuilderPresenter();
  let called = false;
  s.registerActionCreatedListener(() => { called = true; });
  s._notifyNodeCreationRequested('action', null);
  expect(called).toBe(true);
});

test('_notifyNodeCreationRequested reducer: calls reducer listeners', () => {
  const s = makeBuilderPresenter();
  let called = false;
  s.registerReducerCreatedListener(() => { called = true; });
  s._notifyNodeCreationRequested('reducer', null);
  expect(called).toBe(true);
});

// ─── deleteNode: delegates to service, clears editor ─────────────────────────

test('deleteNode event: calls eventService.deleteEvent', () => {
  const s = makeBuilderPresenter();
  const { eventService } = ServiceRegistry.getInstance();
  document.body.appendChild(makeEmptyTemplate());

  let deletedId = null;
  const orig = eventService.deleteEvent.bind(eventService);
  eventService.deleteEvent = (id) => { deletedId = id; };

  s.deleteNode({ id: 'e1', kind: 'event' });

  eventService.deleteEvent = orig;
  expect(deletedId).toBe('e1');
});

test('deleteNode handler: calls handlerService.deleteHandler', () => {
  const s = makeBuilderPresenter();
  const { handlerService } = ServiceRegistry.getInstance();
  document.body.appendChild(makeEmptyTemplate());

  let deletedId = null;
  const orig = handlerService.deleteHandler.bind(handlerService);
  handlerService.deleteHandler = (id) => { deletedId = id; };

  s.deleteNode({ id: 'h1', kind: 'handler' });

  handlerService.deleteHandler = orig;
  expect(deletedId).toBe('h1');
});

test('deleteNode action: calls actionService.deleteAction', () => {
  const s = makeBuilderPresenter();
  const { actionService } = ServiceRegistry.getInstance();
  document.body.appendChild(makeEmptyTemplate());

  let deletedId = null;
  const orig = actionService.deleteAction.bind(actionService);
  actionService.deleteAction = (id) => { deletedId = id; };

  s.deleteNode({ id: 'a1', kind: 'action' });

  actionService.deleteAction = orig;
  expect(deletedId).toBe('a1');
});

test('deleteNode reducer: calls reducerService.deleteReducer', () => {
  const s = makeBuilderPresenter();
  const { reducerService } = ServiceRegistry.getInstance();
  document.body.appendChild(makeEmptyTemplate())

  let deletedId = null;
  const orig = reducerService.deleteReducer.bind(reducerService);
  reducerService.deleteReducer = (id) => { deletedId = id; };

  s.deleteNode({ id: 'r1', kind: 'reducer' });

  reducerService.deleteReducer = orig;
  expect(deletedId).toBe('r1');
});

test('deleteNode: removes node from service', () => {
  const s = makeBuilderPresenter();

  const { eventService } = ServiceRegistry.getInstance();
  let deletedId = null;
  const orig = eventService.deleteEvent.bind(eventService);
  eventService.deleteEvent = (id) => { deletedId = id; };

  s.deleteNode({ id: 'e1', kind: 'event' });

  eventService.deleteEvent = orig;
  expect(deletedId).toBe('e1');
});

test('deleteNode: does NOT call graph.removeNode (GraphSync handles removal)', () => {
  const graph = makeGraphRenderer();
  document.body.appendChild(makeEmptyTemplate());
  let removeNodeCalled = false;
  const origRemoveNode = graph._removeNode.bind(graph);
  graph._removeNode = (id) => { removeNodeCalled = true; origRemoveNode(id); };

  const s = makeBuilderPresenter(graph);
  const { eventService } = ServiceRegistry.getInstance();
  const orig = eventService.deleteEvent.bind(eventService);
  eventService.deleteEvent = () => {};

  s.deleteNode({ id: 'e1', kind: 'event' });

  eventService.deleteEvent = orig;
  expect(removeNodeCalled).toBe(false);
});

// ─── GraphBuilderPresenter does NOT subscribe to SERVICE_ACTION ─────────────────────
//
// Graph synchronization is now exclusively GraphSync's responsibility.
// Verifying there are no SERVICE_ACTION subscriptions on the bus after
// constructing GraphBuilderPresenter ensures the bus is not double-handled.

test('GraphBuilderPresenter does not add SERVICE_ACTION subscription to the bus', () => {
  ServiceRegistry.resetAll();
  const { bus } = ServiceRegistry.getInstance();
  const before = (bus.listeners.get('SERVICE_ACTION') ?? []).length;

  makeBuilderPresenter(); // constructs GraphBuilderPresenter

  const after = (bus.listeners.get('SERVICE_ACTION') ?? []).length;
  expect(after).toBe(before);
});
