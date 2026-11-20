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
 * farm-workbook.mjs — import the owners' yearly job-cost workbook into a farm scenario
 * (design 134 §17.2, phase 5).
 *
 * Usage:
 *   npm run farm:workbook -- --dir <folder>                    # writes <folder>/farm-<year>.json
 *   npm run farm:workbook -- --dir <folder> --check            # advisories + reconciliation only
 *   npm run farm:workbook -- --dir <folder> --contract-operator D --price CORN=4.10
 *
 * The folder holds the workbook's four sheets exported as CSV, found by name: Fields, Admin,
 * Direct Expenses (DirectExpenses) and Income; `python3 scripts/farm/xlsx-to-csv.py <workbook.xlsx>
 * <folder>` writes them without Excel. The crop year comes from `--crop-year`, else
 * from the first 20xx in the folder's or a file's name.
 *
 * After the import the season is run, and each amount the sheet states (rent, property tax,
 * crop insurance, program income, interest) is reconciled against the model's ledger.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { parseFlags, printJsonAndExit } from '../lib/cli.mjs';
import { money, columns, heading, note } from '../lib/format.mjs';

import { FarmScenario } from '../../src/scenarios/farm-scenario.js';
import { runFarm } from '../../src/finance/farm/farm-run.js';
import { importFarmWorkbook, PRO_RATA } from '../../src/finance/farm/farm-workbook.js';

const opts = parseFlags(process.argv.slice(2), {
  usage: 'npm run farm:workbook -- --dir <folder> [options]\n\n'
       + 'farm-workbook — import the yearly job-cost workbook (four CSVs) into a farm scenario.',
  dir:              { type: 'string', help: 'folder holding Fields, Admin, Direct Expenses and Income CSVs' },
  cropYear:         { type: 'number', help: 'the crop year (default: the first 20xx in the folder or file names)' },
  out:              { type: 'string', help: 'output scenario file (default: <dir>/farm-<year>.json)' },
  contractOperator: { type: 'string', default: PRO_RATA, help: 'operator id the forward contracts belong to, or PRO_RATA' },
  loanOperator:     { type: 'string', default: PRO_RATA, help: 'operator id who pays the loans, or PRO_RATA' },
  price:            { type: 'list', default: [], help: 'CROP=$/bu for grain not under contract (default: latest NASS)' },
  saleDate:         { type: 'string', help: 'YYYY-MM-DD the unpriced grain is sold (default: each crop\'s harvest)' },
  check:            { type: 'flag', help: 'print advisories and the reconciliation; write nothing' },
  json:             { type: 'flag', help: 'emit the result as JSON' },
});
if (!opts.dir) { console.error('--dir is required (see --help)'); process.exit(2); }

const files = readdirSync(opts.dir).filter(f => /\.csv$/i.test(f));
const SHEETS = {
  fields:         /^fields/i,
  admin:          /^admin/i,
  directExpenses: /^direct\s*_?expenses/i,
  income:         /^income/i,
};
const csv = {};
for (const [key, re] of Object.entries(SHEETS)) {
  const hits = files.filter(f => re.test(f));
  if (hits.length !== 1) {
    console.error(`${opts.dir}: expected one ${key} CSV, found ${hits.length ? hits.join(', ') : 'none'}`);
    process.exit(2);
  }
  csv[key] = readFileSync(join(opts.dir, hits[0]), 'utf8');
}
const cropYear = opts.cropYear
  ?? Number([basename(opts.dir), ...readdirSync(opts.dir)].map(s => /20\d\d/.exec(s)?.[0]).find(Boolean));
if (!Number.isInteger(cropYear)) { console.error('no crop year: pass --crop-year'); process.exit(2); }

const prices = {};
for (const p of opts.price) {
  const [crop, v] = p.split('=');
  if (!crop || !(Number(v) > 0)) { console.error(`--price ${p}: expected CROP=number`); process.exit(2); }
  prices[crop.trim().toUpperCase()] = Number(v);
}

let imported;
try {
  imported = importFarmWorkbook(csv, {
    cropYear, contractOperator: opts.contractOperator, loanOperator: opts.loanOperator, prices,
    saleDate: opts.saleDate,
  });
} catch (e) {
  console.error(`import failed: ${e.message}`);
  process.exit(1);
}
const { farm, advisories, sheet } = imported;
const cfg = FarmScenario.buildDefaultConfig({ farm });
cfg.name = `Farm ${cropYear} (imported from the workbook)`;
cfg.scenarioId = 'p:us-farm';

const { log } = console;
console.log = () => {};
let result;
try { result = runFarm(cfg); } finally { console.log = log; }

// Reconcile what the sheet states against what the model posted for this crop year.
const posted = (pred) => result.ledger.filter(p => p.cropYear === cropYear && pred(p)).reduce((s, p) => s + p.amount, 0);
const recon = [
  ['Cash rent', sheet.rent, posted(p => p.category === 'LAND_RENT')],
  ['Property tax', sheet.propertyTax, posted(p => p.category === 'PROPERTY_TAX')],
  ['Crop insurance', sheet.cropInsurance, posted(p => p.category === 'CROP_INSURANCE')],
  ['Program income', sheet.programIncome, posted(p => p.category === 'PROGRAM_PAYMENT')],
  ['Interest', sheet.interest, posted(p => p.category === 'INTEREST_MORTGAGE' || p.category === 'INTEREST_OTHER')],
].map(([item, s, m]) => ({ item, sheet: s, model: m, diff: m - s, ok: Math.abs(m - s) < 0.005 }));

const out = opts.out ?? join(opts.dir, `farm-${cropYear}.json`);
if (opts.json) {
  await printJsonAndExit({ cropYear, out: opts.check ? null : out, advisories, reconciliation: recon, costing: sheet.costing, cfg }, 2);
}

heading(`Farm workbook ${cropYear} — ${opts.dir}`);
const n = (t) => farm[t].length;
note(`${n('operators')} operators, ${n('fields')} fields, ${n('products')} products, ${n('operations')} operations, `
  + `${n('prescriptions')} prescriptions, ${n('contracts')} contract rows, ${n('overhead')} overhead rows.`);
columns({ title: 'Reconciliation: the sheet\'s amounts vs the model\'s ledger', rows: recon, columns: [
  { head: 'item', get: r => r.item, align: 'left', width: 16 },
  { head: 'sheet', get: r => money(r.sheet), width: 12 },
  { head: 'model', get: r => money(r.model), width: 12 },
  { head: 'diff', get: r => (r.ok ? '0' : money(r.diff)), width: 10 },
] });
note('\nAdvisories:');
for (const a of [...advisories, ...result.jobCost.advisories]) note(`  ! [${a.kind}] ${a.message}`);
const f = result.jobCost.farm;
note(`\nWhole farm, crop year ${cropYear}: revenue ${money(f.revenue.total)}, cost ${money(f.totalCost)}, `
  + `net ${money(f.net)} (${money(f.perAcre.net)}/ac, custom-rate machinery).`);

if (recon.some(r => !r.ok)) { console.error('\nreconciliation FAILED'); process.exit(1); }
if (!opts.check) {
  writeFileSync(out, JSON.stringify({ scenarios: [cfg] }, null, 2));
  note(`\nwrote ${out}  →  npm run farm:report -- --scenario ${out}`);
}
