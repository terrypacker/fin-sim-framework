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
 * run-inspect.mjs — what does this recorded run decide, and when? (design 81 §10)
 *
 * The decision table, grouped by date. With `--at`, the decisions IN FORCE at that instant —
 * which is the question that actually comes up, and the one a raw look at the JSON answers
 * badly: "in force" is the latest row per (lever, key) at or before the date, so at any given
 * moment the plan is running on rows scattered across years.
 *
 * Reads through `resolveActiveMpcRun` / `activeDecisionsAt`, the same two functions the engine
 * uses, so what this prints is what the simulation plays — including the warnings a malformed
 * row produces.
 *
 * Usage:
 *   node scripts/lab/run-inspect.mjs --scenario scenarios/plan.json [--run <id>] [--at 2035-01-01]
 */

import { parseFlags }   from '../lib/cli.mjs';
import { loadScenario } from '../lib/scenario-probe.mjs';
import { listRuns, pickRun, decisionsOf, inForceAt, leversOf, printRunHeader }
  from '../lib/run-lab.mjs';

const opts = parseFlags(process.argv.slice(2), {
  usage: 'node scripts/lab/run-inspect.mjs --scenario <f> [--run <id>] [--at <date>]\n\n'
       + 'run-inspect — the decision table of a recorded MPC run.',
  scenario:     { type: 'string', default: 'scenarios/fin-sim-die-with.json', help: 'scenario export' },
  scenarioName: { type: 'string', help: 'scenario NAME inside that file (default: the first)' },
  run:          { type: 'string', help: 'runId (default: the scenario\'s selection, or the only one)' },
  at:           { type: 'string', help: 'show the decisions IN FORCE at this date instead of the table' },
  list:         { type: 'flag',   help: 'list the scenario\'s recorded runs and stop' },
});

const cfg = loadScenario(opts.scenario, opts.scenarioName);

if (opts.list) {
  const runs = listRuns(cfg);
  console.log(`\n${opts.scenario} — ${runs.length} recorded run(s)\n`);
  for (const r of runs) console.log(`  ${r.runId.padEnd(24)} ${r.rows.toString().padStart(4)} row(s)  ${r.label}`);
  console.log('');
  process.exit(0);
}

const run = pickRun(cfg, opts.run);
printRunHeader(opts.scenario, cfg, run);

if (opts.at) {
  const { throughMs, rows } = inForceAt(run.entry, opts.at, run.runId);
  if (!rows.length) {
    console.log(`  Nothing in force at ${opts.at} — every decision is dated after it, so the run `
      + 'plays the base plan up to here.\n');
    process.exit(0);
  }
  // The date a decision became LIVE, not the date recorded: a row bites at the first period
  // advance on or after its date (D6), and on a semi-annual cadence that is up to six months.
  console.log(`  In force at ${opts.at} (latest decision applied ${new Date(throughMs).toISOString().slice(0, 10)}):\n`);
  for (const r of rows) {
    console.log(`  ${String(r.date).slice(0, 10)}  ${r.lever.padEnd(20)} ${r.key.padEnd(26)} ${r.value}`);
  }
  console.log('');
  process.exit(0);
}

const rows = decisionsOf(run.entry, run.runId);
console.log(`  ${leversOf(run.entry, run.runId).join(', ')}\n`);

let lastDate = null;
for (const r of rows) {
  const day = String(r.date).slice(0, 10);
  // Blank line between dates: the table's unit is the EPOCH, and a solid block of 400 rows
  // hides where one decision ends and the next begins.
  if (lastDate && day !== lastDate) console.log('');
  console.log(`  ${(day === lastDate ? '' : day).padEnd(12)} ${r.lever.padEnd(20)} ${r.key.padEnd(26)} ${r.value}`);
  lastDate = day;
}
console.log(`\n  ${rows.length} row(s) over ${new Set(rows.map(r => String(r.date).slice(0, 10))).size} date(s).\n`);
