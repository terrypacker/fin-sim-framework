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
 * run-replay.mjs — the A / A′ / B table (design 81 §10; generalises `replay-vs-bake.mjs`).
 *
 *   A   what the last epoch PROJECTED            — straight off the decision record
 *   A′  the run's realized closed-loop path      — `replayDecisions`, solver deleted
 *   B   the recorded run played from t₀          — this design's whole point
 *   —   the base plan with the run switched off  — the control
 *
 * ─── what this measures NOW, which is not what `replay-vs-bake.mjs` measured ─────
 *
 * That tool existed because a harvest could break a solvent run and there was no way to tell
 * a bad run from a bad bake. Under design 81 there is no bake: B plays the decisions
 * themselves, so **B ≡ A′ is a regression test rather than a finding**, and a gap between
 * them is a defect in one of the two mechanisms rather than a property of the plan.
 *
 * The two are not, however, the same code. A′ applies each epoch's `controlParams` through
 * `set()` onto an INDEXED param path (`spendingExpenseBands[3].monthlyAmount`) and rolls
 * snapshot to snapshot; B stamps state through each lever's `applyAt` as the clock reaches
 * each row. That is exactly the difference design 81 exists to make — so when they disagree,
 * the suspect is the index-keyed replay, which is the mechanism this design replaced.
 *
 * A vs A′ is unchanged and still worth printing: it is the gap between what the controller
 * predicted each epoch and what its own decisions actually produced, which is not zero,
 * because every epoch prices its tail at values later epochs overwrite (Q6).
 *
 * Usage:
 *   node scripts/lab/run-replay.mjs --scenario scenarios/plan.json [--run <id>] \
 *     [--decisions scenarios/fin-sim-decisions.json]
 */

import { readFileSync } from 'node:fs';

import { replayDecisions } from '../../src/finance/mpc/replay.js';
import { parseFlags }      from '../lib/cli.mjs';
import { loadScenario, cloneCfg, fmtUsd } from '../lib/scenario-probe.mjs';
import { pickRun, withActiveRun, withoutRun, runArm, reportRow, fmtDelta, printRunHeader }
  from '../lib/run-lab.mjs';

const opts = parseFlags(process.argv.slice(2), {
  usage: 'node scripts/lab/run-replay.mjs --scenario <f> [--run <id>] [--decisions <f>]\n\n'
       + 'run-replay — A (projected) / A′ (replayed) / B (played) for a recorded run.',
  scenario:     { type: 'string', default: 'scenarios/fin-sim-die-with.json', help: 'scenario carrying the run' },
  scenarioName: { type: 'string', help: 'scenario NAME inside that file (default: the first)' },
  run:          { type: 'string', help: 'runId (default: the scenario\'s selection)' },
  decisions:    { type: 'string', help: 'decision-record export, for the A and A′ terms' },
  tolerance:    { type: 'string', default: '0.005', help: 'B≡A′ tolerance, as a fraction of A′' },
});

const cfg = loadScenario(opts.scenario, opts.scenarioName);
const run = pickRun(cfg, opts.run);
printRunHeader(opts.scenario, cfg, run);

// ── B and the control ─────────────────────────────────────────────────────────────
const base   = runArm(withoutRun(cfg));
const played = runArm(withActiveRun(cfg, run.runId));

// `source.baseScenarioId` finally earns its keep (design 81 Q5's residue). A′ replays the log
// by writing INDEXED param paths, so replaying it against a DIFFERENT scenario lands those
// writes on different rows of a different table — which is the index trap §4.4 describes, and
// makes a B−A′ gap a property of the setup rather than of either mechanism.
const recordedAgainst = run.entry?.source?.baseScenarioId ?? null;
const here = cfg.id ?? cfg.name ?? null;
if (opts.decisions && recordedAgainst && here && recordedAgainst !== here) {
  console.log(`  ! this run was recorded against "${recordedAgainst}", not "${here}". A\u2032 replays the`);
  console.log('    log by INDEX, so it will address different rows of this scenario\u2019s tables — expect');
  console.log('    a B\u2212A\u2032 gap, and read it as the index trap rather than as a defect in either arm.\n');
}

console.log('  term  what it is');
reportRow('—     base plan, run OFF', base);
reportRow('B     the run, played from t₀', played, base);

// ── A and A′, when the log is to hand ─────────────────────────────────────────────
if (!opts.decisions) {
  console.log('\n  (no --decisions: A and A′ need the decision-record export the run was made from)\n');
  process.exit(0);
}

const doc = JSON.parse(readFileSync(opts.decisions, 'utf8'));
const all = Array.isArray(doc.records) ? doc.records : Object.values(doc.records ?? doc);
const logRunId = run.entry?.source?.runId ?? all[all.length - 1]?.runId ?? null;
const records = all
  .filter(r => logRunId == null || r.runId === logRunId)
  .sort((a, b) => String(a.asOfDate).localeCompare(String(b.asOfDate)));
if (!records.length) {
  console.error(`\nNo records for run ${logRunId} in ${opts.decisions}\n`);
  process.exit(2);
}

// A is recorded, not computed: the last epoch's own projection of the terminal.
const last = records[records.length - 1];
const projected = last?.result?.finalNetWorthUsd ?? null;

// The params the run STARTED from — the run must not be playing while A′ replays it, or A′
// measures the run applied twice by two different mechanisms.
const preRun = withoutRun(cfg);
const baseParams = Object.fromEntries((preRun.params ?? []).map(p => [p.key ?? p.name, p.value]));

let replayed = null;
try {
  const out = replayDecisions(records, {
    baseParams,
    simStart:    new Date(cfg.simStart),
    simEnd:      new Date(cfg.simEnd),
    cfgTemplate: cloneCfg(preRun),
  });
  replayed = out.result;
} catch (e) {
  console.log(`\n  A′ could not be replayed: ${e.message}`);
}

console.log('');
if (projected != null) console.log(`  A     last epoch projected            NW ${fmtUsd(projected).padStart(14)}`);
if (replayed) reportRow('A′    replayed closed-loop path', {
  solvent: !(replayed.scenarioFailed ?? false),
  outOfFundsDate: replayed.outOfFundsDate ? String(replayed.outOfFundsDate).slice(0, 10) : null,
  deficitMonths: replayed.deficitMonths ?? 0,
  netWorth: replayed.finalNetWorthUsd ?? null,
}, base);

// ── the regression claim ──────────────────────────────────────────────────────────
if (replayed) {
  const a = replayed.finalNetWorthUsd ?? 0;
  const b = played.netWorth ?? 0;
  const rel = a !== 0 ? Math.abs(b - a) / Math.abs(a) : (b === 0 ? 0 : Infinity);
  const tol = Number(opts.tolerance);
  console.log(`\n  B − A′ = ${fmtDelta(b - a)}  (${(rel * 100).toFixed(2)}% of A′, tolerance ${(tol * 100).toFixed(2)}%)`);
  console.log(rel <= tol
    ? '  ✅ B ≡ A′ — playing the recorded run reproduces its realized path.'
    : '  ❌ B ≢ A′ — the two mechanisms disagree. A′ writes INDEXED param paths and B stamps\n'
      + '     state through each lever’s applyAt, so the suspect is the index-keyed replay that\n'
      + '     design 81 replaced — check whether the band table moved under it.');
}
if (projected != null && replayed) {
  console.log(`  A′ − A  = ${fmtDelta((replayed.finalNetWorthUsd ?? 0) - projected)}`
    + '  — what the controller predicted vs what its own decisions produced (design 81 Q6).');
}
console.log('');
