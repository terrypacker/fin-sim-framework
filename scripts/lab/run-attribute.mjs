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
 * run-attribute.mjs — which lever did the work? (design 81 §10)
 *
 * One arm per lever: the recorded run with THAT lever's rows removed, everything else intact.
 * Design 80 §2.11 built this table by hand once; here it is nine lines, because removing a
 * lever from a run is a filter on an array.
 *
 * ─── removal, not substitution, and what that makes the number mean ──────────────
 *
 * Dropping a lever's rows leaves the BASE SCENARIO's own value governing it — the only
 * counterfactual that is both well-defined and authored by somebody. Substituting "the last
 * epoch's value" instead would compare the run against a plan nobody ever chose.
 *
 * So each row reads: *the run is worth this much more (or less) than the run-without-this-lever*.
 * The rows do not sum to the run's total effect and must not be presented as if they do —
 * levers interact (a drawdown order changes what an allocation mix is rebalancing), and a
 * leave-one-out table prices each lever AT THE MARGIN of the full plan, which is the useful
 * question and not an additive decomposition.
 *
 * Usage:
 *   node scripts/lab/run-attribute.mjs --scenario plan.json [--run <id>]
 */

import { parseFlags }   from '../lib/cli.mjs';
import { loadScenario, fmtUsd } from '../lib/scenario-probe.mjs';
import { pickRun, withActiveRun, withoutRun, withoutLever, leversOf, decisionsOf, runArm,
         fmtDelta, printRunHeader } from '../lib/run-lab.mjs';

const opts = parseFlags(process.argv.slice(2), {
  usage: 'node scripts/lab/run-attribute.mjs --scenario <f> [--run <id>]\n\n'
       + 'run-attribute — leave-one-lever-out table for a recorded MPC run.',
  scenario:     { type: 'string', default: 'scenarios/fin-sim-die-with.json', help: 'scenario carrying the run' },
  scenarioName: { type: 'string', help: 'scenario NAME inside that file (default: the first)' },
  run:          { type: 'string', help: 'runId (default: the scenario\'s selection)' },
  only:         { type: 'list',   default: [], help: 'restrict to these levers' },
});

const cfg = loadScenario(opts.scenario, opts.scenarioName);
const run = pickRun(cfg, opts.run);
printRunHeader(opts.scenario, cfg, run);

const all = leversOf(run.entry, run.runId);
const levers = opts.only.length ? all.filter(l => opts.only.includes(l)) : all;
if (!levers.length) {
  console.error(`\nno matching levers. This run decides: ${all.join(', ')}\n`);
  process.exit(2);
}

const base     = runArm(withoutRun(cfg));
const recorded = runArm(withActiveRun(cfg, run.runId));

console.log(`  base plan, run OFF                 NW ${fmtUsd(base.netWorth).padStart(14)}`);
console.log(`  the run, all ${String(all.length).padStart(2)} levers            NW ${fmtUsd(recorded.netWorth).padStart(14)}`
  + `  Δbase ${fmtDelta((recorded.netWorth ?? 0) - (base.netWorth ?? 0))}\n`);

const rowsOf = (lever) => decisionsOf(run.entry, run.runId).filter(d => d.lever === lever).length;

/**
 * Identical on every terminal this probe reports — so removing the lever changed NOTHING.
 *
 * Reported as INERT rather than as "worth $0", because the two are different findings and
 * this repo has paid for confusing them more than once (a multiplicative lever with a zero
 * base; a sleeve-narrowed pool claim that makes a drawdown weight unreachable). A lever worth
 * $0 traded and broke even. An inert one was never read: its rows are in the run, the run
 * plays them, and no consumer is listening — usually because a gate upstream (pools claiming
 * the classes, a schedule overriding the anchor) is the authority instead.
 *
 * It is a PROBE, not a proof: equal on four terminals is strong evidence and not
 * byte-identity, so the message says "check the gate", never "the lever is dead".
 */
const isInert = (a, b) => a.netWorth === b.netWorth
  && a.netLiquidity === b.netLiquidity
  && a.cumulativeDeficit === b.cumulativeDeficit
  && a.solvent === b.solvent;

const out = [];
for (const lever of levers) {
  const r = runArm(withActiveRun(cfg, run.runId, withoutLever(run.entry, lever)));
  const contribution = (recorded.netWorth ?? 0) - (r.netWorth ?? 0);
  out.push({ lever, r, contribution, inert: isInert(r, recorded) });
  console.log(`  without ${lever.padEnd(22)} ${r.solvent ? '✅' : `❌ ${r.outOfFundsDate}`}`
    + `  NW ${fmtUsd(r.netWorth).padStart(14)}  `
    + (isInert(r, recorded) ? 'INERT — identical run' : `worth ${fmtDelta(contribution)}`));
}

console.log('\n  ranked by contribution at the margin of the full plan:');
for (const o of [...out].sort((a, b) => b.contribution - a.contribution)) {
  console.log(`    ${(o.inert ? 'INERT' : fmtDelta(o.contribution)).padStart(14)}  `
    + `${o.lever.padEnd(22)} (${rowsOf(o.lever)} row(s))`);
}

const dead = out.filter(o => o.inert);
if (dead.length) {
  console.log(`\n  ${dead.length} lever(s) are INERT in this plan: ${dead.map(o => o.lever).join(', ')}.`);
  console.log('  Their rows play and nothing reads the result. That is usually a gate upstream being');
  console.log('  the authority instead — a pool graph claiming the classes an allocation mix targets,');
  console.log('  a non-STATIC allocationSchedule overriding the committed anchor (design 81 \u00a716.1), a');
  console.log('  sleeve-narrowed claim leaving one class per draw. Check the gate before concluding');
  console.log('  the lever does not matter: it may be load-bearing in a plan without that gate.');
}
console.log('\n  These do NOT sum to the run’s total effect and must not be read as if they did:');
console.log('  levers interact, and a leave-one-out table prices each ONE at the margin of the');
console.log('  full plan. A lever worth nothing here may still be load-bearing without another.\n');
