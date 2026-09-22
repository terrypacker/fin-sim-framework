/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { resolveLiquidityGraph, poolsClaimingClass } from '../pools/liquidity-graph.js';
import { ALLOC_WEIGHT_CLASSES }                      from '../../scenarios/params/lever-weights.js';
import { targetVocabularyProblems }                  from '../pools/pool-axis-hygiene.js';
import { authoredPoolGraphs }                        from '../pools/pool-target-scale.js';

/**
 * DESIGN 39 §14.8, SECOND HALF — the levers a config makes inert that a GATE should not refuse.
 *
 * §14.8's first half is four gates in `lever-schedule.js`: a compiled spend order makes four
 * drawdown levers decide nothing, the condition is visible in the params bag, so `appliesTo`
 * says no and the cockpit greys out Advise. This is the other half, and it exists because
 * `ALLOCATION_MIX` fails a different test.
 *
 * ─── why this one reports instead of refusing ────────────────────────────────────
 *
 * `RebalanceToTargetReducer` SIZES the allocation classes its pools claim (design 97 §12.4 —
 * one authority, which is why a pool target beside `poolCashYears` throws). So a graph whose
 * pools claim EVERY class the lever searches leaves the weights nothing to decide: measured on
 * a real pooled plan, `allocWeight::*` swept to an equity-heavy extreme returned the run
 * to the dollar. But drop ONE claim — the same plan with CASH unclaimed — and the lever moves
 * terminal wealth by over a percent. The inertness is a property of which classes the claims
 * cover, not of pooling, and a gate that refuses the lever whenever a graph exists would be
 * wrong on every plan that leaves a class free.
 *
 * That is the `pool-axis-hygiene.js` / `run-axis-hygiene.js` shape — **report, never repair**,
 * always `severity: 'warn'` — and the rows are shaped like theirs so one renderer draws all
 * three. The operator decides: free a class in the graph, or search a lever that is live.
 *
 * ─── why it is not in `lever-schedule.js` ────────────────────────────────────────
 *
 * That file may import LEAF modules only (design 81 §16.5, measured: a non-leaf import there
 * kills four entry points with a TDZ error). Answering this question needs the normalizer and
 * `poolsClaimingClass`, so it lives here instead — imported by the cockpit, which already
 * reaches half the finance tree.
 */

/**
 * What a hygiene row says about the lever it is warning about. One kind today, named rather
 * than left implicit for the reason the pool module found: the SENTENCE is the useful part,
 * because "the lever is inert" and "the search is confounded" send an operator in opposite
 * directions.
 */
export const LEVER_PROBLEM_KIND = Object.freeze({
  /** The lever is searchable, the search will run, and every candidate returns the same run. */
  INERT: 'inert',
  /** The lever moves, and so does something else: the result reads larger or different than it is. */
  CONFOUNDED: 'confounded',
});

/** The classes `ALLOCATION_MIX.buildVariables` emits a variable for (the last is the residual). */
const SEARCHED_ALLOC_CLASSES = ALLOC_WEIGHT_CLASSES.slice(0, -1);

/**
 * Is every allocation class the mix lever searches claimed by a pool?
 *
 * Claimed, not sized: a claimed class a pool leaves unsized is the RESIDUAL of the sized ones,
 * which is equally not the weights' decision — the plan measured above claims EQUITY with no
 * target and the lever is inert all the same.
 *
 * @param {object} params    the scenario parameter bag
 * @param {Array}  accounts  context.accounts, for the normalizer's account lookups
 * @returns {boolean}
 */
function _poolsClaimEveryMixClass(params, accounts) {
  let graph = null;
  // A graph this scenario cannot compile is not this function's problem to report — the
  // normalizer's own refusal is already on screen, and a hygiene row must never be the thing
  // that throws inside a panel render.
  try { graph = resolveLiquidityGraph(params, accounts); } catch { return false; }
  if (!graph) return false;
  return SEARCHED_ALLOC_CLASSES.every(cls => poolsClaimingClass(graph, cls).length > 0);
}

/**
 * Hygiene problems for the levers a cockpit search is about to run, or `[]` when there is
 * nothing to say.
 *
 * @param {object} params        the scenario parameter bag
 * @param {string[]} leverKeys   the `COCKPIT_CONTROLS` keys the search will use
 * @param {Array} [accounts]     context.accounts
 * @returns {Array<{lever:string, severity:'warn', kind:string, message:string}>}
 */
export function leverHygieneProblems(params, leverKeys = [], accounts = []) {
  const out = [];
  if (leverKeys.includes('ALLOCATION_MIX') && _poolsClaimEveryMixClass(params, accounts)) {
    out.push({
      lever: 'ALLOCATION_MIX', severity: 'warn', kind: LEVER_PROBLEM_KIND.INERT,
      message: 'Liquidity pools claim every class this lever searches '
        + `(${SEARCHED_ALLOC_CLASSES.join(', ')}), and a pool target is the one authority for a `
        + 'class it claims (design 97 §12.4) — so the mix is already decided by the graph and '
        + 'every candidate returns the identical run. Free a class (drop its claim, or leave a '
        + 'claiming pool unsized) to make this lever live, or search a different one.',
    });
  }
  // Design 112 §2.5 — what a size factor does to the rest of the pool vocabulary: a REMAINDER
  // pool, a pool in front of one, a capacity plateau, a floor. The same rows the grid's
  // preflight reports for the hidden axis, because the MPC variable is the same factor.
  if (leverKeys.includes('POOL_TARGET')) {
    let rows = [];
    try {
      rows = targetVocabularyProblems(authoredPoolGraphs({ parameters: params }),
        params?.liquidityTargetSchedule);
    } catch { rows = []; }
    for (const r of rows) {
      out.push({ lever: 'POOL_TARGET', severity: 'warn', kind: r.kind, message: r.message });
    }
  }
  return out;
}
