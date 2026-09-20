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
 * save-run.mjs — write a recorded MPC run into a scenario's `mpcRuns` bag (design 81 §10, 4c).
 *
 * The headless twin of the cockpit's "Save run to plan" button, and deliberately the SAME code
 * path: `buildRunEntry` → `checkRunFeasibility` (the design 80 F1 gate) → `saveRunToScenario`.
 * A CLI that reconstructed any of those would be a second answer to "what did this run decide",
 * which is the class of drift this whole design exists to remove.
 *
 * Input is an exported decision log — `fin-sim-decisions` out of browser localStorage — plus the
 * scenario it was recorded against, the same two files `replay-vs-bake.mjs` takes.
 *
 * Usage:
 *   node scripts/scenario/save-run.mjs \
 *     --decisions scenarios/fin-sim-decisions.json \
 *     --scenario  scenarios/fin-sim-die-with.json \
 *     --out       scenarios/fin-sim-die-with-run.json
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { COCKPIT_CONTROLS } from '../../src/finance/mpc/cockpit-controller.js';
import { buildRunEntry, makeRunKey, describeRunSource, saveRunToScenario, checkRunFeasibility }
  from '../../src/finance/mpc/run-record.js';
import { describeFeasibility } from '../../src/finance/mpc/harvest-feasibility.js';
import { parseFlags }   from '../lib/cli.mjs';
import { loadScenario, readParams, cloneCfg } from '../lib/scenario-probe.mjs';

const opts = parseFlags(process.argv.slice(2), {
  usage: 'node scripts/scenario/save-run.mjs --decisions <f> --scenario <f> [--out <f>]\n\n'
       + 'save-run — promote a recorded MPC decision log into a scenario\'s mpcRuns bag.',
  decisions:    { type: 'string', default: 'scenarios/fin-sim-decisions.json', help: 'decision record export' },
  scenario:     { type: 'string', default: 'scenarios/fin-sim-die-with.json',  help: 'scenario export' },
  scenarioName: { type: 'string', help: 'scenario NAME inside that file (default: the first)' },
  run:          { type: 'string', help: 'runId to promote (default: the last recorded)' },
  out:          { type: 'string', help: 'write the updated scenario here (default: print, write nothing)' },
  as:           { type: 'string', help: 'bag key for the new entry (default: run:<recorded date>)' },
  derivedFrom:  { type: 'string', help: 'the bag entry this run was re-solved from (design 81 §4.3)' },
  solver:       { type: 'string', help: 'solver + budget for the picker label, e.g. CEM/128' },
  noSelect:     { type: 'flag',   help: 'write the entry without selecting it' },
  noCheck:      { type: 'flag',   help: 'skip the design 80 F1 feasibility gate (not recommended)' },
  keepRepeats:  { type: 'flag',   help: 'keep rows that re-decide a value already in force' },
});

// ── the log ───────────────────────────────────────────────────────────────────────
const doc = JSON.parse(readFileSync(opts.decisions, 'utf8'));
const all = Array.isArray(doc.records) ? doc.records : Object.values(doc.records ?? doc);
const runId = opts.run ?? all[all.length - 1]?.runId ?? null;
const records = all
  .filter(r => runId == null || r.runId === runId)
  .sort((a, b) => String(a.asOfDate).localeCompare(String(b.asOfDate)));

if (records.length === 0) {
  console.error(`\nNo decision records for run ${runId ?? '[any]'} in ${opts.decisions}\n`);
  process.exit(2);
}

const cfg = loadScenario(opts.scenario, opts.scenarioName);

const { entry, warnings } = buildRunEntry(records, {
  controlsByKey:   COCKPIT_CONTROLS,
  runId,
  solver:          opts.solver ?? null,
  derivedFrom:     opts.derivedFrom ?? null,
  baseScenarioId:  cfg.id ?? cfg.name ?? null,
  dedupeUnchanged: !opts.keepRepeats,
});
for (const w of warnings) console.warn(`  ! ${w}`);
if (!entry) process.exit(2);

const bag = readParams(cfg, ['mpcRuns']).mpcRuns ?? {};
const key = opts.as ?? makeRunKey(entry.source, bag);

console.log(`\n${opts.scenario} ← ${key}`);
console.log(`  ${describeRunSource(entry.source, key)}`);
console.log(`  ${entry.decisions.length} decision row(s) over ${entry.source.epochs} epoch(s)`
  + `, ${entry.source.first?.slice(0, 10)} → ${entry.source.last?.slice(0, 10)}`);

// ── the F1 gate ───────────────────────────────────────────────────────────────────
// Writing a bag entry is a PROMOTION (D9), so it passes the same gate the harvest does. The
// check runs the plan the user is about to create, from t₀, and asks the simulation whether it
// runs out of money — a question the goal metric cannot answer at a die-with-zero target.
if (!opts.noCheck) {
  const base = Object.fromEntries((cfg.params ?? []).map(p => [p.key ?? p.name, p.value]));
  const f = checkRunFeasibility({
    runId: key, entry, baseParams: base,
    simStart: new Date(cfg.simStart), simEnd: new Date(cfg.simEnd),
    cfgTemplate: cloneCfg(cfg),
  });
  if (f.playable === false) {
    // D11's refusal, not the F1 gate. Saving here writes a scenario that THROWS at load, so
    // it is refused louder and separately from "this plan runs out of money".
    console.error(`\n${f.error}\n`);
    console.error('Refusing to save a run this scenario cannot play. '
      + 'Fix the scenario, or re-run with --no-check to write it anyway.\n');
    process.exit(1);
  }
  console.log(`  F1: ${describeFeasibility(f)}`);
  if (f.feasible === false) {
    console.error('\nRefusing to save an insolvent plan. Re-run with --no-check to override.\n');
    process.exit(1);
  }
}

// ── the write ─────────────────────────────────────────────────────────────────────
const next = cloneCfg(cfg);
const res = saveRunToScenario(next, { runId: key, entry, select: !opts.noSelect });
console.log(`  ${res.created ? 'created' : 'replaced'}${res.selected ? ' and selected' : ''}`);

if (!opts.out) {
  console.log('\n(no --out: nothing written)\n');
} else {
  writeFileSync(opts.out, `${JSON.stringify({ scenarios: [next] }, null, 2)}\n`);
  console.log(`\nwrote ${opts.out}\n`);
}
