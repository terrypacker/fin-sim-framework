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
 * mc-worker.mjs — one shard of design 97 §20's paired run. Driven by `runJobsParallel`.
 *
 * A process boundary per shard is not an optimisation: `ServiceRegistry` is a process-global
 * singleton that `openSim` resets on every run, so two sims cannot be in flight at once and a
 * leaked registry silently contaminates the next run. See `scripts/lib/parallel.mjs`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { buildScenario, GROWTH, OFFSET } from './scenario.mjs';
import { arms, PROCESSES } from './arms.mjs';
import { openSim, quiet } from '../../lib/run.mjs';
import { computeAfterTaxNetWorth, afterTaxOptionsFromParams }
  from '../../../src/finance/derived-metrics/after-tax.js';
import { computeNetLiquidity } from '../../../src/finance/derived-metrics/net-liquidity.js';

const [, , inF, outF] = process.argv;
const { jobs } = JSON.parse(readFileSync(inF, 'utf8'));

const ARMS = Object.fromEntries(arms().map(a => [a.key, a]));
const PROC = Object.fromEntries(PROCESSES.map(p => [p.key, p]));

const rows = jobs.map(({ id, armKey, processKey, seed, vol, shock, crashYear }) => {
  const cfg = buildScenario({
    params: {
      liquidityGraph: ARMS[armKey].graph,
      equityReturnStochastic: true,
      equityReturnVol: vol,
      randomSeed: seed,
      shocks: shock ? [{ preset: shock, startDate: `${crashYear}-01-01` }] : [],
      ...PROC[processKey].params,
    },
  });

  // The RNG path itself, sampled once a year. Two arms on the same seed MUST see the same
  // market — that is what "paired" means and it is not a safe assumption: any arm that
  // consumed a different number of uniforms would silently be compared against a different
  // world. `equity-sleeve-rng-neutrality` is the same check one layer down.
  const rates = [];
  const sim = quiet(() => {
    const s = openSim(cfg, {
      telemetry: 'journal', samplerCadence: 'year-boundary',
      sampler: (state) => { rates.push(Math.round((state?.effectiveGrowthRates?.EQUITY_US ?? 0) * 1e6)); return null; },
    });
    s.stepTo(new Date(cfg.simEnd));
    return s;
  });

  let interest = 0;
  let oof = null;
  for (const e of sim.journal?.journal ?? []) {
    const t = e.action?.type;
    if (t === 'LOAN_PAYMENT_APPLY') interest += e.action.data?.interest ?? e.action.interest ?? 0;
    else if (t === 'OUT_OF_FUNDS' && !oof) oof = new Date(e.date ?? 0).getUTCFullYear();
  }

  const atnw = computeAfterTaxNetWorth(sim.state, afterTaxOptionsFromParams(cfg.parameters ?? {}));
  const liq  = computeNetLiquidity(sim.state);
  return {
    id, armKey, processKey, seed,
    afterTaxNW: Math.round(typeof atnw === 'number' ? atnw : (atnw?.total ?? 0)),
    nw:         Math.round(sim.state.metrics?.netWorth ?? 0),
    netLiq:     Math.round(typeof liq === 'number' ? liq : (liq?.total ?? 0)),
    equityEnd:  Math.round((sim.state?.[GROWTH]?.holdings ?? [])
                  .filter(h => h.allocation === 'EQUITY')
                  .reduce((t, h) => t + (h.marketValue ?? 0), 0)),
    offsetEnd:  Math.round(sim.state?.[OFFSET]?.balance ?? 0),
    interest:   Math.round(interest),
    failed:     !!sim.state.scenarioFailed,
    oof,
    ratesKey:   rates.join(','),
  };
});

writeFileSync(outF, JSON.stringify(rows));
