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
 * serializer-framework-execution.test.mjs  — Level 2 of the serialization test pyramid
 *
 * Serialize a minimal scenario that uses only pure-framework components
 * (EventSeries, OneOffEvent, HandlerEntry, AmountAction, NumericSumReducer,
 * ScriptedReducer), restore it into a fresh BaseScenario, run the simulation,
 * and assert that state changes match the original.
 *
 * No finance-domain classes are used; that is Level 3.
 *
 * Key regression:
 *   OneOffEvent must fire exactly once on the correct date after a round-trip.
 *   If it is serialized as EventSeries (the 'OneOff' vs 'OneOffEvent' bug),
 *   it fires every month-end and produces wrong state.
 *
 * Handlers use ActionDefinition.fromAction() so they are fully serializable —
 * a custom `call` override cannot survive a serialize/deserialize cycle.
 *
 * Run with: node --test tests/unit/serializer-framework-execution.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Simulation }     from '../../src/simulation-framework/simulation.js';
import { HandlerEntry }   from '../../src/simulation-framework/handlers.js';
import {
  AmountAction, Action, FieldAction, FieldValueAction, ScriptedAction,
  RecordBalanceAction, ActionDefinition,
} from '../../src/simulation-framework/actions.js';
import {
  FieldReducer, NumericSumReducer, ArrayReducer, MultiplicativeReducer,
  NoOpReducer, ScriptedReducer,
} from '../../src/simulation-framework/reducers.js';
import { ReducerBuilder }  from '../../src/simulation-framework/builders/reducer-builder.js';
import { EventSeries }     from '../../src/simulation-framework/events/event-series.js';
import { OneOffEvent }     from '../../src/simulation-framework/events/one-off-event.js';

import { ServiceRegistry }    from '../../src/services/service-registry.js';
import { BaseScenario }       from '../../src/scenarios/base-scenario.js';
import { ScenarioSerializer } from '../../src/scenarios/scenario-serializer.js';
import { Person }             from '../../src/finance/person.js';
import { Account, SavingsAccount } from '../../src/finance/assets/account.js';
import {
  RothAccount, TraditionalIRAAccount, FourOhOneKAccount, BrokerageAccount,
  SuperannuationAccount,
} from '../../src/finance/assets/investment-account.js';

// FinSimLib global
globalThis.FinSimLib = {
  Finance: {
    Person, Account, SavingsAccount,
    RothAccount, TraditionalIRAAccount, FourOhOneKAccount, BrokerageAccount,
    SuperannuationAccount,
  },
  Engine: {
    Simulation, HandlerEntry,
    AmountAction, Action, FieldAction, FieldValueAction, ScriptedAction, RecordBalanceAction,
    FieldReducer, NumericSumReducer, ArrayReducer, MultiplicativeReducer, NoOpReducer, ScriptedReducer,
    ReducerBuilder,
    EventSeries, OneOffEvent,
  },
  Scenarios: {},
};

// ─── Shared helpers ───────────────────────────────────────────────────────────

const SIM_START = new Date(Date.UTC(2026, 0, 1));
const SIM_END   = new Date(Date.UTC(2041, 0, 1));

const STUB_UI = {
  _listeners: { eventCreated: [], handlerCreated: [], actionCreated: [], reducerCreated: [] },
  registerEventCreatedListener(l)   { this._listeners.eventCreated.push(l); },
  registerHandlerCreatedListener(l) { this._listeners.handlerCreated.push(l); },
  registerActionCreatedListener(l)  { this._listeners.actionCreated.push(l); },
  registerReducerCreatedListener(l) { this._listeners.reducerCreated.push(l); },
};

/**
 * Build a minimal scenario using pure-framework components, then serialize.
 * `buildFn(services)` should call service.register() for each component.
 * IMPORTANT: handlers must use ActionDefinition.fromAction() for their
 * generatedActionDefinitions so they survive the serialize/deserialize cycle.
 */
function buildAndSerialize(initialState, buildFn) {
  ServiceRegistry.reset();
  const scenario = new BaseScenario({
    eventSchedulerUI: STUB_UI,
    context:      ServiceRegistry.getInstance().simulationContext,
    initialState,
    simStart: SIM_START,
    simEnd:   SIM_END,
  });
  scenario.buildSim();

  const sr = ServiceRegistry.getInstance();
  buildFn(sr);

  const config = ScenarioSerializer.serialize(
    sr, 'test', 'Test', 1, true,
    scenario.simStart, scenario.simEnd,
    scenario.initialState, [],
  );
  return { sim: scenario.sim, config };
}

/**
 * Restore a scenario from a serialized config using BaseScenario + deserialize.
 */
function restoreFromConfig(config) {
  ServiceRegistry.reset();
  const scenario = new BaseScenario({
    eventSchedulerUI: STUB_UI,
    context:      ServiceRegistry.getInstance().simulationContext,
    initialState: config.initialState ?? {},
    simStart:     new Date(config.simStart),
    simEnd:       new Date(config.simEnd),
  });
  scenario.buildSim();
  ScenarioSerializer.deserializeGraph(config, ServiceRegistry.getInstance());
  return { scenario, sim: scenario.sim };
}

// ═════════════════════════════════════════════════════════════════════════════
// Test 1: EventSeries fires every month-end and accumulates state
// ═════════════════════════════════════════════════════════════════════════════

test('framework round-trip: monthly EventSeries accumulates total after 3 months', () => {
  const { sim: simOrig, config } = buildAndSerialize({ total: 0 }, (sr) => {
    const monthEnd = sr.eventService.createEventSeries({
      name: 'Month End', type: 'MONTH_END', interval: 'month-end', enabled: true,
    });

    // Use AmountAction so value=1000 survives the round-trip via ActionDefinition.
    const creditAction = new AmountAction('CREDIT', 'Credit', 1000);
    creditAction.id = 'credit';
    sr.actionService.register(creditAction);

    const handler = new HandlerEntry(null, 'Credit Handler');
    handler.handledEvents.push(monthEnd);
    handler.generatedActionTypes = ['CREDIT'];
    handler.generatedActionDefinitions = [ActionDefinition.fromAction(creditAction)];
    sr.handlerService.register(handler);

    const reducer = ReducerBuilder.numericSum('total').name('Total').priority(50).build();
    reducer.reducedActionTypes = ['CREDIT'];
    sr.reducerService.register(reducer);
  });

  const Q1 = new Date(Date.UTC(2026, 2, 31));
  simOrig.stepTo(Q1);
  assert.strictEqual(simOrig.state.total, 3000, 'original: 3 months × $1000 = $3000');

  const { sim: simRestored } = restoreFromConfig(config);
  simRestored.stepTo(Q1);
  assert.strictEqual(simRestored.state.total, 3000,
    `restored: expected 3000, got ${simRestored.state.total}`);
});

// ═════════════════════════════════════════════════════════════════════════════
// Test 2: OneOffEvent fires exactly once on the correct date
// ═════════════════════════════════════════════════════════════════════════════

test('framework round-trip: OneOffEvent fires exactly once on the target date', () => {
  const targetDate   = new Date(Date.UTC(2026, 5, 30)); // Jun 30 2026
  const beforeTarget = new Date(Date.UTC(2026, 4, 31)); // May 31 2026
  const afterTarget  = new Date(Date.UTC(2026, 6, 31)); // Jul 31 2026

  const { sim: simOrig, config } = buildAndSerialize({ firedCount: 0 }, (sr) => {
    const oneOff = sr.eventService.createOneOffEvent({
      name: 'Big Event', type: 'BIG_EVENT', date: targetDate, enabled: true,
    });

    const fireAction = new AmountAction('FIRE', 'Fire', 1);
    fireAction.id = 'fire-action';
    sr.actionService.register(fireAction);

    const handler = new HandlerEntry(null, 'Fire Handler');
    handler.handledEvents.push(oneOff);
    handler.generatedActionTypes = ['FIRE'];
    handler.generatedActionDefinitions = [ActionDefinition.fromAction(fireAction)];
    sr.handlerService.register(handler);

    const reducer = ReducerBuilder.numericSum('firedCount').name('Fire Counter').priority(50).build();
    reducer.reducedActionTypes = ['FIRE'];
    sr.reducerService.register(reducer);
  });

  // Original: verify single fire behaviour
  simOrig.stepTo(afterTarget);
  assert.strictEqual(simOrig.state.firedCount, 1, 'original: should fire exactly once');

  // Restored: must not fire before target
  const { sim: simBefore } = restoreFromConfig(config);
  simBefore.stepTo(beforeTarget);
  assert.strictEqual(simBefore.state.firedCount, 0,
    'before target: event must not have fired yet');

  // Restored: must fire exactly once after target
  const { sim: simAfter } = restoreFromConfig(config);
  simAfter.stepTo(afterTarget);
  assert.strictEqual(simAfter.state.firedCount, 1,
    'after target: event must fire exactly once');
});

test('framework round-trip: OneOffEvent does not fire repeatedly like EventSeries', () => {
  // If OneOffEvent is incorrectly serialized as EventSeries, it fires every
  // month-end. After 6 months, firedCount must be 1 (not 6).
  const targetDate = new Date(Date.UTC(2026, 2, 31)); // Mar 31 2026
  const sixMonths  = new Date(Date.UTC(2026, 5, 30)); // Jun 30 2026

  const { config } = buildAndSerialize({ firedCount: 0 }, (sr) => {
    const oneOff = sr.eventService.createOneOffEvent({
      name: 'One Time', type: 'ONE_TIME_FIRE', date: targetDate, enabled: true,
    });
    const fireAction = new AmountAction('FIRE_ONCE', 'Fire Once', 1);
    fireAction.id = 'fire-once';
    sr.actionService.register(fireAction);
    const handler = new HandlerEntry(null, 'One Time Handler');
    handler.handledEvents.push(oneOff);
    handler.generatedActionTypes = ['FIRE_ONCE'];
    handler.generatedActionDefinitions = [ActionDefinition.fromAction(fireAction)];
    sr.handlerService.register(handler);
    const reducer = ReducerBuilder.numericSum('firedCount').name('Counter').priority(50).build();
    reducer.reducedActionTypes = ['FIRE_ONCE'];
    sr.reducerService.register(reducer);
  });

  const { sim } = restoreFromConfig(config);
  sim.stepTo(sixMonths);
  assert.strictEqual(sim.state.firedCount, 1,
    `expected firedCount=1 but got ${sim.state.firedCount} — ` +
    'OneOffEvent is firing repeatedly (was likely serialized as EventSeries)');
});

// ═════════════════════════════════════════════════════════════════════════════
// Test 3: ScriptedReducer round-trip
// ═════════════════════════════════════════════════════════════════════════════

test('framework round-trip: ScriptedReducer state mutation survives serialize/deserialize', () => {
  // ScriptedReducer with fieldName='x': script must return the VALUE to write at state.x.
  // (Return a full state object only when fieldName is empty/null.)
  const script = 'return (state.x ?? 0) + (action.value ?? 0) * 2;';

  const { sim: simOrig, config } = buildAndSerialize({ x: 0 }, (sr) => {
    const ev = sr.eventService.createEventSeries({
      name: 'Monthly', type: 'MONTHLY_SCRIPT', interval: 'monthly', enabled: true,
    });
    const triggerAction = new AmountAction('INC_X', 'Increment X', 5);
    triggerAction.id = 'inc-x';
    sr.actionService.register(triggerAction);

    const handler = new HandlerEntry(null, 'X Handler');
    handler.handledEvents.push(ev);
    handler.generatedActionTypes = ['INC_X'];
    handler.generatedActionDefinitions = [ActionDefinition.fromAction(triggerAction)];
    sr.handlerService.register(handler);

    const reducer = new ScriptedReducer('Double X', 50, 'x', script);
    reducer.reducedActionTypes = ['INC_X'];
    sr.reducerService.register(reducer);
  });

  // Monthly interval fires on Jan 1, Feb 1, Mar 1 = 3 times; 3 × (5 × 2) = 30.
  const threeMonths = new Date(Date.UTC(2026, 2, 31));
  simOrig.stepTo(threeMonths);
  const origX = simOrig.state.x;
  assert.ok(origX > 0, `original: x should be > 0, got ${origX}`);

  const { sim: simRestored } = restoreFromConfig(config);
  simRestored.stepTo(threeMonths);
  assert.strictEqual(simRestored.state.x, origX,
    `restored: expected ${origX}, got ${simRestored.state.x}`);
});

// ═════════════════════════════════════════════════════════════════════════════
// Test 4: Two independent event series accumulate independently
// ═════════════════════════════════════════════════════════════════════════════

test('framework round-trip: two independent EventSeries accumulate independently', () => {
  const { sim: simOrig, config } = buildAndSerialize({ monthTotal: 0, yearTotal: 0 }, (sr) => {
    const monthEnd = sr.eventService.createEventSeries({
      name: 'Month End', type: 'MONTH_END_MULTI', interval: 'month-end', enabled: true,
    });
    const yearEnd = sr.eventService.createEventSeries({
      name: 'Year End', type: 'YEAR_END_MULTI', interval: 'year-end', enabled: true,
    });

    const monthAction = new AmountAction('MONTHLY_CREDIT', 'Monthly Credit', 100);
    monthAction.id = 'monthly-credit';
    sr.actionService.register(monthAction);

    const yearAction = new AmountAction('ANNUAL_CREDIT', 'Annual Credit', 1200);
    yearAction.id = 'annual-credit';
    sr.actionService.register(yearAction);

    const monthHandler = new HandlerEntry(null, 'Monthly Handler');
    monthHandler.handledEvents.push(monthEnd);
    monthHandler.generatedActionTypes = ['MONTHLY_CREDIT'];
    monthHandler.generatedActionDefinitions = [ActionDefinition.fromAction(monthAction)];
    sr.handlerService.register(monthHandler);

    const yearHandler = new HandlerEntry(null, 'Annual Handler');
    yearHandler.handledEvents.push(yearEnd);
    yearHandler.generatedActionTypes = ['ANNUAL_CREDIT'];
    yearHandler.generatedActionDefinitions = [ActionDefinition.fromAction(yearAction)];
    sr.handlerService.register(yearHandler);

    const monthReducer = ReducerBuilder.numericSum('monthTotal').name('Month Total').priority(50).build();
    monthReducer.reducedActionTypes = ['MONTHLY_CREDIT'];
    sr.reducerService.register(monthReducer);

    const yearReducer = ReducerBuilder.numericSum('yearTotal').name('Year Total').priority(50).build();
    yearReducer.reducedActionTypes = ['ANNUAL_CREDIT'];
    sr.reducerService.register(yearReducer);
  });

  // 15 months Jan 2026 → Mar 2027; crosses Dec 31 2026 year-end once.
  const fifteenMonths = new Date(Date.UTC(2027, 2, 31));
  simOrig.stepTo(fifteenMonths);
  const origMonthTotal = simOrig.state.monthTotal;
  const origYearTotal  = simOrig.state.yearTotal;

  assert.strictEqual(origMonthTotal, 1500, 'original: 15 months × $100');
  assert.strictEqual(origYearTotal,  1200, 'original: 1 year-end × $1200');

  const { sim: simRestored } = restoreFromConfig(config);
  simRestored.stepTo(fifteenMonths);
  assert.strictEqual(simRestored.state.monthTotal, origMonthTotal,
    `monthTotal: expected ${origMonthTotal}, got ${simRestored.state.monthTotal}`);
  assert.strictEqual(simRestored.state.yearTotal, origYearTotal,
    `yearTotal: expected ${origYearTotal}, got ${simRestored.state.yearTotal}`);
});

// ═════════════════════════════════════════════════════════════════════════════
// Test 5: Disabled event does not fire
// ═════════════════════════════════════════════════════════════════════════════

test('framework round-trip: disabled EventSeries does not fire after round-trip', () => {
  const { config } = buildAndSerialize({ count: 0 }, (sr) => {
    const ev = sr.eventService.createEventSeries({
      name: 'Disabled', type: 'DISABLED_MONTHLY', interval: 'month-end', enabled: false,
    });
    const action = new AmountAction('DISABLED_CREDIT', 'Disabled Credit', 1000);
    action.id = 'disabled-credit';
    sr.actionService.register(action);
    const handler = new HandlerEntry(null, 'Disabled Handler');
    handler.handledEvents.push(ev);
    handler.generatedActionTypes = ['DISABLED_CREDIT'];
    handler.generatedActionDefinitions = [ActionDefinition.fromAction(action)];
    sr.handlerService.register(handler);
    const reducer = ReducerBuilder.numericSum('count').name('Count').priority(50).build();
    reducer.reducedActionTypes = ['DISABLED_CREDIT'];
    sr.reducerService.register(reducer);
  });

  const { sim } = restoreFromConfig(config);
  sim.stepTo(new Date(Date.UTC(2026, 2, 31)));
  assert.strictEqual(sim.state.count, 0,
    'disabled event must not fire after round-trip');
});
