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
 * probe-prime-inflation.mjs — design 104 §2.
 *
 * How do policy rates follow inflation? If the engine ties the prime rate to its stochastic
 * inflation path (design 103), these are the numbers the tie should reproduce:
 *
 *   1. the REAL policy rate (rate − inflation): its mean, spread and persistence by era;
 *   2. a partial-adjustment ("Taylor-style") fit, rate_t = ρ·rate_{t−1} + (1−ρ)·(c + β·π_t),
 *      where β > 1 means the central bank moves more than one-for-one with inflation, and ρ
 *      is how slowly it gets there;
 *   3. how far a year's rate CHANGE follows that year's inflation CHANGE.
 *
 * US: bank prime (FRED MPRIME), the series the engine's PRIME_US means, and the effective
 * fed funds rate for comparison. AU: the RBA cash rate target (1990–, the targeting era).
 * Inflation: US CPI-U Dec→Dec (FRED CPIAUCNS) and OECD AU CPI Q4 year-on-year. Rates are
 * December values, so each year's rate lines up with that year's inflation.
 *
 * Usage: node scripts/probes/probe-prime-inflation.mjs
 */

import { readFileSync }  from 'node:fs';
import { fileURLToPath } from 'node:url';

const D = fileURLToPath(new URL('../../docs/economic-shocks/data/', import.meta.url));
const lines = (f) => readFileSync(D + f, 'utf8').trim().split(/\r?\n/);
const fred = (f, col) => {
  const [hdr, ...rows] = lines(f);
  const i = hdr.split(',').indexOf(col);
  return rows.map(r => r.split(',')).map(c => ({ date: c[0], v: c[i] === '' || c[i] === '.' ? null : Number(c[i]) }));
};
/** December (month 12) value per year. */
const december = (rows) => new Map(rows.filter(r => r.date.slice(5, 7) === '12' && r.v != null).map(r => [Number(r.date.slice(0, 4)), r.v]));

const cpi   = december(fred('FRED-CPIAUCNS.csv', 'CPIAUCNS'));
const usInf = new Map([...cpi].filter(([y]) => cpi.has(y - 1)).map(([y, v]) => [y, v / cpi.get(y - 1) - 1]));
const prime = new Map([...december(fred('FRED-MPRIME.csv', 'MPRIME'))].map(([y, v]) => [y, v / 100]));
const ffr   = new Map([...december(fred('FRED-FEDFUNDS.csv', 'FEDFUNDS'))].map(([y, v]) => [y, v / 100]));
const auInf = new Map(fred('FRED-CPALTT01AUQ659N.csv', 'CPALTT01AUQ659N').filter(r => r.date.slice(5, 7) === '10').map(r => [Number(r.date.slice(0, 4)), r.v / 100]));

// RBA F1.1: metadata rows, then `dd/mm/yyyy,<cash rate target>,…`. December of each year.
const rbaCash = new Map();
for (const l of lines('RBA-F1.1-money-market.csv')) {
  const m = l.match(/^(\d{2})\/(\d{2})\/(\d{4}),([^,]*)/);
  if (m && m[2] === '12' && m[4] !== '') rbaCash.set(Number(m[3]), Number(m[4]) / 100);
}

// ── statistics ───────────────────────────────────────────────────────────────────
const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length;
const sd   = (x) => { const m = mean(x); return Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1)); };
const ac1  = (x) => { const m = mean(x); let n = 0, d = 0; x.forEach((v, i) => { d += (v - m) ** 2; if (i) n += (v - m) * (x[i - 1] - m); }); return n / d; };
const corr = (a, b) => { const ma = mean(a), mb = mean(b); let s = 0, sa = 0, sb = 0; a.forEach((v, i) => { s += (v - ma) * (b[i] - mb); sa += (v - ma) ** 2; sb += (b[i] - mb) ** 2; }); return s / Math.sqrt(sa * sb); };
const pct  = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
const f2   = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;

/** OLS of y on [1, x1, x2]; returns [b0, b1, b2] and R². */
function ols2(y, x1, x2) {
  const n = y.length, X = y.map((_, i) => [1, x1[i], x2[i]]);
  const XtX = [0, 1, 2].map(r => [0, 1, 2].map(c => X.reduce((s, row) => s + row[r] * row[c], 0)));
  const Xty = [0, 1, 2].map(r => X.reduce((s, row, i) => s + row[r] * y[i], 0));
  // 3×3 solve by Cramer's rule.
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const d = det(XtX);
  const b = [0, 1, 2].map(k => det(XtX.map((row, r) => row.map((v, c) => (c === k ? Xty[r] : v)))) / d);
  const fit = X.map(row => b[0] + b[1] * row[1] + b[2] * row[2]);
  const my = mean(y);
  const r2 = 1 - y.reduce((s, v, i) => s + (v - fit[i]) ** 2, 0) / y.reduce((s, v) => s + (v - my) ** 2, 0);
  return { b, r2, resid: y.map((v, i) => v - fit[i]) };
}

function study(label, rate, infl, from, to) {
  const ys = [...rate.keys()].filter(y => y >= from && y <= to && infl.has(y) && rate.has(y - 1)).sort((a, b) => a - b);
  const r = ys.map(y => rate.get(y)), rl = ys.map(y => rate.get(y - 1)), p = ys.map(y => infl.get(y));
  const real = r.map((v, i) => v - p[i]);
  const { b, r2, resid } = ols2(r, rl, p);
  const rho = b[1], beta = b[2] / (1 - rho), c = b[0] / (1 - rho);
  const dr = r.map((v, i) => v - rl[i]);
  const dp = ys.map((y, i) => (infl.has(y - 1) ? p[i] - infl.get(y - 1) : null));
  const keep = dp.map((v, i) => v != null ? i : -1).filter(i => i >= 0);
  console.log(`${label.padEnd(30)} ${from}–${to} n=${String(ys.length).padStart(2)}  real rate ${pct(mean(real))} sd ${pct(sd(real))} persistence ${f2(ac1(real))}  |  `
    + `fit: ρ ${f2(rho)} β ${f2(beta)} c ${pct(c)} R² ${r2.toFixed(2)} resid sd ${pct(sd(resid))}  |  corr(Δrate, Δinflation) ${f2(corr(keep.map(i => dr[i]), keep.map(i => dp[i])))}`);
}

console.log('\nPOLICY RATE vs INFLATION (December rates; real rate = rate − that year\'s inflation)\n');
console.log('Fit: rate_t = ρ·rate_{t−1} + (1−ρ)·(c + β·π_t). ρ = how slowly the rate adjusts; β = long-run move per point of inflation; c = the rate at zero inflation.\n');
study('US prime (MPRIME)',           prime, usInf, 1955, 2025);
study('US prime, 1955–1982',         prime, usInf, 1955, 1982);
study('US prime, 1983–2025',         prime, usInf, 1983, 2025);
study('US fed funds',                ffr,   usInf, 1955, 2025);
study('AU RBA cash rate target',     rbaCash, auInf, 1991, 2024);

const spread = [...prime.keys()].filter(y => ffr.has(y) && y >= 1995).map(y => prime.get(y) - ffr.get(y));
console.log(`\nUS prime − fed funds since 1995: mean ${pct(mean(spread))}, sd ${pct(sd(spread))} (banks have priced prime at fed funds + 3 points since the mid-1990s)`);
