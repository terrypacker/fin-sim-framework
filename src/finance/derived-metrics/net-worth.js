/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { toBaseCurrency, currencyOf } from '../fx/to-base-currency.js';
import { isSpeculative } from '../assets/asset.js';

/**
 * Compute total net worth from simulation state.
 *
 * Includes all asset categories, FX-converted to baseCurrency:
 *   - Accounts       — any state entry with a numeric `balance`
 *   - Real property  — state entries with kind === 'real-property'; contributes equity (value − mortgageBalance)
 *   - Collectibles   — state entries with kind === 'collectible'; contributes market value
 *   - Company equity — state entries with kind === 'company'; contributes market value
 *
 * Except: an asset flagged `speculative` is RECOGNISED AT ZERO (design 88 D5). Its
 * value in state is still real and still compounds — the flag suppresses the carrying
 * value, never the mechanics — so the moment it sells, its proceeds land in an account
 * and are counted in full from that instant. `computeNetWorthInclSpeculative` is the
 * disclosure counterpart for callers that want the "and what if they all pay off?"
 * figure (D7).
 *
 * @param {object} state
 * @param {string} [baseCurrency='USD']
 * @returns {number}
 */
export function computeNetWorth(state, baseCurrency = 'USD') {
  return _sumNetWorth(state, baseCurrency, { includeSpeculative: false });
}

/**
 * Net worth INCLUDING speculative assets at full carrying value — the disclosure
 * figure (design 88 D7). Identical to `computeNetWorth` on any plan with nothing
 * flagged, so publishing both costs nothing until the planner uses the flag.
 *
 * Not a control metric: see design 88 §5. The optimizer/MPC anchor on the recognised
 * figure, or better, on net liquidity.
 *
 * @param {object} state
 * @param {string} [baseCurrency='USD']
 * @returns {number}
 */
export function computeNetWorthInclSpeculative(state, baseCurrency = 'USD') {
  return _sumNetWorth(state, baseCurrency, { includeSpeculative: true });
}

/** @private — one traversal, two scopes, so they cannot drift apart. */
function _sumNetWorth(state, baseCurrency, { includeSpeculative }) {
  let total = 0;

  for (const val of Object.values(state)) {
    if (val == null || typeof val !== 'object') continue;

    const currency = currencyOf(val, baseCurrency);
    let contribution = 0;

    if (val.type === 'loan' && typeof val.balance === 'number') {
      // Liability (design 54): owed principal reduces net worth.
      contribution = -val.balance;
    } else if (typeof val.balance === 'number') {
      // Account (asset). Accounts are out of scope for the speculative flag
      // (design 88 D3/OQ2): an account is drawdown-eligible machinery, and
      // excluding one from worth while the engine spends from it is incoherent.
      contribution = val.balance;
    } else if (val.kind === 'real-property' && typeof val.value === 'number') {
      // RealProperty: equity only
      if (!includeSpeculative && isSpeculative(val)) continue;
      contribution = val.value - (val.mortgageBalance ?? 0);
    } else if (val.kind === 'collectible' && typeof val.value === 'number') {
      if (!includeSpeculative && isSpeculative(val)) continue;
      contribution = val.value;
    } else if (val.kind === 'company' && typeof val.value === 'number') {
      if (!includeSpeculative && isSpeculative(val)) continue;
      contribution = val.value;
    } else {
      continue;
    }

    // Shared with the allocation cube (design 82 §5.1a): the two are bound by the
    // invariant Σ cube rows === computeNetWorth, so they must not be able to hold
    // different opinions about what a dollar is.
    total += toBaseCurrency(contribution, currency, baseCurrency, state);
  }

  return total;
}

/**
 * DerivedMetrics function: writes state.metrics.netWorth, plus
 * state.metrics.netWorthInclSpeculative when — and only when — the plan actually
 * holds a flagged asset (design 88 D7).
 *
 * The conditional write is deliberate: an unconditional second key would put a new
 * (identical) number into every saved state and every golden fixture, breaking D2's
 * byte-identity guarantee to say nothing new. A plan with nothing flagged has one
 * honest number, not two.
 *
 * Register with DerivedMetricsRegistry or pass as a standalone function.
 *
 * @param {object} state
 * @param {string} [baseCurrency='USD']
 */
export function deriveNetWorth(state, baseCurrency = 'USD') {
  if (typeof baseCurrency !== 'string') baseCurrency = 'USD'; // registry passes date as 2nd arg
  if (!state.metrics || typeof state.metrics !== 'object') state.metrics = {};
  const worth = computeNetWorth(state, baseCurrency);
  state.metrics.netWorth = +worth.toFixed(2);

  // Once the key exists it must keep being refreshed, or a flagged stake that later
  // SELLS would freeze the disclosure figure at its pre-sale value — the two numbers
  // legitimately converge at that moment, and a stale key would hide it.
  const incl = computeNetWorthInclSpeculative(state, baseCurrency);
  if (incl !== worth || 'netWorthInclSpeculative' in state.metrics) {
    state.metrics.netWorthInclSpeculative = +incl.toFixed(2);
  }
}
