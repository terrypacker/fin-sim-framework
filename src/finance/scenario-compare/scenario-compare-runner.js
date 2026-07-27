/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ServiceRegistry }        from '../../services/service-registry.js';
import { IntlRetirementScenario } from '../../scenarios/intl-retirement-scenario.js';
import { ScenarioLoader }         from '../../scenarios/scenario-loader.js';
import { ScenarioSerializer }     from '../../scenarios/scenario-serializer.js';
import { computeNetWorthUsd }     from '../monte-carlo/intl-retirement-mc-runner.js';
import { computeNetWorthInclSpeculative } from '../derived-metrics/net-worth.js';

/**
 * ScenarioCompareRunner — runs a scenario registry entry deterministically
 * in an isolated ServiceRegistry (no effect on the singleton or live sim).
 *
 * Returns the final state, journal entries, and headline KPI metrics so the
 * comparison presenter can render side-by-side diffs without running MC.
 */
export class ScenarioCompareRunner {
  /**
   * Run a single scenario entry to completion.
   *
   * @param {object} entry       — scenario graph node (from ScenarioRegistry)
   * @param {Function} [ScenarioCls=IntlRetirementScenario]
   * @returns {{ finalState, journalEntries, finalNetWorthUsd, outOfFundsDate, cumulativeDeficit, scenarioFailed }}
   */
  static run(entry, ScenarioCls = IntlRetirementScenario) {
    const simStart = new Date(entry.simStart);
    const simEnd   = new Date(entry.simEnd);

    const cfg = ScenarioSerializer.serializeScenario(entry);

    const registry = new ServiceRegistry();
    const scenario = new ScenarioCls({
      context:  registry.simulationContext,
      simStart,
      simEnd,
    });
    scenario.buildSim();
    new ScenarioLoader().load(cfg, registry);

    // Do NOT set sim.silent — silent mode skips stateDiff computation (simulation.js:789),
    // which Phase B.5 needs for field-level journal diff.  The isolated ServiceRegistry
    // means bus events publish to a no-subscriber bus; cost is negligible for 2 scenarios.
    scenario.sim.stepTo(simEnd);

    const state = scenario.sim.state;
    return {
      finalState:        state,
      journalEntries:    scenario.sim.journal.journal.slice(),
      finalNetWorthUsd:  computeNetWorthUsd(state),
      finalNetWorthInclSpeculative: computeNetWorthInclSpeculative(state, 'USD'),  // design 88 D7
      outOfFundsDate:    state.outOfFundsDate    ?? null,
      cumulativeDeficit: state.cumulativeDeficit ?? 0,
      scenarioFailed:    state.scenarioFailed    ?? false,
    };
  }
}
