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
 * Shared machinery for the harvest lab scripts (design/39 §13.7 / §13.13.3).
 *
 * Drives a real closed-loop cockpit run headlessly, harvests it back into params,
 * and re-runs the baked scenario from t₀ so the three terminals can be compared:
 *
 *   A = the MPC's committed closed-loop plan   (what the cockpit showed)
 *   B = the baked SCHEDULE, re-run from t₀     (what a saved scenario does)
 *   C = the best STATIC value (RESOLVE)        (what one number can do)
 *
 *   VoTV = B − C   what time-variation is worth
 *   VoFB = A − B   what feedback is worth — and what harvesting destroys
 *
 * Everything here is deterministic at a fixed seed; the honest caveat (§13.7) is
 * that a schedule fitted on one path is open-loop, so a second seed is the real
 * out-of-sample test — hence `--seeds`.
 */

import { Graph }                    from '../../src/graph/graph.js';
import { OptimizationProblem }      from '../../src/finance/optimization/optimization-problem.js';
import { OPTIMIZATION_OBJECTIVES, objectivePrimaryMetric }
  from '../../src/finance/optimization/optimization-objectives.js';
import { CockpitController, COCKPIT_CONTROLS } from '../../src/finance/mpc/cockpit-controller.js';
import { makeInitialSnapshot }      from '../../src/finance/mpc/mpc-controller.js';
import { readDecisionRecords }      from '../../src/finance/mpc/apply-forward.js';
import { harvestDecisions }         from '../../src/finance/mpc/harvest.js';
import { applyHarvestPlan }         from '../../src/finance/mpc/harvest-apply.js';
import { resolveStaticLevers, foldScheduleBakes, mergeResolved }
  from '../../src/finance/mpc/harvest-resolve.js';

/** Run `fn` with the sim's per-run console chatter silenced. */
export function quiet(fn) {
  const l = console.log, w = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { return fn(); } finally { console.log = l; console.warn = w; }
}
export async function quietAsync(fn) {
  const l = console.log, w = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { return await fn(); } finally { console.log = l; console.warn = w; }
}

export const fmtUsd = n => (Number.isFinite(n) ? '$' + Math.round(n).toLocaleString() : '—');
export const fmtPct = n => (Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${(n * 100).toFixed(2)}%` : '—');

/** A params BAG → the typed `params` array shape `applyHarvestPlan` writes into. */
export function paramsToArray(bag) {
  return Object.entries(bag ?? {}).map(([name, value]) => ({ name, value }));
}
export function paramsToBag(arr) {
  return Object.fromEntries((arr ?? []).map(p => [p.key ?? p.name, p.value]));
}

/** Terminal metrics for one params bag, compiled and run from t₀ (open-loop). */
export function runFromT0({ baseParams, objective, simStart, simEnd, cfgTemplate = null }) {
  const problem = new OptimizationProblem({
    variables: [], baseParams, objective, simStart, simEnd,
    initialState: { kind: 'compile', cfgTemplate },
  });
  return quiet(() => problem.evaluate({}));
}

/**
 * Drive a headless closed-loop run and return its decision log + committed plan.
 *
 * This is the projection-only `autoRun` (no live sim), which is exactly what the
 * cockpit's Auto mode does to the isolated rollouts — so the decision records it
 * writes are the same shape the UI harvest reads.
 */
export async function runCockpit({
  levers, baseParams, objective, simStart, simEnd, asOf,
  solverKey = 'CEM', budget = 32, seed = 1, epochs = null, stepYears = 1,
  runId = 'run:lab',
}) {
  const graph    = new Graph();
  const controls = levers.map(k => COCKPIT_CONTROLS[k]).filter(Boolean);
  if (controls.length !== levers.length) {
    throw new Error(`unknown lever(s): ${levers.filter(k => !COCKPIT_CONTROLS[k]).join(', ')}`);
  }

  const snapshot = quiet(() => makeInitialSnapshot({ simStart, simEnd, asOfDate: asOf, baseParams }));
  const controller = new CockpitController({
    simStart, simEnd, baseParams, objective, controls, graph, runId, parentId: null,
  });
  controller.setSnapshot(snapshot);

  let n = 0;
  const log = await quietAsync(() => controller.autoRun({
    solverKey, solverOptions: { budget, seed }, stepYears,
    shouldStop: () => (epochs != null && n >= epochs),
    onEpoch: () => { n += 1; },
  }));

  return { graph, controller, log, records: readDecisionRecords(graph, { runId }) };
}

/**
 * The full A/B/C comparison for one lever set (§13.7 verify + §13.13.3 VoTV).
 *
 * @param {object}  opts
 * @param {boolean} [opts.resolve=false] - also compute C (costs one full-horizon solve).
 */
export async function harvestLab({
  levers, baseParams, objective, simStart, simEnd, asOf, birthDate,
  solverKey = 'CEM', budget = 32, seed = 1, epochs = null, resolve = false,
}) {
  const metric = objectivePrimaryMetric(objective);

  // Baseline: the scenario as it stood before the run.
  const before = runFromT0({ baseParams, objective, simStart, simEnd });

  const { records, controller, log } = await runCockpit({
    levers, baseParams, objective, simStart, simEnd, asOf, solverKey, budget, seed, epochs,
  });
  if (!records.length) throw new Error('the cockpit run produced no decisions — nothing to harvest');

  // A — the MPC's committed closed-loop terminal (the last epoch's projection).
  const a = records[records.length - 1]?.result?.[metric.key] ?? null;

  // Harvest → apply onto a scenario-shaped params array → read back the bag.
  let plan = harvestDecisions(records, {
    controlsByKey: COCKPIT_CONTROLS, baseParams, birth: { birthDate }, simStart,
  });

  // C — the best STATIC value for the whole run, given the schedule bakes.
  let resolved = null;
  if (resolve) {
    resolved = await quietAsync(() => resolveStaticLevers({
      plan, controlsByKey: COCKPIT_CONTROLS,
      baseParams: foldScheduleBakes(baseParams, plan),
      objective, simStart, simEnd,
      solverKey, solverOptions: { budget, seed },
    }));
  }

  const bakedScenario = { params: paramsToArray(baseParams) };
  applyHarvestPlan(bakedScenario, plan);
  const bakedParams = paramsToBag(bakedScenario.params);
  const b = runFromT0({ baseParams: bakedParams, objective, simStart, simEnd })
    .result?.[metric.key] ?? null;

  let c = null;
  if (resolved) {
    const staticScenario = { params: paramsToArray(baseParams) };
    applyHarvestPlan(staticScenario, mergeResolved(plan, resolved));
    c = runFromT0({ baseParams: paramsToBag(staticScenario.params), objective, simStart, simEnd })
      .result?.[metric.key] ?? null;
  }

  return {
    metric, plan, resolved, records, log,
    committedParams: controller.committed,
    bakedParams,
    terminals: { before: before.result?.[metric.key] ?? null, a, b, c },
    voTV: (Number.isFinite(b) && Number.isFinite(c)) ? b - c : null,
    voFB: (Number.isFinite(a) && Number.isFinite(b)) ? a - b : null,
  };
}

/** Print the shared A/B/C report. */
export function report({ title, out }) {
  const { metric, terminals: t, plan } = out;
  const rel = (x, base) => (Number.isFinite(x) && Number.isFinite(base) && base !== 0 ? (x - base) / Math.abs(base) : null);

  console.log(`\n=== ${title} ===`);
  console.log(`  goal metric: ${metric.label} (${metric.key})`);
  console.log(`  run: ${plan.epochs} epoch(s) · ${String(plan.epochRange[0]).slice(0, 10)} → ${String(plan.epochRange[1]).slice(0, 10)}`
    + ` · levers: ${plan.levers.join(', ')}`);
  console.log('');
  console.log(`  before harvest (baseline)      : ${fmtUsd(t.before)}`);
  console.log(`  A · MPC committed (closed-loop): ${fmtUsd(t.a)}`);
  console.log(`  B · baked schedule, re-run t₀  : ${fmtUsd(t.b)}   drift vs A ${fmtPct(rel(t.b, t.a))}`);
  if (t.c != null) {
    console.log(`  C · best static (RESOLVE)      : ${fmtUsd(t.c)}   drift vs A ${fmtPct(rel(t.c, t.a))}`);
    console.log('');
    console.log(`  VoTV = B − C  (value of time-variation): ${fmtUsd(out.voTV)}  ${fmtPct(rel(t.b, t.c))}`);
    console.log(`  VoFB = A − B  (value of feedback)      : ${fmtUsd(out.voFB)}  ${fmtPct(rel(t.a, t.b))}`);
    console.log('');
    // A zero VoTV means "time-variation is worthless" only if the lever moved the
    // outcome AT ALL. When the run never diverges from the baseline the lever is
    // INERT in this scenario (the known scenario-shaped trap) and every number
    // below is a tautology — say so instead of recommending a scalar.
    if (Number.isFinite(t.before) && Number.isFinite(t.a) && Math.abs(t.a - t.before) < 1) {
      console.log('  ⚠ INCONCLUSIVE — the run never moved the terminal off the baseline, so this lever is');
      console.log('    INERT in this scenario. VoTV/VoFB of 0 here says nothing about time-variation.');
      console.log('    Pick params/dates that force the lever to bite (cf. scripts/lab/verify-mpc-lever.mjs).');
      console.log('');
      dumpPlan(plan);
      return;
    }
    console.log('  Reading (§13.13.3):');
    console.log('    VoTV ≈ 0             → the lever wants to be a SCALAR; ship RESOLVE, skip the schedule.');
    console.log('    VoTV large           → build the schedule form; this number justifies the work.');
    console.log('    VoTV ≈ 0, VoFB large → the variation is STATE-driven, not calendar-driven: a rung-3');
    console.log('                           state-conditioned rule is the right upgrade, not more knots.');
  }
  dumpPlan(plan);
}

/** The harvested entries + their warnings — printed on every path, including the
 *  inconclusive one (the plan is the evidence either way). */
function dumpPlan(plan) {
  for (const e of plan.entries) {
    console.log(`    · [${e.form}] ${e.paramKey} → ${e.label ?? e.to}`);
  }
  for (const w of plan.warnings) console.log(`    ⚠ ${w}`);
  console.log('');
}

export const OBJECTIVES = OPTIMIZATION_OBJECTIVES;
