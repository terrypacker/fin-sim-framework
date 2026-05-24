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
 * scenario-rebuild.test.mjs
 *
 * Regression tests for the scenario rebuild / load bug introduced during
 * design/17 (Scenario as Graph Node).
 *
 * Root cause: SimulationAdapter._registeredRecurringTypes was never cleared on
 * ServiceRegistry.reset(). On the second Rebuild/Load each EventSeries type was
 * already in the map, so its recurring self-scheduling handler was not registered
 * with the new Simulation. Each series fired exactly once instead of recurring
 * throughout the run (e.g. 24 events instead of 1463 over 2 years).
 *
 * Fix: SimulationSync subscribes to 'execution:reset' and calls adapter.reset(),
 * which clears _registeredRecurringTypes so the new Simulation gets all handlers.
 *
 * Run with: node --test tests/unit/scenario-rebuild.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { EventSeries }     from '../../src/simulation-framework/events/event-series.js';
import { SimulationAdapter } from '../../src/simulation-framework/simulation/simulation-adapter.js';
import { ServiceRegistry } from '../../src/services/service-registry.js';
import { BaseScenario }    from '../../src/scenarios/base-scenario.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const TARGET = new Date(Date.UTC(2028, 0, 1));  // 2 years into the 15-year sim

const PREBUILT_ENTRIES = [
  {
    cls:      IntlRetirementScenario,
    order:    1,
    active:   true,
    simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd:   new Date(Date.UTC(2041, 0, 1)),
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * First-time build: reset everything, load prebuilts, compile, return the
 * live sim and the service registry.
 */
function firstBuild() {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  services.scenarioRegistry.loadPrebuilt(PREBUILT_ENTRIES);

  const scenario = services.scenarioService.createActiveScenario();
  scenario.buildSim();

  const activeConfig = services.scenarioService.getActive();
  new ScenarioLoader().load(activeConfig, services);

  return { services, sim: services.simulationRegistry.getPrimary() };
}

/**
 * Simulate WorkbenchApp.destroyScenario() + initScenario():
 *   clearLayer('config') → ServiceRegistry.reset() → loadPrebuilt (no-op) →
 *   createActiveScenario → buildSim → ScenarioLoader.load
 *
 * Uses the same singleton ServiceRegistry (no resetAll) so scenario nodes on
 * layer:'scenario' survive, exactly as they do in the real app.
 */
function rebuild(services) {
  services.graph.clearLayer('config');
  ServiceRegistry.reset();  // clears execution layer + publishes 'execution:reset'

  services.scenarioRegistry.loadPrebuilt(PREBUILT_ENTRIES); // no-op: node already exists

  const scenario = services.scenarioService.createActiveScenario();
  scenario.buildSim();

  const activeConfig = services.scenarioService.getActive();
  new ScenarioLoader().load(activeConfig, services);

  return services.simulationRegistry.getPrimary();
}

// ═════════════════════════════════════════════════════════════════════════════
// Unit test: SimulationAdapter.reset()
// ═════════════════════════════════════════════════════════════════════════════

test('SimulationAdapter: reset() clears _registeredRecurringTypes', () => {
  const adapter = new SimulationAdapter({ sim: null, simStart: null });

  adapter._registeredRecurringTypes.set('MONTHLY_EXPENSE', {});
  adapter._registeredRecurringTypes.set('ANNUAL_SAVINGS',  {});
  assert.strictEqual(adapter._registeredRecurringTypes.size, 2);

  adapter.reset();
  assert.strictEqual(adapter._registeredRecurringTypes.size, 0,
    'reset() must clear all registered recurring types');
});

// ═════════════════════════════════════════════════════════════════════════════
// Integration test: 'execution:reset' bus event triggers adapter.reset()
// ═════════════════════════════════════════════════════════════════════════════

test('SimulationSync: execution:reset clears recurring-type registrations', () => {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();

  const scenario = new BaseScenario({
    context:  services.simulationContext,
    simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd:   new Date(Date.UTC(2028, 0, 1)),
  });
  scenario.buildSim();

  // Register a recurring EventSeries — this populates _registeredRecurringTypes
  const series = new EventSeries({
    id:       'test-series',
    name:     'Test Series',
    type:     'TEST_RECURRING_EVENT',
    interval: 'monthly',
    enabled:  true,
  });
  services.eventService.register(series);

  const adapter = services.simulationSync.adapter;
  assert.strictEqual(adapter._registeredRecurringTypes.has('TEST_RECURRING_EVENT'), true,
    'registering an EventSeries must populate _registeredRecurringTypes');

  // Simulate ServiceRegistry.reset() — publishes 'execution:reset'
  services.bus.publish({ type: 'execution:reset' });

  assert.strictEqual(adapter._registeredRecurringTypes.size, 0,
    'execution:reset bus event must clear _registeredRecurringTypes');
});

// ═════════════════════════════════════════════════════════════════════════════
// Integration test: rebuild produces same execution counts as first run
// ═════════════════════════════════════════════════════════════════════════════

test('rebuild: simulation produces same execution counts after destroyScenario/initScenario', () => {
  const { services, sim: sim1 } = firstBuild();
  sim1.stepTo(TARGET);

  const firstRun = {
    events:   sim1.eventExecutions,
    handlers: sim1.handlerExecutions,
    actions:  sim1.actionExecutions,
    reducers: sim1.reducerExecutions,
  };

  assert.ok(firstRun.events   > 100, `first run should have many events (got ${firstRun.events})`);
  assert.ok(firstRun.handlers > 100, `first run should have many handlers (got ${firstRun.handlers})`);

  // Rebuild without a full ServiceRegistry teardown — scenario nodes survive
  const sim2 = rebuild(services);
  sim2.stepTo(TARGET);

  const secondRun = {
    events:   sim2.eventExecutions,
    handlers: sim2.handlerExecutions,
    actions:  sim2.actionExecutions,
    reducers: sim2.reducerExecutions,
  };

  assert.strictEqual(secondRun.events,   firstRun.events,
    `rebuild: event count mismatch (first: ${firstRun.events}, second: ${secondRun.events})`);
  assert.strictEqual(secondRun.handlers, firstRun.handlers,
    `rebuild: handler count mismatch (first: ${firstRun.handlers}, second: ${secondRun.handlers})`);
  assert.strictEqual(secondRun.actions,  firstRun.actions,
    `rebuild: action count mismatch (first: ${firstRun.actions}, second: ${secondRun.actions})`);
  assert.strictEqual(secondRun.reducers, firstRun.reducers,
    `rebuild: reducer count mismatch (first: ${firstRun.reducers}, second: ${secondRun.reducers})`);
});

// ═════════════════════════════════════════════════════════════════════════════
// Integration test: loading a user-scenario copy produces same counts
// ═════════════════════════════════════════════════════════════════════════════

test('load-copy: switching to a user scenario produces same execution counts', () => {
  const { services, sim: sim1 } = firstBuild();
  sim1.stepTo(TARGET);

  const firstRun = {
    events:   sim1.eventExecutions,
    handlers: sim1.handlerExecutions,
    actions:  sim1.actionExecutions,
    reducers: sim1.reducerExecutions,
  };

  // Create a user-scenario copy and make it active
  const active = services.scenarioService.getActive();
  services.scenarioService.newScenario(active); // sets copy as active

  // Rebuild — now the active scenario is the user copy
  const sim2 = rebuild(services);
  sim2.stepTo(TARGET);

  const secondRun = {
    events:   sim2.eventExecutions,
    handlers: sim2.handlerExecutions,
    actions:  sim2.actionExecutions,
    reducers: sim2.reducerExecutions,
  };

  assert.strictEqual(secondRun.events,   firstRun.events,
    `copy load: event count mismatch (original: ${firstRun.events}, copy: ${secondRun.events})`);
  assert.strictEqual(secondRun.handlers, firstRun.handlers,
    `copy load: handler count mismatch (original: ${firstRun.handlers}, copy: ${secondRun.handlers})`);
  assert.strictEqual(secondRun.actions,  firstRun.actions,
    `copy load: action count mismatch (original: ${firstRun.actions}, copy: ${secondRun.actions})`);
  assert.strictEqual(secondRun.reducers, firstRun.reducers,
    `copy load: reducer count mismatch (original: ${firstRun.reducers}, copy: ${secondRun.reducers})`);
});
