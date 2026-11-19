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
 * farm-report.mjs — run one farm season and print its job-cost and cash reports (design 134).
 *
 * Usage:
 *   npm run farm:report                                   # the demo farm
 *   npm run farm:report -- --scenario farm.json           # a saved farm scenario
 *   npm run farm:report -- --scenario farm.json --machinery-basis ACTUAL
 *   npm run farm:report -- --scenario farm.json --json    # machine-readable
 *
 * The job-cost report is per crop plan for the season's crop year, with breakevens
 * (design 134 §5.4). The cash report is a calendar-year Schedule F per operator, with
 * §464(d) applied to the full year (§7.1).
 */

import { readFileSync } from 'node:fs';

import { parseFlags, printJsonAndExit }   from '../lib/cli.mjs';
import { money, columns, heading, note } from '../lib/format.mjs';

import { FarmScenario } from '../../src/scenarios/farm-scenario.js';
import { runFarm }      from '../../src/finance/farm/farm-run.js';
import { SCHEDULE_F_LINES, SCHEDULE_F_LINE_ORDER } from '../../src/finance/farm/schedule-f.js';

const opts = parseFlags(process.argv.slice(2), {
  usage: 'npm run farm:report -- [--scenario farm.json] [options]\n\n'
       + 'farm-report — job-cost P&L, breakevens and calendar-year Schedule F for one farm season.',
  scenario:       { type: 'string', help: 'farm scenario export ({ scenarios: [...] } or one cfg); default: the demo farm' },
  index:          { type: 'number', default: 0, help: 'which scenario in the file' },
  machineryBasis: { type: 'string', default: 'CUSTOM', choices: ['CUSTOM', 'ACTUAL'],
                    help: 'machinery in the job-cost net: custom-hire rates, or the real machinery figure' },
  json:           { type: 'flag', help: 'emit the reports as JSON' },
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
if (!opts.verbose) console.log = () => {};
let result;
try { result = runFarm(cfg, { machineryBasis: opts.machineryBasis }); }
finally { console.log = log; }
const { jobCost, cash } = result;

if (opts.json) {
  await printJsonAndExit({ source, jobCost, cash }, 2);
}

const perBu = (n) => (n == null ? '—' : `$${n.toFixed(2)}`);
const bu = (n) => (n == null ? '—' : Math.round(n).toLocaleString());
const yld = (n) => (n == null ? '—' : n.toFixed(1));

heading(`Farm season ${jobCost.cropYear} — ${source}`);
note(`Machinery in the job-cost net: ${jobCost.machineryBasis === 'CUSTOM' ? 'custom-hire rates' : 'the real machinery figure'}.`);

const jobCols = [
  { head: 'job', get: r => r.planId ?? r.jobId ?? r.operatorId ?? r.crop ?? 'farm', align: 'left', width: 18 },
  { head: 'crop', get: r => r.crop ?? '—', align: 'left', width: 10 },
  { head: 'acres', get: r => r.acres.toFixed(0), width: 7 },
  { head: 'revenue', get: r => money(r.revenue.total), width: 12 },
  { head: 'direct', get: r => money(r.directCost), width: 11 },
  { head: 'overhead', get: r => money(r.overheadCost), width: 11 },
  { head: 'machinery', get: r => money(r.machineryCost), width: 11 },
  { head: 'net', get: r => money(r.net), width: 11 },
  { head: 'net/ac', get: r => money(r.perAcre.net), width: 8 },
  { head: 'BE $/bu', get: r => perBu(r.breakevenPrice), width: 9 },
  { head: 'BE unpriced', get: r => perBu(r.breakevenUnpricedPrice), width: 12 },
  { head: 'BE bu/ac', get: r => yld(r.breakevenYield), width: 9 },
  { head: 'mach margin', get: r => money(r.machinery.margin), width: 12 },
];
columns({ title: `Job cost — crop year ${jobCost.cropYear}, per crop plan`, rows: jobCost.plans, columns: jobCols });
columns({ title: 'Per operator', rows: jobCost.byOperator, columns: jobCols });
columns({ title: 'Per crop', rows: jobCost.byCrop, columns: jobCols });
columns({ title: 'Whole farm', rows: [jobCost.farm], columns: jobCols });
for (const [op, u] of Object.entries(jobCost.unallocated)) {
  note(`  ! ${op}: ${money(u.cost)} cost and ${money(u.revenue)} revenue had no crop plan to allocate to.`);
}
for (const a of jobCost.advisories ?? []) note(`  ! ${a.message}`);

const lines = SCHEDULE_F_LINE_ORDER.filter(l => cash.some(r => r.income[l] != null || r.expense[l] != null));
for (const r of cash) {
  const head = `Schedule F (cash) — ${r.operatorId}, ${r.year}${r.partial ? '  [PARTIAL: this season only]' : ''}`;
  const rows = lines.filter(l => r.income[l] != null || r.expense[l] != null).map(l => ({
    line: l, label: SCHEDULE_F_LINES[l].label, amount: r.income[l] ?? r.expense[l],
  }));
  rows.push({ line: '9',  label: 'Gross income', amount: r.grossIncome });
  rows.push({ line: '33', label: 'Total expenses', amount: r.totalExpenses });
  rows.push({ line: '34', label: 'Net farm profit or (loss), before §464(d)', amount: r.netBefore464 });
  columns({ title: head, rows, columns: [
    { head: 'line', get: x => x.line, align: 'left', width: 17 },
    { head: 'description', get: x => x.label.slice(0, 58), align: 'left', width: 60 },
    { head: 'amount', get: x => money(x.amount), width: 12 },
  ] });
  if (r.section451f?.elected) note(`  §451(f): ${r.section451f.reason}.`);
  const s = r.section464;
  if (!s.assessed) note(`  §464(d): not assessed — ${s.reason}.`);
  else {
    note(`  §464(d): prepaid supplies ${money(s.prepaid)}, limit ${money(s.limit)} (50% of ${money(s.otherExpenses)}); `
      + `${s.applies ? `excess deferred ${money(s.deferred)}` : 'limit does not apply'} — ${s.reason}.`);
    note(`           headroom for more prepay without deferral: ${money(s.headroom)}.  Net after §464(d): ${money(r.net)}.`);
  }
}
note(`\nGrain bushels: ${bu(jobCost.farm.expectedBushels)} expected across all crops.`);
