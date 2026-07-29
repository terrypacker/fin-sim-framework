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
 * run.mjs — drive one cfg to completion and reduce it to a comparable row.
 *
 * The lab tools compare hundreds of runs, so what matters is that every run is
 * reduced the SAME way. The row below is that contract.
 *
 * `failed` is the primary outcome for solvency work: `scenarioFailed` is set by an
 * OUT_OF_FUNDS event — unmet spending OR unpayable tax (the tax leg became
 * symmetric with spending when NIIT went in). Terminal net worth is a secondary
 * readout, and a misleading primary one: a plan can end rich having been insolvent
 * in 2038.
 *
 * A caveat worth carrying: "no OOF event" is trivially satisfied by any ADAPTIVE
 * spending rule. A guardrail cannot run out of money — it responds to depletion by
 * spending less. Under GUARDRAIL, `failed` stops being informative and you must
 * look at the standard of living it passed AT. `traceRealSpending` is that lens.
 */

import { ServiceRegistry } from '../../src/services/service-registry.js';
import { BaseScenario }    from '../../src/scenarios/base-scenario.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';
import { computeNetLiquidity } from '../../src/finance/derived-metrics/net-liquidity.js';

/** Silence the sim's per-event logging; hundreds of runs otherwise drown the report. */
export function quiet(fn) {
  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  try { return fn(); } finally { console.log = log; console.warn = warn; }
}

/**
 * Async-aware `quiet`. Restores the console only after the promise SETTLES.
 *
 * Using the sync version on an async body is a real trap: it restores the console
 * the moment the promise is returned, so the run's logging escapes anyway and the
 * report is buried — the silencing silently does nothing.
 */
export async function quietAsync(fn) {
  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  try { return await fn(); } finally { console.log = log; console.warn = warn; }
}

/**
 * Build and load a sim from a cfg WITHOUT stepping it. Use when a tool needs to
 * inspect intermediate state rather than just the terminal row.
 *
 * @param {object} cfg
 * @param {object} [o]
 * @param {'full'|'journal'|'metrics'|'off'} [o.telemetry='full'] See
 *   TELEMETRY_LEVELS (design 78 §4.3). Defaults to `full` because a tool that
 *   opens a sim without stepping it usually wants to inspect the journal or
 *   snapshots; pass `'off'` if all you need is state.
 * @param {function} [o.sampler] Optional (state, date) => record — collect a time
 *   series off the run itself instead of re-stepping it. See Simulation#samples.
 * @param {'interval'|'year-boundary'} [o.samplerCadence='interval'] When the
 *   sampler fires (design 82 §4).
 */
export function openSim(cfg, { telemetry = 'full', sampler = null, samplerCadence = 'interval' } = {}) {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  const scenario = new BaseScenario({
    context:      services.simulationContext,
    initialState: cfg.initialState ?? {},
    simStart:     new Date(cfg.simStart),
    simEnd:       new Date(cfg.simEnd),
  });
  scenario.buildSim({ telemetry, sampler, samplerCadence });
  new ScenarioLoader().load(cfg, services);
  return scenario.sim;
}

/**
 * Run a cfg to its simEnd and reduce it to one row.
 *
 * Defaults to `telemetry: 'off'` — this function's whole contract is "reduce to
 * one terminal row", and `summarize()` reads only state and derived metrics,
 * both of which are produced at every level. Journal, history snapshots and bus
 * telemetry are pure cost here, and they dominate: ~3,800ms vs ~300ms on a
 * 44-year scenario (design 78 §2). This is what makes the grid/frontier/sweep
 * tooling roughly 12x faster.
 *
 * @param {object} cfg
 * @param {object} [o]
 * @param {'full'|'journal'|'metrics'|'off'} [o.telemetry='off']
 * @returns {{failed, oofDate, deficit, deficitMonths, netWorth, netLiq}}
 */
export function run(cfg, { telemetry = 'off' } = {}) {
  const sim = openSim(cfg, { telemetry });
  quiet(() => sim.stepTo(new Date(cfg.simEnd)));
  return summarize(sim);
}

export function summarize(sim) {
  const s = sim.state;
  return {
    failed:        s.scenarioFailed ?? false,
    oofDate:       s.outOfFundsDate ? new Date(s.outOfFundsDate).toISOString().slice(0, 10) : null,
    deficit:       Math.round(s.cumulativeDeficit ?? 0),
    deficitMonths: s.deficitMonths ?? 0,
    netWorth:      Math.round(s.metrics?.netWorth ?? 0),
    netLiq:        Math.round(computeNetLiquidity(s, sim.currentDate)),
  };
}

/**
 * Year-by-year REAL monthly spending, deflated by the inflation accumulator.
 *
 * This is the companion to `run()` for adaptive spending strategies, where the
 * pass/fail flag is uninformative (see the header note). It answers "it survived —
 * but on how much?".
 *
 * @param {object} cfg
 * @param {string} [country] inflation accumulator to deflate by (default: US)
 */
export function traceRealSpending(cfg, country = 'US') {
  // Reads state only (expenses + inflation accumulator), so no telemetry needed.
  const sim = openSim(cfg, { telemetry: 'off' });
  const startYear = new Date(cfg.simStart).getUTCFullYear();
  const endYear   = new Date(cfg.simEnd).getUTCFullYear();
  const series = [];

  quiet(() => {
    for (let y = startYear + 1; y <= endYear; y++) {
      sim.stepTo(new Date(Date.UTC(y, 0, 1)));
      const s = sim.state;
      const nominal = (s.expenses?.essential ?? 0) + (s.expenses?.discretionary ?? 0);
      const infl = s.inflationAccumulator?.[country] ?? s.inflationAccumulator?.US ?? 1;
      series.push({ year: y, nominal, real: infl ? nominal / infl : nominal });
    }
  });

  const reals = series.map(p => p.real).filter(v => v > 0);
  return {
    ...summarize(sim),
    series,
    minReal:   reals.length ? Math.min(...reals) : 0,
    finalReal: series.at(-1)?.real ?? 0,
  };
}
