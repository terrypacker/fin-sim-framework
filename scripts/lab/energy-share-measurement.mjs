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
 * energy-share-measurement.mjs — design 126 §4.4, G2 step 0.
 *
 * G2 would price a household's spending at π + (s − w)·r instead of the CPI's π, where s is the
 * household's energy share, w the CPI's, and r energy's move against the basket. Before
 * building it, this measures how big that can get, from sources on disk in docs/energy-prices/.
 *
 * With fixed base-period weights (Laspeyres) and every index normalised to 1 at the base, the
 * household index over the CPI is exactly
 *
 *     H / CPI − 1 = (s − w) · (R − 1) / (1 − w),   R = energy index / all-items index
 *
 * (all-items = (1 − w)·core + w·energy, household = (1 − s)·core + s·energy; eliminate core).
 *
 *   1. s − w. US: the Consumer Expenditure Survey's energy share for households aged 65+ minus
 *      its share for all households — the same survey on both sides, so CE-vs-CPI scope does not
 *      leak into the difference. AU: the ABS self-funded retiree (and age pensioner) living
 *      cost index weights minus the CPI's, 2024 and 2025 weight sets.
 *   2. R. US: CPI energy over CPI all items, monthly. AU: OECD energy and all-items CPI,
 *      quarterly growth chained into indexes.
 *   3. The gap H/CPI − 1 through the 1970s stagflation window (1973–1982) and 2021–22, rebased
 *      to the quarter before each episode.
 *
 * Usage:  node scripts/lab/energy-share-measurement.mjs
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA = 'docs/energy-prices/data';

/** FRED CSV → [{ date: 'YYYY-MM-DD', v: number }] (rows FRED marks '.' are skipped). */
function fred(file) {
  return readFileSync(join(DATA, file), 'utf8').trim().split('\n').slice(1)
    .map(l => l.split(','))
    .filter(([, v]) => v !== '.' && v !== '')
    .map(([date, v]) => ({ date, v: Number(v) }));
}

const byYear = (rows) => new Map(rows.map(r => [Number(r.date.slice(0, 4)), r.v]));
const pct = (x, d = 2) => `${(100 * x).toFixed(d)}%`;
const pp  = (x, d = 2) => `${(100 * x >= 0 ? '+' : '')}${(100 * x).toFixed(d)} pp`;

// ── 1. s − w ─────────────────────────────────────────────────────────────────────────────────

/** CE energy share by year for one age group: electricity + natural gas + fuel oil and other
 *  fuels + gasoline, other fuels and motor oil, over total expenditures. */
function ceShare(demo) {
  const s = (item) => byYear(fred(`ce/CXU${item}${demo}M.csv`));
  const total = s('TOTALEXP'), el = s('ELECTRIC'), gas = s('NATRLGAS'), oil = s('OTHRFUEL'), mot = s('GASOIL');
  const out = new Map();
  for (const [y, t] of total) {
    // The motor-fuel series carries a placeholder of 1 from 2023 (FRED's last value); stop there.
    if (![el, gas, oil, mot].every(m => m.has(y)) || mot.get(y) < 10) continue;
    out.set(y, (el.get(y) + gas.get(y) + oil.get(y) + mot.get(y)) / t);
  }
  return out;
}

const DEMOS = { all: 'LB0101', '65+': 'LB0407', '65-74': 'LB0408', '75+': 'LB0409' };
const ce = Object.fromEntries(Object.entries(DEMOS).map(([k, d]) => [k, ceShare(d)]));

console.log('\n1. Energy share of spending, s − w\n');
console.log('US — BLS Consumer Expenditure Survey (energy = electricity + natural gas + fuel oil');
console.log('and other fuels + gasoline, other fuels and motor oil), share of total expenditures\n');
console.log('year     all     65+   65-74     75+   65+ − all');
const years = [...ce.all.keys()].filter(y => y >= 2010).sort();
for (const y of years) {
  const row = ['all', '65+', '65-74', '75+'].map(k => pct(ce[k].get(y)).padStart(7));
  console.log(`${y} ${row.join(' ')}  ${pp(ce['65+'].get(y) - ce.all.get(y)).padStart(10)}`);
}
const span = years.filter(y => y >= 2013 && y <= 2022);
const mean = (f) => span.reduce((a, y) => a + f(y), 0) / span.length;
const usGap = mean(y => ce['65+'].get(y) - ce.all.get(y));
const usGap75 = mean(y => ce['75+'].get(y) - ce.all.get(y));
console.log(`\nmean ${span[0]}–${span.at(-1)}: 65+ − all = ${pp(usGap)}, 75+ − all = ${pp(usGap75)}`);
const QUINTILES = { lowest: 'LB0102', second: 'LB0103', third: 'LB0104', fourth: 'LB0105', highest: 'LB0106' };
const q = Object.fromEntries(Object.entries(QUINTILES).map(([k, d]) => [k, ceShare(d)]));
console.log('\nby income quintile (before tax): energy is a necessity, so its share falls with income');
for (const y of [2019, 2022]) {
  console.log(`  ${y}  ` + Object.keys(QUINTILES).map(k => `${k} ${pct(q[k].get(y))}`).join('  '));
}
console.log('CPI-U relative importance, Dec 2025 (SOURCES.md): energy 6.383% — CE all-household'
  + ` ${span.at(-1)} share ${pct(ce.all.get(span.at(-1)))}, same order`);

// ABS weights, December quarter 2024 (the 2025 set) and the 2024 set: transcribed from the
// two ABS workbooks in data/abs/ — see SOURCES.md for the rows. Energy = automotive fuel +
// electricity + gas and other household fuels.
const AU_WEIGHTS = {
  2025: { cpi: 3.3469 + 1.8353 + 0.9616, sfr: 3.20 + 1.99 + 1.09, pensioner: 3.58 + 3.08 + 1.47 },
  2024: { cpi: 3.73 + 2.36 + 0.98,       sfr: 3.80 + 2.58 + 1.13, pensioner: 4.24 + 3.69 + 1.53 },
};
console.log('\nAU — ABS CPI and Selected Living Cost Index weights (automotive fuel + electricity +');
console.log('gas and other household fuels), weighted average of eight capital cities\n');
console.log('set     CPI   self-funded retiree   age pensioner');
for (const [set, w] of Object.entries(AU_WEIGHTS)) {
  console.log(`${set}  ${w.cpi.toFixed(2)}%   ${w.sfr.toFixed(2)}% (${pp((w.sfr - w.cpi) / 100)})`
    + `     ${w.pensioner.toFixed(2)}% (${pp((w.pensioner - w.cpi) / 100)})`);
}
const auSfrGap = (AU_WEIGHTS[2024].sfr - AU_WEIGHTS[2024].cpi) / 100;
const auPenGap = (AU_WEIGHTS[2024].pensioner - AU_WEIGHTS[2024].cpi) / 100;
console.log('(2025 electricity weights are net of the 2024–25 Energy Bill Relief rebates; the 2024');
console.log(' set is used below as the unrebated reading.)');

// ── 2. R, energy relative to all items ───────────────────────────────────────────────────────

/** US monthly R = energy / all items. */
const usAll = new Map(fred('CPIAUCSL.csv').map(r => [r.date.slice(0, 7), r.v]));
const usR = fred('CPIENGSL.csv').filter(r => usAll.has(r.date.slice(0, 7)))
  .map(r => ({ t: r.date.slice(0, 7), R: r.v / usAll.get(r.date.slice(0, 7)) }));

/** AU quarterly R from chained q/q growth (OECD MEI via FRED, % change on previous period). */
function chain(file) {
  let lvl = 1;
  return new Map(fred(file).map(r => [r.date.slice(0, 7), (lvl *= 1 + r.v / 100)]));
}
const auE = chain('CPGREN01AUQ657N.csv'), auA = chain('CPALTT01AUQ657N.csv');
const auR = [...auE.keys()].filter(t => auA.has(t)).map(t => ({ t, R: auE.get(t) / auA.get(t) }));

// ── 3. The gap through each episode ──────────────────────────────────────────────────────────

/** The path of H/CPI − 1 from a base date: peak, mean, and the cumulative excess in months of
 *  spending (Σ gap over the window, in years × 12). */
function episode(series, base, from, to, gap, perYear) {
  const R0 = series.find(r => r.t === base)?.R;
  const win = series.filter(r => r.t >= from && r.t <= to);
  const g = win.map(r => ({ t: r.t, rel: r.R / R0 - 1, gap: gap * (r.R / R0 - 1) / (1 - 0.07) }));
  const peak = g.reduce((a, b) => (b.gap > a.gap ? b : a));
  const meanGap = g.reduce((a, b) => a + b.gap, 0) / g.length;
  const months = (g.reduce((a, b) => a + b.gap, 0) / perYear) * 12;
  return { peak, meanGap, months, peakRel: Math.max(...g.map(x => x.rel)) };
}

const EPISODES = [
  { name: '1970s stagflation', base: '1972-10', from: '1973-01', to: '1982-12' },
  { name: '2021–22',           base: '2020-10', from: '2021-01', to: '2023-12' },
];
const CASES = [
  { who: 'US 65+ vs all',            series: usR, gap: usGap,    perYear: 12 },
  { who: 'US 75+ vs all',            series: usR, gap: usGap75,  perYear: 12 },
  { who: 'AU self-funded retiree',   series: auR, gap: auSfrGap, perYear: 4 },
  { who: 'AU age pensioner',         series: auR, gap: auPenGap, perYear: 4 },
];

console.log('\n2–3. Energy relative price R and the household gap H/CPI − 1 = (s − w)(R − 1)/(1 − w)');
console.log('     (w ≈ 7%; R rebased to the quarter before each episode)\n');
console.log('episode              household                 s − w    R peak   gap peak      gap mean   Σ gap');
for (const ep of EPISODES) {
  for (const c of CASES) {
    const e = episode(c.series, ep.base, ep.from, ep.to, c.gap, c.perYear);
    console.log(`${ep.name.padEnd(20)} ${c.who.padEnd(24)} ${pp(c.gap).padStart(9)}  `
      + `${pct(e.peakRel, 0).padStart(6)}  ${pct(e.peak.gap).padStart(6)} (${e.peak.t})  `
      + `${pct(e.meanGap).padStart(6)}   ${e.months.toFixed(2)} mo`);
  }
}
// Break-even: the s − w at which the episode's peak R would put the gap at 1% of spending.
console.log('\nbreak-even s − w for a 1% peak gap:');
for (const ep of EPISODES) {
  for (const [who, series] of [['US', usR], ['AU', auR]]) {
    const { peakRel } = episode(series, ep.base, ep.from, ep.to, 1, 1);
    console.log(`  ${ep.name.padEnd(20)} ${who}: ${pp(0.01 * (1 - 0.07) / peakRel)}`);
  }
}
console.log('\nΣ gap = the extra spending over the whole window, in months of that household\'s spending.');
console.log('Design 126 §4.4 threshold: G2 is built only if the gap reaches about 1% of spending.');
