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
 * farm-calibrate.mjs — the farm Monte Carlo's spreads from USDA NASS history (design 134 §13.8).
 *
 * Usage:
 *   npm run farm:calibrate                       # Nebraska: the spread across its counties
 *   npm run farm:calibrate -- --county HALL      # one county's own figures
 *   npm run farm:calibrate -- --from 1980 --json
 *
 * Reads docs/us-farm-markets/nass-qs-corn-soy-ne-us-*.tsv.gz (see SOURCES.md there). Prints, per
 * crop: the dryland and irrigated yield-deviation sds, the irrigated β, the January→harvest
 * price vol from Nebraska monthly prices received, and the price–yield link b. The arithmetic
 * is src/finance/farm/farm-calibration.js.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parseFlags } from '../lib/cli.mjs';
import { columns, heading, note } from '../lib/format.mjs';
import { calibrateFromNass, FARM_CALIBRATION } from '../../src/finance/farm/farm-calibration.js';

const opts = parseFlags(process.argv.slice(2), {
  usage: 'npm run farm:calibrate -- [--county NAME] [--from YEAR] [--json]\n\n'
       + 'farm-calibrate — yield and price spreads for the farm Monte Carlo from USDA NASS history.',
  county:  { type: 'string', help: 'one Nebraska county (NASS county_name, e.g. HALL); default: all, summarized' },
  from:    { type: 'number', default: FARM_CALIBRATION.from, help: 'first year used' },
  harvest: { type: 'number', default: 10, help: 'harvest month for the price change (1–12)' },
  data:    { type: 'string', help: 'the NASS extract (default: newest in docs/us-farm-markets/)' },
  json:    { type: 'flag', help: 'emit the figures as JSON' },
});

const dir = resolve(import.meta.dirname, '../../docs/us-farm-markets');
const file = opts.data ?? resolve(dir, readdirSync(dir).filter(f => /^nass-qs-corn-soy-ne-us-\d+\.tsv\.gz$/.test(f)).sort().at(-1));
/** The extract's text; gzipped on disk (`.tsv.gz`), plain if handed a `.tsv`. */
const readNass = (f) => (f.endsWith('.gz') ? gunzipSync(readFileSync(f)) : readFileSync(f)).toString('utf8');

let res;
try {
  res = calibrateFromNass(readNass(file), { from: opts.from, harvestMonth: opts.harvest, county: opts.county ?? null });
} catch (e) { console.error(e.message); process.exit(2); }
const out = res.crops;
const CROPS = Object.keys(out);

if (opts.json) {
  console.log(JSON.stringify({ source: file, from: opts.from, county: opts.county ?? null, crops: out }, null, 2));
  process.exit(0);
}

const f = (x, d = 3) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(d));
const q = (s) => (opts.county ? f(s.p50) : `${f(s.p50)}  (${f(s.p25)} – ${f(s.p75)})`);
heading(`Farm MC calibration — Nebraska${opts.county ? `, ${opts.county} county` : `, ${out.CORN.counties} counties (median, IQR)`}, ${opts.from}–`);
columns({
  rows: CROPS.map(c => ({ c, ...out[c] })),
  columns: [
    { head: 'crop', align: 'left', width: 10, get: r => r.c },
    { head: 'yield sd dry', width: 28, get: r => q(r.sdDry) },
    { head: 'yield sd irr', width: 28, get: r => q(r.sdIrr) },
    { head: 'irrigated β', width: 28, get: r => q(r.irrigatedBeta) },
    { head: 'irr residual sd', width: 28, get: r => q(r.irrResidualSd) },
    { head: 'skew dry', width: 28, get: r => q(r.skewDry) },
    { head: 'skew irr resid', width: 28, get: r => q(r.irrResidualSkew) },
    { head: `price vol Jan→m${opts.harvest}`, get: r => f(r.priceVol.annualized) },
    { head: 'price–yield b', width: 28, get: r => q(r.priceYieldBeta) },
  ],
});
note(`Dryland shock scale, soybeans ÷ corn: ${f(out.SOYBEANS.sdDry.p50 / out.CORN.sdDry.p50)}.`);
note(`Prices: Nebraska monthly prices received, ${out.CORN.priceVol.years} years. They are month AVERAGES, `
  + 'which damps the vol; the mean log change (the seasonal move) is in the price table already.');
note('Yields: each county detrended on its own linear trend; the irrigated split ends 2018 in NASS.');
note(`Source: ${file}`);
