/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import {
  HoldingTransactReducer, HoldingRevalueReducer, HoldingSetBasisReducer,
  HoldingSplitReducer, HoldingRetitleReducer,
  HOLDING_REDUCER_CLASSES,
} from '../../finance/holdings/holding-reducers.js';
import { registerHoldingActionTypes } from '../../finance/holdings/holding-actions.js';
import { AssetAppreciateReducer } from '../../finance/handlers/asset-appreciation-handler.js';
import { PeriodService } from '../../finance/period/period-service.js';

/**
 * ScenarioCompiler — consumes a declarative scenario definition and a
 * ToolsetRegistry, resolves toolset dependencies, collects contributions
 * (state, schedules, handlers, reducers), and registers everything with
 * the simulation services.
 *
 * JSON scenario definition shape:
 * {
 *   "toolsets": ["US_RETIREMENT"],
 *   "simStart": "2026-01-01",
 *   "simEnd":   "2046-01-01",
 *   "parameters": { "inflationRate": 0.03, ... },
 *   "persons": [...],
 *   "accounts": [...]
 * }
 */
export class ScenarioCompiler {
  constructor(registry) {
    this.registry = registry;
  }

  /**
   * Compile a declarative scenario definition into a fully wired simulation.
   *
   * @param {object} definition — parsed JSON scenario (toolsets, simStart, simEnd, parameters)
   * @param {object} services — ServiceRegistry instance
   * @returns {{ paramSchema: Array }} merged typed schema for UI rendering
   */
  compile(definition, services) {
    const resolved   = this._resolveToolsets(definition.toolsets);

    // Phase 3: register all resolved toolsets' class + action-type metadata
    // BEFORE any handlers/reducers are instantiated, so the TypeRegistry is
    // populated when the simulation pipeline first runs.
    for (const toolset of resolved) {
      services.typeRegistry?.registerToolset(toolset);
    }
    // Framework-owned substrate (holdings, design 25) is not toolset-bound.
    // Register here so any TypeRegistry instance (incl. test detectors that
    // swap the registry after ServiceRegistry construction) sees it.
    if (services.typeRegistry) {
      registerHoldingActionTypes(services.typeRegistry);
      for (const ctor of Object.values(HOLDING_REDUCER_CLASSES)) {
        services.typeRegistry.registerClass(ctor);
      }
      services.typeRegistry.registerClass(AssetAppreciateReducer);
      services.typeRegistry.registerActionType({
        type: 'ASSET_APPRECIATE_APPLY', family: 'REAL_PROPERTY_CASH', cc: null,
        fields: { stateKey: {}, delta: {} },
      });
    }

    const parameters = this._resolveParameters(definition, resolved);
    const paramSchema = resolved.flatMap(t => t.paramSchema?.({}) ?? []);
    const context    = this._buildContext(definition, services, parameters, paramSchema);

    const statePatches = {};
    const schedules    = [];
    const handlers     = [];
    const reducers     = [];

    for (const toolset of resolved) {
      _mergeStatePatches(statePatches, toolset.state?.(context) ?? {});

      const ts = toolset.schedules?.(context) ?? [];
      for (const s of ts) {
        schedules.push(s);
        context.schedulesById[s.type] = s;
      }

      for (const h of toolset.handlers?.(context) ?? []) {
        h._sourceToolset = toolset.id;
        handlers.push(h);
      }

      reducers.push(...(toolset.reducers?.(context) ?? []));
    }

    // Warn on duplicate EventSeries types (same recurring event registered twice)
    const seenSeries = new Set();
    for (const s of schedules) {
      if (s.interval !== undefined && seenSeries.has(s.type)) {
        console.warn(`[ScenarioCompiler] duplicate EventSeries type '${s.type}'`);
      }
      seenSeries.add(s.type);
    }

    // Expose the shared period service built by tax toolsets so downstream
    // consumers (e.g. JournalQueryApi / journal-report-plugin) can call
    // PeriodService.aggregate() without re-deriving period boundaries.
    if (context.periodService.getAllPeriods().length) {
      services.periodService = context.periodService;
    }

    // Register everything with the simulation services
    const sim = services.simulationRegistry.getPrimary();
    try {
      Object.assign(sim.state, structuredClone(statePatches));
    } catch {
      Object.assign(sim.state, JSON.parse(JSON.stringify(statePatches)));
    }
    for (const s of schedules) services.eventService.register(s);
    for (const h of handlers)  services.handlerService.register(h);
    for (const r of reducers)  services.reducerService.register(r);

    // Framework substrate reducers (design 25 holdings) — always present,
    // not toolset-owned. Registered last so they live in the same pipeline
    // and run at their declared priorities relative to toolset reducers.
    for (const r of _frameworkSubstrateReducers()) {
      services.reducerService.register(r);
    }

    return { paramSchema, statePatches };
  }

  _resolveToolsets(requestedIds) {
    const resolved = new Map();
    const visit = (id) => {
      if (resolved.has(id)) return;
      const toolset = this.registry.get(id);
      for (const dep of toolset.dependencies ?? []) visit(dep);
      resolved.set(id, toolset);
    };
    for (const id of requestedIds) visit(id);
    return [...resolved.values()];
  }

  _resolveParameters(definition, resolvedToolsets) {
    const defaults = {};
    for (const toolset of resolvedToolsets) {
      for (const entry of toolset.paramSchema?.({}) ?? []) {
        if (entry.defaultValue !== undefined) {
          defaults[entry.key] = entry.defaultValue;
        }
      }
    }
    return { ...defaults, ...(definition.parameters ?? {}) };
  }

  _buildContext(definition, services, parameters, paramSchema) {
    return {
      startDate:      new Date(definition.simStart),
      endDate:        new Date(definition.simEnd),
      people:         services.personService?.getAll()         ?? [],
      accounts:       services.accountService?.getAll()        ?? [],
      realProperties: services.realPropertyService?.getAll()   ?? [],
      collectibles:   services.collectibleService?.getAll()    ?? [],
      parameters,
      paramSchema,
      stateRegistry:  services.stateRegistry,
      accountService: services.accountService,
      schedulesById:  {},
      // Shared across toolsets — each tax toolset adds its periods here so
      // US and AU periods end up in one service available for journal reports.
      periodService:  new PeriodService(),
    };
  }
}

/**
 * Build fresh instances of the framework-owned (non-toolset) reducers.
 * Currently: design 25 holdings substrate. Adding a new substrate reducer
 * here is the standard extension point.
 */
function _frameworkSubstrateReducers() {
  return [
    new HoldingTransactReducer(),
    new HoldingRevalueReducer(),
    new HoldingSetBasisReducer(),
    new HoldingSplitReducer(),
    new HoldingRetitleReducer(),
    new AssetAppreciateReducer(),
  ];
}

/**
 * Merge incoming state patches into the accumulator.
 *
 * Most keys are overwritten (last toolset wins, matching Object.assign semantics).
 * A small set of well-known object keys that multiple toolsets may contribute to
 * are merged shallowly so that each toolset's entries are additive rather than
 * destructive:
 *
 *   currentPeriods     — US_TAX contributes { US }, AU_TAX contributes { AU }
 *   inflationRates     — US_RETIREMENT contributes { US }, AU_RETIREMENT { AU }, etc.
 *   inflationAccumulator — same pattern as inflationRates
 *
 * @param {object} acc     — accumulator (mutated in place)
 * @param {object} patches — new patches from a single toolset
 */
function _mergeStatePatches(acc, patches) {
  const SHALLOW_MERGE_KEYS = new Set([
    'currentPeriods',
    'inflationRates',
    'inflationAccumulator',
  ]);
  for (const [key, value] of Object.entries(patches)) {
    if (SHALLOW_MERGE_KEYS.has(key) && acc[key] != null && typeof acc[key] === 'object'
        && value != null && typeof value === 'object') {
      acc[key] = { ...acc[key], ...value };
    } else {
      acc[key] = value;
    }
  }
}
