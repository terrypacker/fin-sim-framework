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
 * hedge-horizon-worker.mjs — the per-process body of `scripts/lab/hedge-horizon.mjs`.
 *
 * Spawned by `runJobsParallel` as `node hedge-horizon-worker.mjs <in.json> <out.json>`. Each
 * job is one (seed, ρ) run of AU Single Homeowner with stochastic equity, MEAN_REVERTING FX
 * and `rngStreams`, and records per year the USD/AUD rate and the ex-AU sleeve's deviation.
 *
 * The equity draw made on 31 Dec of Y drives year Y + 1's growth and year Y + 1's FX ticks
 * (design 120 §5.4, the stamped `equityMarketShock`), so the deviation read at the start of
 * Y + 1 is recorded against Y + 1.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { ServiceRegistry }             from '../../src/services/service-registry.js';
import { BaseScenario }                from '../../src/scenarios/base-scenario.js';
import { ScenarioLoader }              from '../../src/scenarios/scenario-loader.js';
import { AuSingleHomeownerScenario }   from '../../src/scenarios/au-single-homeowner-scenario.js';

function runOne({ seed, rho, toYear }) {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  const cfg = AuSingleHomeownerScenario.buildDefaultConfig({
    fxProcessModel: 'MEAN_REVERTING', equityReturnStochastic: true, rngStreams: true,
    randomSeed: seed, fxEquityCorrelation: rho,
  });
  const sc = new BaseScenario({ context: services.simulationContext, initialState: cfg.initialState ?? {},
    simStart: new Date(cfg.simStart), simEnd: new Date(cfg.simEnd) });
  sc.buildSim({ telemetry: 'none' });
  new ScenarioLoader().load(cfg, services);
  const fx = {}, dev = {};
  for (let y = new Date(cfg.simStart).getUTCFullYear(); y <= toYear; y++) {
    sc.sim.stepTo(new Date(Date.UTC(y + 1, 0, 1)));
    const s = sc.sim.state;
    fx[y] = s.effectiveExchangeRates.USD_AUD;
    const d = s.equityReturnDev?.EQUITY_INTL_EX_AU;
    if (d != null) dev[y + 1] = d;
  }
  return { seed, rho, fx, dev };
}

const [inF, outF] = process.argv.slice(2);
const { jobs } = JSON.parse(readFileSync(inF, 'utf8'));
const { log, warn } = console;
const rows = jobs.map(({ levers }) => {
  console.log = () => {}; console.warn = () => {};
  try { return runOne(levers); }
  catch (e) { return { ...levers, error: String(e?.stack ?? e) }; }
  finally { console.log = log; console.warn = warn; }
});
writeFileSync(outF, JSON.stringify(rows));
