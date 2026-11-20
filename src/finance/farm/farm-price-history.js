/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { FARM_PRICE_HISTORY } from './farm-price-history-data.js';

/**
 * Real crop prices for the farm charts (design 134 §17.5, phase 8, step 8a).
 *
 * The source is the USDA NASS extract in `docs/us-farm-markets/` (see SOURCES.md there):
 * Nebraska's monthly **price received**, \$/bu, per crop. The Field P&L panel runs in the
 * browser and cannot read that gzipped file, so `npm run farm:price-history` writes the
 * series into `farm-price-history-data.js`, and tests/unit/farm-price-history.test.mjs checks
 * that file is exactly what the extract on disk gives.
 *
 * Three limits travel with every reading, and a chart that draws this must say them
 * (`PRICE_HISTORY_LIMITS`): a month's figure is an AVERAGE (it smooths the short rallies), it
 * is the STATE's price (a local elevator's bid differs by its basis, Q32), and it is not
 * daily.
 */

export const PRICE_HISTORY_CROPS = Object.freeze(['CORN', 'SOYBEANS']);

const MONTHS = Object.freeze({
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
});

/** What every chart drawing this history says about it. */
export const PRICE_HISTORY_LIMITS = Object.freeze([
  'monthly averages, which smooth short rallies',
  'the Nebraska average price received, not a local bid',
  'not adjusted for local basis (Q32)',
]);

/**
 * Nebraska's monthly prices received from a NASS extract (tab-separated, Quick Stats column
 * names, as `nass-extract.py` writes it). Only STATE rows for Nebraska with a MONTHLY
 * frequency and a month as the reference period are read: the marketing-year rows, the US
 * rows and every yield row are skipped. A value NASS withholds or marks not available
 * (`(D)`, `(NA)`, …) is left out, never read as 0.
 *
 * @param {string} tsv
 * @param {{ from?: number }} [opts] first year kept
 * @returns {{ [crop: string]: Map<string, number> }} crop → `YYYY-MM` → \$/bu, in month order
 */
export function parseNassMonthlyPrices(tsv, { from = 0 } = {}) {
  const lines = tsv.split('\n');
  const col = Object.fromEntries(lines[0].split('\t').map((h, i) => [h.trim(), i]));
  for (const k of ['commodity_desc', 'statisticcat_desc', 'agg_level_desc', 'state_alpha', 'year',
    'freq_desc', 'reference_period_desc', 'value']) {
    if (col[k] == null) throw new Error(`the NASS extract has no "${k}" column`);
  }
  const out = Object.fromEntries(PRICE_HISTORY_CROPS.map(c => [c, new Map()]));
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const r = line.split('\t');
    const crop = r[col.commodity_desc];
    if (!out[crop] || r[col.statisticcat_desc] !== 'PRICE RECEIVED' || r[col.agg_level_desc] !== 'STATE'
      || r[col.state_alpha] !== 'NE' || r[col.freq_desc] !== 'MONTHLY') continue;
    const month = MONTHS[r[col.reference_period_desc]];
    const year = Number(r[col.year]);
    if (!month || !(year >= from)) continue;
    const v = Number(String(r[col.value]).replace(/,/g, '').trim());
    if (!Number.isFinite(v)) continue;
    out[crop].set(`${year}-${String(month).padStart(2, '0')}`, v);
  }
  for (const c of PRICE_HISTORY_CROPS) out[c] = new Map([...out[c]].sort(([a], [b]) => (a < b ? -1 : 1)));
  return out;
}

/**
 * The data module's content: per crop, the first month and one value per month from there to
 * the last, with `null` where NASS has no figure. Plain JSON-able numbers, so the file is
 * small and its diff readable.
 *
 * @param {{ [crop]: Map<string, number> }} prices `parseNassMonthlyPrices(...)`
 * @param {{ source: string, from: number }} meta
 */
export function priceHistoryData(prices, { source, from }) {
  const crops = {};
  for (const c of PRICE_HISTORY_CROPS) {
    const keys = [...prices[c].keys()];
    if (!keys.length) { crops[c] = { start: null, values: [] }; continue; }
    const values = [];
    for (let m = keys[0]; m <= keys.at(-1); m = nextMonth(m)) values.push(prices[c].get(m) ?? null);
    crops[c] = { start: keys[0], values };
  }
  return {
    source,
    from,
    region: 'Nebraska',
    series: 'NASS price received, monthly',
    unit: 'USD / bu',
    crops,
  };
}

/**
 * The generated module's text, byte for byte. The script writes it and the test compares the
 * file on disk to it, so one function owns the format.
 */
export function renderPriceHistoryModule(data) {
  const row = (c) => {
    const { start, values } = data.crops[c];
    // Twelve values to a line, a year's worth when the series starts in January.
    const lines = [];
    for (let i = 0; i < values.length; i += 12) lines.push(`      ${values.slice(i, i + 12).map(v => (v == null ? 'null' : String(v))).join(', ')},`);
    return `    ${c}: Object.freeze({\n      start: ${JSON.stringify(start)},\n      values: Object.freeze([\n${lines.map(l => `  ${l}`).join('\n')}\n      ]),\n    }),`;
  };
  return `/*
 * GENERATED by \`npm run farm:price-history\` (scripts/farm/farm-price-history.mjs) from
 * ${data.source}.
 * Do not edit: re-run the script. tests/unit/farm-price-history.test.mjs checks this file is
 * exactly what that extract gives.
 */

/** Nebraska monthly prices received, \\$/bu, per crop (design 134 §17.5, step 8a). */
export const FARM_PRICE_HISTORY = Object.freeze({
  source: ${JSON.stringify(data.source)},
  from: ${data.from},
  region: ${JSON.stringify(data.region)},
  series: ${JSON.stringify(data.series)},
  unit: ${JSON.stringify(data.unit)},
  crops: Object.freeze({
${PRICE_HISTORY_CROPS.map(row).join('\n')}
  }),
});
`;
}

/** `YYYY-MM` one month on. */
export function nextMonth(m) {
  const [y, mo] = m.split('-').map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
}

/**
 * One crop's history as a Map, `YYYY-MM` → \$/bu, months NASS has no figure for left out.
 *
 * @param {string} crop `CORN` or `SOYBEANS`
 * @param {object} [history=FARM_PRICE_HISTORY]
 * @returns {Map<string, number>} empty for a crop with no history
 */
export function priceHistory(crop, history = FARM_PRICE_HISTORY) {
  const s = history.crops[crop];
  const out = new Map();
  if (!s?.start) return out;
  let m = s.start;
  for (const v of s.values) {
    if (v != null) out.set(m, v);
    m = nextMonth(m);
  }
  return out;
}

/**
 * One crop's months within `[from, to]` (`YYYY-MM`, both inclusive), in order.
 *
 * @returns {Array<[string, number]>}
 */
export function priceHistoryBetween(crop, from, to, history = FARM_PRICE_HISTORY) {
  return [...priceHistory(crop, history)].filter(([m]) => m >= from && m <= to);
}

/** The last month a crop has a figure for, or null. */
export function latestPriceMonth(crop, history = FARM_PRICE_HISTORY) {
  return [...priceHistory(crop, history).keys()].at(-1) ?? null;
}
