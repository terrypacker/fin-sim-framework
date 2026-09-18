#!/usr/bin/env node
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
 * probe-equity-process-fit.mjs — design 102 §2.
 *
 * Which equity return process is "realistic"? This measures 150+ years of US history
 * (Shiller S&P 500, January to January) on the statistics that decide a retirement plan's
 * success rate, and puts each of the engine's processes, run through the REAL
 * `EquityReturnTickHandler`, on the same yardstick:
 *
 *   - lag-1 autocorrelation: does a year predict the next one?
 *   - variance ratios VR(k) = Var(k-year sum) / (k · Var(1-year)): 1 means independent
 *     years, above 1 means momentum, below 1 means prices pull back over time;
 *   - the spread of 30-year annualized returns, which is what drives MC failure;
 *   - skew and excess kurtosis (the crash tail).
 *
 * Also: a permutation test of whether history's VR < 1 beats chance, and the CAPE10 →
 * next-decade return relation (valuation, which the CMA anchor already prices).
 *
 * Every model runs through the handler at the same anchor (history's real geometric mean)
 * and the same vol (history's sd, so the bootstrap replays history at its own size), with
 * idiosyncratic vol off. Only the process shape differs.
 *
 * Usage: node scripts/probes/probe-equity-process-fit.mjs [--paths 2000] [--seed 7]
 */

import { readFileSync }  from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EquityReturnTickHandler, HISTORICAL_BOOTSTRAP_SERIES } from '../../src/finance/economic-regimes/equity-return-tick-handler.js';
import { EquityReturnStepReducer } from '../../src/finance/economic-regimes/equity-return-step-reducer.js';
import { EQUITY_SLEEVES, RATE_KEYS } from '../../src/finance/economic-regimes/rate-keys.js';
import { gaussianFrom }  from '../../src/finance/fx/fx-process-models.js';
import { parseFlags } from '../lib/cli.mjs';

const opts  = parseFlags(process.argv.slice(2), {
  usage: 'node scripts/probes/probe-equity-process-fit.mjs [--paths 2000] [--seed 7]\n\n'
       + 'probe-equity-process-fit — which return process fits the observed history.',
  paths: { type: 'number', default: 2000, help: 'simulated paths per model' },
  seed:  { type: 'number', default: 7,    help: 'RNG seed' },
});
const PATHS = opts.paths;
const SEED  = opts.seed;

// ── data ─────────────────────────────────────────────────────────────────────────
const root = fileURLToPath(new URL('../../', import.meta.url));
const [hdr, ...lines] = readFileSync(root + 'docs/economic-shocks/data/Shiller-SP500-monthly.csv', 'utf8').trim().split(/\r?\n/);
const cols = hdr.split(',');
const at   = (c, name) => c[cols.indexOf(name)];
const jan  = lines.map(l => l.split(',')).filter(c => at(c, 'observation_date').slice(5, 7) === '01' && at(c, 'real_total_return_price') !== '');
const years = jan.map(c => Number(at(c, 'observation_date').slice(0, 4)));
const rtr   = jan.map(c => Number(at(c, 'real_total_return_price')));
const cpi   = jan.map(c => Number(at(c, 'CPI')));
const real  = rtr.slice(1).map((v, i) => Math.log(v / rtr[i]));                          // log real TR
const nom   = rtr.slice(1).map((v, i) => Math.log((v * cpi[i + 1]) / (rtr[i] * cpi[i])));  // log nominal TR
const N     = real.length;

// ── statistics ───────────────────────────────────────────────────────────────────
const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length;
const sdev = (x) => { const m = mean(x); return Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1)); };
const ac   = (x, l) => { const m = mean(x); let num = 0, den = 0; for (let i = 0; i < x.length; i++) { den += (x[i] - m) ** 2; if (i >= l) num += (x[i] - m) * (x[i - l] - m); } return num / den; };
const sums = (x, k) => { const out = []; for (let i = 0; i + k <= x.length; i++) { let s = 0; for (let j = 0; j < k; j++) s += x[i + j]; out.push(s); } return out; };
const vr   = (x, k) => sdev(sums(x, k)) ** 2 / (k * sdev(x) ** 2);
const quantile = (arr, q) => { const a = [...arr].sort((p, r) => p - r); const pos = (a.length - 1) * q; const lo = Math.floor(pos); return a[lo] + (a[Math.min(lo + 1, a.length - 1)] - a[lo]) * (pos - lo); };
const median = (a) => quantile(a, 0.5);
const pct  = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
const f    = (v, d = 3) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;

function describeSeries(x) {
  const m = mean(x), s = sdev(x);
  const z = x.map(v => (v - m) / s);
  return {
    mean: m, sd: s, skew: mean(z.map(v => v ** 3)), exkurt: mean(z.map(v => v ** 4)) - 3,
    ac1: ac(x, 1), ac2: ac(x, 2), ac3: ac(x, 3), ac5: ac(x, 5),
    vr5: vr(x, 5), vr10: vr(x, 10), vr20: vr(x, 20),
    pBelowMinus25: x.filter(v => Math.expm1(v) < -0.25).length / x.length,
  };
}

// A seeded uniform generator (mulberry32), so every table is reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rng = mulberry32(SEED);

// ── 1. history ───────────────────────────────────────────────────────────────────
console.log(`\nShiller S&P 500 total return, January to January, ${years[0]}–${years[years.length - 1]} (${N} annual returns, log)\n`);
for (const [name, x] of [['REAL', real], ['NOMINAL', nom]]) {
  const d = describeSeries(x);
  console.log(`${name.padEnd(8)} mean ${f(d.mean)}  sd ${d.sd.toFixed(3)}  skew ${f(d.skew, 2)}  exkurt ${f(d.exkurt, 2)}  `
    + `ac1 ${f(d.ac1, 2)} ac2 ${f(d.ac2, 2)} ac3 ${f(d.ac3, 2)} ac5 ${f(d.ac5, 2)}  `
    + `VR5 ${d.vr5.toFixed(2)} VR10 ${d.vr10.toFixed(2)} VR20 ${d.vr20.toFixed(2)}  P(yr < −25%) ${pct(d.pBelowMinus25)}`);
  for (const h of [10, 20, 30]) {
    const c = sums(x, h).map(s => Math.expm1(s / h));
    console.log(`         rolling ${h}y annualized  p5 ${pct(quantile(c, 0.05))}  p50 ${pct(quantile(c, 0.5))}  p95 ${pct(quantile(c, 0.95))}  worst ${pct(Math.min(...c))}`);
  }
}

// ── 2. is history's pull-back distinguishable from independent years? ────────────
const shuffle = (x) => { const a = [...x]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const nulls = Array.from({ length: 5000 }, () => { const p = shuffle(real); return [ac(p, 1), vr(p, 5), vr(p, 10), vr(p, 20)]; });
const observed = [ac(real, 1), vr(real, 5), vr(real, 10), vr(real, 20)];
console.log('\nREAL vs the same years shuffled (5000 permutations — independent years, same fat tails)');
console.log('stat     observed   null p5 .. p95     one-sided p (null ≤ observed)');
['ac1', 'VR5', 'VR10', 'VR20'].forEach((lab, i) => {
  const col = nulls.map(r => r[i]);
  const p   = col.filter(v => v <= observed[i]).length / col.length;
  console.log(`${lab.padEnd(8)} ${f(observed[i]).padStart(7)}   ${f(quantile(col, 0.05))} .. ${f(quantile(col, 0.95))}     ${p.toFixed(3)}`);
});

// ── 3. the engine's processes, through the real handler ──────────────────────────
const simple  = real.map(Math.expm1);
const anchor  = Math.exp(mean(real)) - 1;                 // history's real geometric mean
const histSd  = HISTORICAL_BOOTSTRAP_SERIES.sd;           // simple-return sd the bootstrap rescales against
const US      = RATE_KEYS.EQUITY_US;
const noIdio  = Object.fromEntries(EQUITY_SLEEVES.map(k => [k, 0]));
const reducer = new EquityReturnStepReducer();

/** One path of `years` log returns through the handler, the reducer threading its state. */
function enginePath(opts, years) {
  const h = new EquityReturnTickHandler({ vol: histSd, idioVol: noIdio, ...opts });
  const sim = { rng };
  let state = {};
  const out = [];
  for (let t = 0; t < years; t++) {
    const a = h.call({ sim, state })[0];
    state   = reducer.reduce(state, a);
    const r = anchor + a.deviation[US] + a.driftComp[US];
    // A year below −100% is impossible for a real asset. Count it, and floor it at −99.99%
    // so one bad year doesn't turn the whole path's statistics into NaN.
    if (r <= -1) impossibleYears++;
    out.push(Math.log(Math.max(1 + r, 1e-4)));
  }
  return out;
}
let impossibleYears = 0;

const MODELS = [
  ['WHITE_NOISE',                        { model: 'WHITE_NOISE' }],
  ['MEAN_REVERTING k=0.3 (persistent)',  { model: 'MEAN_REVERTING', reversionSpeed: 0.3 }],
  ['MEAN_REVERTING k=0.5 (persistent)',  { model: 'MEAN_REVERTING', reversionSpeed: 0.5 }],
  ['HISTORICAL_BOOTSTRAP block 1',       { model: 'HISTORICAL_BOOTSTRAP', blockLength: 1 }],
  ['HISTORICAL_BOOTSTRAP block 5',       { model: 'HISTORICAL_BOOTSTRAP', blockLength: 5 }],
  ['HISTORICAL_BOOTSTRAP block 10',      { model: 'HISTORICAL_BOOTSTRAP', blockLength: 10 }],
];

console.log(`\nEngine processes: ${PATHS} paths × ${N} years, anchor ${pct(anchor)} real (history's geometric mean), vol ${histSd.toFixed(3)} (history's simple-return sd), idio off`);
console.log('Path statistics are medians across paths. 30y columns use each path\'s first 30 years; "width" is p95 − p5.');
console.log(`${'process'.padEnd(36)}    sd    ac1   VR5  VR10  VR20   skew  30y p5  30y p50  30y p95   width  geo mean`);
const h30   = sums(real, 30).map(s => Math.expm1(s / 30));
const hq    = [0.05, 0.5, 0.95].map(q => quantile(h30, q));
const hd    = describeSeries(real);
console.log(`${'HISTORY (rolling, overlapping)'.padEnd(36)} ${hd.sd.toFixed(3)} ${f(hd.ac1, 2)}  ${hd.vr5.toFixed(2)}  ${hd.vr10.toFixed(2)}  ${hd.vr20.toFixed(2)}  ${f(hd.skew, 2)}  ${pct(hq[0]).padStart(6)}  ${pct(hq[1]).padStart(7)}  ${pct(hq[2]).padStart(7)}  ${pct(hq[2] - hq[0]).padStart(6)}   ${pct(anchor)}`);
for (const [label, opts] of MODELS) {
  impossibleYears = 0;
  const paths = Array.from({ length: PATHS }, () => enginePath(opts, N));
  if (impossibleYears > 0) console.log(`  ⚠️ ${label}: ${impossibleYears} of ${PATHS * N} years below −100% (floored at −99.99%)`);
  const per   = paths.slice(0, 1000).map(describeSeries);
  const c30   = paths.map(p => Math.expm1(mean(p.slice(0, 30))));
  const q     = [0.05, 0.5, 0.95].map(v => quantile(c30, v));
  const geo   = Math.expm1(mean(paths.flat()));
  const med   = (k) => median(per.map(d => d[k]));
  console.log(`${label.padEnd(36)} ${med('sd').toFixed(3)} ${f(med('ac1'), 2)}  ${med('vr5').toFixed(2)}  ${med('vr10').toFixed(2)}  ${med('vr20').toFixed(2)}  ${f(med('skew'), 2)}  ${pct(q[0]).padStart(6)}  ${pct(q[1]).padStart(7)}  ${pct(q[2]).padStart(7)}  ${pct(q[2] - q[0]).padStart(6)}   ${pct(geo)}`);
}

// ── 4. the AU market (design 102 §6) ─────────────────────────────────────────────
// Is the AU replay consistent with the AU sleeve's beta and idio settings? The model
// implies corr(AU, US) = β·σ / √(β²σ² + σ_idio²). History gives one number for 1958–2023,
// and the engine with the replay on should land near it, since it replays those years.
{
  const { HISTORICAL_AU_SERIES } = await import('../../src/finance/economic-regimes/equity-return-tick-handler.js');
  const { DEFAULT_EQUITY_BETA, DEFAULT_EQUITY_IDIO } = await import('../../src/finance/economic-regimes/rate-keys.js');
  const AU = RATE_KEYS.EQUITY_AU;
  const au = HISTORICAL_AU_SERIES;
  const usSame = simple.slice(au.firstYear - years[0], au.firstYear - years[0] + au.deviations.length);
  const corr = (a, b) => { const ma = mean(a), mb = mean(b); let s = 0, sa = 0, sb = 0; a.forEach((v, i) => { s += (v - ma) * (b[i] - mb); sa += (v - ma) ** 2; sb += (b[i] - mb) ** 2; }); return s / Math.sqrt(sa * sb); };
  const beta = DEFAULT_EQUITY_BETA[AU], idio = DEFAULT_EQUITY_IDIO[AU], vol = 0.18;
  console.log(`\nAU MARKET (OECD, real price, 1958–2023, n=${au.deviations.length})`);
  console.log(`  history:        sd ${au.sd.toFixed(3)}   corr with US ${f(corr(au.deviations, usSame), 2)}`);
  console.log(`  model settings: sd ${Math.sqrt(beta * beta * vol * vol + idio * idio).toFixed(3)}   corr with US ${f(beta * vol / Math.sqrt(beta * beta * vol * vol + idio * idio), 2)}   (β ${beta}, idio ${idio}, vol ${vol})`);
  for (const auReplay of [true, false]) {
    const h = new EquityReturnTickHandler({ model: 'HISTORICAL_BOOTSTRAP', vol, auReplay });
    const us = [], aus = [];
    for (let p = 0; p < 500; p++) {
      let state = {};
      for (let t = 0; t < 40; t++) {
        const a = h.call({ sim: { rng }, state })[0];
        state = reducer.reduce(state, a);
        if (a.bootstrap.year >= au.firstYear) { us.push(a.deviation[RATE_KEYS.EQUITY_US]); aus.push(a.deviation[AU]); }
      }
    }
    console.log(`  engine, replay ${auReplay ? 'on ' : 'off'}: sd ${sdev(aus).toFixed(3)}   corr with US ${f(corr(aus, us), 2)}   (years 1958–2023 only)`);
  }
}

// ── 5. valuation ─────────────────────────────────────────────────────────────────
// CAPE10 = real price / trailing 10-year mean real earnings, against the next 10 years' mean
// real log return. Overlapping windows, so only about n/10 observations are independent.
const byYear = new Map(jan.map(c => [Number(at(c, 'observation_date').slice(0, 4)), c]));
const realEarn = (y) => {
  const c = byYear.get(y);
  if (!c || at(c, 'SP500_earnings_12m') === '') return null;
  return Number(at(c, 'real_price')) * Number(at(c, 'SP500_earnings_12m')) / Number(at(c, 'SP500_price'));
};
const capeX = [], fwdY = [];
for (let i = 0; i + 10 <= N; i++) {
  const e = Array.from({ length: 10 }, (_, j) => realEarn(years[i] - 1 - j));
  if (e.includes(null)) continue;
  capeX.push(Math.log(Number(at(jan[i], 'real_price')) / mean(e)));
  fwdY.push(mean(real.slice(i, i + 10)));
}
const mx = mean(capeX), my = mean(fwdY);
let sxy = 0, sxx = 0, syy = 0;
capeX.forEach((x, i) => { sxy += (x - mx) * (fwdY[i] - my); sxx += (x - mx) ** 2; syy += (fwdY[i] - my) ** 2; });
console.log(`\nCAPE10 vs the next 10 years' real return: n=${capeX.length} (~${Math.floor(capeX.length / 10)} independent), corr ${f(sxy / Math.sqrt(sxx * syy), 2)}, slope ${f(sxy / sxx)} per log-unit of CAPE`);
console.log(`
Reading it:
  ac1 ≈ 0 in history. WHITE_NOISE and the bootstrap reproduce that; MEAN_REVERTING does not.
  In the engine it is an OU step on the RETURN, which makes returns persist (momentum).
  VR < 1 in history is mild price pull-back. It is suggestive, not significant (section 2's p).
  The bootstrap keeps whatever of it survives inside a block, without fitting it.
  30y width is what an MC failure rate responds to. History's own rolling width comes from
  a handful of independent 30-year windows in one survivor market, so it UNDERSTATES the risk.
`);
