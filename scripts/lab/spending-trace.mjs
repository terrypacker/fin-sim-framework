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
 * spending-trace.mjs — what an adaptive spending rule actually COSTS you.
 *
 * This exists because of a specific way of fooling yourself. Switch a plan from
 * FIXED to GUARDRAIL spending and it stops going out of funds, at every return you
 * care to test. That looks like the guardrail solved the problem. It did not: a
 * proportional withdrawal rule CANNOT run out of money, because its response to
 * depletion is to spend less. The OOF flag has simply stopped measuring anything.
 *
 * So the honest question is not "does it survive" but "AT WHAT STANDARD OF LIVING
 * did it survive". This prints realised monthly spending in REAL (base-year)
 * dollars, deflated by the inflation accumulator, so the answer is in the units the
 * household experiences rather than in nominal dollars that flatter later years.
 *
 * A guardrail run that "passes" at a real $4k/mo against a $9k/mo intent has not
 * passed in any sense the person living in it would recognise. That gap is the
 * number this tool exists to show, and it is what makes an adaptive strategy
 * comparable to the alternatives — working longer, or spending less on purpose.
 *
 * Usage:
 *   node scripts/lab/spending-trace.mjs [--strategy GUARDRAIL] [--scenario plan.json]
 *
 *   Run `--help` for the flags; the spec in this file is the only copy of them.
 *
 * Example:
 *   node scripts/lab/spending-trace.mjs --scenario plan.json --strategy GUARDRAIL \
 *        --levers '{"retire":{"primary":2032},"spendTotal":9000}'
 */

import { readFileSync, existsSync } from 'node:fs';

import { loadBaseConfig, describeSource } from '../lib/scenario-source.mjs';
import { parseFlags } from '../lib/cli.mjs';
import { buildVariant, baseEquityRate } from '../lib/variant.mjs';
import { traceRealSpending } from '../lib/run.mjs';
import { money, pct, columns } from '../lib/format.mjs';

const opts = parseFlags(process.argv.slice(2), {
  usage: 'node scripts/lab/spending-trace.mjs [--strategy GUARDRAIL] [--scenario plan.json]\n\n'
       + 'spending-trace — what an adaptive strategy actually pays out, year by year.',
  strategy: { type: 'string', help: 'FIXED | GUARDRAIL | EXPLICIT_BANDS | … (default: leave as authored)' },
  returns:  { type: 'list',   default: [0.08, 0.06, 0.05, 0.04], help: 'equity returns to trace' },
  levers:   { type: 'string', help: 'lever bag applied to every case: inline JSON or a file (see lib/variant.mjs)' },
  years:    { type: 'list',   help: 'report years (default: evenly spaced across the horizon)' },
  country:  { type: 'string', default: 'US', help: 'inflation accumulator to deflate by' },
  scenario: { type: 'string', help: 'base scenario export; omitted ⇒ the synthetic default' },
  index:    { type: 'number', default: 0, help: 'scenario index in that file' },
  json:     { type: 'flag',   help: 'machine-readable output' },
});

const strategy = opts.strategy ?? null;
const country  = opts.country;
const returns  = opts.returns.map(Number);

let levers = {};
if (opts.levers) {
  levers = JSON.parse(existsSync(opts.levers) ? readFileSync(opts.levers, 'utf8') : opts.levers);
}

const source = { file: opts.scenario, index: opts.index };
const base = loadBaseConfig(source);

const baseRate = baseEquityRate(base.cfg);

const startYear = new Date(base.cfg.simStart).getUTCFullYear();
const endYear   = new Date(base.cfg.simEnd).getUTCFullYear();
const reportYears = opts.years
  ? opts.years.map(Number)
  : evenlySpaced(startYear + 1, endYear, 7);

function evenlySpaced(a, b, k) {
  const out = [];
  for (let i = 0; i < k; i++) out.push(Math.round(a + (i * (b - a)) / (k - 1)));
  return [...new Set(out)];
}

const cases = returns.map(rate => {
  const t = traceRealSpending(
    buildVariant(base.cfg, {
      ...levers,
      equityShift: rate - baseRate,
      ...(strategy ? { spendingStrategy: strategy } : {}),
    }),
    country,
  );
  return { rate, ...t };
});

if (opts.json) {
  console.log(JSON.stringify({ source: base.source, strategy, levers, country, cases }, null, 1));
  process.exit(0);
}

console.log(`\n════ REALISED REAL SPENDING${strategy ? ` — ${strategy}` : ''} ════`);
console.log(describeSource(base));
console.log(`Monthly spending in REAL ${country} base-year dollars, deflated by the inflation`);
console.log(`accumulator. Scenario's own equity rate: ${pct(baseRate, 2)}.`);
if (Object.keys(levers).length) console.log(`held: ${JSON.stringify(levers)}`);

columns({
  rows: cases,
  columns: [
    { head: 'RETURN', get: c => pct(c.rate), width: 9 },
    ...reportYears.map(y => ({
      head: String(y), width: 11,
      get: c => money(c.series.find(p => p.year === y)?.real ?? null),
    })),
    { head: 'MIN', get: c => money(c.minReal), width: 12 },
    { head: 'OOF?', get: c => (c.failed ? 'FAIL' : 'ok'), width: 7 },
  ],
});

const intent = levers.spendTotal ?? levers.monthlyExpenses ?? null;
console.log('');
if (intent != null) {
  console.log(`Intent was ${money(intent)}/mo. The gap between that and the MIN column is what`);
  console.log(`the strategy actually charged you in the bad states:`);
  for (const c of cases) {
    const shortfall = intent - c.minReal;
    console.log(`  ${pct(c.rate).padStart(6)}: worst real month ${money(c.minReal).padStart(10)}`
      + `  — ${shortfall > 0 ? money(shortfall) + ' below intent' : 'never dipped below intent'}`
      + ` (${shortfall > 0 ? (100 * shortfall / intent).toFixed(0) + '% cut' : 'no cut'})`);
  }
} else {
  console.log('Pass `--levers` with `spendTotal` or `monthlyExpenses` to see the shortfall');
  console.log('against your intended spend.');
}

if (cases.every(c => !c.failed)) {
  console.log('\nEvery case "passed" — which under an adaptive rule is close to guaranteed and');
  console.log('is NOT evidence the plan is sound. Read the MIN column, not the OOF column.');
}
