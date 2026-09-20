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
 * run-sweep.mjs — N branches of one decision, ranked (design 81 §10).
 *
 * `run-branch` with a list instead of a value, over `grid.mjs` rather than a hand-rolled loop:
 * the cross product, the progress line with an ETA, per-cell error handling and the results
 * envelope are the four things every study driver used to rewrite.
 *
 * ─── why this is not an OPTIMIZER axis, and must not be read as one ──────────────
 *
 * Every cell holds the rest of the recorded plan FIXED and changes one decision from one date.
 * That is a sensitivity curve around a plan, not a search: the controller would have re-decided
 * everything downstream of the change and does not here, so the best cell is the best
 * *counterfactual*, not the best plan. Sweeping `mpcActiveRun` across several whole recorded
 * runs is the other question and the one §4.2 built the selector for.
 *
 * A cell that throws ABORTS the sweep, which is `grid.mjs`'s default and its stated lesson:
 * the characteristic failure is not a cell that errors, it is a sweep that quietly measured
 * nothing.
 *
 * Usage:
 *   node scripts/lab/run-sweep.mjs --scenario plan.json --at 2040-01-01 \
 *     --key 'SPENDING:band@60' --values 8000,9000,10000,11000
 */

import { parseFlags }   from '../lib/cli.mjs';
import { loadScenario, fmtUsd } from '../lib/scenario-probe.mjs';
import { runGrid, markdownTable, escapeMoney } from '../lib/grid.mjs';
import { pickRun, withActiveRun, withoutRun, branchAt, parseSet, inForceAt, runArm, fmtDelta,
         printRunHeader } from '../lib/run-lab.mjs';

const opts = parseFlags(process.argv.slice(2), {
  usage: "node scripts/lab/run-sweep.mjs --scenario <f> --at <date> --key 'LEVER:key' --values a,b,c\n\n"
       + 'run-sweep — N counterfactual values of one recorded decision, ranked.',
  scenario:     { type: 'string', default: 'scenarios/fin-sim-die-with.json', help: 'scenario carrying the run' },
  scenarioName: { type: 'string', help: 'scenario NAME inside that file (default: the first)' },
  run:          { type: 'string', help: 'runId (default: the scenario\'s selection)' },
  at:           { type: 'string', help: 'the date the change takes over (required)' },
  key:          { type: 'string', help: "LEVER:key, or key when only one lever decides it (required)" },
  values:       { type: 'list',   default: [], help: 'comma-separated values to try' },
  markdown:     { type: 'flag',   help: 'also print a markdown table' },
});

if (!opts.at)             { console.error('\n--at <date> is required\n'); process.exit(2); }
if (!opts.key)            { console.error('\n--key is required\n'); process.exit(2); }
if (!opts.values.length)  { console.error('\n--values a,b,c is required\n'); process.exit(2); }

const cfg = loadScenario(opts.scenario, opts.scenarioName);
const run = pickRun(cfg, opts.run);
printRunHeader(opts.scenario, cfg, run);

// Parse once with a throwaway value, so an ambiguous key is reported before anything runs.
let spec;
try { spec = parseSet(`${opts.key}=0`, run.entry, run.runId); }
catch (e) { console.error(`\n${e.message}\n`); process.exit(2); }

const { rows: inForce } = inForceAt(run.entry, opts.at, run.runId);
const was = inForce.find(r => r.lever === spec.lever && r.key === spec.key)?.value;

const base     = runArm(withoutRun(cfg));
const recorded = runArm(withActiveRun(cfg, run.runId));

const cols = opts.values.map(v => ({
  id: String(v),
  label: String(v) + (String(v) === String(was) ? ' (as recorded)' : ''),
}));

const { results } = await runGrid({
  title:  `${spec.lever} ${spec.key} from ${String(opts.at).slice(0, 10)}`,
  header: `recorded value ${was ?? '(undecided)'} · base NW ${fmtUsd(base.netWorth)} · run NW ${fmtUsd(recorded.netWorth)}`,
  rows: [{ id: 'nw', label: 'terminal net worth' }],
  cols,
  cell: (_row, col) => {
    const value = Number.isFinite(Number(col.id)) ? Number(col.id) : col.id;
    const r = runArm(withActiveRun(cfg, run.runId,
      branchAt(run.entry, opts.at, [{ lever: spec.lever, key: spec.key, value }])));
    return { netWorth: r.netWorth, solvent: r.solvent, outOfFundsDate: r.outOfFundsDate };
  },
  summarize: (_r, _c, res) => `${res.solvent ? '✅' : '❌'} ${fmtUsd(res.netWorth)}`,
});

// Ranked, solvency FIRST — a higher terminal on an insolvent path is not a better plan
// (design 80 U2: solvency outranks reward, structurally).
const ranked = Object.values(results)
  .sort((a, b) => (Number(b.solvent) - Number(a.solvent)) || ((b.netWorth ?? 0) - (a.netWorth ?? 0)));

console.log('\n  ranked (solvency first):');
for (const r of ranked) {
  const mark = String(r.col) === String(was) ? ' ← as recorded' : '';
  console.log(`    ${String(r.col).padStart(12)}  ${r.solvent ? '✅' : `❌ ${r.outOfFundsDate}`}`
    + `  NW ${fmtUsd(r.netWorth).padStart(14)}  Δrun ${fmtDelta((r.netWorth ?? 0) - (recorded.netWorth ?? 0))}${mark}`);
}

if (opts.markdown) {
  console.log('\n' + markdownTable({
    corner: `${spec.lever} ${spec.key}`,
    rows: [{ id: 'nw', label: 'terminal NW' }],
    cols,
    cell: (_r, c) => escapeMoney(results[`nw/${c.id}`]?.netWorth ?? NaN, 0),
  }));
}
console.log('\n  Every cell holds the REST of the run fixed — a sensitivity curve around this plan,');
console.log('  not a search. The controller would have re-decided downstream and did not.\n');
