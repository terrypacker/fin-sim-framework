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
 * gold-correlation.mjs — what gold's annual return has moved with, by era (design 131 §2).
 *
 * Every series is on the model's own convention: a calendar year's return is January to
 * January on monthly AVERAGES, the way the equity bootstrap's rows are built (design 102
 * §4.1). So a gold row measured here is the row a replay would hand the engine for that
 * year, and every correlation below is the one a replay would reproduce.
 *
 * Inputs (all on disk, docs/economic-shocks/data and the packaged series):
 *   - gold:      WorldBank-CMO-gold-monthly.csv (US$/oz, monthly average, 1960–)
 *   - CPI:       FRED-CPIAUCSL.csv (CPI-U SA, monthly, 1947–)
 *   - 10-year:   FRED-GS10.csv (monthly, 1953–)
 *   - TIPS:      FRED-FII10.csv (10-year TIPS real yield, monthly, 2003–)
 *   - USD:       FRED-TWEXMMTH.csv (trade-weighted, major currencies, 1973–2019)
 *   - AUD:       FRED-DEXUSAL.csv (US$ per A$, daily, 1971–)
 *   - equity:    HISTORICAL_EQUITY_RETURNS (Shiller S&P real TR; AU real price)
 *   - surprise:  HISTORICAL_JOINT_WINDOW.US.residuals (the AR(1) inflation residual joint
 *                mode replays, design 103 §10.4)
 *
 * Gold before 1968 was pegged at \$35 (the London Gold Pool), so its "return" there is
 * minus inflation, not a market. The two-tier market opened in March 1968 and the gold
 * window closed in August 1971. Windows start no earlier than 1969 (January 1969 → 1970).
 *
 * Usage:  node scripts/lab/gold-correlation.mjs [--json <file>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HISTORICAL_EQUITY_RETURNS as E } from '../../src/finance/economic-regimes/historical-equity-returns.js';
import { HISTORICAL_JOINT_WINDOW as J } from '../../src/finance/economic-regimes/inflation-tick-handler.js';
import { parseFlags } from '../lib/cli.mjs';

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs/economic-shocks/data');
const opts = parseFlags(process.argv.slice(2), {
  usage: 'node scripts/lab/gold-correlation.mjs [--json <file>]\n\n'
       + 'gold-correlation — gold\'s annual real return against equity, inflation, real rates and the dollar, by era (design 131).',
  json: { type: 'string', help: 'also write every statistic to this JSON file' },
});
const jsonOut = opts.json ?? null;

// ── series ──────────────────────────────────────────────────────────────────────────
/** January monthly average of a CSV series, by year: Map(year → value). Daily series are averaged. */
function januaryAverages(file, { col = 1 } = {}) {
  const rows = fs.readFileSync(path.join(DATA, file), 'utf8').trim().split('\n').slice(1);
  const acc = new Map();
  for (const r of rows) {
    const c = r.split(','); const d = c[0]; const v = Number(c[col]);
    if (!d || c[col] === '' || c[col] === '.' || !Number.isFinite(v) || v === 0) continue; // FRED blanks parse as 0
    const [y, m] = d.split('-').map(Number); if (m !== 1) continue;
    const a = acc.get(y) ?? { s: 0, n: 0 }; a.s += v; a.n += 1; acc.set(y, a);
  }
  return new Map([...acc].map(([y, a]) => [y, a.s / a.n]));
}
const goldJan = januaryAverages('WorldBank-CMO-gold-monthly.csv');
const cpiJan  = januaryAverages('FRED-CPIAUCSL.csv');
const gs10Jan = januaryAverages('FRED-GS10.csv');
const tipsJan = januaryAverages('FRED-FII10.csv');
const usdJan  = januaryAverages('FRED-TWEXMMTH.csv');
const audJan  = januaryAverages('FRED-DEXUSAL.csv');   // US$ per A$

const ratio = (m, y) => (m.has(y) && m.has(y + 1)) ? m.get(y + 1) / m.get(y) - 1 : null;
const diff  = (m, y) => (m.has(y) && m.has(y + 1)) ? m.get(y + 1) - m.get(y) : null;

const S = {
  /** gold nominal US$ return, Jan y → Jan y+1 */
  goldNom:   (y) => ratio(goldJan, y),
  cpi:       (y) => ratio(cpiJan, y),
  /** gold real return (deflated by CPI-U) */
  goldReal:  (y) => { const g = S.goldNom(y), p = S.cpi(y); return g == null || p == null ? null : (1 + g) / (1 + p) - 1; },
  /** gold in A$ (nominal): US$ gold ÷ US$-per-A$ */
  goldAud:   (y) => { const g = S.goldNom(y), a = ratio(audJan, y); return g == null || a == null ? null : (1 + g) / (1 + a) - 1; },
  eqReal:    (y) => E.returns[y - E.firstYear] ?? null,
  auEqReal:  (y) => E.au.returns[y - E.au.firstYear] ?? null,
  /** AR(1) inflation residual (joint mode's surprise), same year index */
  inflSurp:  (y) => J.US.residuals[y - J.firstYear] ?? null,
  dGs10:     (y) => { const d = diff(gs10Jan, y); return d == null ? null : d / 100; },
  /** ex-post real 10-year: GS10 at January minus the trailing twelve months' CPI */
  real10:    (y) => (gs10Jan.has(y) && cpiJan.has(y) && cpiJan.has(y - 1)) ? gs10Jan.get(y) / 100 - (cpiJan.get(y) / cpiJan.get(y - 1) - 1) : null,
  dReal10:   (y) => { const a = S.real10(y), b = S.real10(y + 1); return a == null || b == null ? null : b - a; },
  dTips:     (y) => { const d = diff(tipsJan, y); return d == null ? null : d / 100; },
  dUsd:      (y) => ratio(usdJan, y),
};

// ── statistics ─────────────────────────────────────────────────────────────────────
const mean = (x) => x.reduce((a, b) => a + b, 0) / x.length;
const sd   = (x) => { const m = mean(x); return Math.sqrt(x.reduce((a, v) => a + (v - m) ** 2, 0) / (x.length - 1)); };
const geo  = (x) => Math.exp(mean(x.map(v => Math.log(1 + v)))) - 1;
const corr = (x, y) => { const mx = mean(x), my = mean(y); let s = 0, a = 0, b = 0; x.forEach((v, i) => { s += (v - mx) * (y[i] - my); a += (v - mx) ** 2; b += (y[i] - my) ** 2; }); return s / Math.sqrt(a * b); };
/** Fisher-z 95% interval */
const ci = (r, n) => { if (n < 5) return [NaN, NaN]; const z = Math.atanh(r), h = 1.96 / Math.sqrt(n - 3); return [Math.tanh(z - h), Math.tanh(z + h)]; };
/** Spearman rank correlation (robust to the 1979–80 outliers) */
const rank = (x) => { const o = x.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const r = new Array(x.length); o.forEach(([, i], k) => { r[i] = k; }); return r; };
const spearman = (x, y) => corr(rank(x), rank(y));

/** OLS y = Xb with an intercept; returns { b, r2, residSd, n } */
function ols(y, cols) {
  const n = y.length, k = cols.length + 1;
  const X = y.map((_, i) => [1, ...cols.map(c => c[i])]);
  const XtX = Array.from({ length: k }, (_, a) => Array.from({ length: k }, (_, b) => X.reduce((s, r) => s + r[a] * r[b], 0)));
  const Xty = Array.from({ length: k }, (_, a) => X.reduce((s, r, i) => s + r[a] * y[i], 0));
  // Gauss-Jordan
  const M = XtX.map((r, i) => [...r, Xty[i]]);
  for (let c = 0; c < k; c++) {
    let p = c; for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < k; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let j = c; j <= k; j++) M[r][j] -= f * M[c][j]; }
  }
  const b = M.map((r, i) => r[k] / r[i]);
  const fit = X.map(r => r.reduce((s, v, j) => s + v * b[j], 0));
  const res = y.map((v, i) => v - fit[i]);
  const my = mean(y);
  const r2 = 1 - res.reduce((s, v) => s + v * v, 0) / y.reduce((s, v) => s + (v - my) ** 2, 0);
  return { b, r2, residSd: Math.sqrt(res.reduce((s, v) => s + v * v, 0) / (n - k)), n };
}

const years = (from, to, ...fns) => { const ys = []; for (let y = from; y <= to; y++) if (fns.every(f => f(y) != null)) ys.push(y); return ys; };
const pct = (v, d = 1) => Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(100 * v).toFixed(d)}%` : '   n/a';
const num = (v, d = 2) => Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(d)}` : '  n/a';

const out = { generated: 'scripts/lab/gold-correlation.mjs', convention: 'January to January, monthly averages', windows: {}, factors: {}, conditional: {}, regression: {} };

// ── 1. gold's own distribution ─────────────────────────────────────────────────────
const WINDOWS = [
  ['free market (two-tier from 1968)',  1969, 2023],
  ['after Bretton Woods',               1972, 2023],
  ['1970s stagflation',                 1973, 1982],
  ['disinflation',                      1983, 1999],
  ['since 1985',                        1985, 2023],
  ['low inflation 2000–2020',           2000, 2020],
  ['since 2000',                        2000, 2023],
];
const LAST_GOLD = Math.max(...goldJan.keys()) - 1;
console.log(`\n1. Gold's annual return, ${WINDOWS[0][1]}–${LAST_GOLD} available (January to January, monthly averages)\n`);
console.log('window                              years       n   real geo  real mean  real sd  nominal geo');
for (const [name, from, to0] of [...WINDOWS.slice(0, 2).map(([n, f]) => [n, f, LAST_GOLD]), ...WINDOWS.slice(2)]) {
  const ys = years(from, to0, S.goldReal);
  const r = ys.map(S.goldReal), nmn = ys.map(S.goldNom);
  out.windows[`${from}-${to0}`] = { name, n: ys.length, realGeo: geo(r), realMean: mean(r), realSd: sd(r), nominalGeo: geo(nmn), nominalSd: sd(nmn) };
  console.log(`${name.padEnd(34)}  ${from}–${to0}  ${String(ys.length).padStart(3)}  ${pct(geo(r)).padStart(8)}  ${pct(mean(r)).padStart(9)}  ${pct(sd(r)).padStart(7)}  ${pct(geo(nmn)).padStart(10)}`);
}

// ── 2. correlations with each candidate driver ─────────────────────────────────────
const FACTORS = [
  ['US equity real TR (S&P)',             S.eqReal],
  ['AU equity real price',                S.auEqReal],
  ['US CPI inflation (level)',            S.cpi],
  ['US inflation SURPRISE (AR(1) resid.)', S.inflSurp],
  ['Δ US 10-year yield',                  S.dGs10],
  ['real 10-year at January (level)',     S.real10],
  ['Δ real 10-year (ex-post)',            S.dReal10],
  ['Δ 10-year TIPS real yield',           S.dTips],
  ['Δ trade-weighted USD',                S.dUsd],
];
console.log('\n2. Correlation of gold\'s REAL return with each driver (Pearson [95% CI] / Spearman, n)\n');
const header = 'driver                                   ' + WINDOWS.map(([, f, t]) => `${f}–${String(t).slice(2)}`.padStart(22)).join('');
console.log(header);
for (const [name, f] of FACTORS) {
  out.factors[name] = {};
  const cells = WINDOWS.map(([, from, to]) => {
    const ys = years(from, to, S.goldReal, f);
    // A driver whose data starts inside the window (TIPS 2003–, USD to 2019) is not that window's answer.
    if (ys.length < 8 || ys[0] > from + 3 || ys[ys.length - 1] < to - 3) return ''.padStart(22);
    const g = ys.map(S.goldReal), x = ys.map(f);
    const r = corr(g, x), [lo, hi] = ci(r, ys.length), rs = spearman(g, x);
    out.factors[name][`${from}-${to}`] = { n: ys.length, pearson: r, ci95: [lo, hi], spearman: rs };
    return `${num(r)} [${num(lo, 1)},${num(hi, 1)}] ${num(rs, 1)}`.padStart(22).slice(-22) + '';
  });
  console.log(name.padEnd(41) + cells.map(c => ' ' + c).join(''));
}
console.log('\n   n per window:', WINDOWS.map(([, f, t]) => `${f}–${t}: ${years(f, t, S.goldReal, S.eqReal).length}`).join(', '));

// ── 3. conditional behaviour: the years the hedge is supposed to pay ────────────────
const cond = (label, from, to, pred) => {
  const ys = years(from, to, S.goldReal, S.eqReal, S.cpi).filter(pred);
  const g = ys.map(S.goldReal);
  out.conditional[label] = { n: ys.length, years: ys, goldRealMean: ys.length ? mean(g) : null, goldRealMedian: ys.length ? [...g].sort((a, b) => a - b)[Math.floor(g.length / 2)] : null, goldUpShare: ys.length ? g.filter(v => v > 0).length / g.length : null };
  console.log(`  ${label.padEnd(46)} n=${String(ys.length).padStart(2)}  gold real mean ${pct(mean(g)).padStart(7)}  up in ${ys.length ? Math.round(100 * g.filter(v => v > 0).length / g.length) : 0}%   ${ys.join(' ')}`);
};
console.log('\n3. Gold\'s real return in the years each hedge claim is about (1969–2023)\n');
cond('all years',                                   1969, 2023, () => true);
cond('equity real < −10% (crash years)',            1969, 2023, y => S.eqReal(y) < -0.10);
cond('equity real < −10%, since 1985',              1985, 2023, y => S.eqReal(y) < -0.10);
cond('CPI > 5%',                                    1969, 2023, y => S.cpi(y) > 0.05);
cond('inflation surprise > +1 sd',                  1969, 2023, y => S.inflSurp(y) > J.US.sd);
cond('real 10-year < 0 at January',                 1969, 2023, y => S.real10(y) != null && S.real10(y) < 0);
cond('real 10-year > 3% at January',                1969, 2023, y => S.real10(y) != null && S.real10(y) > 0.03);
cond('equity < −10% AND CPI > 5% (stagflation yrs)', 1969, 2023, y => S.eqReal(y) < -0.10 && S.cpi(y) > 0.05);

// ── 4. a factor model: is gold = market + inflation surprise + real-rate move + noise? ─
console.log('\n4. OLS: gold real = a + b_eq·equity + b_infl·surprise + b_real·Δreal10 + e\n');
for (const [label, from, to] of [['1969–2023', 1969, 2023], ['1972–2023', 1972, 2023], ['1985–2023', 1985, 2023]]) {
  const ys = years(from, to, S.goldReal, S.eqReal, S.inflSurp, S.dReal10);
  const fit = ols(ys.map(S.goldReal), [ys.map(S.eqReal), ys.map(S.inflSurp), ys.map(S.dReal10)]);
  out.regression[label] = { ...fit, terms: ['a', 'b_eq', 'b_infl', 'b_real'] };
  console.log(`  ${label}  n=${fit.n}  a ${pct(fit.b[0])}  b_eq ${num(fit.b[1])}  b_infl ${num(fit.b[2])}  b_real ${num(fit.b[3])}  R² ${fit.r2.toFixed(2)}  resid sd ${pct(fit.residSd)}`);
}
{
  const ys = years(2003, 2023, S.goldReal, S.eqReal, S.dTips);
  const fit = ols(ys.map(S.goldReal), [ys.map(S.eqReal), ys.map(S.dTips)]);
  out.regression['2003–2023 TIPS'] = { ...fit, terms: ['a', 'b_eq', 'b_tips'] };
  console.log(`  2003–2023 (TIPS) n=${fit.n}  a ${pct(fit.b[0])}  b_eq ${num(fit.b[1])}  b_ΔTIPS ${num(fit.b[2])}  R² ${fit.r2.toFixed(2)}  resid sd ${pct(fit.residSd)}`);
}

// ── 5. the A$ investor's gold ──────────────────────────────────────────────────────
console.log('\n5. Gold in A$ (nominal), 1972–2023\n');
{
  const ys = years(1972, 2023, S.goldAud, S.goldNom, S.auEqReal);
  const ga = ys.map(S.goldAud), gu = ys.map(S.goldNom), au = ys.map(S.auEqReal);
  out.aud = { n: ys.length, sdAud: sd(ga), sdUsd: sd(gu), corrAudUsd: corr(ga, gu), corrAuEquity: corr(ga, au) };
  console.log(`  n=${ys.length}  sd A$ ${pct(sd(ga))} vs US$ ${pct(sd(gu))}   corr(A$ gold, US$ gold) ${num(corr(ga, gu))}   corr(A$ gold, AU equity real) ${num(corr(ga, au))}`);
}

// ── 6. replay coverage against the bootstrap windows ───────────────────────────────
const post = years(1951, 2023, S.eqReal), withGold = post.filter(y => y >= 1969 && S.goldReal(y) != null);
out.coverage = { postwarYears: post.length, goldMarketYears: withGold.length };
console.log(`\n6. Replay coverage: the POSTWAR bootstrap window has ${post.length} years; ${withGold.length} have a market gold row (1969+). The FULL window (1871–) has ${E.returns.length}.`);

if (jsonOut) { fs.writeFileSync(jsonOut, JSON.stringify(out, null, 1)); console.log(`\nwrote ${jsonOut}`); }

// ── 7. out-of-sample: does the real-rate beta hold in the half it was not fitted on? ──
console.log('\n7. Split sample: gold real = a + b·Δreal10, fitted on one half, scored on the other\n');
out.splitSample = {};
for (const [fitFrom, fitTo, testFrom, testTo] of [[1969, 1996, 1997, 2023], [1997, 2023, 1969, 1996]]) {
  const fy = years(fitFrom, fitTo, S.goldReal, S.dReal10), ty = years(testFrom, testTo, S.goldReal, S.dReal10);
  const fit = ols(fy.map(S.goldReal), [fy.map(S.dReal10)]);
  const g = ty.map(S.goldReal), pred = ty.map(y => fit.b[0] + fit.b[1] * S.dReal10(y));
  // Out-of-sample R² against the TEST half's own mean (a fair, demanding benchmark).
  const mg = mean(g); const oos = 1 - g.reduce((s, v, i) => s + (v - pred[i]) ** 2, 0) / g.reduce((s, v) => s + (v - mg) ** 2, 0);
  const tfit = ols(g, [ty.map(S.dReal10)]);
  const key = `fit ${fitFrom}-${fitTo} → test ${testFrom}-${testTo}`;
  out.splitSample[key] = { bFit: fit.b[1], bTest: tfit.b[1], oosR2: oos, nFit: fy.length, nTest: ty.length };
  console.log(`  ${key}: b ${num(fit.b[1])} (test half's own b ${num(tfit.b[1])}), out-of-sample R² ${oos.toFixed(2)}, n ${fy.length}/${ty.length}`);
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(out, null, 1));
