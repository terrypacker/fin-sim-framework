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
 * Regression tests for GraphBuilderController link/unlink.
 *
 * Bug: linking Event→Handler→Action→Reducer in the UI only created graph edges;
 * it never synced the canonical relationship arrays (handledEvents,
 * generatedActionTypes, reducedActionTypes). Those arrays are what toJSON
 * serializes and what the sim reads to wire handlers/reducers, so hand-built
 * links neither survived a reload nor executed — the event fired but nothing
 * downstream ran.
 */

import { test, expect, beforeEach } from '@jest/globals';
import { GraphBuilderController } from '../../src/visualization/graph-builder/graph-builder-controller.js';
import { ServiceRegistry } from '../../src/services/service-registry.js';
import { EDGE_TYPES } from '../../src/graph/edge.js';

function makeController() {
  ServiceRegistry.resetAll();
  const registry = ServiceRegistry.getInstance();
  const controller = new GraphBuilderController({
    eventService:   registry.eventService,
    handlerService: registry.handlerService,
    actionService:  registry.actionService,
    reducerService: registry.reducerService,
  });
  return { controller, registry };
}

let controller, registry, event, handler, action, reducer;

beforeEach(() => {
  ({ controller, registry } = makeController());
  event   = controller.eventCreationRequested('OneOff');
  handler = controller.handlerCreationRequested();
  action  = controller.actionCreationRequested();             // type 'NEW_ACTION'
  reducer = controller.reducerCreationRequested();
});

test('linking event→handler populates handler.handledEvents (drag from either end)', () => {
  controller.linkNodes(event, handler);
  expect(handler.handledEvents.map(e => e.id)).toEqual([event.id]);

  // Direction-agnostic: dragging from the handler end yields the same result.
  controller.unlinkNodes(handler, event);
  expect(handler.handledEvents).toEqual([]);
  controller.linkNodes(handler, event);
  expect(handler.handledEvents.map(e => e.id)).toEqual([event.id]);
});

test('linking event→handler creates the HANDLED_BY graph edge', () => {
  controller.linkNodes(event, handler);
  const edges = registry.graph.getEdges({ from: event.id, to: handler.id, type: EDGE_TYPES.HANDLED_BY });
  expect(edges).toHaveLength(1);
});

test('the wired handler survives serialization (toJSON carries handledEventIds)', () => {
  controller.linkNodes(event, handler);
  expect(handler.toJSON().handledEventIds).toEqual([event.id]);
});

test('linking action→reducer populates reducer.reducedActionTypes and the edge', () => {
  controller.linkNodes(action, reducer);
  expect(reducer.reducedActionTypes).toContain(action.type);

  const edges = registry.graph.getEdges({ from: action.id, to: reducer.id, type: EDGE_TYPES.REDUCES_ACTION });
  expect(edges).toHaveLength(1);
});

test('linking handler→action populates handler.generatedActionTypes and the edge', () => {
  controller.linkNodes(handler, action);
  expect(handler.generatedActionTypes).toContain(action.type);

  const edges = registry.graph.getEdges({ from: handler.id, to: action.id, type: EDGE_TYPES.GENERATES_ACTION });
  expect(edges).toHaveLength(1);
});

test('unlink removes both the canonical entry and the graph edge', () => {
  controller.linkNodes(action, reducer);
  controller.unlinkNodes(action, reducer);

  expect(reducer.reducedActionTypes).not.toContain(action.type);
  const edges = registry.graph.getEdges({ from: action.id, to: reducer.id, type: EDGE_TYPES.REDUCES_ACTION });
  expect(edges).toHaveLength(0);
});

test('linking is idempotent — re-linking does not duplicate array entries', () => {
  controller.linkNodes(event, handler);
  controller.linkNodes(event, handler);
  expect(handler.handledEvents.map(e => e.id)).toEqual([event.id]);
});

test('addActionDefinition for a brand-new type creates an action node in the graph', () => {
  expect(registry.actionService.getByType('METRIC_100')).toBeFalsy();

  controller.addActionDefinition(handler, {
    type: 'METRIC_100',
    config: { actionClass: 'AmountAction', value: 100 },
  });

  // A graph action node now exists for the type (visible + selectable)…
  const node = registry.actionService.getByType('METRIC_100');
  expect(node).toBeTruthy();
  expect(node.kind).toBe('action');

  // …the type is declared on the handler…
  expect(handler.generatedActionTypes).toContain('METRIC_100');

  // …and the handler→action edge is wired.
  const edges = registry.graph.getEdges({ from: handler.id, to: node.id, type: EDGE_TYPES.GENERATES_ACTION });
  expect(edges).toHaveLength(1);
});

test('addActionDefinition links the def to its node via _actionId (so the node shows fired)', () => {
  const def = controller.addActionDefinition(handler, {
    type: 'METRIC_100',
    config: { actionClass: 'AmountAction', value: 100 },
  });
  const node = registry.actionService.getByType('METRIC_100');
  // The runtime action instantiated from this def will carry _actionId = node.id,
  // which execution telemetry publishes as nodeId → the graph node lights up.
  expect(def.config._actionId).toBe(node.id);
});

test('a generated action node can then be reduced by a reducer (issue: not selectable)', () => {
  controller.addActionDefinition(handler, {
    type: 'METRIC_100',
    config: { actionClass: 'AmountAction', value: 100 },
  });
  const actionNode = registry.actionService.getByType('METRIC_100');

  // The reducer can now link to that action node (it exists in the graph).
  controller.linkNodes(actionNode, reducer);
  expect(reducer.reducedActionTypes).toContain('METRIC_100');
  const edges = registry.graph.getEdges({ from: actionNode.id, to: reducer.id, type: EDGE_TYPES.REDUCES_ACTION });
  expect(edges).toHaveLength(1);
});

test('addActionDefinition reuses an existing action node of the same type', () => {
  // action (NEW_ACTION) already exists from beforeEach
  const before = registry.actionService.getAll().filter(a => a.type === action.type).length;
  controller.addActionDefinition(handler, {
    type: action.type,
    config: { actionClass: 'AmountAction', value: 100 },
  });
  const after = registry.actionService.getAll().filter(a => a.type === action.type).length;
  expect(after).toBe(before); // no duplicate node created
  expect(handler.generatedActionTypes).toContain(action.type);
});
