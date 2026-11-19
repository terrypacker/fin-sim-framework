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
 * farm-mc.mjs — Monte Carlo over one farm season (design 134 phase 2).
 *
 * Usage:
 *   npm run farm:mc -- --list                                  # the variables, all off
 *   npm run farm:mc -- --enable farm.price. --n 500            # sample every price row
 *   npm run farm:mc -- --scenario farm.json --enable all --json
 *
 * Reports the distribution of net income and the probability of a loss for the farm, each
 * operator, crop and crop plan, and the distribution of each breakeven (design 134 §5.4).
 *
 * The farm-wide yield shocks and the price paths are calibrated from USDA NASS history
 * (design 134 §13.8, `npm run farm:calibrate`). Every other spread is either 0 (a field's own
 * yield, the cost multipliers: no source sets them) or the parameter harvest's generic ±10% /
 * ±20%, which the output flags UNCALIBRATED: a run that samples those is a sensitivity run.
 */

import { readFileSync } from 'node:fs';

import { parseFlags }   from '../lib/cli.mjs';
import { money, columns, heading, note } from '../lib/format.mjs';

import { FarmScenario } from '../../src/scenarios/farm-scenario.js';
import { FarmMcRunner, FarmMcConfig } from '../../src/finance/farm/farm-mc.js';

const opts = parseFlags(process.argv.slice(2), {
  usage: 'npm run farm:mc -- [--scenario farm.json] [--enable <keys>] [options]\n\n'
       + 'farm-mc — Monte Carlo over one farm season: net income, loss probability and breakevens.',
  scenario:       { type: 'string', help: 'farm scenario export ({ scenarios: [...] } or one cfg); default: the demo farm' },
  index:          { type: 'number', default: 0, help: 'which scenario in the file' },
  n:              { type: 'number', default: 200, help: 'number of paths' },
  enable:         { type: 'string', help: 'variables to sample: comma-separated keys or key prefixes (farm.price.), or "all"' },
  machineryBasis: { type: 'string', default: 'CUSTOM', choices: ['CUSTOM', 'ACTUAL'],
                    help: 'machinery in the nets shown: custom-hire rates, or the real machinery figure' },
  list:           { type: 'flag', help: 'list the variables and exit' },
  json:           { type: 'flag', help: 'emit the runs and summary as JSON' },
  verbose:        { type: 'flag', help: "show the simulation's own console output" },
});

let cfg, source;
if (opts.scenario) {
  const doc = JSON.parse(readFileSync(opts.scenario, 'utf8'));
  const list = doc.scenarios ?? (Array.isArray(doc) ? doc : [doc]);
  cfg = list[opts.index];
  if (!cfg) { console.error(`no scenario at index ${opts.index} in ${opts.scenario}`); process.exit(2); }
  if (!cfg.farm) { console.error(`${opts.scenario}#${opts.index} has no farm records (cfg.farm)`); process.exit(2); }
  source = `${opts.scenario}#${opts.index}`;
} else {
  cfg = FarmScenario.buildDefaultConfig();
  source = 'FarmScenario demo farm  ** SYNTHETIC DEFAULT **';
}

const { log } = console;
const quiet = (f) => { if (!opts.verbose) console.log = () => {}; try { return f(); } finally { console.log = log; } };

const available = quiet(() => new FarmMcRunner({ cfgTemplate: cfg })._prepare().ctx.variables);
const wanted = (opts.enable ?? '').split(',').map(s => s.trim()).filter(Boolean);
const picked = available.filter(v => wanted.includes('all') || wanted.some(w => v.paramKey === w || v.paramKey.startsWith(w)));
const unknown = wanted.filter(w => w !== 'all' && !available.some(v => v.paramKey === w || v.paramKey.startsWith(w)));
if (unknown.length) { console.error(`no variable matches: ${unknown.join(', ')} (try --list)`); process.exit(2); }

if (opts.list) {
  heading(`Farm MC variables — ${source}`);
  columns({ title: `${available.length} variables (all off unless --enable)`, rows: available, columns: [
    { head: 'key', get: v => v.paramKey, align: 'left', width: 46 },
    { head: 'group', get: v => v.group ?? '', align: 'left', width: 22 },
    { head: 'mean', get: v => String(+(v.mean ?? 0).toFixed(4)), width: 10 },
    { head: 'sd', get: v => String(+(v.stdDev ?? 0).toFixed(4)), width: 9 },
  ] });
  process.exit(0);
}

const mcConfig = new FarmMcConfig();
for (const v of picked) mcConfig.applyOverride(v.paramKey, { enabled: true });
const result = await (async () => {
  if (!opts.verbose) console.log = () => {};
  try { return await new FarmMcRunner({ n: opts.n, cfgTemplate: cfg, mcConfig }).run(); }
  finally { console.log = log; }
})();
const { summary } = result;

if (opts.json) {
  console.log(JSON.stringify({ source, ...result }, null, 2));
  process.exit(0);
}

const basis = opts.machineryBasis === 'ACTUAL' ? 'actual' : 'custom';
const s = summary.metrics;
const perBu = (x) => (x == null ? '—' : `$${x.toFixed(2)}`);
const pct = (x) => (x == null ? '—' : `${(100 * x).toFixed(1)}%`);
const yld = (x) => (x == null ? '—' : x.toFixed(1));

heading(`Farm Monte Carlo — ${source}`);
note(`${summary.n} paths; ${picked.length} of ${available.length} variables sampled; machinery: `
  + `${basis === 'custom' ? 'custom-hire rates' : 'the real machinery figure'}.`);
if (picked.length === 0) note('Nothing is sampled, so every path is the deterministic run. Use --enable (see --list).');
if (summary.provenance.uncalibrated.length) {
  note(`UNCALIBRATED: ${summary.provenance.uncalibrated.length} sampled variable(s) use the harvest's generic spread, `
    + 'not a distribution from a source (design 134 §6). Read this as a sensitivity run.');
}
const filled = Object.entries(summary.provenance.priceVolFilled ?? {});
if (filled.length) {
  note(`Price vol from the NASS calibration (the season sets none): ${filled.map(([c, v]) => `${c} ${v}`).join(', ')}.`);
}
if (summary.erroredRuns.length) note(`! ${summary.erroredRuns.length} path(s) threw and are excluded.`);

const scopes = [
  ['farm', 'Whole farm'],
  ...Object.keys(s).filter(k => /^operator\.[^.]+\.net\.custom$/.test(k)).map(k => [k.split('.').slice(0, 2).join('.'), k.split('.')[1]]),
  ...Object.keys(s).filter(k => /^crop\.[^.]+\.net\.custom$/.test(k)).map(k => [k.split('.').slice(0, 2).join('.'), k.split('.')[1]]),
  ...Object.keys(s).filter(k => /^plan\.[^.]+\.net\.custom$/.test(k)).map(k => [k.split('.').slice(0, 2).join('.'), k.split('.')[1]]),
];
const net = (scope, f) => s[`${scope}.net.${basis}`]?.[f];
columns({ title: 'Net income (crop-year job cost)', rows: scopes, columns: [
  { head: 'scope', get: ([, l]) => l, align: 'left', width: 18 },
  { head: 'P(loss)', get: ([k]) => pct(net(k, 'lossProbability')), width: 8 },
  { head: 'p10', get: ([k]) => money(net(k, 'p10')), width: 12 },
  { head: 'p50', get: ([k]) => money(net(k, 'p50')), width: 12 },
  { head: 'p90', get: ([k]) => money(net(k, 'p90')), width: 12 },
  { head: 'mean', get: ([k]) => money(net(k, 'mean')), width: 12 },
  { head: 'Sched F p50', get: ([k]) => (k.startsWith('operator.') ? money(s[`${k}.scheduleF`]?.p50) : ''), width: 13 },
  { head: 'P(SchF loss)', get: ([k]) => (k.startsWith('operator.') ? pct(s[`${k}.scheduleF`]?.lossProbability) : ''), width: 14 },
] });

const be = (scope, m, f) => s[`${scope}.${m}.${basis}`]?.[f];
const priced = scopes.filter(([k]) => k.startsWith('crop.') || k.startsWith('plan.'));
columns({ title: 'Breakevens (p10 / p50 / p90)', rows: priced, columns: [
  { head: 'scope', get: ([, l]) => l, align: 'left', width: 18 },
  { head: '$/bu', get: ([k]) => ['p10', 'p50', 'p90'].map(f => perBu(be(k, 'breakevenPrice', f))).join(' '), width: 24 },
  { head: 'unpriced $/bu', get: ([k]) => ['p10', 'p50', 'p90'].map(f => perBu(be(k, 'breakevenUnpricedPrice', f))).join(' '), width: 24 },
  { head: 'bu/ac', get: ([k]) => ['p10', 'p50', 'p90'].map(f => yld(be(k, 'breakevenYield', f))).join(' '), width: 20 },
] });
