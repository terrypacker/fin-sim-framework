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
 * intl-retirement-scenario.test.mjs
 *
 * Integration tests for IntlRetirementScenario.
 * Focuses on the year-boundary transition at end of 2027 which exposed
 * an infinite-loop bug in the PERIOD_ADVANCE / TAX_SETTLE event scheduling.
 *
 * Run with: node --test tests/unit/intl-retirement-scenario.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Simulation }      from '../../src/simulation-framework/simulation.js';
import { HandlerEntry }    from '../../src/simulation-framework/handlers.js';
import { AmountAction, Action, RecordBalanceAction, FieldValueAction } from '../../src/simulation-framework/actions.js';
import { FieldReducer }    from '../../src/simulation-framework/reducers.js';
import { BaseEvent }       from '../../src/simulation-framework/events/base-event.js';
import { EventSeries }     from '../../src/simulation-framework/events/event-series.js';
import { OneOffEvent }     from '../../src/simulation-framework/events/one-off-event.js';
import { ServiceRegistry } from '../../src/services/service-registry.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';

// ─── Provide the FinSimLib global that BaseScenario.buildSim() needs ──────────

globalThis.FinSimLib = {
  Core: {
    Simulation, HandlerEntry, AmountAction, Action, FieldValueAction, RecordBalanceAction,
    FieldReducer, BaseEvent, EventSeries, OneOffEvent,
  },
  Scenarios: {},
};

// ─── Stub EventSchedulerUI ────────────────────────────────────────────────────

function makeStubUI() {
  const stub = {
    nodes: [],
    _listeners: { eventCreated: [], handlerCreated: [], actionCreated: [], reducerCreated: [] },
    registerEventCreatedListener(l)   { stub._listeners.eventCreated.push(l); },
    registerHandlerCreatedListener(l) { stub._listeners.handlerCreated.push(l); },
    registerActionCreatedListener(l)  { stub._listeners.actionCreated.push(l); },
    registerReducerCreatedListener(l) { stub._listeners.reducerCreated.push(l); },
    addEvent(e)   { stub.nodes.push(e); },
    addHandler(h) { stub.nodes.push(h); },
    addAction(a)  { stub.nodes.push(a); },
    addReducer(r) { stub.nodes.push(r); },
    editNode()    {},
  };
  return stub;
}

// ─── Build helpers ────────────────────────────────────────────────────────────

/**
 * Build and initialise an IntlRetirementScenario.
 * Returns { scenario, sim } ready to step.
 */
function buildScenario(params = {}) {
  ServiceRegistry.reset();
  const ui       = makeStubUI();
  const scenario = new IntlRetirementScenario({ eventSchedulerUI: ui });
  scenario.buildSim(params);
  scenario.loadDefaults();
  const sim = scenario.sim;
  return { scenario, sim };
}

/**
 * Step the simulation in daily increments up to targetDate.
 * Throws if the queue processes more than maxEvents events total — a guard
 * against the infinite-loop bug we are testing for.
 *
 * Returns the number of events processed.
 */
function stepWithGuard(sim, targetDate, maxEvents = 5000) {
  let count = 0;
  const origPop = sim.queue.pop.bind(sim.queue);
  sim.queue.pop = function() {
    if (++count > maxEvents) {
      throw new Error(
        `stepWithGuard: exceeded ${maxEvents} events — likely infinite loop at ` +
        sim.currentDate.toISOString()
      );
    }
    return origPop();
  };

  sim.stepTo(targetDate);

  // Restore
  sim.queue.pop = origPop;
  return count;
}

// ═════════════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════════════

test('scenario builds without error', () => {
  const { sim } = buildScenario();
  assert.ok(sim, 'sim should be defined');
  assert.ok(sim.queue.size() > 0, 'queue should have events scheduled');
});

test('scenario advances through year 1 (2026) without looping', () => {
  const { sim } = buildScenario();
  const endOf2026 = new Date(Date.UTC(2026, 11, 31));
  const count = stepWithGuard(sim, endOf2026);
  assert.ok(count > 0, `should have processed events, got ${count}`);
  assert.strictEqual(sim.currentDate.toISOString(), endOf2026.toISOString(),
    'sim.currentDate should be Dec 31 2026');
});

test('scenario advances through Nov 30 2027 without looping', () => {
  const { sim } = buildScenario();
  const nov30 = new Date(Date.UTC(2027, 10, 30));
  const count = stepWithGuard(sim, nov30);
  assert.ok(count > 0, `should have processed events`);
  assert.strictEqual(sim.currentDate.toISOString(), nov30.toISOString(),
    'sim.currentDate should be Nov 30 2027');
});

test('scenario advances through Dec 31 2027 (year-end boundary) without looping', () => {
  const { sim } = buildScenario();
  // First advance to Nov 30 2027 (as the user described the repro)
  const nov30 = new Date(Date.UTC(2027, 10, 30));
  stepWithGuard(sim, nov30);

  // Then advance to Dec 31 2027 — this is where the loop was reported
  const dec31 = new Date(Date.UTC(2027, 11, 31));
  const count = stepWithGuard(sim, dec31);
  assert.ok(count > 0, `should have processed events in Dec 2027`);
  assert.strictEqual(sim.currentDate.toISOString(), dec31.toISOString(),
    'sim.currentDate should reach Dec 31 2027');
});

test('scenario advances through year 3 (end of 2028) without looping', () => {
  const { sim } = buildScenario();
  const endOf2028 = new Date(Date.UTC(2028, 11, 31));
  const count = stepWithGuard(sim, endOf2028, 10000);
  assert.ok(count > 0);
  assert.strictEqual(sim.currentDate.toISOString(), endOf2028.toISOString());
});

test('US tax YTD resets after Dec 31 2026 settlement (Dec interest re-adds)', () => {
  const { sim } = buildScenario();
  sim.stepTo(new Date(Date.UTC(2026, 11, 31)));
  // TAX_SETTLE resets usOrdinaryIncomeYTD to 0 but the same-day Dec 31
  // US_SAVINGS_INTEREST_MONTHLY event fires and adds December's interest back,
  // so the value should be a small positive number (not the full year's YTD).
  assert.ok(sim.state.usOrdinaryIncomeYTD >= 0,
    'usOrdinaryIncomeYTD should be non-negative after US tax settlement + Dec interest');
  // Sanity: it should be less than one month's worth of interest (~75 max)
  assert.ok(sim.state.usOrdinaryIncomeYTD < 100,
    `usOrdinaryIncomeYTD should be a single month's interest, got ${sim.state.usOrdinaryIncomeYTD}`);
});

test('AU tax YTD resets to 0 after Jun 30 2026 settlement', () => {
  const { sim } = buildScenario();
  sim.stepTo(new Date(Date.UTC(2026, 5, 30)));  // Jun 30, 2026
  // The AU FY2025-2026 TAX_SETTLE should have fired, resetting AU YTD
  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0,
    'auOrdinaryIncomeYTD should be reset after AU tax settlement');
});

test('currentPeriods.US advances to 2027 after Jan 1 2027 PERIOD_ADVANCE', () => {
  const { sim } = buildScenario();
  sim.stepTo(new Date(Date.UTC(2027, 0, 2)));  // Jan 2, 2027 (one day after advance)
  const period = sim.state.currentPeriods?.US;
  assert.ok(period, 'currentPeriods.US should exist');
  const startYear = new Date(period.startMs).getUTCFullYear();
  assert.strictEqual(startYear, 2027, 'US period should be 2027 after Jan 1 PERIOD_ADVANCE');
});

test('currentPeriods.AU advances to FY2026-27 after Jul 1 2026 PERIOD_ADVANCE', () => {
  const { sim } = buildScenario();
  sim.stepTo(new Date(Date.UTC(2026, 6, 2)));  // Jul 2, 2026 (one day after advance)
  const period = sim.state.currentPeriods?.AU;
  assert.ok(period, 'currentPeriods.AU should exist');
  const startYear = new Date(period.startMs).getUTCFullYear();
  assert.strictEqual(startYear, 2026,
    'AU period should start in 2026 (FY2026-27 starts Jul 1 2026)');
});
