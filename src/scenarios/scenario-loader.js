/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ScenarioSerializer } from './scenario-serializer.js';
import { ToolsetRegistry }    from './toolsets/toolset-registry.js';
import { ScenarioCompiler }   from './toolsets/scenario-compiler.js';
import { US_BANKING }         from './toolsets/us-banking-toolset.js';
import { US_TAX }             from './toolsets/us-tax-toolset.js';
import { US_RETIREMENT }      from './toolsets/us-retirement-toolset.js';
import { AU_BANKING }         from './toolsets/au-banking-toolset.js';
import { AU_TAX }             from './toolsets/au-tax-toolset.js';
import { AU_RETIREMENT }      from './toolsets/au-retirement-toolset.js';
import { US_AU_CROSS_BORDER } from './toolsets/us-au-cross-border-toolset.js';
import { US_REAL_PROPERTY }   from './toolsets/us-real-property-toolset.js';
import { AU_REAL_PROPERTY }   from './toolsets/au-real-property-toolset.js';
import { US_COLLECTIBLES }    from './toolsets/us-collectibles-toolset.js';
import { US_ROTH_CONVERSION } from './toolsets/us-roth-conversion-toolset.js';

const BUILT_IN_TOOLSETS = [
  US_BANKING, US_TAX, US_RETIREMENT,
  AU_BANKING, AU_TAX, AU_RETIREMENT,
  US_AU_CROSS_BORDER,
  US_REAL_PROPERTY, AU_REAL_PROPERTY,
  US_COLLECTIBLES, US_ROTH_CONVERSION,
];

/**
 * ScenarioLoader — single entry point for restoring a scenario configuration
 * into the simulation services.
 *
 * Two-branch dispatch:
 *   - If `cfg` carries a saved graph (events/handlers/actions/reducers),
 *     restore it via ScenarioSerializer.deserializeGraph().
 *   - Otherwise, if `cfg.toolsets` is non-empty, synthesize the graph by
 *     compiling the declarative toolsets.
 *
 * Persons / accounts / real-properties / collectibles are always restored
 * via ScenarioSerializer.deserializePersonsAccounts() before the graph step,
 * so the toolset compiler can read them from the services.
 */
export class ScenarioLoader {
  constructor() {
    this._toolsetRegistry = new ToolsetRegistry();
    for (const t of BUILT_IN_TOOLSETS) this._toolsetRegistry.register(t);
  }

  /**
   * Populate `services` from `cfg`. Caller is responsible for having created
   * the Simulation (via `scenario.buildSim()`) before calling this.
   *
   * Compile branch — runs the toolset compiler, which mutates sim.state. The
   * resulting state is snapshotted into `cfg.initialState` so the next save/load
   * cycle can restore it without re-running the compiler.
   *
   * Deserialize branch — restores the graph from a saved snapshot, then re-hydrates
   * sim.state from `cfg.initialState`. buildSim() can't do this on its own because
   * scenario subclasses (e.g. IntlRetirementScenario) don't thread initialState
   * through their constructor, so sim.state starts empty regardless.
   *
   * @param {object} cfg      - serialized scenario config
   * @param {object} services - ServiceRegistry instance
   */
  load(cfg, services) {
    if (!cfg) return;

    ScenarioSerializer.deserializePersonsAccounts(cfg, services);

    const sim = services.simulationRegistry?.getPrimary?.();

    if (ScenarioSerializer.hasSerializedGraph(cfg)) {
      ScenarioSerializer.deserializeGraph(cfg, services);
      if (sim && cfg.initialState && Object.keys(cfg.initialState).length > 0) {
        Object.assign(sim.state, _cloneState(cfg.initialState));
      }
    } else if (cfg.toolsets?.length > 0) {
      new ScenarioCompiler(this._toolsetRegistry).compile(cfg, services);
      if (sim) cfg.initialState = _cloneState(sim.state);
    }
  }
}

/**
 * Deep-clone the simulation state. structuredClone preserves Date objects
 * (which the people map carries) but falls back to JSON-clone for any state
 * that contains class instances structuredClone can't handle.
 */
function _cloneState(state) {
  try {
    return structuredClone(state);
  } catch {
    return JSON.parse(JSON.stringify(state));
  }
}
