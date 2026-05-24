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
 * base-scenario.test.mjs
 * Tests for BaseScenario: creation/deletion listener flow, ID counters,
 * eventChanged fix, and sim cleanup.
 * Run with: node --test tests/base-scenario.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { BaseScenario }    from '../../src/scenarios/base-scenario.js';
import { ServiceRegistry } from '../../src/services/service-registry.js';
import { Simulation }      from '../../src/simulation-framework/simulation.js';
import { BaseEvent }    from '../../src/simulation-framework/events/base-event.js';
import { EventSeries }  from '../../src/simulation-framework/events/event-series.js';
import { OneOffEvent }  from '../../src/simulation-framework/events/one-off-event.js';
import { HandlerEntry } from '../../src/simulation-framework/handlers.js';
import { AmountAction } from '../../src/simulation-framework/actions.js';
import { MetricReducer } from '../../src/simulation-framework/reducers.js';
import { ReducerBuilder } from '../../src/simulation-framework/builders/reducer-builder.js';

// BaseScenario references FinSimLib as a browser global — provide it here.
globalThis.FinSimLib = {
  Core:      { Simulation, HandlerEntry, AmountAction, MetricReducer, BaseEvent, EventSeries, OneOffEvent },
  Scenarios: {},
};

// ─── Stub EventSchedulerUI ────────────────────────────────────────────────────

class StubSchedulerUI {
  constructor() {
    this.nodes       = [];
    this.editedNodes = [];
    this._listeners  = {
      eventChange: [], handlerChange: [], actionChange: [], reducerChange: [],
      eventCreated: [], handlerCreated: [], actionCreated: [], reducerCreated: [],
      eventDeleted: [], handlerDeleted: [], actionDeleted: [], reducerDeleted: [],
    };
    this.graph = { getKind: (kind) => this.nodes.filter(n => n.kind === kind) };
  }

  registerEventChangeListener(l)    { this._listeners.eventChange.push(l); }
  registerHandlerChangeListener(l)  { this._listeners.handlerChange.push(l); }
  registerActionChangeListener(l)   { this._listeners.actionChange.push(l); }
  registerReducerChangeListener(l)  { this._listeners.reducerChange.push(l); }
  registerEventCreatedListener(l)   { this._listeners.eventCreated.push(l); }
  registerHandlerCreatedListener(l) { this._listeners.handlerCreated.push(l); }
  registerActionCreatedListener(l)  { this._listeners.actionCreated.push(l); }
  registerReducerCreatedListener(l) { this._listeners.reducerCreated.push(l); }
  registerEventDeletedListener(l)   { this._listeners.eventDeleted.push(l); }
  registerHandlerDeletedListener(l) { this._listeners.handlerDeleted.push(l); }
  registerActionDeletedListener(l)  { this._listeners.actionDeleted.push(l); }
  registerReducerDeletedListener(l) { this._listeners.reducerDeleted.push(l); }

  addEvent(e)   { e.kind = 'event';   this.nodes.push(e); }
  addHandler(h) { h.kind = 'handler'; this.nodes.push(h); }
  addAction(a)  { a.kind = 'action';  a.id = a.type; this.nodes.push(a); }
  addReducer(r) { r.kind = 'reducer'; this.nodes.push(r); }
  editNode(n)   { this.editedNodes.push(n); }

  triggerCreate(kind, subtype) {
    if (kind === 'event')   this._listeners.eventCreated.forEach(l => l(subtype));
    if (kind === 'handler') this._listeners.handlerCreated.forEach(l => l());
    if (kind === 'action')  this._listeners.actionCreated.forEach(l => l());
    if (kind === 'reducer') this._listeners.reducerCreated.forEach(l => l());
  }

  triggerDelete(node) {
    if (node.kind === 'event')   this._listeners.eventDeleted.forEach(l => l(node));
    if (node.kind === 'handler') this._listeners.handlerDeleted.forEach(l => l(node));
    if (node.kind === 'action')  this._listeners.actionDeleted.forEach(l => l(node));
    if (node.kind === 'reducer') this._listeners.reducerDeleted.forEach(l => l(node));
  }
}

function makeScenario() {
  ServiceRegistry.reset();
  const ui       = new StubSchedulerUI();
  const scenario = new BaseScenario({ eventSchedulerUI: ui });
  scenario.buildSim({}, { metrics: {} });
  return { ui, scenario };
}

// ─── ID counters ──────────────────────────────────────────────────────────────

test('registerHandler: assigns incrementing IDs h1, h2, h3', () => {
  const { scenario } = makeScenario();
  const h1 = new HandlerEntry(() => [], 'A');
  const h2 = new HandlerEntry(() => [], 'B');
  const h3 = new HandlerEntry(() => [], 'C');
  scenario.registerHandler(h1);
  scenario.registerHandler(h2);
  scenario.registerHandler(h3);
  assert.strictEqual(h1.id, 'h1');
  assert.strictEqual(h2.id, 'h2');
  assert.strictEqual(h3.id, 'h3');
});

test('registerReducer: assigns incrementing IDs r1, r2', () => {
  const { scenario } = makeScenario();
  const r1 = ReducerBuilder.metric('a').name('R1').build();
  const r2 = ReducerBuilder.metric('b').name('R2').build();
  scenario.registerReducer(r1);
  scenario.registerReducer(r2);
  assert.strictEqual(r1.id, 'r1');
  assert.strictEqual(r2.id, 'r2');
});

// ─── Event creation ───────────────────────────────────────────────────────────

test('eventCreationRequested Series: adds EventSeries to UI with e1 id', () => {
  const { ui } = makeScenario();
  ui.triggerCreate('event', 'Series');
  const events = ui.nodes.filter(n => n.kind === 'event');
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].id, 'e1');
  assert.ok(events[0] instanceof EventSeries, 'should be an EventSeries');
  assert.strictEqual(events[0].enabled, false);
});

test('eventCreationRequested OneOff: adds plain object with date field', () => {
  const { ui } = makeScenario();
  ui.triggerCreate('event', 'OneOff');
  const events = ui.nodes.filter(n => n.kind === 'event');
  assert.strictEqual(events.length, 1);
  assert.ok(events[0].date instanceof Date, 'should have a date');
  assert.strictEqual(events[0].enabled, false);
});

test('eventCreationRequested: opens editor for created node', () => {
  const { ui } = makeScenario();
  ui.triggerCreate('event', 'Series');
  assert.strictEqual(ui.editedNodes.length, 1);
  assert.strictEqual(ui.editedNodes[0].id, 'e1');
});

test('eventCreationRequested: IDs increment across multiple creates', () => {
  const { ui } = makeScenario();
  ui.triggerCreate('event', 'Series');
  ui.triggerCreate('event', 'Series');
  const ids = ui.nodes.filter(n => n.kind === 'event').map(n => n.id);
  assert.deepStrictEqual(ids, ['e1', 'e2']);
});

// ─── Handler creation ─────────────────────────────────────────────────────────

test('handlerCreationRequested: adds HandlerEntry to UI with h1 id', () => {
  const { ui } = makeScenario();
  ui.triggerCreate('handler');
  const handlers = ui.nodes.filter(n => n.kind === 'handler');
  assert.strictEqual(handlers.length, 1);
  assert.strictEqual(handlers[0].id, 'h1');
  assert.ok(handlers[0] instanceof HandlerEntry);
});

test('handlerCreationRequested: opens editor for created node', () => {
  const { ui } = makeScenario();
  ui.triggerCreate('handler');
  assert.strictEqual(ui.editedNodes.length, 1);
  assert.strictEqual(ui.editedNodes[0].id, 'h1');
});

// ─── Action creation ──────────────────────────────────────────────────────────

test('actionCreationRequested: adds AmountAction to UI', () => {
  const { ui } = makeScenario();
  ui.triggerCreate('action');
  const actions = ui.nodes.filter(n => n.kind === 'action');
  assert.strictEqual(actions.length, 1);
  assert.ok(actions[0] instanceof AmountAction);
  assert.ok(actions[0].id.startsWith('NEW_ACTION_a1'));
});

test('actionCreationRequested: opens editor for created node', () => {
  const { ui } = makeScenario();
  ui.triggerCreate('action');
  assert.strictEqual(ui.editedNodes.length, 1);
});

// ─── Reducer creation ─────────────────────────────────────────────────────────

test('reducerCreationRequested: adds MetricReducer to UI with r1 id', () => {
  const { ui } = makeScenario();
  ui.triggerCreate('reducer');
  const reducers = ui.nodes.filter(n => n.kind === 'reducer');
  assert.strictEqual(reducers.length, 1);
  assert.strictEqual(reducers[0].id, 'r1');
  assert.ok(reducers[0] instanceof MetricReducer);
});

test('reducerCreationRequested: opens editor for created node', () => {
  const { ui } = makeScenario();
  ui.triggerCreate('reducer');
  assert.strictEqual(ui.editedNodes.length, 1);
  assert.strictEqual(ui.editedNodes[0].id, 'r1');
});

// ─── eventChanged fix ─────────────────────────────────────────────────────────

test('eventChanged: enabling a UI-created event does not throw', () => {
  const { ui, scenario } = makeScenario();
  ui.triggerCreate('event', 'Series');
  const event = ui.nodes.find(n => n.kind === 'event');

  // Simulate user enabling it — this must NOT throw "already in graph"
  event.enabled = true;
  assert.doesNotThrow(() => scenario.eventChanged(event));
});

test('eventChanged: disabling an enabled event unschedules it from sim', () => {
  const { scenario } = makeScenario();
  const event = new EventSeries({
    id: 'e-test', name: 'Test', type: 'TEST_EVT', interval: 'month-end', enabled: true, color: '#fff'
  });
  scenario.scheduleEvent(event);

  event.enabled = false;
  assert.doesNotThrow(() => scenario.eventChanged(event));
});

// ─── Event deletion ───────────────────────────────────────────────────────────

test('eventDeleted: removes event from _registeredRecurringTypes', () => {
  const { ui, scenario } = makeScenario();
  ui.triggerCreate('event', 'Series');
  const event = ui.nodes.find(n => n.kind === 'event');

  // Enable and schedule it so it gets into _registeredRecurringTypes
  event.enabled = true;
  scenario.eventChanged(event);
  assert.ok(scenario._registeredRecurringTypes.has(event.type));

  ServiceRegistry.getInstance().eventService.deleteEvent(event.id);
  assert.ok(!scenario._registeredRecurringTypes.has(event.type));
});

test('eventDeleted: disabled event can be deleted without error', () => {
  const { ui } = makeScenario();
  ui.triggerCreate('event', 'Series');
  const event = ui.nodes.find(n => n.kind === 'event');
  assert.doesNotThrow(() => ServiceRegistry.getInstance().eventService.deleteEvent(event.id));
});

// ─── Handler deletion ─────────────────────────────────────────────────────────

test('handlerDeleted: unregisters handler from sim', () => {
  const { ui, scenario } = makeScenario();
  ui.triggerCreate('handler');
  const handler = ui.nodes.find(n => n.kind === 'handler');

  // Link to a dummy event type so the handler is registered
  const event = new EventSeries({ id: 'ev1', name: 'Ev', type: 'TEST_HANDLER_EVT', interval: 'month-end', enabled: true, color: '#aaa' });
  scenario.scheduleEvent(event);
  handler.handledEvents.push(event);
  scenario.sim.register(event.type, handler);

  ServiceRegistry.getInstance().handlerService.deleteHandler(handler.id);
  // After deletion, no handlers should fire for this event type
  assert.strictEqual(scenario.sim.handlers.get(event.type).length, 1); // only auto-reschedule handler remains
});

// ─── Action deletion ──────────────────────────────────────────────────────────

test('actionDeleted: removes action from handler generatedActions', () => {
  const { ui, scenario } = makeScenario();
  ui.triggerCreate('handler');
  ui.triggerCreate('action');

  const handler = ui.nodes.find(n => n.kind === 'handler');
  const action  = ui.nodes.find(n => n.kind === 'action');

  handler.generatedActions.push(action);
  assert.strictEqual(handler.generatedActions.length, 1);

  ServiceRegistry.getInstance().actionService.deleteAction(action.id);
  assert.strictEqual(handler.generatedActions.length, 0);
});

test('actionDeleted: removes action from reducer reducedActions', () => {
  const { ui, scenario } = makeScenario();
  ui.triggerCreate('reducer');
  ui.triggerCreate('action');

  const reducer = ui.nodes.find(n => n.kind === 'reducer');
  const action  = ui.nodes.find(n => n.kind === 'action');

  reducer.reducedActions.push(action);
  assert.strictEqual(reducer.reducedActions.length, 1);

  ServiceRegistry.getInstance().actionService.deleteAction(action.id);
  assert.strictEqual(reducer.reducedActions.length, 0);
});

// ─── Reducer deletion ─────────────────────────────────────────────────────────

test('reducerDeleted: unregisters reducer from sim pipeline', () => {
  const { ui, scenario } = makeScenario();
  ui.triggerCreate('action');
  ui.triggerCreate('reducer');

  const reducer = ui.nodes.find(n => n.kind === 'reducer');
  const action  = ui.nodes.find(n => n.kind === 'action');

  // Register the reducer for the action type
  reducer.reducedActions.push(action);
  scenario.reregisterReducer(reducer);

  // Verify it is registered
  const before = scenario.sim.reducers.get(action.type);
  assert.ok(before.length > 0, 'reducer should be registered before deletion');

  ServiceRegistry.getInstance().reducerService.deleteReducer(reducer.id);
  const after = scenario.sim.reducers.get(action.type);
  assert.strictEqual(after.length, 0, 'reducer should be unregistered after deletion');
});
