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
 * verify-mpc-lever.mjs
 *
 * Headless verification harness for the design-58 MPC / online-control levers.
 *
 * The MPC gap (design 58 §11.1): the receding-horizon rollout seeds from a
 * now-snapshot via `_injectSnapshot`, which OVERWRITES any compile-time state
 * field (crossBorderDrawdown, withinTierDraw, the Lever-B drawdownPriority the
 * cascade bakes in) with its OLD value. So a committed control is INERT under MPC
 * unless a forward-effective shim re-applies it after injection.
 *
 * This harness makes that concrete WITHOUT driving the browser cockpit. For a
 * given control param + two values it runs the SAME candidate two ways:
 *
 *   • COMPILE path (kind:'compile') — the one-shot optimizer's path. No injection,
 *     so the control should ALWAYS bite here (control wired end-to-end at t0).
 *   • SNAPSHOT path (kind:'snapshot') — the MPC path. The control bites ONLY if the
 *     `_seededSim` shim re-stamps it after injection.
 *
 * Interpretation:
 *   compile DIFFERS + snapshot IDENTICAL  → the §11.1 gap (shim missing/needed).
 *   compile DIFFERS + snapshot DIFFERS    → the online shim works — the lever bites
 *                                           under MPC. (The success criterion.)
 *   compile IDENTICAL                     → the chosen scenario doesn't exercise the
 *                                           lever; pick params that force the draw.
 *
 * Usage:
 *   node scripts/verify-mpc-lever.mjs                    # all three levers
 *   node scripts/verify-mpc-lever.mjs crossBorderDrawdown   # Lever A only
 *   node scripts/verify-mpc-lever.mjs withinTierDraw        # Lever C only
 *   node scripts/verify-mpc-lever.mjs drawdownWeights      # Lever B only
 */

import { OptimizationProblem }     from '../src/finance/optimization/optimization-problem.js';
import { OPT_PARAM_TYPES, OPTIMIZATION_OBJECTIVES } from '../src/finance/optimization/optimization-objectives.js';
import { makeInitialSnapshot }     from '../src/finance/mpc/mpc-controller.js';
import { drawdownWeightKey, allocWeightKey, ALLOCATION_OPTIMIZED_MODE }
  from '../src/scenarios/intl-retirement-scenario.js';
import { sleeveWeightKey } from '../src/finance/holdings/holdings-selection.js';

const SIM_START = new Date(Date.UTC(2026, 0, 1));
const SIM_END   = new Date(Date.UTC(2050, 0, 1));
// "Now" is just after retirement (2040) and post-move (2031), so the forward
// rollout window [now, simEnd] funds spending by draining investments across the
// US↔AU border — the regime where the cross-border / within-tier / weight levers
// actually change the outcome. Earlier than this and wages cover spending (no
// drawdown); much later and the portfolio is already exhausted to an
// order-invariant illiquid floor.
const NOW       = new Date(Date.UTC(2041, 0, 1));

// Moderate spend (leaves an order-sensitive residual rather than exhausting the
// portfolio) + CUSTOM authored per-account priorities, so the drawdown *order*
// controls which accounts are preserved into the bequest. The control param under
// test is supplied per-run as the candidate; BASE only seeds the realized past.
const BASE = {
  monthlyExpenses:  12_000,
  drawdownStrategy: 'CUSTOM',
};

const OBJECTIVE = OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH;

/** Run `fn` with the sim's per-run console chatter silenced. */
function quiet(fn) {
  const l = console.log, w = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { return fn(); } finally { console.log = l; console.warn = w; }
}

/** Terminal net worth for one candidate under one initial-state kind. */
function evalCandidate(initialState, candidate) {
  const problem = new OptimizationProblem({
    variables: [], baseParams: BASE, objective: OBJECTIVE,
    simStart: SIM_START, simEnd: SIM_END, initialState,
  });
  return problem.evaluate(candidate).result?.finalNetWorthUsd ?? 0;
}

/**
 * Verify one lever by comparing two candidates (each a paramKey→value map) under
 * both initial-state kinds. `base` overrides let a lever supply the params it needs
 * (e.g. Lever B needs drawdownStrategy=WEIGHTED). Returns the bite verdicts.
 */
function verify(title, candA, candB, baseOverride = {}) {
  const base0 = BASE, baseX = { ...BASE, ...baseOverride };
  // Swap BASE for this lever's needs (the closures above read the module BASE).
  Object.assign(BASE, baseX);
  const snapshot = quiet(() => makeInitialSnapshot({ simStart: SIM_START, simEnd: SIM_END, asOfDate: NOW, baseParams: BASE }));
  const compileA = quiet(() => evalCandidate({ kind: 'compile' }, candA));
  const compileB = quiet(() => evalCandidate({ kind: 'compile' }, candB));
  const snapA    = quiet(() => evalCandidate({ kind: 'snapshot', snapshot }, candA));
  const snapB    = quiet(() => evalCandidate({ kind: 'snapshot', snapshot }, candB));
  Object.assign(BASE, base0);   // restore

  const f = n => '$' + Math.round(n).toLocaleString();
  const eps = 1;
  const compileBites  = Math.abs(compileA - compileB) > eps;
  const snapshotBites = Math.abs(snapA - snapB) > eps;

  console.log(`\n=== MPC lever verification: ${title} ===`);
  console.log(`  now = ${NOW.toISOString().slice(0, 10)}, simEnd = ${SIM_END.toISOString().slice(0, 10)}`);
  console.log(`  COMPILE path : A → ${f(compileA)}   B → ${f(compileB)}   ${compileBites ? 'DIFFERS ✓ (lever wired at t0)' : 'identical (scenario does not exercise it)'}`);
  console.log(`  SNAPSHOT path: A → ${f(snapA)}   B → ${f(snapB)}   ${snapshotBites ? 'DIFFERS ✓ (online shim works)' : 'IDENTICAL ✗ (clobbered by injection — §11.1 gap)'}`);

  let verdict;
  if (!compileBites) verdict = 'INCONCLUSIVE — pick params that force the lever to matter.';
  else if (snapshotBites) verdict = 'PASS — the control bites under MPC (shim in place).';
  else verdict = 'GAP — the control is INERT under MPC; the _seededSim shim is missing/needed.';
  console.log(`  VERDICT: ${verdict}\n`);
  return { compileBites, snapshotBites };
}

// A Lever-B roth-first weight vector (Roth drawn first, taxable last).
const ROTH_FIRST_WEIGHTS = {
  [drawdownWeightKey('roth-ira')]: 0.01,
  [drawdownWeightKey('fixed-income')]: 0.99,
  [drawdownWeightKey('us-stock')]: 0.95,
};

// Design 61 Lever A/D online (ALLOCATION_MIX): two mixes that grow the portfolio
// very differently — equity-heavy vs bond/cash-heavy — so terminal wealth diverges.
// Unlike the drawdown levers (whose order bakes into per-account `drawdownPriority`,
// a STATE field the snapshot injection clobbers), the allocation target is held in the
// freshly-compiled RebalanceToTargetReducer, so it should survive injection ⇒ bite
// under the snapshot path with NO shim. This case proves (or refutes) that.
const EQUITY_HEAVY = {
  [allocWeightKey('EQUITY')]: 0.95, [allocWeightKey('BOND')]: 0.5, [allocWeightKey('CASH')]: 0.5,
};
const BOND_HEAVY = {
  [allocWeightKey('EQUITY')]: 0.05, [allocWeightKey('BOND')]: 0.9, [allocWeightKey('CASH')]: 0.5,
};

// Design 65 Lever A online (DRAWDOWN_SLEEVE): two sleeve sell-orders that leave a very
// different residual book — sell EQUITY first (spend down the growth engine) vs sell it
// last (spend cash/bond, let equity compound). Unlike the design-58 role weights (which
// bake into per-account drawdownPriority, a clobbered STATE field), the sleeve policy is
// a state-resident config forwarded via FORWARD_DRAWDOWN_STATE_FIELDS ⇒ should bite under
// the snapshot path with NO `_seededSim` per-account shim. This case proves it.
const SELL_EQUITY_FIRST = {
  [sleeveWeightKey('EQUITY')]: 0.05, [sleeveWeightKey('GOLD')]: 0.10,
  [sleeveWeightKey('CASH')]: 0.90,   [sleeveWeightKey('BOND')]: 0.80,
};
const SELL_EQUITY_LAST = {
  [sleeveWeightKey('EQUITY')]: 0.95, [sleeveWeightKey('GOLD')]: 0.90,
  [sleeveWeightKey('CASH')]: 0.10,   [sleeveWeightKey('BOND')]: 0.20,
};

const lever = process.argv[2] ?? 'all';
function runXborder()  { verify('Lever A — crossBorderDrawdown (LOCAL_FIRST vs GLOBAL)',
  { crossBorderDrawdown: 'LOCAL_FIRST' }, { crossBorderDrawdown: 'GLOBAL' }); }
function runWithin()   { verify('Lever C — withinTierDraw (SEQUENTIAL vs PROPORTIONAL)',
  { withinTierDraw: 'SEQUENTIAL' }, { withinTierDraw: 'PROPORTIONAL' }); }
function runWeights()  { verify('Lever B — drawdownWeight order (default vs roth-first)',
  {}, ROTH_FIRST_WEIGHTS, { drawdownStrategy: 'WEIGHTED', crossBorderDrawdown: 'GLOBAL', monthlyExpenses: 10_000 }); }
function runAllocMix()  { verify('Design 61 — allocationMix (equity-heavy vs bond-heavy)',
  EQUITY_HEAVY, BOND_HEAVY,
  { behavioralStrategies: ['TARGET_ALLOCATION'], allocationStrategy: ALLOCATION_OPTIMIZED_MODE, monthlyExpenses: 8_000 }); }
function runSleeve()   { verify('Design 65 — drawdownSleeve (sell equity first vs last)',
  SELL_EQUITY_FIRST, SELL_EQUITY_LAST,
  { drawdownSleeveOrder: 'WEIGHTED', crossBorderDrawdown: 'GLOBAL', monthlyExpenses: 12_000 }); }

if (lever === 'all')                 { runXborder(); runWithin(); runWeights(); runAllocMix(); runSleeve(); }
else if (lever === 'crossBorderDrawdown') runXborder();
else if (lever === 'withinTierDraw')      runWithin();
else if (lever === 'drawdownWeights')     runWeights();
else if (lever === 'allocationMix')       runAllocMix();
else if (lever === 'drawdownSleeve')      runSleeve();
else console.log(`Unknown lever "${lever}". Use: all | crossBorderDrawdown | withinTierDraw | drawdownWeights | allocationMix | drawdownSleeve`);
