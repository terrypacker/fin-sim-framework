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
  RecordNumericSumMetricAction,
  RecordArrayMetricAction,
  RecordMetricAction,
  RecordMultiplicativeMetricAction,
  RecordBalanceAction,
} from '../../src/simulation-framework/actions.js';
import {
  MetricReducer,
  NumericSumMetricReducer,
  ArrayMetricReducer,
  MultiplicativeMetricReducer,
  NoOpReducer,
} from '../../src/simulation-framework/reducers.js';
import { ReducerBuilder } from '../../src/simulation-framework/builders/reducer-builder.js';

// ─── FinSimLib global (required by BaseScenario and ScenarioSerializer) ────────

globalThis.FinSimLib = {
  Core: {
    Simulation,
    HandlerEntry,
    AmountAction,
    RecordMetricAction,
    RecordNumericSumMetricAction,
    RecordArrayMetricAction,
    RecordMultiplicativeMetricAction,
    RecordBalanceAction,
    MetricReducer,
    NumericSumMetricReducer,
    ArrayMetricReducer,
    MultiplicativeMetricReducer,
    NoOpReducer,
    ReducerBuilder,
    EventSeries,
    OneOffEvent,
  },
};

// ─── Tracking scheduler UI stub ───────────────────────────────────────────────
//
// Mirrors the parts of EventScheduler that ScenarioSerializer and BaseScenario
// call during deserialize: addEvent, addHandler, addAction, addReducer.
// addHandler and addReducer also call addAction for related actions, matching
// EventScheduler's behaviour so the node list reflects what the real graph
// would contain.

class TrackingUI {
  constructor() {
    this.nodes = [];
    // BaseScenario constructor registers creation listeners — we must accept them.
    this._listeners = {
      eventCreated: [], handlerCreated: [], actionCreated: [], reducerCreated: [],
    };
  }

  registerEventCreatedListener(l)   { this._listeners.eventCreated.push(l); }
  registerHandlerCreatedListener(l) { this._listeners.handlerCreated.push(l); }
  registerActionCreatedListener(l)  { this._listeners.actionCreated.push(l); }
  registerReducerCreatedListener(l) { this._listeners.reducerCreated.push(l); }

  addEvent(e) {
    if (this.nodes.find(n => n.id === e.id)) {
      throw new Error(`Event already in graph: ${e.id}`);
    }
    e.kind = 'event';
    // Mirror EventScheduler.addEvent: stamp eventType so _serializeEvent works.
    if (e instanceof OneOffEvent) {
      e.eventType = 'OneOff';
    } else {
      e.eventType = 'Series';
    }
    this.nodes.push(e);
  }

  addAction(a) {
    // Mirror EventScheduler.addAction: load into service if not already registered.
    if (!this.nodes.find(n => n.id === a.id)) {
      const { actionService } = ServiceRegistry.getInstance();
      if (!actionService.get(a.id)) actionService.load(a);
      a.kind = 'action';
      this.nodes.push(a);
    }
  }

  addHandler(h) {
    h.kind = 'handler';
    this.nodes.push(h);
    // EventScheduler.addHandler calls addAction for each generated action
    (h.generatedActions ?? []).forEach(a => this.addAction(a));
  }

  addReducer(r) {
    r.kind = 'reducer';
    // Mirror EventScheduler.addReducer: stamp reducerType so _serializeReducer works.
    if      (r instanceof NumericSumMetricReducer)    r.reducerType = 'NumericSumMetricReducer';
    else if (r instanceof ArrayMetricReducer)          r.reducerType = 'ArrayMetricReducer';
    else if (r instanceof MultiplicativeMetricReducer) r.reducerType = 'MultiplicativeMetricReducer';
    else if (r instanceof MetricReducer)               r.reducerType = 'MetricReducer';
    else if (r instanceof NoOpReducer)                 r.reducerType = 'NoOpReducer';
    else                                               r.reducerType = 'MetricReducer';
    this.nodes.push(r);
    // EventScheduler.addReducer calls addAction for reduced and generated actions
    (r.reducedActions   ?? []).forEach(a => this.addAction(a));
    (r.generatedActions ?? []).forEach(a => this.addAction(a));
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
      handledEventIds: ['e1'], generatedActionIds: ['RECORD_METRIC'] },
  ],
  actions: [
    { __type: 'AmountAction', id: 'RECORD_METRIC', name: 'Pay Salary',
      type: 'RECORD_METRIC', value: 1200, fieldName: 'amount' },
  ],
  reducers: [
    { __type: 'MetricReducer', id: 'r1', name: 'Process Payment',
      priority: 90, fieldName: 'metrics.amount',
      reducedActionIds: ['RECORD_METRIC'], generatedActionIds: [] },
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
      handledEventIds: ['e1'], generatedActionIds: ['RECORD_METRIC'] },
    { __type: 'HandlerEntry', id: 'h2', name: 'Year End Handler',
      handledEventIds: ['e2'], generatedActionIds: ['NEW_ACTION_a1'] },
  ],
  actions: [
    { __type: 'AmountAction', id: 'RECORD_METRIC', name: 'Pay Salary',
      type: 'RECORD_METRIC', value: 1200, fieldName: 'amount' },
    { __type: 'RecordNumericSumMetricAction', id: 'RECORD_NUMERIC_SUM_METRIC',
      name: 'Sum Payments', type: 'RECORD_NUMERIC_SUM_METRIC', fieldName: 'amount' },
    { __type: 'AmountAction', id: 'NEW_ACTION_a1', name: 'Pay Taxes',
      type: 'NEW_ACTION_a1', value: 0, fieldName: 'salary' },
  ],
  reducers: [
    { __type: 'MetricReducer', id: 'r1', name: 'Process Salary Payment Amount',
      priority: 90, fieldName: 'metrics.amount',
      reducedActionIds: ['RECORD_METRIC'], generatedActionIds: ['RECORD_NUMERIC_SUM_METRIC'] },
    { __type: 'NumericSumMetricReducer', id: 'r2', name: 'Update Total Salary',
      priority: 90, fieldName: 'metrics.salary',
      reducedActionIds: ['RECORD_NUMERIC_SUM_METRIC'], generatedActionIds: [] },
    { __type: 'ArrayMetricReducer', id: 'r3', name: 'Deposit Payment',
      priority: 90, fieldName: 'metrics.deposits',
      reducedActionIds: ['RECORD_METRIC'], generatedActionIds: [] },
    { __type: 'MetricReducer', id: 'r4', name: 'Tax Owed',
      priority: 90, fieldName: 'metrics.',
      reducedActionIds: ['NEW_ACTION_a1'], generatedActionIds: [] },
  ],
  initialState: { metrics: { amount: 0, salary: 0 } },
  params: [],
};

// ─── Minimal config: basic deserialize correctness ────────────────────────────

test('deserialize minimal: event e1 is added to the scheduler UI', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(MINIMAL_CONFIG, scenario);
  assert.ok(ui.nodeIds().includes('e1'), 'e1 should be present');
});

test('deserialize minimal: handler h1 is added to the scheduler UI', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(MINIMAL_CONFIG, scenario);
  assert.ok(ui.nodeIds().includes('h1'), 'h1 should be present');
});

test('deserialize minimal: action RECORD_METRIC is added via the handler', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(MINIMAL_CONFIG, scenario);
  assert.ok(ui.nodeIds().includes('RECORD_METRIC'), 'RECORD_METRIC should be present');
});

test('deserialize minimal: reducer r1 is added to the scheduler UI', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(MINIMAL_CONFIG, scenario);
  assert.ok(ui.nodeIds().includes('r1'), 'r1 should be present');
});

// ─── Extended config: regression for missing-new-nodes bug ────────────────────

test('deserialize extended: e1 (original event) is present', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, scenario);
  assert.ok(ui.nodeIds().includes('e1'));
});

test('deserialize extended: e2 (added event) is present — regression', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, scenario);
  assert.ok(ui.nodeIds().includes('e2'), 'e2 was missing before the fix');
});

test('deserialize extended: h1 (original handler) is present', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, scenario);
  assert.ok(ui.nodeIds().includes('h1'));
});

test('deserialize extended: h2 (added handler) is present — regression', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, scenario);
  assert.ok(ui.nodeIds().includes('h2'), 'h2 was missing before the fix');
});

test('deserialize extended: RECORD_METRIC action is present', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, scenario);
  assert.ok(ui.nodeIds().includes('RECORD_METRIC'));
});

test('deserialize extended: NEW_ACTION_a1 (added action) is present — regression', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, scenario);
  assert.ok(
    ui.nodeIds().includes('NEW_ACTION_a1'),
    'NEW_ACTION_a1 was missing before the fix'
  );
});

test('deserialize extended: RECORD_NUMERIC_SUM_METRIC action is present', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, scenario);
  assert.ok(ui.nodeIds().includes('RECORD_NUMERIC_SUM_METRIC'));
});

test('deserialize extended: r1, r2, r3 (original reducers) are present', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, scenario);
  assert.ok(ui.nodeIds().includes('r1'));
  assert.ok(ui.nodeIds().includes('r2'));
  assert.ok(ui.nodeIds().includes('r3'));
});

test('deserialize extended: r4 (added reducer) is present — regression', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, scenario);
  assert.ok(ui.nodeIds().includes('r4'), 'r4 was missing before the fix');
});

test('deserialize extended: total node count matches all config entries', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, scenario);
  // 2 events + 2 handlers + 3 actions + 4 reducers = 11 nodes
  assert.strictEqual(ui.nodes.length, 11,
    `expected 11 nodes, got ${ui.nodes.length}: [${ui.nodeIds().join(', ')}]`);
});

// ─── Node kinds are set correctly ─────────────────────────────────────────────

test('deserialize extended: each event node has kind "event"', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, scenario);
  ui.ofKind('event').forEach(n => assert.strictEqual(n.kind, 'event'));
  assert.strictEqual(ui.ofKind('event').length, 2);
});

test('deserialize extended: each handler node has kind "handler"', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, scenario);
  assert.strictEqual(ui.ofKind('handler').length, 2);
});

test('deserialize extended: each action node has kind "action"', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, scenario);
  assert.strictEqual(ui.ofKind('action').length, 3);
});

test('deserialize extended: each reducer node has kind "reducer"', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, scenario);
  assert.strictEqual(ui.ofKind('reducer').length, 4);
});

// ─── ID counter advancement ───────────────────────────────────────────────────

test('deserialize advances eventService _nextId past the highest event id', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, scenario);
  // config has e1, e2 → service counter must be at least 3
  const nextId = ServiceRegistry.getInstance().eventService._nextId;
  assert.ok(nextId >= 3,
    `eventService._nextId should be ≥ 3, got ${nextId}`);
});

test('deserialize advances reducerService _nextId past the highest reducer id', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, scenario);
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
  ScenarioSerializer.deserialize(cfg, scenario);
  assert.ok(ui.nodeIds().includes('e-off'), 'disabled event should still appear in the UI');
  // It must not be scheduled in the sim
  assert.ok(!scenario._registeredRecurringTypes.has('OFF_EVT'),
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
  ScenarioSerializer.deserialize(MINIMAL_CONFIG, scenario);
  const cfg = serializeNow();
  assert.ok(Array.isArray(cfg.events),   'events should be an array');
  assert.ok(Array.isArray(cfg.handlers), 'handlers should be an array');
  assert.ok(Array.isArray(cfg.actions),  'actions should be an array');
  assert.ok(Array.isArray(cfg.reducers), 'reducers should be an array');
});

test('serialize: minimal config produces correct node counts', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(MINIMAL_CONFIG, scenario);
  const cfg = serializeNow();
  assert.strictEqual(cfg.events.length,   1, 'one event');
  assert.strictEqual(cfg.handlers.length, 1, 'one handler');
  assert.strictEqual(cfg.reducers.length, 1, 'one reducer');
});

test('serialize: event __type is EventSeries for a recurring event', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(MINIMAL_CONFIG, scenario);
  const cfg = serializeNow();
  assert.strictEqual(cfg.events[0].__type, 'EventSeries');
});

test('serialize: reducer __type matches the class set during registration', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(MINIMAL_CONFIG, scenario);
  const cfg = serializeNow();
  const r = cfg.reducers.find(r => r.id === 'r1');
  assert.strictEqual(r.__type, 'MetricReducer');
});

test('serialize: extended config produces correct node counts', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, scenario);
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
  ScenarioSerializer.deserialize(MINIMAL_CONFIG, scenario);

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
  ScenarioSerializer.deserialize(MINIMAL_CONFIG, scenario);

  // Simulate what the UI type-select does when user picks a different reducer type
  ServiceRegistry.getInstance().reducerService.updateReducer('r1', { reducerType: 'NumericSumMetricReducer' });

  const cfg = serializeNow();
  const r = cfg.reducers.find(r => r.id === 'r1');
  assert.ok(r, 'r1 must be present in serialized output');
  assert.strictEqual(r.__type, 'NumericSumMetricReducer',
    'serialized __type must reflect the reducerType set via updateReducer');
});

test('serialize regression: event name change is captured in saved config', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(MINIMAL_CONFIG, scenario);

  ServiceRegistry.getInstance().eventService.updateEvent('e1', { name: 'Renamed Event' });

  const cfg = serializeNow();
  const e = cfg.events.find(e => e.id === 'e1');
  assert.ok(e, 'e1 must be present in serialized output');
  assert.strictEqual(e.name, 'Renamed Event',
    'serialized event name must match the value set via updateEvent');
});

test('serialize regression: event type string change is captured in saved config', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(MINIMAL_CONFIG, scenario);

  ServiceRegistry.getInstance().eventService.updateEvent('e1', { type: 'CUSTOM_EVENT_TYPE' });

  const cfg = serializeNow();
  const e = cfg.events.find(e => e.id === 'e1');
  assert.strictEqual(e.type, 'CUSTOM_EVENT_TYPE',
    'serialized event type string must reflect the update');
});

test('serialize regression: handler name change is captured in saved config', () => {
  const { ui, scenario } = makeScenario();
  ScenarioSerializer.deserialize(MINIMAL_CONFIG, scenario);

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
  ScenarioSerializer.deserialize(EXTENDED_CONFIG, s1);
  const firstIds = ui1.nodeIds().sort();

  // Serialize the first scenario's services to a config
  const roundTripCfg = serializeNow('Round-Trip', EXTENDED_CONFIG.initialState);

  // Second scenario: deserialize the round-trip config
  const { ui: ui2, scenario: s2 } = makeScenario();
  ScenarioSerializer.deserialize(roundTripCfg, s2);
  const secondIds = ui2.nodeIds().sort();

  assert.deepStrictEqual(secondIds, firstIds,
    'round-tripped scenario must have the same node IDs as the original');
});
