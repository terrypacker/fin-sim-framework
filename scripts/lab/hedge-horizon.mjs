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
 * hedge-horizon.mjs — the model's minimum-variance currency hedge ratio by holding period
 * (design 120 §4).
 *
 * `fx-equity-correlation.mjs` measures corr(f, local) and h* from history. This measures
 * what the ENGINE produces: it runs AU Single Homeowner with stochastic equity, MEAN_REVERTING
 * FX and `fxEquityCorrelation` = each ρ, and for one dollar of the ex-AU sleeve held T years
 * computes
 *
 *   L_T  = Σ log(1 + μ + dev_y)            the sleeve's local log return (μ only moves the mean)
 *   F_T  = 0.86 · log(R_end / R_start)     the basket's currency move (§5.2's volScale)
 *   h*_T = 1 + cov(L_T, F_T) / var(F_T)    an h-hedged dollar returns ≈ L_T + (1 − h)·F_T
 *
 * The one-year figure is §4's check (≈ 0.19 at ρ −0.54). Under mean-reverting FX the
 * currency's variance stops growing while the shares' keeps growing, so h*_T drifts away
 * from 1 as T rises: towards 0 at a negative ρ, above 1 at a positive one. The table also
 * prints the continuous-time OU reading of that drift, 1 + (h*_1 − 1)·g(T)/g(1) with
 * g(T) = 2/(1 + e^(−kT)), for comparison; it ignores the decay of the realised
 * correlation at long horizons, so it overstates the drift.
 *
 * Each run steps the whole plan to 2048. Design 120's phase 3 study ran 400 seeds × 3 ρ in
 * under an hour on 8 cores; at n = 400 the standard error of h* at T = 20 is about 0.15, so
 * fewer seeds read the long horizons only roughly.
 *
 * Usage:
 *   node scripts/lab/hedge-horizon.mjs --seeds 200 --workers 8 --out runs.jsonl
 *   node scripts/lab/hedge-horizon.mjs --in runs.jsonl          # re-analyse saved runs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath }               from 'node:url';
import { parseFlags }                  from '../lib/cli.mjs';
import { runJobsParallel }             from '../lib/parallel.mjs';

const WORKER = fileURLToPath(new URL('../lib/hedge-horizon-worker.mjs', import.meta.url));
const VOL_SCALE = 0.86;   // currency-overlay.js FX_EXPOSURE_BY_MARKET.EQUITY_INTL_EX_AU.volScale
const K         = 0.114;  // FxService.DEFAULT_FX_REVERSION
const MU        = 0.07;   // a nominal sleeve mean; covariances do not depend on it
const START     = 2028;   // the first year whose growth carries an equity draw on this plan
const HORIZONS  = [1, 2, 3, 5, 10, 15, 20];

const opts = parseFlags(process.argv.slice(2), {
  usage: 'node scripts/lab/hedge-horizon.mjs [--seeds N] [--rho list] [--workers N] [--out f.jsonl | --in f.jsonl]\n\n'
       + 'hedge-horizon — the engine\'s minimum-variance currency hedge ratio by holding period.',
  seeds:   { type: 'int',    default: 200,              help: 'seeds per ρ (1..N)' },
  rho:     { type: 'list',   default: ['-0.54', '0', '0.16'], help: 'fxEquityCorrelation values' },
  workers: { type: 'int',    default: 8,                help: 'worker processes' },
  out:     { type: 'string', default: null,             help: 'save the per-path rows (JSONL)' },
  in:      { type: 'string', default: null,             help: 'analyse saved rows instead of running' },
});

const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const cov  = (a, b) => { const ma = mean(a), mb = mean(b); return mean(a.map((x, i) => (x - ma) * (b[i] - mb))); };
const corr = (a, b) => cov(a, b) / Math.sqrt(cov(a, a) * cov(b, b));
const g    = t => 2 / (1 + Math.exp(-K * t));

let rows;
if (opts.in) {
  rows = readFileSync(opts.in, 'utf8').trim().split('\n').map(JSON.parse);
} else {
  const rhos = opts.rho.map(Number);
  const toYear = START + Math.max(...HORIZONS);
  const jobs = [];
  for (let seed = 1; seed <= opts.seeds; seed++) {
    for (const rho of rhos) jobs.push({ id: `${seed}|${rho}`, levers: { seed, rho, toYear } });
  }
  rows = await runJobsParallel({ jobs, source: null, worker: WORKER, workers: opts.workers, label: 'runs' });
  if (opts.out) writeFileSync(opts.out, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

const errors = rows.filter(r => r.error);
rows = rows.filter(r => !r.error);
console.log(`# hedge-horizon — AU Single Homeowner, ${rows.length} paths, ${errors.length} errors`);
if (errors.length) console.log(errors[0].error);

const fxLog = (r, y) => VOL_SCALE * Math.log(r.fx[y] / r.fx[y - 1]);
for (const rho of [...new Set(rows.map(r => r.rho))].sort((a, b) => a - b)) {
  const P = rows.filter(r => r.rho === rho);
  const lastYear = Math.max(...Object.keys(P[0].fx).map(Number));
  // Alignment: the year's currency move against the sleeve deviation of the same and adjacent years.
  const lag = l => {
    const a = [], b = [];
    for (const r of P) for (let y = START + 1; y < lastYear; y++) { a.push(fxLog(r, y)); b.push(r.dev[y + l]); }
    return corr(a, b);
  };
  console.log(`\n## ρ ${rho} (${P.length} paths): annual corr(f, local) lag −1 ${lag(-1).toFixed(3)}, `
    + `same year ${lag(0).toFixed(3)}, lag +1 ${lag(1).toFixed(3)}`);
  console.log('| T yrs | sd(L_T) | sd(F_T) | sd(F_1)·√T | corr(L_T, F_T) | h*_T | OU reading |');
  console.log('|---|---|---|---|---|---|---|');
  const sdF1 = Math.sqrt(mean(P.map(r => fxLog(r, START) ** 2)));
  let h1 = null;
  for (const T of HORIZONS.filter(t => START + t - 1 <= lastYear)) {
    const L = [], F = [];
    for (const r of P) {
      let l = 0;
      for (let y = START; y < START + T; y++) l += Math.log(1 + MU + r.dev[y]);
      L.push(l);
      F.push(VOL_SCALE * Math.log(r.fx[START + T - 1] / r.fx[START - 1]));
    }
    const h = 1 + cov(L, F) / cov(F, F);
    if (h1 == null) h1 = h;
    console.log(`| ${T} | ${Math.sqrt(cov(L, L)).toFixed(3)} | ${Math.sqrt(cov(F, F)).toFixed(3)} | `
      + `${(sdF1 * Math.sqrt(T)).toFixed(3)} | ${corr(L, F).toFixed(3)} | ${h.toFixed(2)} | `
      + `${(1 + (h1 - 1) * g(T) / g(1)).toFixed(2)} |`);
  }
}
