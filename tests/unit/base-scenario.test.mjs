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
 *
 * Tests for BaseScenario: service-as-entry-point wiring, creation listener flow,
 * ID counters, and sim cleanup via bus events.
 *
 * Objects are inserted via service.register() or service.create*().  The bus
 * propagates CREATE → BaseScenario wires sim; UPDATE/DELETE follow unchanged.
 *
 * Run with: node --test tests/unit/base-scenario.test.mjs
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
import { FieldReducer } from '../../src/simulation-framework/reducers.js';
import { ReducerBuilder } from '../../src/simulation-framework/builders/reducer-builder.js';

// BaseScenario references FinSimLib as a browser global — provide it here.
globalThis.FinSimLib = {
  Core:      { Simulation, HandlerEntry, AmountAction, FieldReducer, BaseEvent, EventSeries, OneOffEvent },
  Scenarios: {},
};

// ─── Stub EventSchedulerUI ────────────────────────────────────────────────────

class StubSchedulerUI {
  constructor() {
    this.nodes       = [];
    this.editedNodes = [];
    this._listeners  = {
      eventCreated: [], handlerCreated: [], actionCreated: [], reducerCreated: [],
    };
  }

  registerEventCreatedListener(l)   { this._listeners.eventCreated.push(l); }
  registerHandlerCreatedListener(l) { this._listeners.handlerCreated.push(l); }
  registerActionCreatedListener(l)  { this._listeners.actionCreated.push(l); }
  registerReducerCreatedListener(l) { this._listeners.reducerCreated.push(l); }

  addEvent(e)   { e.kind = 'event'; this.nodes.push(e); }
  addHandler(h) { this.nodes.push(h); }
  addAction(a)  { this.nodes.push(a); }
  addReducer(r) { this.nodes.push(r); }
  editNode(n)   { this.editedNodes.push(n); }

  triggerCreate(kind, subtype) {
    if (kind === 'event')   this._listeners.eventCreated.forEach(l => l(subtype));
    if (kind === 'handler') this._listeners.handlerCreated.forEach(l => l());
    if (kind === 'action')  this._listeners.actionCreated.forEach(l => l());
    if (kind === 'reducer') this._listeners.reducerCreated.forEach(l => l());
  }
}

function makeScenario() {
  ServiceRegistry.reset();
  const ui       = new StubSchedulerUI();

  // Subscribe to bus so the stub UI reacts to CREATE events — mirrors what
  // EventScheduler does in production.
  ServiceRegistry.getInstance().bus.subscribe('SERVICE_ACTION', (msg) => {
    if (msg.actionType !== 'CREATE') return;
    const { classType, item } = msg;
    if (classType === 'EventSeries' || classType === 'OneOffEvent') { item.kind = 'event'; ui.nodes.push(item); }
    else if (classType === 'HandlerEntry') ui.nodes.push(item);
    else if (['AmountAction', 'RecordBalanceAction','ScriptedAction',
      'FieldValueAction', 'FieldAction', 'Action'].includes(classType)) ui.nodes.push(item);
    else if ([,'ArrayReducer','NumericSumReducer',
              'MultiplicativeReducer','NoOpReducer','FieldReducer', 'FieldValueReducer'
              ,'AccountTransactionReducer','ScriptedReducer'].includes(classType)) ui.nodes.push(item);
  });

  const scenario = new BaseScenario({ eventSchedulerUI: ui });
  scenario.buildSim({}, { metrics: {} });
  return { ui, scenario };
}

// ─── service.register() → ID assignment ──────────────────────────────────────

test('handlerService.register: assigns incrementing IDs h1, h2, h3', () => {
  const { scenario } = makeScenario();
  const { handlerService } = ServiceRegistry.getInstance();
  const h1 = new HandlerEntry(() => [], 'A');
  const h2 = new HandlerEntry(() => [], 'B');
  const h3 = new HandlerEntry(() => [], 'C');
  handlerService.register(h1);
  handlerService.register(h2);
  handlerService.register(h3);
  assert.strictEqual(h1.id, 'h1');
  assert.strictEqual(h2.id, 'h2');
  assert.strictEqual(h3.id, 'h3');
});

test('reducerService.register: assigns incrementing IDs r1, r2', () => {
  const { scenario } = makeScenario();
  const { reducerService } = ServiceRegistry.getInstance();
  const r1 = ReducerBuilder.field('a').name('R1').build();
  const r2 = ReducerBuilder.field('b').name('R2').build();
  reducerService.register(r1);
  reducerService.register(r2);
  assert.strictEqual(r1.id, 'r1');
  assert.strictEqual(r2.id, 'r2');
});

// ─── service.register() → sim wiring (CREATE path) ───────────────────────────

test('eventService.register: enabled EventSeries is scheduled in sim', () => {
  const { scenario } = makeScenario();
  const event = new EventSeries({
    name: 'Monthly', type: 'MONTHLY_TEST', interval: 'month-end', enabled: true, color: '#fff'
  });
  ServiceRegistry.getInstance().eventService.register(event);
  assert.ok(ServiceRegistry.getInstance().simulationSync._registeredRecurringTypes.has('MONTHLY_TEST'),
    'enabled series should be in _registeredRecurringTypes after register');
});

test('eventService.register: disabled EventSeries is not scheduled in sim', () => {
  const { scenario } = makeScenario();
  const event = new EventSeries({
    name: 'Monthly', type: 'MONTHLY_DISABLED', interval: 'month-end', enabled: false, color: '#fff'
  });
  ServiceRegistry.getInstance().eventService.register(event);
  assert.ok(!ServiceRegistry.getInstance().simulationSync._registeredRecurringTypes.has('MONTHLY_DISABLED'),
    'disabled series should not be scheduled');
});

test('eventService.register: enabled OneOffEvent is placed in sim queue', () => {
  const { scenario } = makeScenario();
  const futureDate = new Date(Date.UTC(2035, 5, 1));
  const event = new OneOffEvent({
    name: 'One-Off', type: 'ONE_OFF_TEST', date: futureDate, enabled: true, color: '#fff'
  });
  ServiceRegistry.getInstance().eventService.register(event);
  // Queue should contain at least the one-off event
  assert.ok(scenario.sim.queue.size() > 0, 'one-off event should be in sim queue');
});

test('handlerService.register: handler is wired into sim for each handledEvent', () => {
  const { scenario } = makeScenario();
  const sr = ServiceRegistry.getInstance();

  const event = new EventSeries({ name: 'E', type: 'H_WIRE_TEST', interval: 'month-end', enabled: true, color: '#fff' });
  sr.eventService.register(event);

  const handler = new HandlerEntry(() => [], 'H');
  handler.handledEvents.push(event);
  sr.handlerService.register(handler);

  // The sim should have the user handler registered for the event type
  // (plus the auto-reschedule handler from the series — so at least 2)
  const handlers = scenario.sim.handlers.get('H_WIRE_TEST');
  assert.ok(handlers.length >= 2, 'handler should be registered with sim');
  assert.ok(handlers.some(h => h === handler || h.handler === handler));
});

test('reducerService.register: reducer is wired into sim for each reducedAction', () => {
  const { scenario } = makeScenario();
  const sr = ServiceRegistry.getInstance();

  const action = new AmountAction('PAY_TEST', 'Pay', 100);
  sr.actionService.register(action);

  const reducer = ReducerBuilder.field('amount').name('Metric R').build();
  reducer.reducedActions.push(action);
  sr.reducerService.register(reducer);

  const reducers = scenario.sim.reducers.get('PAY_TEST');
  assert.ok(reducers.length > 0, 'reducer should be registered with sim after register()');
});

// ─── Event creation via UI ────────────────────────────────────────────────────

test('eventCreationRequested Series: node appears in UI via bus with e1 id', () => {
  const { ui } = makeScenario();
  ui.triggerCreate('event', 'Series');
  const events = ui.nodes.filter(n => n.kind === 'event');
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].id, 'e1');
  assert.ok(events[0] instanceof EventSeries, 'should be an EventSeries');
  assert.strictEqual(events[0].enabled, false);
});

test('eventCreationRequested OneOff: node appears in UI via bus with date field', () => {
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

// ─── Handler creation via UI ──────────────────────────────────────────────────

test('handlerCreationRequested: node appears in UI via bus with h1 id', () => {
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

// ─── Action creation via UI ───────────────────────────────────────────────────

test('actionCreationRequested: node appears in UI via bus with service-generated id', () => {
  const { ui } = makeScenario();
  ui.triggerCreate('action');
  const actions = ui.nodes.filter(n => n.kind === 'action');
  assert.strictEqual(actions.length, 1);
  assert.ok(actions[0] instanceof AmountAction);
  assert.strictEqual(actions[0].id, 'a1');
  assert.strictEqual(actions[0].type, 'NEW_ACTION');
});

test('actionCreationRequested: opens editor for created node', () => {
  const { ui } = makeScenario();
  ui.triggerCreate('action');
  assert.strictEqual(ui.editedNodes.length, 1);
});

// ─── Reducer creation via UI ──────────────────────────────────────────────────

test('reducerCreationRequested: node appears in UI via bus with r1 id', () => {
  const { ui } = makeScenario();
  ui.triggerCreate('reducer');
  const reducers = ui.nodes.filter(n => n.kind === 'reducer');
  assert.strictEqual(reducers.length, 1);
  assert.strictEqual(reducers[0].id, 'r1');
  assert.ok(reducers[0] instanceof FieldReducer);
});

test('reducerCreationRequested: opens editor for created node', () => {
  const { ui } = makeScenario();
  ui.triggerCreate('reducer');
  assert.strictEqual(ui.editedNodes.length, 1);
  assert.strictEqual(ui.editedNodes[0].id, 'r1');
});

// ─── Enable / disable via service UPDATE ─────────────────────────────────────

test('enabling a registered event via service update schedules it in sim', () => {
  const { ui, scenario } = makeScenario();
  ui.triggerCreate('event', 'Series');
  const event = ui.nodes.find(n => n.kind === 'event');

  assert.doesNotThrow(() => {
    ServiceRegistry.getInstance().eventService.updateEvent(event.id, { enabled: true });
  });
  assert.ok(ServiceRegistry.getInstance().simulationSync._registeredRecurringTypes.has(event.type));
});

test('disabling an enabled event via service update unschedules it from sim', () => {
  const { scenario } = makeScenario();
  const event = new EventSeries({
    name: 'Test', type: 'TEST_EVT', interval: 'month-end', enabled: true, color: '#fff'
  });
  ServiceRegistry.getInstance().eventService.register(event);
  assert.ok(ServiceRegistry.getInstance().simulationSync._registeredRecurringTypes.has('TEST_EVT'));

  assert.doesNotThrow(() => {
    ServiceRegistry.getInstance().eventService.updateEvent(event.id, { enabled: false });
  });
});

// ─── Event deletion ───────────────────────────────────────────────────────────

test('eventDeleted: removes event from _registeredRecurringTypes', () => {
  const { scenario } = makeScenario();
  const event = new EventSeries({
    name: 'Test', type: 'DELETE_EVT', interval: 'month-end', enabled: true, color: '#fff'
  });
  ServiceRegistry.getInstance().eventService.register(event);
  assert.ok(ServiceRegistry.getInstance().simulationSync._registeredRecurringTypes.has('DELETE_EVT'));

  ServiceRegistry.getInstance().eventService.deleteEvent(event.id);
  assert.ok(!ServiceRegistry.getInstance().simulationSync._registeredRecurringTypes.has('DELETE_EVT'));
});

test('eventDeleted: disabled event can be deleted without error', () => {
  const { ui } = makeScenario();
  ui.triggerCreate('event', 'Series');
  const event = ui.nodes.find(n => n.kind === 'event');
  assert.doesNotThrow(() => ServiceRegistry.getInstance().eventService.deleteEvent(event.id));
});

// ─── Handler deletion ─────────────────────────────────────────────────────────

test('handlerDeleted: unregisters handler from sim', () => {
  const { scenario } = makeScenario();
  const sr = ServiceRegistry.getInstance();

  const event = new EventSeries({ name: 'Ev', type: 'TEST_HANDLER_EVT', interval: 'month-end', enabled: true, color: '#aaa' });
  sr.eventService.register(event);

  const handler = new HandlerEntry(() => [], 'H');
  handler.handledEvents.push(event);
  sr.handlerService.register(handler);

  sr.handlerService.deleteHandler(handler.id);
  // Only the auto-reschedule handler should remain
  assert.strictEqual(scenario.sim.handlers.get(event.type).length, 1);
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
  const { scenario } = makeScenario();
  const sr = ServiceRegistry.getInstance();

  const action = new AmountAction('DEL_ACTION', 'Del', 0);
  sr.actionService.register(action);

  const reducer = ReducerBuilder.field('x').name('R').build();
  reducer.reducedActions.push(action);
  sr.reducerService.register(reducer);

  const before = scenario.sim.reducers.get('DEL_ACTION');
  assert.ok(before.length > 0, 'reducer should be registered before deletion');

  sr.reducerService.deleteReducer(reducer.id);
  const after = scenario.sim.reducers.get('DEL_ACTION');
  assert.strictEqual(after.length, 0, 'reducer should be unregistered after deletion');
});
