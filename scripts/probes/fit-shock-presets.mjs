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
 * fit-shock-presets — refit each equity shock preset's drag and recovery curve so the
 * ENGINE's emergent path matches the measured episode (design 127 phase 3).
 *
 *   node scripts/probes/fit-shock-presets.mjs [--only MARKET_CRASH_2008_LITE,…] [--cadence MONTHLY]
 *
 * The presets were tuned when equity read a regime's drag only on 31 December, so their drags
 * were sized for one sample a year. Under MONTHLY crediting the engine integrates the whole
 * recovery curve, and those drags overshoot. This searches, per preset:
 *
 *   - the main `equity` leg: a scale k on its equity adjustments, `durationMonths`, and for a
 *     *_REBOUND profile `reboundStart` / `reboundPeak` — against the S&P targets (depth,
 *     trough month, back-to-peak, and the 10-year cumulative where one is measured);
 *   - then, where MEASUREMENTS §1 has an OECD AU figure, the AU adjustment alone against the AU
 *     depth, on the curve just fitted (AU's own leg in DOTCOM is fitted whole);
 *   - the international sleeves keep their authored ratio to US (no measurement of their own).
 *
 * Weighting: see `loss`. Level breaks are NOT fitted: each is the measured share of the fall that really was
 * instantaneous, a fact about the episode. It prints the fitted values and the before/after
 * table; the library is edited by hand from that output, then `shock-path-engine.mjs --write`
 * regenerates CALIBRATION.md.
 */
import { SHOCK_LIBRARY } from '../../src/finance/economic-shocks/shock-library.js';
import { runPath, summarizePath, asSleeve, TARGETS, SLEEVE_BASE, START_YEAR } from '../lib/shock-path.mjs';
import { parseFlags } from '../lib/cli.mjs';

const opts = parseFlags(process.argv.slice(2), {
  usage: 'node scripts/probes/fit-shock-presets.mjs [--only <keys>] [--cadence MONTHLY]\n\n'
       + 'fit-shock-presets — refit equity shock presets to their measured episodes under a cadence.',
  only:    { type: 'string', default: null, help: 'comma-separated preset keys (default: every preset with a target)' },
  cadence: { type: 'string', default: 'MONTHLY', help: 'equityEarningsCadence to fit under' },
  seed:    { type: 'number', default: 127, help: 'seed for the search\'s random starts' },
});

const START = `${START_YEAR + 1}-01-15`;
const SHOCK_MONTH = 12;
const NO_BACK = 400;                // a path that never regains its peak, in months, for the error

// ── seeded uniform for the random starts ─────────────────────────────────────────
let seed = opts.seed | 0;
const rnd = () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

const noneBy = new Map();
const none = base => noneBy.get(base) ?? noneBy.set(base, runPath([], { base, cadence: opts.cadence })).get(base);

function measure(shock, sleeve = 'EQUITY_US') {
  const base = SLEEVE_BASE[sleeve];
  const path = runPath([asSleeve({ ...shock, startDate: START }, sleeve)], { base, cadence: opts.cadence });
  return summarizePath(none(base), path, SHOCK_MONTH);
}

/**
 * Normalised squared error against a target set, weighted as the library states its
 * calibration target: "the pair (trough depth, trough year), with back-to-peak checked
 * afterwards". Depth 0.5 pp and trough 1 month are primary; back-to-peak 4 months and the
 * 10-year cumulative 4 pp are secondary, because one rebound arc cannot always meet both.
 */
function loss(m, t, base = 0.07) {
  let e = 0;
  // Where no 10-year figure is measured, a WEAK prior toward the baseline's: the targets stop
  // at back-to-peak, and without it the search is free to buy them with a rebound that runs
  // at +50 %/yr for the rest of the decade (seen on dot-com AU: +897 % over ten years).
  if (t.cum10 == null && t.cumAt == null) e += ((m.cum10 - ((1 + base) ** 10 - 1)) / 0.5) ** 2;
  if (t.depth  != null) e += ((m.depth - t.depth) / 0.005) ** 2;
  if (t.trough != null) e += ((m.troughMonth - t.trough) / 1) ** 2;
  if (t.back   != null) e += (((m.backToPeak ?? NO_BACK) - t.back) / 4) ** 2;
  if (t.cum10  != null) e += ((m.cum10 - t.cum10) / 0.04) ** 2;
  if (t.cumAt  != null) e += ((m.cumAt(t.cumAt.months) - t.cumAt.value) / 0.04) ** 2;
  return e;
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * A copy of `preset` with leg `legId`'s curve set from `p` and its equity adjustments scaled
 * by `p.k` — every sleeve, or only `sleeves` when given.
 */
function withLeg(preset, legId, p, sleeves = null) {
  return {
    ...preset,
    legs: preset.legs.map(l => {
      if (l.id !== legId) return l;
      const adj = {};
      for (const [rk, v] of Object.entries(l.regime.returnAdjustment)) {
        adj[rk] = (!sleeves || sleeves.includes(rk)) && rk.startsWith('EQUITY') ? +(v * p.k).toFixed(4) : v;
      }
      const rec = { ...l.recovery, durationMonths: Math.round(p.D) };
      if (p.rs != null) rec.reboundStart = +p.rs.toFixed(3);
      if (p.rp != null) rec.reboundPeak  = +p.rp.toFixed(3);
      return { ...l, regime: { ...l.regime, returnAdjustment: adj }, recovery: rec };
    }),
  };
}

/** Nelder–Mead on a box. `f` takes a vector; returns { x, fx }. */
function nelderMead(f, x0, lo, hi, { iters = 300, step = 0.15 } = {}) {
  const n = x0.length;
  const box = x => x.map((v, i) => clamp(v, lo[i], hi[i]));
  let simplex = [box(x0)];
  for (let i = 0; i < n; i++) {
    const x = [...x0]; x[i] = x[i] + step * (hi[i] - lo[i]) * (x[i] + step * (hi[i] - lo[i]) > hi[i] ? -1 : 1);
    simplex.push(box(x));
  }
  let fs = simplex.map(f);
  for (let it = 0; it < iters; it++) {
    const order = fs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]).map(p => p[1]);
    simplex = order.map(i => simplex[i]); fs = order.map(i => fs[i]);
    const c = Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += simplex[i][j] / n;
    const lin = (a, b, t) => box(a.map((v, j) => v + t * (b[j] - v)));
    const xr = lin(c, simplex[n], -1), fr = f(xr);
    if (fr < fs[0]) {
      const xe = lin(c, simplex[n], -2), fe = f(xe);
      if (fe < fr) { simplex[n] = xe; fs[n] = fe; } else { simplex[n] = xr; fs[n] = fr; }
    } else if (fr < fs[n - 1]) { simplex[n] = xr; fs[n] = fr; }
    else {
      const xc = lin(c, simplex[n], 0.5), fc = f(xc);
      if (fc < fs[n]) { simplex[n] = xc; fs[n] = fc; }
      else for (let i = 1; i <= n; i++) { simplex[i] = lin(simplex[0], simplex[i], 0.5); fs[i] = f(simplex[i]); }
    }
    if (Math.abs(fs[n] - fs[0]) < 1e-6) break;
  }
  const best = fs.indexOf(Math.min(...fs));
  return { x: simplex[best], fx: fs[best] };
}

/** Fit one leg's curve and scale to a target set, on one sleeve. Random starts, then Nelder–Mead. */
function fitLeg(preset, legId, target, { sleeve = 'EQUITY_US', sleeves = null } = {}) {
  const leg = preset.legs.find(l => l.id === legId);
  const rebound = /REBOUND/.test(leg.recovery.profile);
  const p0 = { k: 1, D: leg.recovery.durationMonths, rs: leg.recovery.reboundStart ?? 0.5, rp: leg.recovery.reboundPeak ?? 0.5 };
  const lo = rebound ? [0.05, 6, 0.05, 0] : [0.05, 6];
  const hi = rebound ? [3, 240, 0.95, 2.5] : [3, 240];
  const toP = x => (rebound ? { k: x[0], D: x[1], rs: x[2], rp: x[3] } : { k: x[0], D: x[1] });
  const f = x => loss(measure(withLeg(preset, legId, toP(x), sleeves), sleeve), target, SLEEVE_BASE[sleeve]);
  const x0 = rebound ? [p0.k, p0.D, p0.rs, p0.rp] : [p0.k, p0.D];
  const starts = [x0];
  for (let i = 0; i < 200; i++) starts.push(lo.map((l, j) => l + rnd() * (hi[j] - l)));
  const scored = starts.map(x => ({ x, fx: f(x) })).sort((a, b) => a.fx - b.fx).slice(0, 6);
  let best = { x: x0, fx: f(x0) };
  for (const s of scored) {
    const r = nelderMead(f, s.x, lo, hi);
    if (r.fx < best.fx) best = r;
  }
  return { p: toP(best.x), loss: best.fx, start: loss(measure(preset, sleeve), target, SLEEVE_BASE[sleeve]) };
}

/**
 * Fit one sleeve's adjustment on leg `legId`, on the leg's curve as it stands, by its full
 * loss (depth primary, as for US): a grid over the scale, then a golden-section refine.
 * Fitting depth alone was wrong where the level break already IS the measured fall (COVID AU):
 * it shrank the drag to nothing, and the rebound with it.
 */
function fitSleeveScale(preset, legId, sleeve, target) {
  const rec = preset.legs.find(l => l.id === legId).recovery;
  const f = k => loss(measure(withLeg(preset, legId, { k, D: rec.durationMonths, rs: rec.reboundStart, rp: rec.reboundPeak },
    [sleeve]), sleeve), target, SLEEVE_BASE[sleeve]);
  let best = 1, fb = f(1);
  for (let k = 0.02; k <= 3; k += 0.02) { const v = f(k); if (v < fb) { fb = v; best = k; } }
  let a = Math.max(0.01, best - 0.02), b = best + 0.02;
  const g = (Math.sqrt(5) - 1) / 2;
  for (let i = 0; i < 30; i++) {
    const c = b - g * (b - a), d = a + g * (b - a);
    if (f(c) < f(d)) b = d; else a = c;
  }
  return (a + b) / 2;
}

const fmt  = m => `${(100 * m.depth).toFixed(1)} % / ${m.troughMonth} mo / ${m.backToPeak ?? 'never'} mo / @56 ${(100 * m.cumAt(56)).toFixed(1)} % / 10y ${(100 * m.cum10).toFixed(1)} %`;
const fmtT = t => `${t.depth == null ? '—' : (100 * t.depth).toFixed(1) + ' %'} / ${t.trough ?? '—'} mo / ${t.back ?? '—'} mo / @${t.cumAt?.months ?? 56} ${t.cumAt == null ? '—' : (100 * t.cumAt.value).toFixed(1) + ' %'} / 10y ${t.cum10 == null ? '—' : (100 * t.cum10).toFixed(1) + ' %'}`;

const keys = (opts.only ? opts.only.split(',') : Object.keys(TARGETS));
const result = {};
for (const key of keys) {
  const preset = SHOCK_LIBRARY[key];
  const target = TARGETS[key];
  if (!preset || !target) { console.log(`${key}: no preset or target`); continue; }
  const t0 = Date.now();
  const au = target.au;
  // AU is fitted on its own where it has a measurement, so the US fit leaves it alone.
  const usSleeves = Object.keys(preset.legs.find(l => l.id === 'equity').regime.returnAdjustment)
    .filter(rk => !(au && rk === 'EQUITY_AU'));
  const fit = fitLeg(preset, 'equity', target, { sleeves: usSleeves });
  let fitted = withLeg(preset, 'equity', fit.p, usSleeves);
  const line = { before: fmt(measure(preset)), after: fmt(measure(fitted)), target: fmtT(target), p: fit.p, loss: +fit.loss.toFixed(2) };

  if (au) {
    if (key === 'DOTCOM_2000_LITE') {
      const fa = fitLeg(fitted, 'equity-au', au, { sleeve: 'EQUITY_AU' });
      line.auBefore = fmt(measure(fitted, 'EQUITY_AU'));
      fitted = withLeg(fitted, 'equity-au', fa.p);
      line.auP = fa.p;
    } else if (preset.legs.find(l => l.id === 'equity').regime.returnAdjustment.EQUITY_AU != null) {
      line.auBefore = fmt(measure(fitted, 'EQUITY_AU'));
      const kAu = fitSleeveScale(fitted, 'equity', 'EQUITY_AU', au);
      const leg = fitted.legs.find(l => l.id === 'equity');
      fitted = withLeg(fitted, 'equity', { k: kAu, D: leg.recovery.durationMonths, rs: leg.recovery.reboundStart, rp: leg.recovery.reboundPeak }, ['EQUITY_AU']);
      line.auK = +kAu.toFixed(3);
    }
    line.auAfter  = fmt(measure(fitted, 'EQUITY_AU'));
    line.auTarget = fmtT(au);
  }
  line.legs = Object.fromEntries(fitted.legs.filter(l => /^equity/.test(l.id))
    .map(l => [l.id, { returnAdjustment: l.regime.returnAdjustment, recovery: l.recovery }]));
  result[key] = line;
  console.log(`\n## ${key}  (${((Date.now() - t0) / 1000).toFixed(1)} s, loss ${fit.start.toFixed(1)} → ${fit.loss.toFixed(2)})`);
  console.log(`  US   target ${line.target}`);
  console.log(`       before ${line.before}`);
  console.log(`       after  ${line.after}`);
  if (au) {
    console.log(`  AU   target ${line.auTarget}`);
    console.log(`       before ${line.auBefore}`);
    console.log(`       after  ${line.auAfter}`);
  }
  for (const [id, l] of Object.entries(line.legs)) console.log(`  leg ${id}: ${JSON.stringify(l)}`);
}
console.log('\n' + JSON.stringify(result, null, 1));
