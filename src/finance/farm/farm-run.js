/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ServiceRegistry } from '../../services/service-registry.js';
import { BaseScenario }    from '../../scenarios/base-scenario.js';
import { ScenarioLoader }  from '../../scenarios/scenario-loader.js';
import { normalizeFarm }   from './farm-records.js';
import { farmLedger, farmGrainMoves, farmGrainSales, jobCostReport, cashReport } from './farm-reports.js';

/**
 * Run one farm season headlessly and build its reports (design 134). One implementation for
 * the CLI, the tests and any later batch caller, all through the real `ScenarioLoader`.
 *
 * Resets the global `ServiceRegistry`, as every headless runner here does.
 *
 * @param {object} cfg a farm scenario cfg (`FarmScenario.buildDefaultConfig()` or a saved one)
 * @param {object} [opts]
 * @param {'CUSTOM'|'ACTUAL'} [opts.machineryBasis='CUSTOM']
 * @param {'full'|'journal'} [opts.telemetry='journal'] the ledger IS the journal, so a level
 *   below `journal` would leave the reports empty
 * @returns {{ sim, cfg, farm, ledger, jobCost, cash }}
 */
export function runFarm(cfg, { machineryBasis = 'CUSTOM', telemetry = 'journal' } = {}) {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  const scenario = new BaseScenario({
    context:  services.simulationContext,
    simStart: new Date(cfg.simStart),
    simEnd:   new Date(cfg.simEnd),
  });
  scenario.buildSim({ telemetry });
  new ScenarioLoader().load(cfg, services);
  const sim = scenario.sim;
  sim.stepTo(new Date(cfg.simEnd));
  return { sim, cfg, ...farmReports(cfg, sim, { machineryBasis }) };
}

/**
 * The planned season: the farm run to its end on its own isolated service registry, so a
 * panel can read the full season's breakevens while the workbench's own run is part-way
 * through it. It never touches the singleton registry, so the active scenario and its UI
 * bindings stay as they are (the Monte Carlo worker's pattern, mc-worker-core.js).
 *
 * @param {object} cfg the farm scenario cfg; it is cloned, never mutated. The clone is a JSON
 *   round trip, as a saved scenario is: the workbench's live cfg carries class references
 *   (its scenario class) that `structuredClone` refuses.
 * @returns {{ farm: object, ledger: object[], grain: object[], grainSales: object[], pools: object,
 *   receivables: object }} what `jobCostReport` needs, at either machinery basis, the grain
 *   moves (`farmGrainMoves`) for the grain chart and what each move out fetched
 *   (`farmGrainSales`) for the grain value chart
 */
export function planFarm(cfg) {
  const registry = new ServiceRegistry();
  const scenario = new BaseScenario({
    context:  registry.simulationContext,
    simStart: new Date(cfg.simStart),
    simEnd:   new Date(cfg.simEnd),
  });
  scenario.buildSim({ telemetry: 'journal' });
  new ScenarioLoader().load(JSON.parse(JSON.stringify(cfg)), registry);
  const sim = scenario.sim;
  sim.stepTo(new Date(cfg.simEnd));
  return {
    farm:        normalizeFarm(cfg.farm),
    ledger:      farmLedger(sim.journal?.journal),
    grain:       farmGrainMoves(sim.journal?.journal),
    grainSales:  farmGrainSales(sim.journal?.journal),
    pools:       sim.state.farm?.pools ?? {},
    receivables: sim.state.farm?.receivables ?? {},
  };
}

/**
 * The reports of a farm sim that has already run.
 *
 * @param {object} cfg
 * @param {object} sim a stepped `Simulation`
 * @param {object} [opts]
 * @param {'CUSTOM'|'ACTUAL'} [opts.machineryBasis='CUSTOM']
 */
export function farmReports(cfg, sim, { machineryBasis = 'CUSTOM' } = {}) {
  const farm = normalizeFarm(cfg.farm);
  const ledger = farmLedger(sim.journal?.journal);
  if (ledger.length === 0 && (farm.cropPlans.length > 0 || farm.fields.length > 0)) {
    throw new Error('The farm ran but its ledger is empty: the reports read the journal, '
      + 'so the sim must be built with telemetry "journal" or "full".');
  }
  return {
    farm,
    ledger,
    jobCost: jobCostReport(farm, ledger, {
      machineryBasis,
      pools:       sim.state.farm?.pools ?? {},
      receivables: sim.state.farm?.receivables ?? {},
    }),
    cash: cashReport(farm, ledger),
  };
}
