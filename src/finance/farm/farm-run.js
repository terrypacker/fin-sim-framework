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
import { farmLedger, jobCostReport, cashReport } from './farm-reports.js';

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
