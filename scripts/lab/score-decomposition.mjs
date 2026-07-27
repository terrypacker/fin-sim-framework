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
 * score-decomposition.mjs — WHY did the controller commit an infeasible plan?
 * (design/80 §2.7 / U1)
 *
 * `epoch-solvency.mjs` showed the controller committing candidates its own rollout
 * flagged `scenarioFailed`. Two very different causes look identical from outside:
 *
 *   OBJECTIVE  — a feasible candidate existed in range and scored WORSE. Then
 *                `running − λ·|terminal−target| − μ·deficit` is mis-weighted and the
 *                fix belongs in the objective (design/80 U1).
 *   SEARCH     — no feasible candidate was ever evaluated. Then the objective is
 *                fine and the fix is a feasibility-first candidate filter plus an
 *                honest "no feasible move" state (design/80 U2).
 *
 * This drives the real loop to a chosen epoch, then sweeps the SPENDING variable
 * across its range at that snapshot and prints the score DECOMPOSED into its three
 * terms, so the two causes separate on sight.
 *
 * Usage:
 *   node scripts/lab/score-decomposition.mjs scenarios/fin-sim-die-with.json \
 *     --epochs 24 --goal DIE_WITH_TARGET_LIQUID --spend-range 7000:10000
 */

import { Graph }                    from '../../src/graph/graph.js';
import { OptimizationProblem }      from '../../src/finance/optimization/optimization-problem.js';
import { OPTIMIZATION_OBJECTIVES, objectivePrimaryMetric,
         DEFAULT_TERMINAL_WEALTH_PENALTY, DEFAULT_DEFICIT_PENALTY }
  from '../../src/finance/optimization/optimization-objectives.js';
import { CockpitController, COCKPIT_CONTROLS } from '../../src/finance/mpc/cockpit-controller.js';
import { makeInitialSnapshot }      from '../../src/finance/mpc/mpc-controller.js';
import { loadScenario, readParams, withParams, cloneCfg, fmtUsd } from '../lib/scenario-probe.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const file    = argv.find(a => !a.startsWith('--')) ?? 'scenarios/fin-sim-die-with.json';
const epochsN = Number(flag('epochs', 24));
const budget  = Number(flag('budget', 20));
const seed    = Number(flag('seed', 1));
const levers  = String(flag('levers',
  'SPENDING,ROTH,ALLOCATION_MIX,DRAWDOWN_WEIGHTS,DRAWDOWN_SLEEVE,DRAWDOWN_XBORDER,DRAWDOWN_WITHINTIER,BOND_LADDER'))
  .split(',').map(s => s.trim().toUpperCase());
const [rMin, rMax, rStep] = String(flag('spend-range', '7000:10000')).split(':').map(Number);

const cfg      = loadScenario(file, flag('scenario', null));
const simStart = new Date(cfg.simStart);
const simEnd   = new Date(cfg.simEnd);

const bands  = readParams(cfg, ['spendingExpenseBands']).spendingExpenseBands ?? [];
const preRunBands = bands.filter(b => b.monthlyAmount === bands[0]?.monthlyAmount);
const preRunCfg   = withParams(cfg, { spendingExpenseBands: preRunBands });
const baseParams  = Object.fromEntries((preRunCfg.params ?? []).map(p => [p.key ?? p.name, p.value]));

const objKey    = flag('goal', 'DIE_WITH_TARGET_LIQUID');
const objective = OPTIMIZATION_OBJECTIVES[objKey];
if (!objective) { console.error(`unknown goal ${objKey}`); process.exit(2); }
const metric = objectivePrimaryMetric(objective);

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

console.log(`\n=== score decomposition at epoch ${epochsN} · ${file} ===`);
console.log(`  goal ${objKey} (${metric.key}) · levers ${levers.join('+')} · budget ${budget} · seed ${seed}`);
console.log(`  driving the real loop to epoch ${epochsN}…`);

const cfgTemplate = cloneCfg(preRunCfg);
const controls = levers.map(k => COCKPIT_CONTROLS[k]).filter(Boolean);
const snapshot0 = quiet(() => makeInitialSnapshot({
  simStart, simEnd, asOfDate: simStart, baseParams, cfgTemplate }));
const controller = new CockpitController({
  simStart, simEnd, baseParams, cfgTemplate, objective, controls,
  graph: new Graph(), runId: 'run:score-decomp', parentId: null,
  controlRanges: { SPENDING: { min: rMin, max: rMax, step: rStep || 500 } },
});
controller.setSnapshot(snapshot0);

let n = 0;
await quietAsync(() => controller.autoRun({
  solverKey: flag('solver', 'CEM'), solverOptions: { budget, seed }, stepYears: 1,
  shouldStop: () => n >= epochsN, onEpoch: () => { n += 1; },
}));

const snap = controller.snapshot;
console.log(`  snapshot now at ${new Date(snap.date).toISOString().slice(0, 10)}`);
console.log(`  snapshot cumulativeDeficit ${fmtUsd(snap.state?.cumulativeDeficit ?? 0)}`
  + ` · cumulativeConsumption ${fmtUsd(snap.state?.cumulativeConsumption ?? 0)}\n`);

// The SPENDING lever's own variable at this snapshot — the same key the controller
// searched, so the sweep is over exactly the decision it made.
const spendVar = COCKPIT_CONTROLS.SPENDING.buildVariables({
  baseParams: controller.committed, range: { min: rMin, max: rMax, step: rStep || 500 },
  asOf: new Date(snap.date), state: snap.state,
})[0];

const problem = new OptimizationProblem({
  variables: [], baseParams: controller.committed, objective, simStart, simEnd,
  initialState: { kind: 'snapshot', snapshot: snap, cfgTemplate },
});

const target = controller.committed.terminalWealthTarget ?? 0;
const lambda = controller.committed.terminalWealthTargetPenalty ?? DEFAULT_TERMINAL_WEALTH_PENALTY;
const mu     = controller.committed.deficitPenalty ?? DEFAULT_DEFICIT_PENALTY;
console.log(`  target ${fmtUsd(target)} · λ ${lambda} · μ ${mu}\n`);

console.log('   spend/mo     reward(Δcons)      λ·|term−tgt|        μ·deficit           SCORE   terminal   deficit  failed');
console.log('  ' + '─'.repeat(112));

const rows = [];
for (let x = rMin; x <= rMax; x += (rStep || 500)) {
  const { result, score } = quiet(() => problem.evaluate({ [spendVar.paramKey]: x }));
  const reward  = (result.lifetimeConsumption ?? 0) - (snap.state?.cumulativeConsumption ?? 0);
  const deficit = Math.max(0, (result.cumulativeDeficit ?? 0) - (snap.state?.cumulativeDeficit ?? 0));
  const priceLevel = result.terminalPriceLevel || 1;
  const realTerminal = (result[metric.key] ?? 0) / priceLevel;
  const lamTerm = lambda * Math.abs(realTerminal - target);
  const muTerm  = mu * deficit;
  rows.push({ x, score, reward, lamTerm, muTerm, deficit,
    terminal: result[metric.key] ?? 0, failed: result.scenarioFailed ?? false });
  console.log(`  ${fmtUsd(x).padStart(9)}  ${fmtUsd(reward).padStart(16)}`
    + `  ${fmtUsd(-lamTerm).padStart(16)}  ${fmtUsd(-muTerm).padStart(16)}`
    + `  ${fmtUsd(score).padStart(14)}  ${fmtUsd(rows.at(-1).terminal).padStart(9)}`
    + `  ${fmtUsd(deficit).padStart(8)}  ${rows.at(-1).failed ? '❌' : '  '}`);
}

const best     = rows.reduce((a, b) => (b.score > a.score ? b : a));
const feasible = rows.filter(r => !r.failed && r.deficit === 0);
const bestFeas = feasible.length ? feasible.reduce((a, b) => (b.score > a.score ? b : a)) : null;

console.log('');
console.log(`  argmax over the range: ${fmtUsd(best.x)}/mo  → score ${fmtUsd(best.score)}`
  + `  ${best.failed ? '❌ INFEASIBLE' : '✅ feasible'}`);
console.log(`  feasible candidates in range: ${feasible.length}/${rows.length}`
  + (bestFeas ? `  · best feasible ${fmtUsd(bestFeas.x)}/mo → score ${fmtUsd(bestFeas.score)}` : ''));

console.log('');
console.log('  VERDICT');
if (!feasible.length) {
  console.log('    SEARCH/RANGE — no value in the lever\'s range is feasible at this snapshot.');
  console.log('    The objective is not at fault: there was nothing better to pick. The controller');
  console.log('    should SAY SO rather than silently commit the least-bad option (design/80 U2),');
  console.log('    and the range floor is implicated (design/80 §2.5).');
} else if (best.failed) {
  console.log('    OBJECTIVE — a FEASIBLE candidate existed and the objective ranked an INFEASIBLE');
  console.log(`    one above it (${fmtUsd(best.x)} infeasible beats ${fmtUsd(bestFeas.x)} feasible by`
    + ` ${fmtUsd(best.score - bestFeas.score)}).`);
  console.log('    → design/80 U1 is real: the three terms are mis-weighted. Compare the columns');
  console.log('      above to see which one paid for the infeasibility.');
} else {
  console.log('    Neither — the argmax over the full range IS feasible, so a complete search would');
  console.log('    have found it. The controller committed an infeasible point anyway, which points');
  console.log('    at the SOLVER budget/coverage, not the objective. → design/80 U2, and raise budget.');
}
console.log('');
