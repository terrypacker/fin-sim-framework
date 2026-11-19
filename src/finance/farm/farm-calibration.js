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
 * farm-calibration.js — the arithmetic that turns USDA NASS history into the farm Monte
 * Carlo's spreads (design 134 §6, §13.8, step 2e). Pure: the data comes in as rows, and
 * `scripts/farm/farm-calibrate.mjs` reads them from `docs/us-farm-markets/`.
 *
 * What each output means in the model:
 *
 *   yield sd      sd of a county's yield ÷ its own linear trend − 1. The season's yieldShock is
 *                 that same ratio (realized = expected × (1 + β·shock + plan shock)).
 *   irrigated β   slope of the county's irrigated deviation on its dryland one, the same years.
 *   skew          the deviations' skewness: dryland yields fall far in a drought and rise only
 *                 somewhat in a great year, so the shocks are skew-normal, not normal.
 *   irr residual  sd of what is left of the irrigated deviation after β·dryland: the season's
 *                 irrigatedYieldShock, common to every irrigated field.
 *   price vol     sd of ln(harvest-month price ÷ January price) across years, annualized by
 *                 √(months/12). Its mean is the seasonal move the price table already holds.
 *   price–yield b −slope of that log change on the county's DRYLAND yield deviation: the model applies
 *                 L −= b · yieldShock at harvest, so a short local crop lifts the price by b·|shock|.
 */

/** OLS fit y = a + b·x. */
export function ols(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const b = sxy / sxx;
  return { a: my - b * mx, b };
}

/** Sample skewness (the moment estimate: mean cubed z). */
export function skewness(v) {
  const m = v.reduce((s, x) => s + x, 0) / v.length;
  const s2 = v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length;
  return v.reduce((s, x) => s + (x - m) ** 3, 0) / v.length / s2 ** 1.5;
}

/** Sample standard deviation (n − 1). */
export function sd(v) {
  const m = v.reduce((s, x) => s + x, 0) / v.length;
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
}

/**
 * A series' relative deviations from its own linear trend: `{ year: y / trend(year) − 1 }`.
 *
 * @param {Map<number, number>} byYear
 */
export function trendDeviations(byYear) {
  const years = [...byYear.keys()].sort((a, b) => a - b);
  const { a, b } = ols(years, years.map(y => byYear.get(y)));
  return new Map(years.map(y => [y, byYear.get(y) / (a + b * y) - 1]));
}

/** The years two maps share, sorted. */
export const sharedYears = (...maps) =>
  [...maps[0].keys()].filter(y => maps.every(m => m.has(y))).sort((a, b) => a - b);

/**
 * The yield side for one county and crop: dryland and irrigated deviation sds, and the
 * irrigated β. Null when fewer than `minYears` years have both practices.
 *
 * @param {Map<number, number>} dry   dryland (NASS "NON-IRRIGATED") yield by year
 * @param {Map<number, number>} irr   irrigated yield by year
 */
export function countyYieldStats(dry, irr, { minYears = 20 } = {}) {
  const dDry = trendDeviations(dry);
  const dIrr = trendDeviations(irr);
  const ys = sharedYears(dDry, dIrr);
  if (ys.length < minYears) return null;
  const x = ys.map(y => dDry.get(y));
  const z = ys.map(y => dIrr.get(y));
  const fit = ols(x, z);
  // What is left of the irrigated deviation once its dryland part is taken out: the irrigated
  // fields' own common shock.
  const residual = z.map((v, i) => v - fit.a - fit.b * x[i]);
  return { years: ys.length, sdDry: sd(x), sdIrr: sd(z), irrigatedBeta: fit.b, irrResidualSd: sd(residual),
    skewDry: skewness(x), irrResidualSkew: skewness(residual) };
}

/**
 * The price side: the log change from January to the harvest month, by year.
 *
 * @param {Map<string, number>} monthly price by `YYYY-MM`
 * @param {number} harvestMonth 1–12
 * @returns {Map<number, number>}
 */
export function plantingToHarvestLogChange(monthly, harvestMonth) {
  const out = new Map();
  for (const [ym, p] of monthly) {
    if (!ym.endsWith('-01')) continue;
    const y = Number(ym.slice(0, 4));
    const h = monthly.get(`${y}-${String(harvestMonth).padStart(2, '0')}`);
    if (h != null && p > 0 && h > 0) out.set(y, Math.log(h / p));
  }
  return out;
}

/** Annualized vol of a set of log changes over `months` months. */
export const annualizedVol = (changes, months) => sd(changes) / Math.sqrt(months / 12);

/**
 * The price–yield link b for one county: −slope of the planting-to-harvest log price change on
 * the county's yield deviation. Null when fewer than `minYears` years are shared.
 */
export function priceYieldBeta(logChange, yieldDev, { minYears = 20 } = {}) {
  const ys = sharedYears(logChange, yieldDev);
  if (ys.length < minYears) return null;
  return -ols(ys.map(y => yieldDev.get(y)), ys.map(y => logChange.get(y))).b;
}

/** Median and quartiles of a list. */
export function quartiles(v) {
  const s = [...v].sort((a, b) => a - b);
  const q = (p) => {
    const i = (s.length - 1) * p;
    const lo = Math.floor(i);
    return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
  };
  return { n: s.length, p25: q(0.25), p50: q(0.5), p75: q(0.75) };
}

const CROPS = ['CORN', 'SOYBEANS'];
const PRACTICE = { 'NON-IRRIGATED': 'dry', IRRIGATED: 'irr', 'ALL PRODUCTION PRACTICES': 'all' };
const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

/**
 * Every figure above, from the NASS Quick Stats extract in `docs/us-farm-markets/` (its text,
 * tab-separated, with the Quick Stats column names). Nebraska only: county yields by
 * practice, and the state's monthly prices received.
 *
 * Each county gets its own figures; the result is their median and quartiles, so a farm
 * that knows its county can read that county's instead (`county`).
 *
 * @param {string} tsv
 * @param {{ from?: number, harvestMonth?: number, county?: string|null }} [opts]
 * @returns {{ counties: string[], crops: { [crop]: object } }}
 */
export function calibrateFromNass(tsv, { from = 1995, harvestMonth = 10, county = null } = {}) {
  const lines = tsv.split('\n');
  const col = Object.fromEntries(lines[0].split('\t').map((h, i) => [h, i]));
  const yields = new Map();                                        // county → `crop|practice` → year → bu/ac
  const price = Object.fromEntries(CROPS.map(c => [c, new Map()])); // crop → YYYY-MM → $/bu
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const r = line.split('\t');
    const crop = r[col.commodity_desc];
    const year = Number(r[col.year]);
    if (!CROPS.includes(crop) || year < from || r[col.state_alpha] !== 'NE') continue;
    const v = Number(String(r[col.value]).replace(/,/g, ''));
    if (!Number.isFinite(v)) continue;
    if (r[col.statisticcat_desc] === 'YIELD' && r[col.agg_level_desc] === 'COUNTY'
        && r[col.reference_period_desc] === 'YEAR') {
      const p = PRACTICE[r[col.prodn_practice_desc]];
      const name = r[col.county_name];
      if (!p || name.startsWith('OTHER')) continue;
      const c = yields.get(name) ?? new Map(); yields.set(name, c);
      const m = c.get(`${crop}|${p}`) ?? new Map(); c.set(`${crop}|${p}`, m);
      m.set(year, v);
    }
    if (r[col.statisticcat_desc] === 'PRICE RECEIVED' && r[col.agg_level_desc] === 'STATE'
        && r[col.freq_desc] === 'MONTHLY' && MONTHS[r[col.reference_period_desc]]) {
      price[crop].set(`${year}-${String(MONTHS[r[col.reference_period_desc]]).padStart(2, '0')}`, v);
    }
  }
  const counties = county ? [county.toUpperCase()] : [...yields.keys()].sort();
  if (county && !yields.has(counties[0])) throw new Error(`no Nebraska county "${county}" in the extract`);

  const crops = {};
  for (const crop of CROPS) {
    const change = plantingToHarvestLogChange(price[crop], harvestMonth);
    const changes = [...change.values()];
    const per = [];
    for (const name of counties) {
      const c = yields.get(name);
      const dry = c?.get(`${crop}|dry`), irr = c?.get(`${crop}|irr`);
      const ys = dry && irr ? countyYieldStats(dry, irr) : null;
      // On the DRYLAND deviation: the model links price to the season's dryland shock.
      const b = dry && dry.size >= 20 ? priceYieldBeta(change, trendDeviations(dry)) : null;
      if (ys || b != null) per.push({ county: name, ...(ys ?? {}), priceYieldBeta: b });
    }
    const pick = (k) => quartiles(per.map(p => p[k]).filter(v => v != null && Number.isFinite(v)));
    crops[crop] = {
      counties: per.length,
      sdDry: pick('sdDry'), sdIrr: pick('sdIrr'), irrResidualSd: pick('irrResidualSd'),
      skewDry: pick('skewDry'), irrResidualSkew: pick('irrResidualSkew'),
      irrigatedBeta: pick('irrigatedBeta'), priceYieldBeta: pick('priceYieldBeta'),
      priceVol: {
        years: changes.length,
        meanLogChange: changes.reduce((s, x) => s + x, 0) / changes.length,
        sdLogChange: sd(changes),
        annualized: annualizedVol(changes, harvestMonth - 1),
      },
    };
  }
  return { counties, crops };
}

/**
 * The farm Monte Carlo's defaults, from `calibrateFromNass` over the extract dated in
 * `source`, 1995 on (design 134 §13.8). Corn sets the farm-wide shocks; `yieldShockScale`
 * scales them per crop. Rounded; tests/unit/farm-calibration.test.mjs re-derives each from the
 * data on disk, so a figure here cannot drift from it.
 */
export const FARM_CALIBRATION = Object.freeze({
  source: 'docs/us-farm-markets/nass-qs-corn-soy-ne-us-20261119.tsv.gz',
  from: 1995,
  region: 'Nebraska, median county',
  /** sd of the season's dryland yield shock (corn). */
  yieldShockSd: 0.30,
  /** Skewness of the dryland shock (corn): a drought's tail. */
  yieldShockSkew: -0.78,
  /** sd of the season's irrigated-only yield shock (corn). */
  irrigatedYieldShockSd: 0.065,
  /** Skewness of the irrigated-only shock (corn). */
  irrigatedYieldShockSkew: -0.22,
  /** How much of the dryland shock an irrigated field takes (corn). */
  irrigatedYieldBeta: 0.05,
  /** Each crop's share of the farm-wide shocks: its dryland sd ÷ corn's. */
  yieldShockScale: Object.freeze({ CORN: 1, SOYBEANS: 0.74 }),
  /** Annualized January→October price vol, Nebraska prices received. */
  priceVol: Object.freeze({ CORN: 0.18, SOYBEANS: 0.17 }),
  /** The price's response to the crop's own dryland yield shock. */
  priceYieldBeta: Object.freeze({ CORN: 0.19, SOYBEANS: 0.24 }),
});
