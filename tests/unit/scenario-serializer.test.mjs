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
 * scenario-serializer.test.mjs
 *
 * Tests that ScenarioSerializer.deserialize registers every node from a saved
 * config — including nodes added beyond the built-in defaults — into the
 * scenario's scheduler UI.
 *
 * Regression coverage for the bug where newly-added event/handler/action/reducer
 * nodes were missing from the graph after a save-and-reload cycle.
 *
 * Run with: node --test tests/scenario-serializer.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ScenarioSerializer } from '../../src/scenarios/scenario-serializer.js';
import { ServiceRegistry }    from '../../src/services/service-registry.js';
import { BaseScenario }       from '../../src/scenarios/base-scenario.js';
import { Simulation }         from '../../src/simulation-framework/simulation.js';
import { EventSeries }        from '../../src/simulation-framework/events/event-series.js';
import { OneOffEvent }        from '../../src/simulation-framework/events/one-off-event.js';
import { HandlerEntry }       from '../../src/simulation-framework/handlers.js';
import {
  AmountAction,
  Action,
  FieldAction,
  FieldValueAction,
  RecordBalanceAction,
  ScriptedAction,
} from '../../src/simulation-framework/actions.js';
import {
  NumericSumReducer,
  ArrayReducer,
  MultiplicativeReducer,
  NoOpReducer,
} from '../../src/simulation-framework/reducers.js';
import { ReducerBuilder } from '../../src/simulation-framework/builders/reducer-builder.js';
import { Person } from '../../src/finance/person.js';

// ─── FinSimLib global (required by BaseScenario and ScenarioSerializer) ────────

globalThis.FinSimLib = {
  Finance: { Person },
  Core: {
    Simulation,
    HandlerEntry,
    AmountAction,
    Action,
    FieldAction,
    FieldValueAction,
    RecordBalanceAction,
    ScriptedAction,
    NumericSumReducer,
    ArrayReducer,
    MultiplicativeReducer,
    NoOpReducer,
    ReducerBuilder,
    EventSeries,
    OneOffEvent,
  },
};

// ─── Tracking scheduler UI stub ───────────────────────────────────────────────
//
// Subscribes to the shared bus (just like the real ConfigBuilder does) and
// adds nodes to this.nodes on CREATE events.  This means ScenarioSerializer
// no longer needs to know about the UI — nodes arrive via the bus.

const ACTION_CLASSES = new Set([
  'AmountAction', 'RecordBalanceAction','ScriptedAction',
  'FieldValueAction', 'FieldAction', 'Action',
]);
const REDUCER_CLASSES = new Set([
  ,'ArrayReducer','NumericSumReducer',
  'MultiplicativeReducer','NoOpReducer',
  'AccountTransactionReducer','ScriptedReducer', 'FieldValueReducer', 'FieldReducer'
]);

class TrackingUI {
  constructor() {
    this.nodes = [];
    // BaseScenario constructor registers creation listeners — we must accept them.
    this._listeners = {
      eventCreated: [], handlerCreated: [], actionCreated: [], reducerCreated: [],
    };

    // React to CREATE events on the bus, mirroring ConfigBuilder behaviour.
    ServiceRegistry.getInstance().bus.subscribe('SERVICE_ACTION', (msg) => {
      if (msg.actionType !== 'CREATE') return;
      const { classType, item } = msg;
      if (classType === 'EventSeries' || classType === 'OneOffEvent') {
        this._addEvent(item);
      } else if (classType === 'HandlerEntry') {
        this._addHandler(item);
      } else if (ACTION_CLASSES.has(classType)) {
        this._addAction(item);
      } else if (REDUCER_CLASSES.has(classType)) {
        this._addReducer(item);
      }
    });
  }

  registerEventCreatedListener(l)   { this._listeners.eventCreated.push(l); }
  registerHandlerCreatedListener(l) { this._listeners.handlerCreated.push(l); }
  registerActionCreatedListener(l)  { this._listeners.actionCreated.push(l); }
  registerReducerCreatedListener(l) { this._listeners.reducerCreated.push(l); }

  _addEvent(e) {
    if (this.nodes.find(n => n.id === e.id)) return; // idempotent
    e.kind = 'event';
    // Stamp eventType so _serializeEvent works.
    if (e instanceof OneOffEvent) {
      e.eventType = 'OneOff';
    } else {
      e.eventType = 'Series';
    }
    this.nodes.push(e);
  }

  _addAction(a) {
    if (!this.nodes.find(n => n.id === a.id)) {
      this.nodes.push(a);
    }
  }

  _addHandler(h) {
    if (!this.nodes.find(n => n.id === h.id)) {
      this.nodes.push(h);
    }
  }

  _addReducer(r) {
    if (!this.nodes.find(n => n.id === r.id)) {
      this.nodes.push(r);
    }
  }

  editNode() {}

  nodeIds() { return this.nodes.map(n => n.id); }
  ofKind(k) { return this.nodes.filter(n => n.kind === k); }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeScenario() {
  ServiceRegistry.reset();
  const ui       = new TrackingUI();
  const scenario = new BaseScenario({ eventSchedulerUI: ui });
  scenario.buildSim({}, { metrics: { amount: 0, salary: 0 } });
  return { ui, scenario };
}

// ─── Test configs ─────────────────────────────────────────────────────────────

// Minimal config: single event, handler, action, reducer (the "defaults").
const MINIMAL_CONFIG = {
  simStart: '2026-01-01',
  simEnd:   '2041-01-01',
  events: [
    { __type: 'EventSeries', id: 'e1', name: 'Month End', type: 'MONTH_END',
      enabled: true, color: '#F44336', interval: 'month-end', startOffset: 0 },
  ],
  handlers: [
    { __type: 'HandlerEntry', id: 'h1', name: 'Month End Handler',
      handledEventIds: ['e1'], generatedActionTypes: ['RECORD_METRIC'],
      generatedActionDefinitions: [] },
  ],
  actions: [
    { __type: 'AmountAction', id: 'RECORD_METRIC', name: 'Pay Salary',
      type: 'RECORD_METRIC', value: 1200, fieldName: 'metrics.amount' },
  ],
  reducers: [
    { __type: 'FieldReducer', id: 'r1', name: 'Process Payment',
      priority: 90, fieldName: 'metrics.amount',
      reducedActionTypes: ['RECORD_METRIC'], generatedActionTypes: [],
      generatedActionDefinitions: [] },
  ],
  initialState: { metrics: { amount: 0 } },
  params: [],
};

// Extended config replicating the user's bug report: four additional nodes
// (e2, h2, NEW_ACTION_a1, r4) that were missing from the graph after reload.
const EXTENDED_CONFIG = {
  simStart: '2026-01-01',
  simEnd:   '2041-01-01',
  events: [
    { __type: 'EventSeries', id: 'e1', name: 'Month End', type: 'MONTH_END',
      enabled: true, color: '#F44336', interval: 'month-end', startOffset: 0 },
    { __type: 'EventSeries', id: 'e2', name: 'Annual Event', type: 'NEW_SERIES_e2',
      enabled: true, color: '#60a5fa', interval: 'annually', startOffset: 0 },
  ],
  handlers: [
    { __type: 'HandlerEntry', id: 'h1', name: 'Month End Handler',
      handledEventIds: ['e1'], generatedActionTypes: ['RECORD_METRIC'],
      generatedActionDefinitions: [] },
    { __type: 'HandlerEntry', id: 'h2', name: 'Year End Handler',
      handledEventIds: ['e2'], generatedActionTypes: ['NEW_ACTION_a1'],
      generatedActionDefinitions: [] },
  ],
  actions: [
    { __type: 'AmountAction', id: 'RECORD_METRIC', name: 'Pay Salary',
      type: 'RECORD_METRIC', value: 1200, fieldName: 'metrics.amount' },
    { __type: 'FieldAction', id: 'RECORD_NUMERIC_SUM_METRIC',
      name: 'Sum Payments', type: 'RECORD_NUMERIC_SUM_METRIC', fieldName: 'metrics.amount' },
    { __type: 'AmountAction', id: 'NEW_ACTION_a1', name: 'Pay Taxes',
      type: 'NEW_ACTION_a1', value: 0, fieldName: 'salary' },
  ],
  reducers: [
    { __type: 'FieldReducer', id: 'r1', name: 'Process Salary Payment Amount',
      priority: 90, fieldName: 'metrics.amount',
      reducedActionTypes: ['RECORD_METRIC'], generatedActionTypes: ['RECORD_NUMERIC_SUM_METRIC'],
      generatedActionDefinitions: [] },
    { __type: 'NumericSumReducer', id: 'r2', name: 'Update Total Salary',
      priority: 90, fieldName: 'metrics.salary',
      reducedActionTypes: ['RECORD_NUMERIC_SUM_METRIC'], generatedActionTypes: [],
      generatedActionDefinitions: [] },
    { __type: 'ArrayReducer', id: 'r3', name: 'Deposit Payment',
      priority: 90, fieldName: 'metrics.deposits',
      reducedActionTypes: ['RECORD_METRIC'], generatedActionTypes: [],
      generatedActionDefinitions: [] },
    { __type: 'FieldReducer', id: 'r4', name: 'Tax Owed',
      priority: 90, fieldName: 'metrics.',
      reducedActionTypes: ['NEW_ACTION_a1'], generatedActionTypes: [],
      generatedActionDefinitions: [] },
  ],
  initialState: { metrics: { amount: 0, salary: 0 } },
  params: [],
};

// ─── Minimal config: basic deserialize correctness ────────────────────────────

test('deserialize minimal: event e1 is added to the scheduler UI', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(MINIMAL_CONFIG, ServiceRegistry.getInstance());
  assert.ok(ui.nodeIds().includes('e1'), 'e1 should be present');
});

test('deserialize minimal: handler h1 is added to the scheduler UI', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(MINIMAL_CONFIG, ServiceRegistry.getInstance());
  assert.ok(ui.nodeIds().includes('h1'), 'h1 should be present');
});

test('deserialize minimal: action RECORD_METRIC is added via the handler', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(MINIMAL_CONFIG, ServiceRegistry.getInstance());
  assert.ok(ui.nodeIds().includes('RECORD_METRIC'), 'RECORD_METRIC should be present');
});

test('deserialize minimal: reducer r1 is added to the scheduler UI', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(MINIMAL_CONFIG, ServiceRegistry.getInstance());
  assert.ok(ui.nodeIds().includes('r1'), 'r1 should be present');
});

// ─── Extended config: regression for missing-new-nodes bug ────────────────────

test('deserialize extended: e1 (original event) is present', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, ServiceRegistry.getInstance());
  assert.ok(ui.nodeIds().includes('e1'));
});

test('deserialize extended: e2 (added event) is present — regression', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, ServiceRegistry.getInstance());
  assert.ok(ui.nodeIds().includes('e2'), 'e2 was missing before the fix');
});

test('deserialize extended: h1 (original handler) is present', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, ServiceRegistry.getInstance());
  assert.ok(ui.nodeIds().includes('h1'));
});

test('deserialize extended: h2 (added handler) is present — regression', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, ServiceRegistry.getInstance());
  assert.ok(ui.nodeIds().includes('h2'), 'h2 was missing before the fix');
});

test('deserialize extended: RECORD_METRIC action is present', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, ServiceRegistry.getInstance());
  assert.ok(ui.nodeIds().includes('RECORD_METRIC'));
});

test('deserialize extended: NEW_ACTION_a1 (added action) is present — regression', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, ServiceRegistry.getInstance());
  assert.ok(
    ui.nodeIds().includes('NEW_ACTION_a1'),
    'NEW_ACTION_a1 was missing before the fix'
  );
});

test('deserialize extended: RECORD_NUMERIC_SUM_METRIC action is present', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, ServiceRegistry.getInstance());
  assert.ok(ui.nodeIds().includes('RECORD_NUMERIC_SUM_METRIC'));
});

test('deserialize extended: r1, r2, r3 (original reducers) are present', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, ServiceRegistry.getInstance());
  assert.ok(ui.nodeIds().includes('r1'));
  assert.ok(ui.nodeIds().includes('r2'));
  assert.ok(ui.nodeIds().includes('r3'));
});

test('deserialize extended: r4 (added reducer) is present — regression', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, ServiceRegistry.getInstance());
  assert.ok(ui.nodeIds().includes('r4'), 'r4 was missing before the fix');
});

test('deserialize extended: total node count matches all config entries', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, ServiceRegistry.getInstance());
  // 2 events + 2 handlers + 3 actions + 4 reducers = 11 nodes
  assert.strictEqual(ui.nodes.length, 11,
    `expected 11 nodes, got ${ui.nodes.length}: [${ui.nodeIds().join(', ')}]`);
});

// ─── Node kinds are set correctly ─────────────────────────────────────────────

test('deserialize extended: each event node has kind "event"', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, ServiceRegistry.getInstance());
  ui.ofKind('event').forEach(n => assert.strictEqual(n.kind, 'event'));
  assert.strictEqual(ui.ofKind('event').length, 2);
});

test('deserialize extended: each handler node has kind "handler"', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, ServiceRegistry.getInstance());
  assert.strictEqual(ui.ofKind('handler').length, 2);
});

test('deserialize extended: each action node has kind "action"', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, ServiceRegistry.getInstance());
  assert.strictEqual(ui.ofKind('action').length, 3);
});

test('deserialize extended: each reducer node has kind "reducer"', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, ServiceRegistry.getInstance());
  assert.strictEqual(ui.ofKind('reducer').length, 4);
});

// ─── ID counter advancement ───────────────────────────────────────────────────

test('deserialize advances eventService _nextId past the highest event id', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, ServiceRegistry.getInstance());
  // config has e1, e2 → service counter must be at least 3
  const nextId = ServiceRegistry.getInstance().eventService._nextId;
  assert.ok(nextId >= 3,
    `eventService._nextId should be ≥ 3, got ${nextId}`);
});

test('deserialize advances reducerService _nextId past the highest reducer id', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, ServiceRegistry.getInstance());
  // config has r1..r4 → service counter must be at least 5
  const nextId = ServiceRegistry.getInstance().reducerService._nextId;
  assert.ok(nextId >= 5,
    `reducerService._nextId should be ≥ 5, got ${nextId}`);
});

// ─── Disabled events ──────────────────────────────────────────────────────────

test('deserialize: disabled event is added to UI without being scheduled', () => {
  const cfg = {
    ...MINIMAL_CONFIG,
    events: [
      { ...MINIMAL_CONFIG.events[0], id: 'e-off', type: 'OFF_EVT', enabled: false },
    ],
    handlers: [],
    reducers: [],
    actions: [],
  };
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(cfg, ServiceRegistry.getInstance());
  assert.ok(ui.nodeIds().includes('e-off'), 'disabled event should still appear in the UI');
  // It must not be scheduled in the sim
  assert.ok(!ServiceRegistry.getInstance().simulationSync._registeredRecurringTypes.has('OFF_EVT'),
    'disabled event should not be in _registeredRecurringTypes');
});

// ─── serialize: basic correctness ─────────────────────────────────────────────

/** Helper: serialize the current ServiceRegistry state into a config object. */
function serializeNow(name = 'Test', initialState = {}) {
  return ScenarioSerializer.serialize(
    ServiceRegistry.getInstance(),
    name,
    '2026-01-01',
    '2041-01-01',
    initialState,
    [],
  );
}

test('serialize: returns arrays for events, handlers, actions, reducers', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(MINIMAL_CONFIG, ServiceRegistry.getInstance());
  const cfg = serializeNow();
  assert.ok(Array.isArray(cfg.events),   'events should be an array');
  assert.ok(Array.isArray(cfg.handlers), 'handlers should be an array');
  assert.ok(Array.isArray(cfg.actions),  'actions should be an array');
  assert.ok(Array.isArray(cfg.reducers), 'reducers should be an array');
});

test('serialize: minimal config produces correct node counts', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(MINIMAL_CONFIG, ServiceRegistry.getInstance());
  const cfg = serializeNow();
  assert.strictEqual(cfg.events.length,   1, 'one event');
  assert.strictEqual(cfg.handlers.length, 1, 'one handler');
  assert.strictEqual(cfg.reducers.length, 1, 'one reducer');
});

test('serialize: event __type is EventSeries for a recurring event', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(MINIMAL_CONFIG, ServiceRegistry.getInstance());
  const cfg = serializeNow();
  assert.strictEqual(cfg.events[0].__type, 'EventSeries');
});

test('serialize: reducer __type matches the class set during registration', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(MINIMAL_CONFIG, ServiceRegistry.getInstance());
  const cfg = serializeNow();
  const r = cfg.reducers.find(r => r.id === 'r1');
  assert.strictEqual(r.__type, 'FieldReducer');
});

test('serialize: extended config produces correct node counts', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, ServiceRegistry.getInstance());
  const cfg = serializeNow();
  assert.strictEqual(cfg.events.length,   2);
  assert.strictEqual(cfg.handlers.length, 2);
  assert.strictEqual(cfg.reducers.length, 4);
});

// ─── serialize: regression — name/type edits survive a save ──────────────────
//
// These tests cover the reported bug: changes made via service.updateX() were
// not reflected in the serialized output when the serializer read from graph
// nodes instead of the service maps.

test('serialize regression: reducer name change is captured in saved config', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(MINIMAL_CONFIG, ServiceRegistry.getInstance());

  // Simulate what the UI reducer editor does when user types a new name
  ServiceRegistry.getInstance().reducerService.updateReducer('r1', { name: 'Renamed Reducer' });

  const cfg = serializeNow();
  const r = cfg.reducers.find(r => r.id === 'r1');
  assert.ok(r, 'r1 must be present in serialized output');
  assert.strictEqual(r.name, 'Renamed Reducer',
    'serialized name must match the value set via updateReducer');
});

test('serialize regression: reducer type change is captured in saved config', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(MINIMAL_CONFIG, ServiceRegistry.getInstance());

  // Simulate what the UI type-select does when user picks a different reducer type
  ServiceRegistry.getInstance().reducerService.replaceReducer('r1', 'NumericSumReducer');

  const cfg = serializeNow();
  const r = cfg.reducers.find(r => r.id === 'r1');
  assert.ok(r, 'r1 must be present in serialized output');
  assert.strictEqual(r.__type, 'NumericSumReducer',
    'serialized __type must reflect the reducerType set via updateReducer');
});

test('serialize regression: event name change is captured in saved config', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(MINIMAL_CONFIG, ServiceRegistry.getInstance());

  ServiceRegistry.getInstance().eventService.updateEvent('e1', { name: 'Renamed Event' });

  const cfg = serializeNow();
  const e = cfg.events.find(e => e.id === 'e1');
  assert.ok(e, 'e1 must be present in serialized output');
  assert.strictEqual(e.name, 'Renamed Event',
    'serialized event name must match the value set via updateEvent');
});

test('serialize regression: event type string change is captured in saved config', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(MINIMAL_CONFIG, ServiceRegistry.getInstance());

  ServiceRegistry.getInstance().eventService.updateEvent('e1', { type: 'CUSTOM_EVENT_TYPE' });

  const cfg = serializeNow();
  const e = cfg.events.find(e => e.id === 'e1');
  assert.strictEqual(e.type, 'CUSTOM_EVENT_TYPE',
    'serialized event type string must reflect the update');
});

test('serialize regression: handler name change is captured in saved config', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(MINIMAL_CONFIG, ServiceRegistry.getInstance());

  ServiceRegistry.getInstance().handlerService.updateHandler('h1', { name: 'Renamed Handler' });

  const cfg = serializeNow();
  const h = cfg.handlers.find(h => h.id === 'h1');
  assert.ok(h, 'h1 must be present in serialized output');
  assert.strictEqual(h.name, 'Renamed Handler',
    'serialized handler name must match the value set via updateHandler');
});

// ─── serialize: round-trip correctness ───────────────────────────────────────

test('serialize round-trip: serialize then deserialize into fresh scenario has same node IDs', () => {
  // First scenario: deserialize EXTENDED_CONFIG
  const { ui: ui1, scenario: s1 } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, ServiceRegistry.getInstance());
  const firstIds = ui1.nodeIds().sort();

  // Serialize the first scenario's services to a config
  const roundTripCfg = serializeNow('Round-Trip', EXTENDED_CONFIG.initialState);

  // Second scenario: deserialize the round-trip config
  const { ui: ui2, scenario: s2 } = makeScenario();
  ScenarioSerializer.deserialize(roundTripCfg, ServiceRegistry.getInstance());
  const secondIds = ui2.nodeIds().sort();

  assert.deepStrictEqual(secondIds, firstIds,
    'round-tripped scenario must have the same node IDs as the original');
});

// ─── Persons: serialize / deserialize round-trip ──────────────────────────────

test('serialize: persons array is included in the serialized output', () => {
  const { scenario } = makeScenario();
  const sr = ServiceRegistry.getInstance();

  sr.personService.createPerson(new Date(Date.UTC(1980, 0, 1)), { name: 'Alice', citizen: ['US'] });
  sr.personService.createPerson(new Date(Date.UTC(1985, 5, 15)), { name: 'Bob', citizen: ['AUS'] });

  const cfg = serializeNow();
  assert.ok(Array.isArray(cfg.persons), 'persons should be an array');
  assert.strictEqual(cfg.persons.length, 2);
});

test('serialize: person fields are correctly serialized', () => {
  const { scenario } = makeScenario();
  const sr = ServiceRegistry.getInstance();

  sr.personService.createPerson(new Date(Date.UTC(1980, 0, 1)), {
    name: 'Alice', citizen: ['US'], lifeExpectancy: 88, socialSecurityMonthly: 3000,
  });

  const cfg = serializeNow();
  const d = cfg.persons[0];
  assert.strictEqual(d.__type, 'Person');
  assert.strictEqual(d.name, 'Alice');
  assert.strictEqual(d.birthDate, '1980-01-01');
  assert.deepStrictEqual(d.citizen, ['US']);
  assert.strictEqual(d.lifeExpectancy, 88);
  assert.strictEqual(d.socialSecurityMonthly, 3000);
});

test('deserialize: persons are registered into personService with correct fields', () => {
  const { scenario } = makeScenario();
  const config = {
    ...MINIMAL_CONFIG,
    persons: [
      { __type: 'Person', id: 'p1', name: 'Alice', birthDate: '1980-01-01',
        citizen: ['US'], lifeExpectancy: 90, socialSecurityMonthly: 2800 },
      { __type: 'Person', id: 'p2', name: 'Bob', birthDate: '1985-06-15',
        citizen: ['AUS'], lifeExpectancy: 85, socialSecurityMonthly: 0 },
    ],
  };

  ScenarioSerializer.deserialize(config, ServiceRegistry.getInstance());

  const sr = ServiceRegistry.getInstance();
  assert.strictEqual(sr.personService.getAll().length, 2);

  const alice = sr.personService.get('p1');
  assert.strictEqual(alice.name, 'Alice');
  assert.deepStrictEqual(alice.citizen, ['US']);

  const bob = sr.personService.get('p2');
  assert.strictEqual(bob.name, 'Bob');
  assert.deepStrictEqual(bob.citizen, ['AUS']);
});

test('persons round-trip: serialize then deserialize preserves all person data', () => {
  const { scenario } = makeScenario();
  const sr = ServiceRegistry.getInstance();

  sr.personService.createPerson(new Date(Date.UTC(1975, 2, 10)), {
    name: 'Carol', citizen: ['US', 'AUS'], lifeExpectancy: 92, socialSecurityMonthly: 3200,
  });

  const cfg = serializeNow('Round-Trip', {});

  // Fresh scenario
  makeScenario();
  ScenarioSerializer.deserialize(cfg, ServiceRegistry.getInstance());

  const sr2 = ServiceRegistry.getInstance();
  const persons = sr2.personService.getAll();
  assert.strictEqual(persons.length, 1);

  const carol = persons[0];
  assert.strictEqual(carol.name, 'Carol');
  assert.deepStrictEqual(carol.citizen, ['US', 'AUS']);
  assert.strictEqual(carol.lifeExpectancy, 92);
  assert.strictEqual(carol.socialSecurityMonthly, 3200);
  assert.strictEqual(carol.birthDate instanceof Date ? carol.birthDate.getUTCFullYear() : new Date(carol.birthDate).getUTCFullYear(), 1975);
});
