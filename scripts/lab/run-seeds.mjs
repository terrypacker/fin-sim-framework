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
 * run-seeds.mjs — is the recorded plan robust, or was it lucky? (design 81 §10)
 *
 * §15's first honest limit, made measurable: *"a schedule is one path"*. Playing a recorded run
 * reproduces one deterministic trajectory and says nothing about robustness until it is run
 * against other draws. `randomSeed` is the single in-loop sequence every stochastic process
 * draws from (FX, the yield curve, equity return paths), so varying it draws a DIFFERENT path
 * from the same distribution — the design-74 way to vary one deterministic run without a
 * Monte Carlo.
 *
 * ─── the arm AND the control, on every seed ──────────────────────────────────────
 *
 * Each seed runs twice: the base plan and the recorded run. The pairing is the point. A run
 * that is solvent on four seeds out of five is only interesting against how the base plan did
 * on those same five — and the seed changes the world, not the plan, so an unpaired table
 * measures the weather.
 *
 * ─── it is still not a Monte Carlo ───────────────────────────────────────────────
 *
 * A handful of seeds is a smoke test for path-dependence, not a distribution. When the answer
 * matters, promote the plan to an MC study — which under design 81 is a `mpcActiveRun`
 * selection and nothing else (§9).
 *
 * Usage:
 *   node scripts/lab/run-seeds.mjs --scenario plan.json --seeds 1,2,3,4,5
 */

import { parseFlags }   from '../lib/cli.mjs';
import { loadScenario, fmtUsd } from '../lib/scenario-probe.mjs';
import { pickRun, withActiveRun, withoutRun, runArm, fmtDelta, printRunHeader } from '../lib/run-lab.mjs';

const opts = parseFlags(process.argv.slice(2), {
  usage: 'node scripts/lab/run-seeds.mjs --scenario <f> [--run <id>] --seeds 1,2,3\n\n'
       + 'run-seeds — the recorded plan and its base across design-74 RNG seeds.',
  scenario:     { type: 'string', default: 'scenarios/fin-sim-die-with.json', help: 'scenario carrying the run' },
  scenarioName: { type: 'string', help: 'scenario NAME inside that file (default: the first)' },
  run:          { type: 'string', help: 'runId (default: the scenario\'s selection)' },
  seeds:        { type: 'list',   default: ['1', '2', '3', '4', '5'], help: 'randomSeed values' },
});

const cfg = loadScenario(opts.scenario, opts.scenarioName);
const run = pickRun(cfg, opts.run);
printRunHeader(opts.scenario, cfg, run);

/** Set `randomSeed` on a cfg copy the two arms already produced. */
const seeded = (variant, seed) => {
  const p = (variant.params ?? []).find(pp => (pp.key ?? pp.name) === 'randomSeed');
  if (p) p.value = seed;
  else variant.params.push({ name: 'randomSeed', label: 'randomSeed', type: 'Number', value: seed });
  return variant;
};

console.log('  seed        base plan                       the run                          Δ');
const rows = [];
for (const raw of opts.seeds) {
  const seed = Number(raw);
  const b = runArm(seeded(withoutRun(cfg), seed));
  const r = runArm(seeded(withActiveRun(cfg, run.runId), seed));
  rows.push({ seed, b, r });
  const verdict = (x) => (x.solvent ? '✅' : `❌ ${x.outOfFundsDate}`);
  console.log(`  ${String(seed).padStart(4)}   ${verdict(b).padEnd(14)} ${fmtUsd(b.netWorth).padStart(14)}`
    + `   ${verdict(r).padEnd(14)} ${fmtUsd(r.netWorth).padStart(14)}`
    + `   ${fmtDelta((r.netWorth ?? 0) - (b.netWorth ?? 0))}`);
}

const ruinRun  = rows.filter(x => !x.r.solvent).length;
const ruinBase = rows.filter(x => !x.b.solvent).length;
const wins     = rows.filter(x => (x.r.netWorth ?? 0) > (x.b.netWorth ?? 0)).length;

console.log(`\n  run insolvent on ${ruinRun}/${rows.length} seed(s); base insolvent on ${ruinBase}/${rows.length}.`);
console.log(`  the run beat its base on ${wins}/${rows.length} seed(s) by terminal net worth.`);
console.log('\n  A handful of seeds is a smoke test for path-dependence, not a distribution. When the');
console.log('  answer matters, promote the plan to a Monte Carlo study — which is a selection and');
console.log('  nothing else (design 81 §9).\n');
