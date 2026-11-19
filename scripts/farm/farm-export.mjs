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
 * farm-export.mjs — write the farm result export a household plan imports (design 134 §8.2).
 *
 * Usage:
 *   npm run farm:export                                          # the demo farm, deterministic
 *   npm run farm:export -- --scenario farm.json --out farm-result.json
 *   npm run farm:export -- --scenario farm.json --n 500 --enable all --out farm-result.json
 *
 * The export carries, per operator and calendar year, the Schedule F lines and net and the
 * household's inputs from them: Schedule SE line 1a, QBI before the household's adjustments,
 * and the Nebraska community-college tax paid. With --n it also carries every Monte Carlo path,
 * with its seed and params, for a household MC to draw from (design 134 §16.1).
 *
 * With no --out it prints the per-year table and writes nothing.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { parseFlags }                    from '../lib/cli.mjs';
import { money, columns, heading, note } from '../lib/format.mjs';

import { FarmScenario }  from '../../src/scenarios/farm-scenario.js';
import { runFarm }       from '../../src/finance/farm/farm-run.js';
import { FarmMcRunner, FarmMcConfig } from '../../src/finance/farm/farm-mc.js';
import { buildFarmExport } from '../../src/finance/farm/farm-export.js';

const opts = parseFlags(process.argv.slice(2), {
  usage: 'npm run farm:export -- [--scenario farm.json] [--n N --enable <keys>] [--out farm-result.json]\n\n'
       + 'farm-export — the farm result export: calendar-year Schedule F per operator, and MC paths.',
  scenario: { type: 'string', help: 'farm scenario export ({ scenarios: [...] } or one cfg); default: the demo farm' },
  index:    { type: 'number', default: 0, help: 'which scenario in the file' },
  n:        { type: 'number', default: 0, help: 'Monte Carlo paths to carry (0 = the deterministic run only)' },
  enable:   { type: 'string', help: 'variables to sample: comma-separated keys or key prefixes, or "all" (see npm run farm:mc -- --list)' },
  out:      { type: 'string', help: 'write the export here; without it, a dry run that prints the table' },
  verbose:  { type: 'flag', help: "show the simulation's own console output" },
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
if (opts.enable && !(opts.n > 0)) { console.error('--enable needs --n: the paths to sample'); process.exit(2); }

const { log } = console;
const quiet = async (f) => { if (!opts.verbose) console.log = () => {}; try { return await f(); } finally { console.log = log; } };

const det = await quiet(() => runFarm(cfg));
let mc = null;
if (opts.n > 0) {
  const available = await quiet(() => new FarmMcRunner({ cfgTemplate: cfg })._prepare().ctx.variables);
  const wanted = (opts.enable ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const unknown = wanted.filter(w => w !== 'all' && !available.some(v => v.paramKey === w || v.paramKey.startsWith(w)));
  if (unknown.length) { console.error(`no variable matches: ${unknown.join(', ')} (npm run farm:mc -- --list)`); process.exit(2); }
  const mcConfig = new FarmMcConfig();
  for (const v of available) {
    if (wanted.includes('all') || wanted.some(w => v.paramKey === w || v.paramKey.startsWith(w))) {
      mcConfig.applyOverride(v.paramKey, { enabled: true });
    }
  }
  mc = await quiet(() => new FarmMcRunner({ n: opts.n, cfgTemplate: cfg, mcConfig }).run());
}
const doc = buildFarmExport({ source, det, mc });

heading(`Farm result export — ${source}`);
note(`Crop year ${doc.cropYear}: the only full Schedule F; the years either side are partial (design 134 §5.5).`);
const rows = [];
for (const op of doc.operators) {
  for (const y of doc.deterministic.operators[op.id] ?? []) rows.push({ op: op.name, ...y });
}
columns({ title: 'Deterministic run, per operator and calendar year', rows, columns: [
  { head: 'operator', get: r => r.op, align: 'left', width: 18 },
  { head: 'year', get: r => `${r.year}${r.partial ? ' (partial)' : ''}`, align: 'left', width: 15 },
  { head: 'gross', get: r => money(r.grossIncome), width: 12 },
  { head: 'expenses', get: r => money(r.totalExpenses), width: 12 },
  { head: '§464 defer', get: r => money(r.section464Deferred), width: 11 },
  { head: 'Sched F net', get: r => money(r.net), width: 12 },
  { head: 'NE CC tax', get: r => money(r.household.neCommunityCollegeTaxPaid), width: 10 },
] });
if (doc.mc) {
  note(`${doc.mc.n} Monte Carlo paths carried${doc.mc.erroredRuns.length ? `; ${doc.mc.erroredRuns.length} errored and are left out` : ''}.`);
  if (doc.mc.provenance.uncalibrated?.length) {
    note(`UNCALIBRATED: ${doc.mc.provenance.uncalibrated.length} sampled variable(s) use a generic spread (design 134 §6).`);
  }
} else {
  note('Deterministic only. --n N --enable <keys> adds Monte Carlo paths.');
}

if (opts.out) {
  writeFileSync(opts.out, `${JSON.stringify(doc, null, 2)}\n`);
  note(`wrote ${opts.out}`);
} else {
  note('Dry run: nothing written (--out FILE writes the export).');
}
