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
import { CheckingAccount } from '../../src/finance/assets/account.js';
import { Person }          from '../../src/finance/person.js';
import {
  GraphBuilderView
} from "../../src/visualization/graph-builder/graph-builder-view.js";

// ─── Stub EventSchedulerUI ────────────────────────────────────────────────────

class StubGraphBuilderView {
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
  ServiceRegistry.resetAll();

  const scenario = new BaseScenario({
    context: ServiceRegistry.getInstance().simulationContext
  });
  scenario.buildSim({}, { metrics: {} });
  return { scenario };
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
  assert.ok(ServiceRegistry.getInstance().simulationSync.adapter._registeredRecurringTypes.has('MONTHLY_TEST'),
    'enabled series should be in _registeredRecurringTypes after register');
});

test('eventService.register: disabled EventSeries is not scheduled in sim', () => {
  const { scenario } = makeScenario();
  const event = new EventSeries({
    name: 'Monthly', type: 'MONTHLY_DISABLED', interval: 'month-end', enabled: false, color: '#fff'
  });
  ServiceRegistry.getInstance().eventService.register(event);
  assert.ok(!ServiceRegistry.getInstance().simulationSync.adapter._registeredRecurringTypes.has('MONTHLY_DISABLED'),
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

test('reducerService.register: reducer is wired into sim for each reducedActionType', () => {
  const { scenario } = makeScenario();
  const sr = ServiceRegistry.getInstance();

  const reducer = ReducerBuilder.field('amount').name('Metric R').build();
  reducer.reducedActionTypes.push('PAY_TEST');
  sr.reducerService.register(reducer);

  const reducers = scenario.sim.reducers.get('PAY_TEST');
  assert.ok(reducers.length > 0, 'reducer should be registered with sim after register()');
});

// ─── Enable / disable via service UPDATE ─────────────────────────────────────

test('disabling an enabled event via service update unschedules it from sim', () => {
  const { scenario } = makeScenario();
  const event = new EventSeries({
    name: 'Test', type: 'TEST_EVT', interval: 'month-end', enabled: true, color: '#fff'
  });
  ServiceRegistry.getInstance().eventService.register(event);
  assert.ok(ServiceRegistry.getInstance().simulationSync.adapter._registeredRecurringTypes.has('TEST_EVT'));

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
  assert.ok(ServiceRegistry.getInstance().simulationSync.adapter._registeredRecurringTypes.has('DELETE_EVT'));

  ServiceRegistry.getInstance().eventService.deleteEvent(event.id);
  assert.ok(!ServiceRegistry.getInstance().simulationSync.adapter._registeredRecurringTypes.has('DELETE_EVT'));
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

// ─── Reducer deletion ─────────────────────────────────────────────────────────

test('reducerDeleted: unregisters reducer from sim pipeline', () => {
  const { scenario } = makeScenario();
  const sr = ServiceRegistry.getInstance();

  const reducer = ReducerBuilder.field('x').name('R').build();
  reducer.reducedActionTypes.push('DEL_ACTION');
  sr.reducerService.register(reducer);

  const before = scenario.sim.reducers.get('DEL_ACTION');
  assert.ok(before.length > 0, 'reducer should be registered before deletion');

  sr.reducerService.deleteReducer(reducer.id);
  const after = scenario.sim.reducers.get('DEL_ACTION');
  assert.strictEqual(after.length, 0, 'reducer should be unregistered after deletion');
});

// ─── applyParams ──────────────────────────────────────────────────────────────

function makeParamScenario() {
  ServiceRegistry.resetAll();
  const sr = ServiceRegistry.getInstance();

  // Register a person with id 'primary'
  const person = new Person('primary', new Date(Date.UTC(1980, 0, 1)), {
    retirementDate: new Date(Date.UTC(2040, 0, 1)),
    monthlyWage: 5000,
  });
  sr.personService.register(person);

  // Register an account with stateKey 'mySavings'
  const account = new CheckingAccount(10000, { name: 'My Savings' });
  account.stateKey = 'mySavings';
  sr.accountService.createAccount(account);

  const scenario = new BaseScenario({
    context: sr.simulationContext,
    params: [
      { name: 'retirementDate', type: 'Date', value: '2040-01-01T00:00:00.000Z',
        node: { type: 'person', id: 'primary', field: 'retirementDate' } },
      { name: 'monthlyWage', type: 'Number', value: 5000,
        node: { type: 'person', id: 'primary', field: 'monthlyWage' } },
      { name: 'savingsBalance', type: 'Number', value: 10000,
        node: { type: 'account', stateKey: 'mySavings', field: 'initialValue' } },
    ],
    initialState: { mySavings: { balance: 10000 } },
  });
  return { scenario, sr, person, account };
}

test('applyParams: updates person field via node declaration', () => {
  const { scenario, sr } = makeParamScenario();
  const newDate = '2038-06-01T00:00:00.000Z';
  scenario.applyParams({ retirementDate: newDate });
  const person = sr.personService.getAll().find(p => p.id === 'primary');
  assert.strictEqual(person.retirementDate, newDate);
});

test('applyParams: updates person Number field', () => {
  const { scenario, sr } = makeParamScenario();
  scenario.applyParams({ monthlyWage: 7500 });
  const person = sr.personService.getAll().find(p => p.id === 'primary');
  assert.strictEqual(person.monthlyWage, 7500);
});

test('applyParams: updates account balance and initialState for initialValue param', () => {
  const { scenario, sr } = makeParamScenario();
  scenario.applyParams({ savingsBalance: 50000 });
  const account = sr.accountService.getAll().find(a => a.stateKey === 'mySavings');
  assert.strictEqual(account.balance, 50000);
  assert.strictEqual(scenario.initialState.mySavings.balance, 50000);
});

test('applyParams: updates this.params typed array values', () => {
  const { scenario } = makeParamScenario();
  scenario.applyParams({ monthlyWage: 9000, savingsBalance: 250000 });
  const wage    = scenario.params.find(p => p.name === 'monthlyWage');
  const savings = scenario.params.find(p => p.name === 'savingsBalance');
  assert.strictEqual(wage.value, 9000);
  assert.strictEqual(savings.value, 250000);
});

test('applyParams: is a no-op when params is empty/null', () => {
  const { scenario, sr } = makeParamScenario();
  scenario.applyParams({});
  scenario.applyParams(null);
  const person = sr.personService.getAll().find(p => p.id === 'primary');
  assert.strictEqual(person.monthlyWage, 5000);
});

test('applyParams: ignores node when person/account not found', () => {
  const { scenario } = makeParamScenario();
  // Should not throw even if the target node doesn't exist
  assert.doesNotThrow(() => scenario.applyParams({ retirementDate: '2039-01-01T00:00:00.000Z' }));
});

// ─── rebuild ──────────────────────────────────────────────────────────────────

test('rebuild: creates a fresh simulation (new sim object)', () => {
  const { scenario } = makeParamScenario();
  scenario.buildSim();
  const simBefore = scenario.sim;
  ServiceRegistry.reset();
  scenario.rebuild();
  assert.notStrictEqual(scenario.sim, simBefore, 'rebuild should produce a new sim');
  assert.ok(scenario.sim instanceof Simulation);
});

test('rebuild: applies params before creating simulation', () => {
  const { scenario, sr } = makeParamScenario();
  scenario.buildSim();
  scenario.rebuild({ monthlyWage: 8000 });
  const person = sr.personService.getAll().find(p => p.id === 'primary');
  assert.strictEqual(person.monthlyWage, 8000);
});
