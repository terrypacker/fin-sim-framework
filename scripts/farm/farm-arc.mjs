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
 * farm-arc.mjs — a county's ARC-County figures from FSA's published file (design 134 §15.3).
 *
 * Usage:
 *   npm run farm:arc -- --county Adams                 # newest program year on disk
 *   npm run farm:arc -- --county Adams --year 2025     # with the actual yield and payment rate
 *   npm run farm:arc -- --county Adams --json          # rows to paste into cfg.farm.arcCounties
 *
 * Reads docs/us-farm-programs/FSA-arcco-<year>-data-*-NE-corn-soy.csv (see SOURCES.md there).
 * Prints each crop and practice's benchmark yield and price, guarantee and maximum rate, and,
 * where FSA has published them, the actual county yield, national price and payment rate,
 * recomputed with the model's own formula (arcCountyRate) beside FSA's.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseFlags, printJsonAndExit } from '../lib/cli.mjs';
import { columns, heading, note } from '../lib/format.mjs';
import { arcCountyRate } from '../../src/finance/farm/farm-programs.js';

const opts = parseFlags(process.argv.slice(2), {
  usage: 'npm run farm:arc -- --county NAME [--year YEAR] [--json]\n\n'
       + 'farm-arc — a Nebraska county\'s ARC-County benchmarks and payment rates from FSA\'s file.',
  county: { type: 'string', help: 'county name as FSA writes it (e.g. Adams)' },
  year:   { type: 'number', help: 'program year (default: the newest file on disk)' },
  json:   { type: 'flag', help: 'emit cfg.farm.arcCounties rows as JSON' },
});
if (!opts.county) { console.error('--county is required (try --help)'); process.exit(2); }

const dir = resolve(import.meta.dirname, '../../docs/us-farm-programs');
const files = readdirSync(dir).filter(f => /^FSA-arcco-\d{4}-data-.*-NE-corn-soy\.csv$/.test(f)).sort();
const yearOf = (f) => Number(f.match(/^FSA-arcco-(\d{4})/)[1]);
const file = opts.year != null ? files.filter(f => yearOf(f) === opts.year).at(-1) : files.at(-1);
if (!file) { console.error(`no FSA ARC-CO file for ${opts.year ?? 'any year'} in ${dir}`); process.exit(2); }
const year = yearOf(file);

const lines = readFileSync(resolve(dir, file), 'utf8').trim().split('\n').map(l => l.split(','));
const h = lines.shift();
const col = (prefix) => h.findIndex(x => x.startsWith(`${year} ${prefix}`));
const c = { by: col('Bench Mark ('), bp: col('Bench Mark Price'), g: col('Guarantee'), mx: col('Maximum'),
  ay: col('Actual Yield'), np: col('National'), pr: col('ARC-CO Payment') };
const num = (v) => (v === '' || v == null ? null : Number(v));
const CROP = { Corn: 'CORN', Soybeans: 'SOYBEANS' };
const PRACTICE = { Irrigated: 'IRRIGATED', Nonirrigated: 'NONIRRIGATED', All: 'ALL' };

const rows = lines.filter(r => r[2].toLowerCase() === opts.county.toLowerCase()).map(r => {
  const crop = CROP[r[4]];
  const o = { county: r[2], subCounty: r[3] || null, crop, practice: PRACTICE[r[6]] ?? r[6],
    benchmarkYield: num(r[c.by]), benchmarkPrice: num(r[c.bp]), guarantee: num(r[c.g]), maxRate: num(r[c.mx]),
    actualYield: num(r[c.ay]), nationalPrice: num(r[c.np]), paymentRate: num(r[c.pr]) };
  if (o.actualYield != null && o.nationalPrice != null) {
    o.modelRate = arcCountyRate({ benchmarkYield: o.benchmarkYield, benchmarkPrice: o.benchmarkPrice,
      actualYield: o.actualYield, nationalPrice: o.nationalPrice, crop, year }).rate;
  }
  return o;
});
if (!rows.length) {
  const names = [...new Set(lines.map(r => r[2]))].sort();
  console.error(`no county "${opts.county}" in ${file}. Counties: ${names.join(', ')}`);
  process.exit(2);
}

if (opts.json) {
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  await printJsonAndExit({
    source: file, programYear: year,
    arcCounties: rows.map(r => ({
      id: `cty-${slug(r.county)}${r.subCounty ? `-${slug(r.subCounty)}` : ''}-${r.crop.toLowerCase()}-${r.practice.toLowerCase()}`,
      county: r.subCounty ? `${r.county} ${r.subCounty}` : r.county, crop: r.crop, practice: r.practice,
      benchmarkYield: r.benchmarkYield, benchmarkPrice: r.benchmarkPrice,
    })),
  }, 2);
}

const money = (x) => (x == null ? '—' : `$${x.toFixed(2)}`);
heading(`ARC-County ${year} — ${rows[0].county}, Nebraska (${file})`);
columns({ rows, columns: [
  { head: 'crop', get: r => r.crop, align: 'left', width: 9 },
  { head: 'practice', get: r => r.practice + (r.subCounty ? ` (${r.subCounty})` : ''), align: 'left', width: 14 },
  { head: 'bench yld', get: r => r.benchmarkYield?.toFixed(2) ?? '—', width: 10 },
  { head: 'bench $', get: r => money(r.benchmarkPrice), width: 8 },
  { head: 'guarantee', get: r => money(r.guarantee), width: 10 },
  { head: 'max rate', get: r => money(r.maxRate), width: 9 },
  { head: 'actual yld', get: r => r.actualYield?.toFixed(2) ?? '—', width: 11 },
  { head: 'natl $', get: r => money(r.nationalPrice), width: 7 },
  { head: 'FSA rate', get: r => money(r.paymentRate), width: 9 },
  { head: 'model rate', get: r => money(r.modelRate), width: 11 },
] });
note('Rates are $ per payment acre (85% of base acres). The model rate is arcCountyRate on FSA\'s inputs.');
