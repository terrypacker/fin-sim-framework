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
 * probe-inflation-joint.mjs — design 103 §2.
 *
 * What a stochastic inflation path has to reproduce, and whether "sample equity, inflation
 * and bond yields by the same historical year" (design 102 §6) is worth building. Reads only
 * the CSVs in docs/economic-shocks/data:
 *
 *   1. US annual inflation by era: mean, sd, persistence (AR(1) φ, half-life). The engine
 *      models inflation as ONE constant rate per path, so persistence is what it misses.
 *   2. AU annual inflation, and how closely it tracks US inflation (one process or two?).
 *   3. The cross-asset links a joint sample would carry: real and nominal equity against
 *      inflation, and the 10-year yield change against inflation and equity.
 *
 * Usage: node scripts/probes/probe-inflation-joint.mjs
 */

import { readFileSync }  from 'node:fs';
import { fileURLToPath } from 'node:url';

const D = fileURLToPath(new URL('../../docs/economic-shocks/data/', import.meta.url));
const csv = (file) => {
  const [hdr, ...lines] = readFileSync(D + file, 'utf8').trim().split(/\r?\n/);
  const cols = hdr.split(',');
  return lines.map(l => { const c = l.split(','); return Object.fromEntries(cols.map((k, i) => [k, c[i]])); });
};

// ── series, keyed by the calendar year the change happens in ───────────────────────
// Shiller (1871–): January to January, so year y is Jan y → Jan y+1.
const sh  = csv('Shiller-SP500-monthly.csv').filter(r => r.observation_date.slice(5, 7) === '01');
const shY = new Map(sh.map(r => [Number(r.observation_date.slice(0, 4)), r]));
const usInfl = new Map(), realEq = new Map(), nomEq = new Map(), dGs10 = new Map();
for (const [y, r] of shY) {
  const n = shY.get(y + 1);
  if (!n) continue;
  const inf = Number(n.CPI) / Number(r.CPI) - 1;
  usInfl.set(y, inf);
  if (r.real_total_return_price && n.real_total_return_price) {
    const re = Number(n.real_total_return_price) / Number(r.real_total_return_price) - 1;
    realEq.set(y, re);
    nomEq.set(y, (1 + re) * (1 + inf) - 1);
  }
  if (r.GS10 && n.GS10) dGs10.set(y, (Number(n.GS10) - Number(r.GS10)) / 100);
}
// FRED CPI-U NSA (1913–): December to December.
const dec = new Map(csv('FRED-CPIAUCNS.csv').filter(r => r.observation_date.slice(5, 7) === '12')
  .map(r => [Number(r.observation_date.slice(0, 4)), Number(r.CPIAUCNS)]));
const usDecInfl = new Map([...dec].filter(([y]) => dec.has(y - 1)).map(([y, v]) => [y, v / dec.get(y - 1) - 1]));
// OECD AU CPI (1949–), year-on-year % per quarter: the Q4 reading is the calendar year.
const auInfl = new Map(csv('FRED-CPALTT01AUQ659N.csv').filter(r => r.observation_date.slice(5, 7) === '10')
  .map(r => [Number(r.observation_date.slice(0, 4)), Number(r.CPALTT01AUQ659N) / 100]));

// ── statistics ───────────────────────────────────────────────────────────────────
const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length;
const sd   = (x) => { const m = mean(x); return Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1)); };
const ac   = (x, l) => { const m = mean(x); let n = 0, d = 0; x.forEach((v, i) => { d += (v - m) ** 2; if (i >= l) n += (v - m) * (x[i - l] - m); }); return n / d; };
const corrAB = (a, b) => { const ma = mean(a), mb = mean(b); let s = 0, sa = 0, sb = 0; a.forEach((v, i) => { s += (v - ma) * (b[i] - mb); sa += (v - ma) ** 2; sb += (b[i] - mb) ** 2; }); return s / Math.sqrt(sa * sb); };
const slope  = (y, x) => { const mx = mean(x), my = mean(y); let s = 0, sx = 0; x.forEach((v, i) => { s += (v - mx) * (y[i] - my); sx += (v - mx) ** 2; }); return s / sx; };
const range  = (m, from, to) => [...m].filter(([y]) => y >= from && y <= to).sort((p, q) => p[0] - q[0]).map(([, v]) => v);
const paired = (a, b, from, to) => { const ys = [...a.keys()].filter(y => b.has(y) && y >= from && y <= to).sort((p, q) => p - q); return [ys.map(y => a.get(y)), ys.map(y => b.get(y)), ys.length]; };
const pct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
const f2  = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;

function row(label, x) {
  const phi = ac(x, 1);
  const halfLife = phi > 0 ? Math.log(2) / -Math.log(phi) : NaN;
  console.log(`${label.padEnd(34)} n=${String(x.length).padStart(3)}  mean ${pct(mean(x)).padStart(6)}  sd ${pct(sd(x)).padStart(6)}  `
    + `φ(ac1) ${f2(phi)}  ac2 ${f2(ac(x, 2))}  innovation sd ${pct(sd(x) * Math.sqrt(Math.max(0, 1 - phi * phi))).padStart(6)}  `
    + `half-life ${Number.isFinite(halfLife) ? halfLife.toFixed(1) + 'y' : '—'}  min ${pct(Math.min(...x))}  max ${pct(Math.max(...x))}`);
}

// ── 1. US inflation by era ───────────────────────────────────────────────────────
console.log('\n1. US ANNUAL INFLATION — persistence is what a constant per-path rate cannot carry\n');
row('Shiller CPI, Jan→Jan, 1871–2023', range(usInfl, 1871, 2023));
row('  gold standard 1871–1913', range(usInfl, 1871, 1913));
row('  wars + depression 1914–1950', range(usInfl, 1914, 1950));
row('  post-war fiat 1951–2023', range(usInfl, 1951, 2023));
row('  since 1983 (after Volcker)', range(usInfl, 1983, 2023));
row('FRED CPI-U, Dec→Dec, 1951–2025', range(usDecInfl, 1951, 2025));

// ── 2. AU inflation, and the US–AU link ──────────────────────────────────────────
console.log('\n2. AU ANNUAL INFLATION (OECD CPI, Q4 year-on-year) and its link to the US\n');
row('AU, 1951–2024', range(auInfl, 1951, 2024));
row('AU, since 1993 (inflation targeting)', range(auInfl, 1993, 2024));
for (const [from, to] of [[1951, 2024], [1993, 2024]]) {
  const [us, au, n] = paired(usDecInfl, auInfl, from, to);
  const dUs = us.slice(1).map((v, i) => v - us[i]), dAu = au.slice(1).map((v, i) => v - au[i]);
  console.log(`US–AU inflation ${from}–${to}: n=${n}  level corr ${f2(corrAB(us, au))}  year-on-year CHANGE corr ${f2(corrAB(dUs, dAu))}`);
}

// ── 3. cross-asset links a joint sample would carry ──────────────────────────────
console.log('\n3. CROSS-ASSET LINKS, same calendar year (Shiller, Jan→Jan)\n');
for (const [from, to] of [[1871, 2023], [1951, 2023], [1983, 2023]]) {
  const [re, inf, n]   = paired(realEq, usInfl, from, to);
  const [ne, inf2]     = paired(nomEq, usInfl, from, to);
  const [dy, inf3]     = paired(dGs10, usInfl, from, to);
  const [dy2, re2]     = paired(dGs10, realEq, from, to);
  console.log(`${from}–${to} (n=${n})`);
  console.log(`  real equity vs inflation     corr ${f2(corrAB(re, inf))}   slope ${f2(slope(re, inf))}  (0 = inflation passes through to nominal returns)`);
  console.log(`  nominal equity vs inflation  corr ${f2(corrAB(ne, inf2))}   slope ${f2(slope(ne, inf2))}  (1 = a full inflation hedge within the year)`);
  console.log(`  Δ10y yield vs inflation      corr ${f2(corrAB(dy, inf3))}   slope ${f2(slope(dy, inf3))}`);
  console.log(`  Δ10y yield vs real equity    corr ${f2(corrAB(dy2, re2))}`);
}

// Inflation shocks vs equity: the years that matter to a retiree.
const [re, inf] = paired(realEq, usInfl, 1951, 2023);
const hi = inf.map((v, i) => [v, re[i]]).filter(([v]) => v > 0.05);
const lo = inf.map((v, i) => [v, re[i]]).filter(([v]) => v <= 0.05);
console.log(`\n1951–2023: mean real equity return in years with inflation > 5%: ${pct(mean(hi.map(p => p[1])))} (n=${hi.length});  ≤ 5%: ${pct(mean(lo.map(p => p[1])))} (n=${lo.length})`);

// 10-year windows: a retiree lives through decades, not years.
const decades = [];
for (let y = 1951; y + 9 <= 2023; y++) {
  const i10 = range(usInfl, y, y + 9), r10 = range(realEq, y, y + 9);
  decades.push([Math.exp(mean(i10.map(Math.log1p))) - 1, Math.exp(mean(r10.map(Math.log1p))) - 1]);
}
console.log(`1951–2023 rolling 10y: corr(annualized inflation, annualized real equity) ${f2(corrAB(decades.map(d => d[0]), decades.map(d => d[1])))};  `
  + `10y inflation ranged ${pct(Math.min(...decades.map(d => d[0])))} .. ${pct(Math.max(...decades.map(d => d[0])))}`);

// ── 4. the engine's inflation path, through the real handlers ────────────────────
// Each mode runs the actual InflationTickHandler beside the POSTWAR equity bootstrap, both
// threaded through their step reducers. US inflation is centred on its post-war mean so
// "a year above 5%" means the same thing it does in history. Equity is reported as its
// real deviation, so only the GAP between high- and low-inflation years is meaningful.
const { InflationTickHandler, HISTORICAL_JOINT_WINDOW } = await import('../../src/finance/economic-regimes/inflation-tick-handler.js');
const { InflationStepReducer }     = await import('../../src/finance/economic-regimes/inflation-step-reducer.js');
const { EquityReturnTickHandler, HISTORICAL_BOOTSTRAP_WINDOWS } = await import('../../src/finance/economic-regimes/equity-return-tick-handler.js');
const { EquityReturnStepReducer }  = await import('../../src/finance/economic-regimes/equity-return-step-reducer.js');
const { EQUITY_SLEEVES, RATE_KEYS } = await import('../../src/finance/economic-regimes/rate-keys.js');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const PATHS = 2000, YEARS = 40;
const usAnchor = HISTORICAL_JOINT_WINDOW.US.mean;
const noIdio   = Object.fromEntries(EQUITY_SLEEVES.map(k => [k, 0]));

console.log(`\n4. THE ENGINE'S INFLATION PATH (${PATHS} paths × ${YEARS} years, POSTWAR equity bootstrap, US anchor ${pct(usAnchor)})\n`);
console.log('mode                 ac1     sd   10y infl p5 .. p95   real equity dev: infl > 5% vs ≤ 5% (gap)');
for (const model of ['GAUSSIAN', 'HISTORICAL_JOINT']) {
  const rng = mulberry32(11);
  const eqH = new EquityReturnTickHandler({ model: 'HISTORICAL_BOOTSTRAP', window: 'POSTWAR', vol: HISTORICAL_BOOTSTRAP_WINDOWS.POSTWAR.sd, idioVol: noIdio });
  const inH = new InflationTickHandler({ model });
  const eqR = new EquityReturnStepReducer(), inR = new InflationStepReducer();
  const ac1s = [], sds = [], dec10 = [], hi = [], lo = [];
  for (let p = 0; p < PATHS; p++) {
    let state = {};
    const infl = [], eq = [];
    for (let t = 0; t < YEARS; t++) {
      const e = eqH.call({ sim: { rng }, state })[0];
      state = eqR.reduce(state, e);
      const i = inH.call({ sim: { rng }, state })[0];
      state = inR.reduce(state, i);
      infl.push(Math.max(-0.05, usAnchor + i.deviation.US));
      eq.push(e.deviation[RATE_KEYS.EQUITY_US]);
    }
    ac1s.push(ac(infl, 1)); sds.push(sd(infl));
    dec10.push(Math.exp(mean(infl.slice(0, 10).map(Math.log1p))) - 1);
    infl.forEach((v, t) => (v > 0.05 ? hi : lo).push(eq[t]));
  }
  const q = (a, x) => { const s = [...a].sort((m, n) => m - n); return s[Math.floor(x * (s.length - 1))]; };
  console.log(`${model.padEnd(18)} ${f2(q(ac1s, 0.5))}  ${pct(q(sds, 0.5)).padStart(6)}   ${pct(q(dec10, 0.05))} .. ${pct(q(dec10, 0.95))}        `
    + `${pct(mean(hi))} vs ${pct(mean(lo))} (${pct(mean(hi) - mean(lo))})`);
}
console.log(`history 1951–2023    ${f2(ac(range(usInfl, 1951, 2023), 1))}  ${pct(sd(range(usInfl, 1951, 2023))).padStart(6)}   (10y range above)       gap ${pct(mean(hi.map(p => p[1])) - mean(lo.map(p => p[1])))}`);
