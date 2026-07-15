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
 * INHERITED_RA_DISTRIBUTION_STRATEGY — the pluggable SECURE-Act 10-year
 * inherited-retirement-account drawdown strategies (design 63 §6.2). This is the
 * primary lever the design exists to optimize: how to draw an inherited pre-tax
 * IRA/401(k) (or tax-free Roth) down against the heir's other income/brackets.
 *
 * Each entry is a pure `plan(balance, yearIndex, ctx) → amount` with a HARD
 * terminal-catch-up constraint: whatever remains in the final window-year
 * (`yearIndex === WINDOW − 1`, i.e. year 9) is fully distributed, guaranteeing
 * the SECURE mandate is met so no strategy can under-distribute.
 *
 * ctx = {
 *   otherOrdinaryIncome, // state.usOrdinaryIncomeYTD read at fire time (nominal)
 *   fillCeilingReal,     // inheritedRaFillCeiling, REAL base-year USD (optimized)
 *   cpiIndexUS,          // cpiAccumulator.US — nominal/real factor for this year
 *   lumpYear,            // inheritedRaLumpYear (0..9)
 *   weights,             // inheritedRaWeight::0..9 vector
 *   WINDOW,              // = 10
 * }
 *
 * Sibling of the design-26 spending-strategy and design-58 drawdown-lever
 * families. Optimizer params route through the Opt/MC/MPC set() path and MUST
 * use `::`-delimited flat keys (dotted keys are silently dropped).
 */

export const INHERITED_RA_WINDOW = 10;

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export const INHERITED_RA_DISTRIBUTION_STRATEGY = {

  /**
   * Equal split of the *remaining* balance over the remaining window years. Drains
   * fully by year 9 (WINDOW − yearIndex === 1 ⇒ full balance) and absorbs any
   * mid-window growth evenly. The neutral baseline.
   */
  equal: {
    plan(balance, yearIndex, ctx) {
      const LAST = ctx.WINDOW - 1;
      if (yearIndex < 0 || balance <= 0) return 0;
      if (yearIndex >= LAST)             return balance;               // terminal catch-up
      return balance / (ctx.WINDOW - yearIndex);
    },
  },

  /**
   * All in a single chosen year `k` (default 0). If `k` is somehow skipped, the
   * year-9 terminal catch-up still empties the account (worst-case bracket spike;
   * a useful optimizer bound).
   */
  lump: {
    plan(balance, yearIndex, ctx) {
      const LAST = ctx.WINDOW - 1;
      if (yearIndex < 0 || balance <= 0) return 0;
      if (yearIndex >= LAST)             return balance;               // terminal catch-up
      const k = clamp(Math.round(ctx.lumpYear ?? 0), 0, LAST);
      return yearIndex === k ? balance : 0;
    },
  },

  /**
   * Nothing until year 9, then the full balance (max deferral). Worst-case
   * single-year bracket spike; a useful optimizer bound.
   */
  maxDefer: {
    plan(balance, yearIndex, ctx) {
      if (yearIndex < 0 || balance <= 0) return 0;
      return yearIndex >= ctx.WINDOW - 1 ? balance : 0;
    },
  },

  /**
   * Distribute enough each year to fill the heir's ordinary income up to a REAL
   * ceiling (inflated to nominal for the compare), spilling the remainder into the
   * year-9 catch-up. The real bracket-smoothing solution; one scalar
   * (`inheritedRaFillCeiling`) captures ~all the value (design 63 §6.2).
   */
  bracketFill: {
    plan(balance, yearIndex, ctx) {
      const LAST = ctx.WINDOW - 1;
      if (yearIndex < 0)                 return 0;
      if (yearIndex >= LAST || balance <= 0) return Math.max(0, balance); // terminal catch-up
      const ceilingNominal = (ctx.fillCeilingReal ?? 0) * (ctx.cpiIndexUS ?? 1);
      const fillRoom       = Math.max(0, ceilingNominal - (ctx.otherOrdinaryIncome ?? 0));
      return Math.min(balance, fillRoom);
    },
  },

  /**
   * Explicit per-year weight vector, renormalized over the remaining window and
   * catch-up-clamped. Expresses any hand-tuned smoothing the other strategies
   * can't; the optimizer tunes `inheritedRaWeight::0..9`.
   */
  weights: {
    plan(balance, yearIndex, ctx) {
      const LAST = ctx.WINDOW - 1;
      if (yearIndex < 0 || balance <= 0) return 0;
      if (yearIndex >= LAST)             return balance;               // terminal catch-up
      const w = ctx.weights ?? [];
      let remaining = 0;
      for (let i = yearIndex; i < ctx.WINDOW; i++) remaining += Math.max(0, w[i] ?? 0);
      if (remaining <= 0) return 0;
      const frac = Math.max(0, w[yearIndex] ?? 0) / remaining;
      return Math.min(balance, balance * frac);
    },
  },
};

/** Resolve a strategy entry by id, falling back to `equal`. */
export function inheritedRaStrategy(id) {
  return INHERITED_RA_DISTRIBUTION_STRATEGY[id] ?? INHERITED_RA_DISTRIBUTION_STRATEGY.equal;
}
