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
 * action-payload-schema.test.mjs — drift detector for the TypeRegistry.
 *
 * Runs IntlRetirementScenario for 2 years and intercepts every pickPayload()
 * call made by the simulation.  For each registered action type, asserts that
 * all non-framework, non-underscore fields present on the live action are
 * declared in the owning toolset's types.actions entry.
 *
 * If a developer adds a new field to an emitted action without updating the
 * toolset manifest, this test names the type and the undeclared field(s).
 *
 * Run with: node --test tests/unit/action-payload-schema.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { TypeRegistry }           from '../../src/simulation-framework/type-registry.js';
import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';
import { ScenarioSerializer }     from '../../src/scenarios/scenario-serializer.js';

// ─── DriftDetectorRegistry ────────────────────────────────────────────────────

// Must mirror FRAMEWORK_FIELDS in type-registry.js.
const FRAMEWORK_FIELDS = new Set(['id', 'type', 'name', 'kind', 'layer', 'siblingIndex', 'data', 'meta']);

/**
 * TypeRegistry subclass that intercepts pickPayload() to detect two drift classes:
 *
 *   1. Registered types with live fields not declared in `entry.fields`.
 *      These fields are silently dropped from journal payloads.
 *
 *   2. Unregistered action types encountered during the run.
 *      These fall through to the heuristic fallback — fine today, but
 *      each one is a missing toolset declaration.
 */
class DriftDetectorRegistry extends TypeRegistry {
  constructor() {
    super();
    this._undeclaredFields  = new Map(); // actionType → Set<fieldName>
    this._unregisteredTypes = new Set(); // actionType strings with no registry entry
  }

  pickPayload(action) {
    const entry = this._actionTypes.get(action.type);
    if (entry) {
      const declared = new Set(Object.keys(entry.fields ?? {}));
      for (const k of Object.keys(action)) {
        if (FRAMEWORK_FIELDS.has(k)) continue;
        if (k.startsWith('_'))       continue;
        if (action[k] == null)       continue;
        if (!declared.has(k)) {
          if (!this._undeclaredFields.has(action.type)) {
            this._undeclaredFields.set(action.type, new Set());
          }
          this._undeclaredFields.get(action.type).add(k);
        }
      }
    }
    return super.pickPayload(action);
  }

  // Override fallback to track unregistered types without console warnings.
  _fallbackPayload(action) {
    this._unregisteredTypes.add(action.type);
    const out = {};
    for (const k of Object.keys(action)) {
      if (FRAMEWORK_FIELDS.has(k)) continue;
      if (k.startsWith('_'))       continue;
      if (action[k] != null)       out[k] = action[k];
    }
    return out;
  }

  /** { actionType: [fieldName, ...] } for all registered types with undeclared fields. */
  get fieldMismatches() {
    const out = {};
    for (const [type, fields] of this._undeclaredFields) {
      out[type] = [...fields].sort();
    }
    return out;
  }

  /** Sorted array of action type strings encountered but not registered. */
  get unregisteredTypes() {
    return [...this._unregisteredTypes].sort();
  }
}

// ─── Scenario setup ──────────────────────────────────────────────────────────

const SIM_START = new Date(Date.UTC(2026, 0, 1));
// 2 years covers all periodic action types: monthly wages/expenses/interest,
// quarterly dividends, annual period-advance/tax-settle, and RMD triggers.
const SIM_END   = new Date(Date.UTC(2028, 1, 1));

/**
 * Build and run the full IntlRetirementScenario with a DriftDetectorRegistry
 * wired in place of the normal TypeRegistry.  Journal entries are discarded
 * (we only need the detector's pickPayload interceptions).
 *
 * Returns the detector after the run completes.
 */
let _detector = null;
function getDetector() {
  if (_detector) return _detector;

  const registry = new ServiceRegistry();

  // Replace before loading so ScenarioCompiler registers toolsets on the detector.
  const detector = new DriftDetectorRegistry();
  registry.typeRegistry                  = detector;
  registry.simulationContext.typeRegistry = detector;

  // Build the Simulation object (registers it as 'primary' in simulationRegistry).
  const scenario = new IntlRetirementScenario({
    context:  registry.simulationContext,
    params:   {},
    simStart: SIM_START,
    simEnd:   SIM_END,
  });
  scenario.buildSim();

  // Compile: registers all toolset declarations on the detector then wires
  // handlers / reducers / schedules into the simulation.
  const rawCfg = IntlRetirementScenario.buildDefaultConfig({}, SIM_START, SIM_END);
  const cfg    = ScenarioSerializer.serializeScenario(rawCfg);
  new ScenarioLoader().load(cfg, registry);

  const sim = registry.simulationRegistry.get('primary');

  // Enable journal so _pickPayload is called for every reducer execution;
  // discard the entries themselves — we only care about the detector's findings.
  sim.journal.enabled  = true;
  sim.journal.addEntry = () => {};

  sim.stepTo(SIM_END);

  _detector = detector;
  return detector;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('no undeclared fields on registered action types (2-year IntlRetirementScenario)', () => {
  const detector   = getDetector();
  const mismatches = detector.fieldMismatches;
  const types      = Object.keys(mismatches);

  if (types.length === 0) return;

  const lines = types.map(t =>
    `  ${t}: undeclared fields [${mismatches[t].join(', ')}]`
  ).join('\n');
  assert.fail(
    `${types.length} action type(s) have live fields not declared in their toolset manifest:\n` +
    `${lines}\n\n` +
    `Fix: add each missing field to the types.actions entry in the owning toolset's types block.`
  );
});

test('all emitted action types are registered in a toolset manifest (2-year IntlRetirementScenario)', () => {
  const detector    = getDetector();
  const unregistered = detector.unregisteredTypes;

  if (unregistered.length === 0) return;

  assert.fail(
    `${unregistered.length} action type(s) were emitted but not registered in any toolset manifest:\n` +
    unregistered.map(t => `  ${t}`).join('\n') + '\n\n' +
    `Fix: add each type to the types.actions block of the owning toolset.`
  );
});
