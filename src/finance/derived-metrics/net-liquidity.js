/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { getBirthDate } from '../residency-utils.js';
import { supportsEarlyWithdrawal } from '../account-rules/us/us-early-withdrawal-rules.js';
import { toBaseCurrency, currencyOf } from '../fx/to-base-currency.js';

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/**
 * Determine whether an account's balance is accessible on `date`.
 *
 * Rules mirror AccountService.replenishSavings:
 *   - No minimumAge             → always accessible
 *   - allowsEarlyWithdrawal, on a type an early withdrawal can actually REACH
 *                               → accessible at any age (with possible penalty)
 *   - minimumAge + no early withdrawal + date provided
 *       → accessible only if the owner's age >= minimumAge
 *   - minimumAge + no early withdrawal + no date
 *       → conservatively treated as inaccessible
 *
 * @param {object}    account
 * @param {object}    state
 * @param {Date|null} date
 * @returns {boolean}
 */
function isAccessible(account, state, date) {
  if (account.minimumAge == null) return true;
  // Design 97 §22.8 — the flag alone is NOT enough, and the asymmetry is the point.
  // `replenishSavings` Phase 2 tests the flag and then looks up the rules, so a type with no
  // entry reaches `if (!rules) continue` and cannot be drawn early at any flag value. This
  // line used to believe the flag unconditionally, so a `super` carrying it would have been
  // counted as reachable by the CONTROL metric (design 88 §5) while no drawdown path could
  // move a dollar of it.
  //
  // Enforced HERE and not only at the config boundary because a config guard is not a choke
  // point: state entries are also built as plain objects (`_accountToStatePlain`, the
  // bequest seeds), and those never pass through the serializer. Inert today — every account
  // that carries the flag either has a rule or has no `minimumAge` and returned above.
  if (account.allowsEarlyWithdrawal && supportsEarlyWithdrawal(account.type)) return true;

  if (!date) return false;

  const ownerId   = account.ownerId ?? Object.keys(state.people ?? {})[0];
  const birthDate = getBirthDate(state, ownerId);
  if (!birthDate) return false;

  const age = (date - birthDate) / MS_PER_YEAR;
  return age >= account.minimumAge;
}

/**
 * The single source of truth for "is this account in the lever-reachable
 * (drawdownable) pool right now": it must opt into drawdown (`drawdownPriority`
 * non-null) AND be age-accessible. Shared by `computeNetLiquidity` and the
 * after-tax liquidity metric (design/40 §4) so the scope rule never drifts.
 *
 * @param {object}    account
 * @param {object}    state
 * @param {Date|null} date
 * @returns {boolean}
 */
export function isDrawdownAccessible(account, state, date) {
  if (account == null || typeof account.balance !== 'number') return false;
  if (account.drawdownPriority == null) return false;
  return isAccessible(account, state, date);
}

/**
 * Compute total net liquidity from simulation state.
 *
 * Net liquidity is the sum of balances of all accounts that the drawdown
 * chain can currently access:
 *   - The account must have a non-null `drawdownPriority` (accounts with
 *     `drawdownPriority === null` are explicitly excluded from drawdown).
 *   - The account must be currently accessible per its age-gate rules:
 *       * No minimumAge → always included
 *       * allowsEarlyWithdrawal=true AND the type has an early-withdrawal rule
 *         → included at any age (IRA, 401k, Roth)
 *       * allowsEarlyWithdrawal=false + minimumAge set (e.g. AU Superannuation)
 *         → included only once the owner is old enough. Super stays here whatever
 *           the flag says: no rules entry, so no drawdown path can reach it
 *           (design 97 §22.8).
 *
 * This value reaches zero at the same moment an OutOfFunds event fires.
 *
 * THIS IS THE CONTROL METRIC (design 88 §5): the MPC/OPT lever set acts on the
 * spending rate and on drawdown-eligible balances, and on nothing else — no control
 * can sell a house, find a buyer for a private stake, or unlock super early. So the
 * pool measured here is exactly the pool a controller can steer, which is why a
 * terminal target should be liquidity-scoped rather than worth-scoped.
 *
 * Real property, collectibles and company equity are excluded because they carry no
 * numeric `balance` — INCIDENTAL in mechanism, DELIBERATE in intent. A future change
 * that gives an asset a balance-like field must not quietly re-admit it here; that
 * would break the control scope, which is the hardest place to notice a break. The
 * same reasoning makes design 88's `speculative` flag unnecessary on this path: a
 * speculative asset was never in the reachable pool to begin with.
 *
 * @param {object}    state
 * @param {Date|null} [date=null]           — current simulation date; required for age-gate checks
 * @param {string}    [baseCurrency='USD']
 * @returns {number}
 */
export function computeNetLiquidity(state, date = null, baseCurrency = 'USD') {
  let total = 0;

  for (const val of Object.values(state)) {
    if (val == null || typeof val !== 'object') continue;
    if (!isDrawdownAccessible(val, state, date)) continue;

    // The one valuation FX convention (design 82 §5.1a) — shared with computeNetWorth
    // and the allocation cube so no two metrics can hold different opinions about
    // what a dollar is.
    total += toBaseCurrency(val.balance, currencyOf(val, baseCurrency), baseCurrency, state);
  }

  return total;
}

/**
 * DerivedMetrics function: writes state.metrics.netLiquidity.
 * Register with DerivedMetricsRegistry — the registry passes the current
 * simulation date as the second argument.
 *
 * @param {object}    state
 * @param {Date|null} [date=null]
 */
export function deriveNetLiquidity(state, date = null) {
  if (!state.metrics || typeof state.metrics !== 'object') state.metrics = {};
  state.metrics.netLiquidity = +computeNetLiquidity(state, date).toFixed(2);
}
