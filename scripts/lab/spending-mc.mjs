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
 * spending-mc.mjs — what the plan costs, as a DISTRIBUTION. Design 89 §11.1 phase 6.
 *
 *   node scripts/lab/spending-mc.mjs [--scenario <file.json>] [-n 100] [options]
 *
 * The lab page and the workbench panel describe one path. This answers what a single path
 * cannot: how *often* tax is more than half the cost of the plan, what the p90 real cost
 * is, and how often the household could not fund what it intended.
 *
 * ─── read this before choosing an n ──────────────────────────────────────────
 *
 * **Recording spending forces `telemetry: 'full'`, and that is 7.5x an ordinary MC
 * iteration.** A spending cube is built from `stateDiff`, and `stateDiff` is skipped
 * entirely in silent mode — a `journal`-level run yields a perfectly well-formed journal
 * whose cube totals **zero**, which is the quiet kind of wrong. Measured on the reference
 * plan: `off` 530 ms/iteration, `full` 3,963 ms.
 *
 * So budget roughly **4 seconds per path**: n=50 is ~3 minutes, n=200 is ~13, n=1000 is
 * over an hour. Start small. Design 82 §8.1 could afford to put allocation into MC
 * because an allocation is a STOCK, readable from live state at an instant; spending is a
 * FLOW and has no such reading.
 *
 * ─── the shortcut this deliberately does not take ────────────────────────────
 *
 * `state.cumulativeTaxesPaid` and `state.cumulativeConsumption` are free at `telemetry:
 * 'off'` and look like they answer the headline question. Measured, they give a tax share
 * of **74.9%** against the correct **53.1%** — because the first is nominal and includes
 * the AU super fund tax that never debits an account, and the second is real and covers
 * only `EXPENSE_DEBIT`. See `spending-distribution.js`.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve }         from 'node:path';

import { loadBaseConfig, parseSourceArgs, describeSource } from '../lib/scenario-source.mjs';
import { buildMcConfig, runArm }    from '../lib/mc.mjs';
import { aggregateSpendingRuns, exceedanceRate, describeSpendingDistribution, TAX_CATEGORIES }
  from '../../src/finance/spending-reporting/spending-distribution.js';
import { SPEND_TIER } from '../../src/finance/spending-reporting/spending-classification.js';

const USAGE = `
spending-mc.mjs — what the plan costs, as a distribution (design 89 phase 6).

  node scripts/lab/spending-mc.mjs [--scenario <file.json>] [options]

  --scenario <file> Workbench export to run (default: built-in synthetic scenario).
  --index <n>       Which scenario inside that file (default 0).
  -n <count>        Paths (default 25). Budget ~4 SECONDS PER PATH — see the header.
  --shock           Enable the manufactured-crash variables.
  --no-recentre     Skip re-centring the MC variables on the scenario (rarely wanted).
  --tax-threshold <f>  Report P(tax share > f). Repeatable. Default 0.4,0.5,0.6.
  --json <file>     Also write the raw per-path summaries + the aggregate.
`;

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has  = (n) => argv.includes(n);

if (has('-h') || has('--help')) { console.log(USAGE); process.exit(0); }

const n          = Number(flag('-n', '25'));
const shock      = has('--shock');
const recentre   = !has('--no-recentre');
const jsonOut    = flag('--json', null);
const thresholds = String(flag('--tax-threshold', '0.4,0.5,0.6'))
  .split(',').map(s => Number(s.trim())).filter(Number.isFinite);

const source = loadBaseConfig(parseSourceArgs(argv));
const cfg    = source.cfg;

const { mcConfig, shocks, recentred } = buildMcConfig(cfg, { shock, recentre });

console.log(`\n${describeSource(source)}`);
console.log(`n=${n} paths · recording classified spending (telemetry FULL — ~4 s/path)`);
if (shock) console.log('risk model: manufactured crash enabled');
if (!recentre) console.log('** CENTER CHECK SKIPPED **');
console.log(`estimated wall clock: ~${Math.round(n * 4 / 60)} min\n`);

const started = Date.now();
const { rows, spendingRuns, provenance } = await runArm({ cfg, n, mcConfig, shocks, spending: true });
const elapsed = (Date.now() - started) / 1000;

const agg = aggregateSpendingRuns(spendingRuns);

// ─── report ──────────────────────────────────────────────────────────────────

const usd = (v) => (v == null ? '—' : `$${Math.round(v).toLocaleString()}`);
const pct = (v, dp = 1) => (v == null ? '—' : `${(v * 100).toFixed(dp)}%`);
const band = (p, fmt = usd) => (p == null ? '—' : `${fmt(p.p10)}  ${fmt(p.p50)}  ${fmt(p.p90)}`);

console.log(`ran ${agg.n} path(s) in ${elapsed.toFixed(0)}s (${(elapsed / Math.max(1, agg.n)).toFixed(1)}s/path)`);
if (agg.nSkipped) console.log(`** ${agg.nSkipped} path(s) produced no cube and are EXCLUDED from every figure below`);
console.log(`failure rate (solvency): ${pct(rows.filter(r => r.failed).length / Math.max(1, rows.length))}\n`);

console.log(`${''.padEnd(30)} ${'p10'.padStart(14)} ${'p50'.padStart(14)} ${'p90'.padStart(14)}`);
console.log('-'.repeat(76));
const line = (label, p, fmt = usd) => console.log(
  `${label.padEnd(30)} ${(p ? fmt(p.p10) : '—').padStart(14)} ` +
  `${(p ? fmt(p.p50) : '—').padStart(14)} ${(p ? fmt(p.p90) : '—').padStart(14)}`);

line('cost of the plan (real)',  agg.spendingReal);
line('cost of the plan (nominal)', agg.spendingNominal);
line('every debit (real)',       agg.totalReal);
line('tax (real)',               agg.taxReal);
line('tax as a share of cost',   agg.taxShare, v => pct(v, 1));
line('unfunded shortfall (real)', agg.shortfallReal);
line('"all debits" overstates by', agg.overstatement, v => pct(v, 0));
line('nominal/real factor',      agg.inflationFactor, v => `${v.toFixed(2)}×`);

console.log('\nby category, REAL, p10 / p50 / p90  (fired = share of paths that used it)');
console.log('-'.repeat(92));
for (const category of agg.categories) {
  const c = agg.byCategoryReal[category];
  const tag = c.tier === SPEND_TIER.SPENDING ? '' : '  (not spending)';
  console.log(`${category.padEnd(20)} ${band(c).padEnd(46)} fired ${pct(c.firedRate, 0).padStart(5)}${tag}`);
}

console.log('\nthreshold questions — the shape §11.1 names for this phase');
console.log('-'.repeat(76));
for (const t of thresholds) {
  const rate = exceedanceRate(spendingRuns, 'taxShare', t);
  console.log(`  P(tax > ${pct(t, 0)} of what the plan costs)  ${pct(rate)}`);
}
console.log(`  P(the plan could not fund what it intended) ${pct(agg.wentShortRate)}`);

// §7(a)'s band, with an address. A sweep reaches corners the reference path never does,
// so this is where a type nobody classified actually surfaces.
if (agg.unclassifiedTypes?.length) {
  console.log('\n** UNCLASSIFIED action types reached on at least one path');
  console.log('   (§8.0 predicted this: types that exist but the reference plan never fires)');
  for (const u of agg.unclassifiedTypes) {
    console.log(`     ${u.actionType.padEnd(36)} ${u.paths} of ${agg.n} path(s)`);
  }
  console.log('   Classify each in spending-classification.js, or record that it belongs there.');
}

console.log(`\n${describeSpendingDistribution(agg)}`);

// A distribution is only about the plan if the variables were centred on it.
if (provenance?.recentred?.length === 0 && recentre) {
  console.log('\n** no MC variable was re-centred on this scenario — the paths may be sampled');
  console.log('   around library defaults rather than around this plan. See mc.mjs.');
}
if (recentred?.length) {
  console.log(`\ncentred ${recentred.length} variable(s) on the scenario.`);
}

if (jsonOut) {
  const out = resolve(jsonOut);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({
    source: describeSource(source), n, shock, elapsedSeconds: elapsed,
    provenance, aggregate: agg, runs: spendingRuns,
  }, null, 1));
  console.log(`\nwrote ${out}`);
}
