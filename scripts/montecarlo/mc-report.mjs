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
 * mc-report.mjs — turn raw Monte Carlo arm output into a decision.
 *
 * Reads the `<armKey>.json` files written by `mc-run.mjs` and prints four views,
 * in increasing order of how much they should influence a decision:
 *
 *   1. DISTRIBUTION   failure rate and low percentiles per arm.
 *   2. PAIRED         per-world rescues between two arms — the decision-relevant one.
 *   3. PATH SHAPE     sequence-risk readouts (only meaningful with --paths runs).
 *   4. DRIVERS        what separates a failing world from a surviving one.
 *
 * Usage:
 *   node scripts/montecarlo/mc-report.mjs --dir <dir> [--pairs "a:b,c:d"] [--json]
 *
 *   --dir <dir>     REQUIRED. Directory of arm JSON files from mc-run.mjs.
 *   --pairs <list>  comma-separated `baseline:changed` arm pairs for the paired view.
 *                   Omitted ⇒ every arm is paired against the first one found.
 *   --json          machine-readable output.
 *
 * ─── why medians and never means ─────────────────────────────────────────────
 *
 * Terminal-wealth MEANS from this model are meaningless. Without stochastic paths a
 * single return is drawn per world and held for the whole horizon, so an unlucky
 * draw at the top of the distribution compounds for forty years into a number with
 * no economic content — and it dominates the average. The median and the low
 * percentiles are the readouts that survive that. This report never prints a mean
 * of terminal wealth, only of explanatory variables.
 *
 * ─── why the paired view outranks the failure rates ──────────────────────────
 *
 * Two arms differing 8% vs 6% could be the lever working, or the same handful of
 * marginal worlds landing differently. Because arms share the seed sequence, world i
 * is the same world in both, so you can count the individual worlds the decision
 * flipped. `rescues` is what the change saves; `reverse` is what it breaks.
 *
 * A nonzero `reverse` is the finding to take seriously even when small. It means the
 * lever has state-dependent harm — there are worlds it makes worse — which is a real
 * risk with a mechanism worth understanding, not noise to be averaged away. A clean
 * zero across a large n is strong evidence the lever weakly dominates, and that is a
 * much stronger claim than any difference in headline rates.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { pairedRescues, failureRate, failureByBand, failureDrivers } from '../lib/mc-analysis.mjs';
import { millions, thousands, money, pct, percentile, columns } from '../lib/format.mjs';

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

const dir = flag('--dir');
if (!dir) { console.error('usage: mc-report.mjs --dir <dir> [--pairs "a:b"] [--json]'); process.exit(2); }

const files = readdirSync(dir).filter(f => f.endsWith('.json'));
if (!files.length) { console.error(`no arm JSON files in ${dir}`); process.exit(2); }

const arms = {};
for (const f of files) {
  const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  arms[d.arm ?? f.replace(/\.json$/, '')] = d;
}

// Spec order, not filesystem order: the first arm is the author's intended baseline
// and the default pairing compares everything else against it.
const keys = Object.keys(arms).sort((a, b) =>
  (arms[a].order ?? Number.MAX_SAFE_INTEGER) - (arms[b].order ?? Number.MAX_SAFE_INTEGER)
  || a.localeCompare(b));
const meta = arms[keys[0]];

if (argv.includes('--json')) {
  console.log(JSON.stringify({
    arms: Object.fromEntries(keys.map(k => [k, {
      n: arms[k].n, failureRate: failureRate(arms[k].rows), pathShape: arms[k].pathShape,
    }])),
  }, null, 1));
  process.exit(0);
}

// ─── header ──────────────────────────────────────────────────────────────────

const rm = meta.riskModel ?? {};
console.log('\n════ MONTE CARLO ════');
console.log(`base: ${meta.source ?? 'unknown'}${meta.synthetic ? '  ** SYNTHETIC DEFAULT — illustrative only **' : ''}`);
console.log(`n=${meta.n}/arm across ${keys.length} arms`);
console.log(`sampled: ${rm.paths
  ? `year-by-year equity returns (vol ${rm.vol}, drift ${rm.drift})`
  : 'long-run AVERAGE return only — NO sequence risk, so failure rates are UNDERSTATED'}`
  + `${rm.propertyPaths ? ' + property path' : ''}${rm.shock ? ' + manufactured crash' : ''}`
  + ', plus lifespan, inflation and FX');
if (rm.recentre === false) {
  console.log('** MC means were NOT re-centred on the scenario — these rates are not about your plan.');
}

// ─── 1. distribution ─────────────────────────────────────────────────────────

const inconsistentN = new Set(keys.map(k => arms[k].n)).size > 1;
columns({
  title: 'DISTRIBUTION — failure rate and low percentiles',
  rows: keys,
  columns: [
    { head: 'ARM', get: k => k, width: 26, align: 'left' },
    { head: 'FAIL%', get: k => pct(failureRate(arms[k].rows)), width: 8 },
    { head: 'p5',     get: k => millions(percentile(arms[k].rows.map(r => r.nw), 5)), width: 10 },
    { head: 'p10',    get: k => millions(percentile(arms[k].rows.map(r => r.nw), 10)), width: 10 },
    { head: 'p25',    get: k => millions(percentile(arms[k].rows.map(r => r.nw), 25)), width: 10 },
    { head: 'MEDIAN', get: k => millions(percentile(arms[k].rows.map(r => r.nw), 50)), width: 11 },
  ],
});
console.log('Terminal net worth percentiles. No mean is shown — see the header note.');
if (inconsistentN) {
  console.log('** arms have DIFFERENT n — the paired view below is only valid on shared seeds.');
}

// ─── 2. paired ───────────────────────────────────────────────────────────────

const pairs = flag('--pairs')
  ? flag('--pairs').split(',').map(s => s.split(':').map(x => x.trim()))
  : keys.slice(1).map(k => [keys[0], k]);

console.log('\n\n════ PAIRED — what each change rescues, world by world ════');
for (const [a, b] of pairs) {
  if (!arms[a] || !arms[b]) { console.log(`\n${a} → ${b}: (missing arm)`); continue; }
  const p = pairedRescues(arms[a].rows, arms[b].rows);
  console.log(`\n${a}  →  ${b}`);
  console.log(`  both fail ${p.both}   only "${a}" fails ${p.rescues}   only "${b}" fails ${p.reverseRescues}`
    + `   neither ${p.neither}   (paired n=${p.n}${p.unpaired ? `, ${p.unpaired} unpaired` : ''})`);
  console.log(`  → rescues ${p.rescues} worlds (${pct(p.rescueRate)}); `
    + `made ${p.reverseRescues} worse (${pct(p.reverseRate)} reverse-rescue)`);
  if (p.reverseRescues > 0) {
    console.log(`  ** state-dependent harm: this change is not a free win — there are worlds it`);
    console.log(`     breaks. Worth understanding the mechanism before acting on the average.`);
  } else if (p.n > 0) {
    console.log(`  (no reverse-rescues — on this evidence the change weakly dominates)`);
  }
}

// ─── 3. path shape ───────────────────────────────────────────────────────────

const hasShape = keys.some(k => arms[k].pathShape?.medianNetWorthCagr != null);
if (hasShape) {
  columns({
    title: 'PATH SHAPE — sequence-of-returns signal',
    rows: keys,
    columns: [
      { head: 'ARM', get: k => k, width: 26, align: 'left' },
      { head: 'medCAGR',   get: k => pct(arms[k].pathShape?.medianNetWorthCagr), width: 9 },
      { head: 'worst5y',   get: k => pct(arms[k].pathShape?.medianWorst5yrCagr), width: 10 },
      { head: 'maxDD',     get: k => pct(arms[k].pathShape?.medianMaxDrawdown, 0), width: 8 },
      { head: 'fail|lo10', get: k => pct(arms[k].pathShape?.failureRateBelowMedianDecade), width: 11 },
      { head: 'fail|hi10', get: k => pct(arms[k].pathShape?.failureRateAboveMedianDecade), width: 11 },
    ],
  });
  console.log('fail|lo10 / fail|hi10 = failure rate among paths whose FIRST DECADE finished below /');
  console.log('above the cross-path median. A wide gap is sequence risk stated directly: the same');
  console.log('long-run average is survivable or fatal depending on when the bad years land.');

  const houseArms = keys.filter(k => arms[k].pathShape?.medianHouseCagr != null);
  if (houseArms.length) {
    columns({
      title: 'PROPERTY PATH — house return and holding cost',
      rows: houseArms,
      columns: [
        { head: 'ARM', get: k => k, width: 26, align: 'left' },
        { head: 'hCAGR',  get: k => pct(arms[k].pathShape.medianHouseCagr), width: 8 },
        { head: 'hMaxDD', get: k => pct(arms[k].pathShape.medianHouseMaxDrawdown, 0), width: 9 },
        { head: 'rep p50', get: k => thousands(arms[k].pathShape.medianRepairSpend), width: 9 },
        { head: 'rep p90', get: k => thousands(arms[k].pathShape.p90RepairSpend), width: 9 },
      ],
    });
    console.log('hMaxDD = worst pre-sale drawdown on the held property; rep = lifetime repair spend.');
  }
}

// ─── 4. drivers ──────────────────────────────────────────────────────────────

console.log('\n\n════ WHAT DISTINGUISHES A FAILING WORLD ════');
const DRIVER_KEYS = ['growth', 'netWorthCagr', 'worst5yrCagr', 'maxDrawdown', 'shockSev', 'repairSpend'];
const LABEL = {
  growth:       'sampled long-run mean return',
  netWorthCagr: 'realized net-worth CAGR',
  worst5yrCagr: 'worst 5-yr window',
  maxDrawdown:  'max drawdown',
  shockSev:     'crash severity',
  repairSpend:  'lifetime repair spend',
};
const isRate = (k) => k !== 'repairSpend' && k !== 'shockSev';

for (const k of keys) {
  const d = failureDrivers(arms[k].rows, DRIVER_KEYS);
  if (!d.nFailed) { console.log(`\n${k}: no failures in ${arms[k].rows.length} paths`); continue; }
  console.log(`\n${k}: ${d.nFailed} failed / ${d.nSurvived} survived`);
  for (const f of d.fields) {
    if (f.failed == null && f.survived == null) continue;
    const fmt = isRate(f.key) ? (v) => pct(v, 2) : money;
    console.log(`    ${LABEL[f.key].padEnd(30)} failed ${fmt(f.failed).padStart(12)}`
      + `   survived ${fmt(f.survived).padStart(12)}`);
  }
  if (d.oofYears.length) {
    console.log(`    ${'out-of-funds year'.padEnd(30)} median ${percentile(d.oofYears, 50)}`
      + `   earliest ${d.oofYears[0]}`);
  }
}

// Failure rate against the sampled return — turns a probability into a threshold.
const bandKey = rm.paths ? 'netWorthCagr' : 'growth';
const EDGES = [0, 0.04, 0.05, 0.06, 0.07, 0.08, 0.10, 0.12, 1];
const anyBanded = keys.some(k => arms[k].rows.some(r => typeof r[bandKey] === 'number'));
if (anyBanded) {
  const bandRows = EDGES.slice(0, -1).map((lo, i) => ({ lo, hi: EDGES[i + 1] }));
  columns({
    title: `FAILURE RATE BY ${bandKey === 'growth' ? 'SAMPLED MEAN RETURN' : 'REALIZED NET-WORTH CAGR'}`,
    rows: bandRows,
    columns: [
      { head: 'BAND', get: b => `${pct(b.lo, 0)}–${pct(b.hi, 0)}`, width: 14, align: 'left' },
      ...keys.map(k => ({
        head: k.length > 12 ? k.slice(0, 12) : k, width: 14,
        get: (b) => {
          const band = failureByBand(arms[k].rows, bandKey, [b.lo, b.hi])[0];
          return band.n ? `${pct(band.rate, 0)} (${band.n})` : '·';
        },
      })),
    ],
  });
  console.log('Cell = failure rate (paths in band). This is the readout to quote: it converts');
  console.log('"12% of paths fail" into a RETURN THRESHOLD you can hold an opinion about.');
}
