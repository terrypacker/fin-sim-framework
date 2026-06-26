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
 * Param type constants for optimization configs.
 *
 * ENUM       — discrete set of explicit values (e.g., bracket rates)
 * INTEGER    — integer range [min, max] stepped by step
 * CONTINUOUS — continuous range [min, max] stepped by step (discretised for grid search)
 */
export const OPT_PARAM_TYPES = {
  ENUM:       'enum',
  INTEGER:    'integer',
  CONTINUOUS: 'continuous',
};

/**
 * Default penalty weight λ for DIE_WITH_TARGET. Large enough that each dollar of
 * terminal-wealth miss outweighs the consumption gained by leaving (or spending)
 * it, so the terminal-wealth target is binding and the band solution is an
 * interior point. Overridable per-scenario via `terminalWealthTargetPenalty`.
 */
export const DEFAULT_TERMINAL_WEALTH_PENALTY = 10;

/**
 * Named optimization objectives (design/38 §5).
 *
 * Each entry has:
 *   label     — human-readable name for UI
 *   direction — 'maximize' | 'minimize'
 *   evaluate  — (result, { snapshot } = {}) => number
 *
 * Objectives are **pure functions of the final sim state** (the `result` object
 * built by OptimizationProblem._readResult): terminal metrics (net worth,
 * liquidity) AND cumulative running accumulators (lifetime taxes, lifetime
 * consumption) that reducers wrote into state over the run. There is no per-step
 * callback — the running/terminal decomposition is realized as "terminal metrics
 * + state accumulators", both read at the end.
 *
 * **Windowed horizons (MPC).** When design 39 solves over a window [t, t+H], the
 * cost incurred within the window is `accumulator(t+H) − accumulator(t)`. The
 * optional `snapshot` carries `accumulator(t)`, so running objectives subtract
 * it; terminal objectives ignore it.
 *
 * The optimizer always maximises internally; a 'minimize' direction causes
 * scores to be negated before ranking.
 */
export const OPTIMIZATION_OBJECTIVES = {
  // ── Terminal objectives (pure functions of final state) ──────────────────
  MAX_NET_WORTH: {
    label:     'Maximize Final Net Worth (USD)',
    direction: 'maximize',
    evaluate:  result => result.finalNetWorthUsd,
  },

  MAX_ROTH_BALANCE: {
    label:     'Maximize Final Roth Balance (USD)',
    direction: 'maximize',
    evaluate:  result => result.rothFinalBalance,
  },

  MIN_DEFICIT: {
    label:     'Minimize Cumulative Deficit',
    direction: 'minimize',
    evaluate:  result => result.cumulativeDeficit,
  },

  MAX_NET_LIQUIDITY: {
    label:     'Maximize Final Net Liquidity (USD)',
    direction: 'maximize',
    evaluate:  result => result.finalNetLiquidity,
  },

  // ── "Die with zero, or with $XX" (the headline, design/38 §5.2) ──────────
  // Maximize lifetime real consumption subject to terminal net worth landing on
  // a target: score = lifetimeConsumption − λ·|NW_T − target|. The soft two-sided
  // penalty makes the band solution an interior point — spend-early ⇄ leave-less.
  DIE_WITH_TARGET: {
    label:     'Die With Target (max consumption, hit terminal wealth)',
    direction: 'maximize',
    evaluate(result, { snapshot } = {}) {
      const consumption = (result.lifetimeConsumption ?? 0)
        - (snapshot?.state?.cumulativeConsumption ?? 0);
      const target  = result.terminalWealthTarget ?? 0;
      const lambda  = result.terminalWealthTargetPenalty ?? DEFAULT_TERMINAL_WEALTH_PENALTY;
      return consumption - lambda * Math.abs((result.finalNetWorthUsd ?? 0) - target);
    },
  },

  // ── Lifetime taxes (running accumulator, design/38 §5.3) ─────────────────
  MIN_LIFETIME_TAXES: {
    label:     'Minimize Lifetime Taxes (USD)',
    direction: 'minimize',
    evaluate(result, { snapshot } = {}) {
      return (result.cumulativeTaxesPaid ?? 0) - (snapshot?.state?.cumulativeTaxesPaid ?? 0);
    },
  },
};
