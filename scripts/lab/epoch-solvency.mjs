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
 * epoch-solvency.mjs — did the CONTROLLER ever project ruin? (design/80 Q5)
 *
 * `attribute-ruin.mjs` showed the baked plan fails because of SPENDING, and
 * `spend-ceiling.mjs` showed no committed level is affordable open-loop — including
 * the controller's own final answer. That is only explicable three ways (design/80
 * Q5), and this script separates them by driving the REAL cockpit loop over the
 * REAL exported scenario and printing, per epoch:
 *
 *   · which band index the lever targeted, and the age span that band covers;
 *   · the amount it committed;
 *   · what its own rollout PROJECTED — terminal, cumulativeDeficit, scenarioFailed.
 *
 * The decision record already carries all of this (`_readResult` surfaces
 * `cumulativeDeficit` / `deficitMonths` / `scenarioFailed`), so no new plant is
 * needed to answer the question — only to make it visible in the UI, which is F5.
 *
 * Reading:
 *   projected deficit > 0 at any epoch  → (a) the controller KNOWINGLY committed to
 *       an insolvent plan; μ=100/deficit-dollar is not biting. A controller defect.
 *   every epoch projects 0 deficit, but the realized sequence is insolvent
 *       → (c) the receding-horizon encoding is over-committing: each epoch prices
 *       its tail at a band it is about to overwrite. Also a controller defect.
 *   every epoch projects 0 AND the realized sequence is solvent
 *       → (b) the saved scenario is not what the run was solved against.
 *
 * Usage:
 *   node scripts/lab/epoch-solvency.mjs scenarios/fin-sim-die-with.json
 *   node scripts/lab/epoch-solvency.mjs <file> --epochs 12 --budget 24 --levers SPENDING
 */

import { Graph }                    from '../../src/graph/graph.js';
import { OPTIMIZATION_OBJECTIVES, objectivePrimaryMetric }
  from '../../src/finance/optimization/optimization-objectives.js';
import { CockpitController, COCKPIT_CONTROLS } from '../../src/finance/mpc/cockpit-controller.js';
import { makeInitialSnapshot }      from '../../src/finance/mpc/mpc-controller.js';
import { readDecisionRecords }      from '../../src/finance/mpc/apply-forward.js';
import { harvestDecisions }         from '../../src/finance/mpc/harvest.js';
import { applyHarvestPlan }         from '../../src/finance/mpc/harvest-apply.js';
import { loadScenario, readParams, runCfg, withParams, fmtUsd, cloneCfg }
  from '../lib/scenario-probe.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const file   = argv.find(a => !a.startsWith('--')) ?? 'scenarios/fin-sim-die-with.json';
const levers = String(flag('levers', 'SPENDING')).split(',').map(s => s.trim().toUpperCase());
const epochsN = Number(flag('epochs', 10));
const budget  = Number(flag('budget', 24));
const seed    = Number(flag('seed', 1));
const stepYears = Number(flag('step-years', 1));

const cfg = loadScenario(file, flag('scenario', null));
const simStart = new Date(cfg.simStart);
const simEnd   = new Date(cfg.simEnd);

// ── Reconstruct the PRE-RUN scenario ────────────────────────────────────────
// The harvest preserves bands below the first epoch's age (§13.6.1), so the
// pre-run spending plan is recoverable from the harvested table: it is the
// leading run of bands that share the first band's amount. Everything above that
// is what the MPC decided, and must be removed to re-run the decision honestly.
const bands  = readParams(cfg, ['spendingExpenseBands']).spendingExpenseBands ?? [];
const preAmt = bands[0]?.monthlyAmount;
const preRunBands = bands.filter(b => b.monthlyAmount === preAmt);
if (!preRunBands.length) { console.error('cannot recover the pre-run band table'); process.exit(2); }

const preRunCfg = withParams(cfg, { spendingExpenseBands: preRunBands });

// The params BAG the controller searches over — the cfg's own params, with the
// harvested spending reverted. `_compile` folds this back onto the cfg, so the
// two-param-stores trap is handled for us.
const baseParams = Object.fromEntries(
  (preRunCfg.params ?? []).map(p => [p.key ?? p.name, p.value]));

const objective = OPTIMIZATION_OBJECTIVES[flag('goal', 'DIE_WITH_TARGET')]
  ?? OPTIMIZATION_OBJECTIVES.DIE_WITH_TARGET;
const metric = objectivePrimaryMetric(objective);

const person = (cfg.persons ?? [])[0];
const birth  = person?.birthDate ? new Date(person.birthDate) : null;
const ageAt  = d => (birth ? (d - birth) / (365.2425 * 864e5) : null);

console.log(`\n=== epoch solvency · ${file} ===`);
console.log(`  levers ${levers.join('+')} · goal ${flag('goal', 'DIE_WITH_TARGET')} (${metric.key})`
  + ` · ${epochsN} epochs · budget ${budget} · seed ${seed}`);
console.log(`  sim ${cfg.simStart.slice(0, 10)} → ${cfg.simEnd.slice(0, 10)}`
  + ` · primary ${person?.name ?? '?'} b${(person?.birthDate ?? '').slice(0, 10)}`);
console.log(`  pre-run bands: ${JSON.stringify(preRunBands)}\n`);

// Sanity: the pre-run scenario must itself be solvent, or nothing below means anything.
const line = (label, r) => console.log(`  ${label.padEnd(26)} `
  + `${(r.solvent ? '✅ solvent' : `❌ ruin ${r.outOfFundsDate}`).padEnd(20)}`
  + `   NW ${fmtUsd(r.netWorth).padStart(12)}   liquidity ${fmtUsd(r.netLiquidity).padStart(12)}`);
const pre = runCfg(preRunCfg);
line('pre-run scenario (no MPC):', pre);
const asHarvested = runCfg(cfg);
line('as-harvested scenario:', asHarvested);
console.log('');

// ── Drive the real closed loop ───────────────────────────────────────────────
const quiet = fn => {
  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  try { return fn(); } finally { console.log = log; console.warn = warn; }
};
const quietAsync = async fn => {
  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  try { return await fn(); } finally { console.log = log; console.warn = warn; }
};

const controls = levers.map(k => COCKPIT_CONTROLS[k]).filter(Boolean);
if (controls.length !== levers.length) {
  console.error(`unknown lever(s): ${levers.filter(k => !COCKPIT_CONTROLS[k]).join(', ')}`);
  process.exit(2);
}

const cfgTemplate = cloneCfg(preRunCfg);
const graph = new Graph();
const runId = 'run:epoch-solvency';

const snapshot = quiet(() => makeInitialSnapshot({
  simStart, simEnd, asOfDate: simStart, baseParams, cfgTemplate,
}));

// `--spend-range 7000:10000[:500]` — the cockpit's Monthly Spending min/max/step.
// This is load-bearing, not cosmetic: the lever cannot commit outside its range, so
// a floor set above the plan's affordable level forces every epoch to over-commit
// and there is no in-range feasible answer left for the controller to find.
const sr = flag('spend-range', null);
const controlRanges = sr
  ? { SPENDING: (([min, max, step]) => ({ min: +min, max: +max, step: +(step ?? 500) }))(sr.split(':')) }
  : null;
if (controlRanges) {
  const r = controlRanges.SPENDING;
  console.log(`  SPENDING search range: ${fmtUsd(r.min)} – ${fmtUsd(r.max)} (step ${fmtUsd(r.step)})\n`);
}

const controller = new CockpitController({
  simStart, simEnd, baseParams, cfgTemplate, objective, controls, graph, runId, parentId: null,
  controlRanges,
});
controller.setSnapshot(snapshot);

let n = 0;
await quietAsync(() => controller.autoRun({
  solverKey: flag('solver', 'CEM'),
  solverOptions: { budget, seed },
  stepYears,
  shouldStop: () => n >= epochsN,
  onEpoch: () => { n += 1; },
}));

const records = readDecisionRecords(graph, { runId });
if (!records.length) { console.error('the run produced no decisions'); process.exit(1); }

// ── Report ───────────────────────────────────────────────────────────────────
console.log('  EPOCH  date        age   band[i] covers      committed    projected terminal   proj. deficit   failed?');
console.log('  ' + '─'.repeat(104));

let anyProjectedRuin = false;
for (const [i, r] of records.entries()) {
  const d   = new Date(r.asOfDate);
  const v   = (r.controlVars ?? []).find(x => x?._bandIndex != null) ?? (r.controlVars ?? [])[0];
  const idx = v?._bandIndex;
  const amt = v ? r.controlParams?.[v.paramKey] : null;

  // What age span does the targeted band actually govern? With the pre-run table
  // this is the whole tail — which is the point of the exercise.
  const startAge = v?._startAge;
  const covers = idx != null && startAge != null
    ? `${startAge}→${preRunBands[idx + 1]?.startAge ?? '∞'}` : '—';

  const res = r.result ?? {};
  const deficit = res.cumulativeDeficit ?? 0;
  const failed  = res.scenarioFailed ?? false;
  if (deficit > 0 || failed) anyProjectedRuin = true;

  console.log(`  ${String(i + 1).padStart(5)}  ${d.toISOString().slice(0, 10)}`
    + `  ${(ageAt(d) ?? 0).toFixed(1).padStart(5)}`
    + `  [${String(idx ?? '?').padStart(2)}] ${covers.padEnd(12)}`
    + `  ${fmtUsd(amt).padStart(9)}`
    + `  ${fmtUsd(res[metric.key]).padStart(18)}`
    + `  ${fmtUsd(deficit).padStart(13)}`
    + `   ${failed ? '❌ YES' : 'no'}`);
}

// ── The realized sequence, re-keyed as the harvest would ─────────────────────
const idxSet = new Set(records.map(r =>
  (r.controlVars ?? []).find(x => x?._bandIndex != null)?._bandIndex).filter(x => x != null));

console.log('');
console.log(`  distinct band indices targeted across ${records.length} epochs: `
  + `{${[...idxSet].join(', ')}}`);

// ── Close the loop: harvest this run and re-run the baked scenario ───────────
// This is design/80 F1 (the pre-apply feasibility gate) in probe form, on the real
// scenario rather than a synthetic params bag. If the epochs all project solvent
// and the bake does not, the gap is the harvest's; if the bake is solvent too, the
// saved scenario was never what this run produced.
if (!argv.includes('--no-harvest')) {
  const plan = harvestDecisions(records, {
    controlsByKey: COCKPIT_CONTROLS, baseParams,
    birth: { birthDate: person?.birthDate }, simStart,
  });
  const baked = { params: (preRunCfg.params ?? []).map(p => ({ ...p })) };
  applyHarvestPlan(baked, plan);
  const bakedCfg = { ...cloneCfg(preRunCfg), params: baked.params };
  const bakedRun = runCfg(bakedCfg);

  console.log('');
  console.log('  HARVEST OF THIS RUN');
  for (const e of plan.entries) console.log(`    · [${e.form}] ${e.paramKey} → ${e.label ?? e.to}`);
  for (const w of plan.warnings) console.log(`    ⚠ ${w}`);
  console.log('');
  console.log(`    baked scenario re-run from t₀: `
    + `${bakedRun.solvent ? '✅ solvent' : `❌ ruin ${bakedRun.outOfFundsDate}`
       + ` (${bakedRun.deficitMonths}mo, ${fmtUsd(bakedRun.cumulativeDeficit)})`}`);
  console.log(`    A (last epoch projected) ${fmtUsd(records.at(-1)?.result?.[metric.key])}`
    + `   vs   B (baked, re-run) ${fmtUsd(bakedRun[metric.key] ?? bakedRun.netWorth)}`);
}

console.log('');
// (a) and (c) are NOT mutually exclusive — the motivating run exhibits both, and an
// else-if would have hidden (c) behind (a). Report each independently.
console.log('  VERDICT');
if (anyProjectedRuin) {
  console.log('    (a) The controller PROJECTED ruin at ≥1 epoch and committed anyway.');
  console.log('        μ = DEFAULT_DEFICIT_PENALTY is not biting. This is a design/39 CONTROLLER');
  console.log('        defect, not a harvest defect — design/80 P2/P3 would fix the wrong layer.');
}
if (idxSet.size === 1) {
  console.log('    (c) Every epoch projected SOLVENT, and every epoch targeted the SAME band index.');
  console.log('        Each decision therefore meant "spend this for the whole remaining life", and');
  console.log('        each rollout priced its tail at the value it was about to overwrite. The');
  console.log('        harvest then re-keys that sequence of lifetime-flat answers into a step');
  console.log('        SCHEDULE, which is not the plan any epoch ever evaluated.');
  console.log('        → a receding-horizon ENCODING defect in the SPENDING lever (design/39 §13.6.1),');
  console.log('          upstream of the harvest.');
}
if (!anyProjectedRuin && idxSet.size > 1) {
  console.log('    Every epoch projected solvent and the lever moved across several bands.');
  console.log('    → (b) is the remaining candidate: the saved scenario is not what the run solved');
  console.log('      against. Compare the per-epoch param sets (design/80 P1-1b) to confirm.');
}
console.log('');
