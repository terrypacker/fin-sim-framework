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
 * run-branch.mjs — one counterfactual against a recorded run (design 81 §10).
 *
 * "What if, from 2040, the plan had spent $2,000 a month more?" Under the old design that
 * needed a bespoke driver to re-seed a snapshot and replay a log past it. Here it is three
 * lines: copy the scenario, append a row to the run, run it. That is §9's claim arriving as
 * an absence of code.
 *
 * ─── it SUPERSEDES, it does not edit ─────────────────────────────────────────────
 *
 * The new row is dated `--at` and takes over from there, leaving every earlier decision
 * intact. Rewriting the original row would change the plan's PAST too, which is a different
 * question — and one the run cannot answer, because the realized past is what produced the
 * state the branch starts from.
 *
 * ─── and it is a counterfactual, not a re-plan (§15) ─────────────────────────────
 *
 * A hand-edited schedule is a what-if under a FROZEN POLICY: the controller is not consulted
 * and does not endorse it. It is legitimate and useful and it is not "the plan if I did this",
 * because the real controller would have re-decided everything downstream.
 *
 * Usage:
 *   node scripts/lab/run-branch.mjs --scenario plan.json --at 2040-01-01 \
 *     --set 'SPENDING:band@60=11000' --set 'BOND_LADDER:bondLadderRungs=8'
 */

import { parseFlags }   from '../lib/cli.mjs';
import { loadScenario } from '../lib/scenario-probe.mjs';
import { pickRun, withActiveRun, withoutRun, branchAt, parseSet, inForceAt, runArm, reportRow,
         printRunHeader } from '../lib/run-lab.mjs';

const opts = parseFlags(process.argv.slice(2), {
  usage: "node scripts/lab/run-branch.mjs --scenario <f> --at <date> --set 'LEVER:key=value'\n\n"
       + 'run-branch — one counterfactual: change a decision from a date and re-run.',
  scenario:     { type: 'string', default: 'scenarios/fin-sim-die-with.json', help: 'scenario carrying the run' },
  scenarioName: { type: 'string', help: 'scenario NAME inside that file (default: the first)' },
  run:          { type: 'string', help: 'runId (default: the scenario\'s selection)' },
  at:           { type: 'string', help: 'the date the change takes over (required)' },
  set:          { type: 'string', repeat: true, default: [],
                  help: "LEVER:key=value, or key=value when only one lever decides it" },
});

if (!opts.at)            { console.error('\n--at <date> is required\n'); process.exit(2); }
if (!opts.set.length)    { console.error("\nat least one --set 'LEVER:key=value' is required\n"); process.exit(2); }

const cfg = loadScenario(opts.scenario, opts.scenarioName);
const run = pickRun(cfg, opts.run);
printRunHeader(opts.scenario, cfg, run);

let sets;
try { sets = opts.set.map(s => parseSet(s, run.entry, run.runId)); }
catch (e) { console.error(`\n${e.message}\n`); process.exit(2); }

// What the run was doing there, so the counterfactual is stated as a change and not as a
// value out of nowhere. "In force" is the latest row per key AT OR BEFORE the date, which is
// rarely the row dated nearest it.
const { rows } = inForceAt(run.entry, opts.at, run.runId);
const wasAt = (lever, key) => rows.find(r => r.lever === lever && r.key === key)?.value;
console.log(`  from ${String(opts.at).slice(0, 10)}:`);
for (const s of sets) {
  const was = wasAt(s.lever, s.key);
  console.log(`    ${s.lever}  ${s.key}  ${was === undefined ? '(undecided)' : was}  →  ${s.value}`);
}
console.log('');

const base     = runArm(withoutRun(cfg));
const recorded = runArm(withActiveRun(cfg, run.runId));
const branched = runArm(withActiveRun(cfg, run.runId, branchAt(run.entry, opts.at, sets)));

console.log('  arm');
reportRow('base plan, run OFF', base);
reportRow('the run as recorded', recorded, base);
reportRow('the branch', branched, recorded);
console.log('\n  Δ on the last line is against THE RUN, which is the comparison a branch asks for.');
console.log('  A branch is a what-if under a frozen policy — the controller would have re-decided');
console.log('  everything downstream, and did not (design 81 §15).\n');
