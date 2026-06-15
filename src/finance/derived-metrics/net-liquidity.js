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

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/**
 * Determine whether an account's balance is accessible on `date`.
 *
 * Rules mirror AccountService.replenishSavings:
 *   - No minimumAge             → always accessible
 *   - allowsEarlyWithdrawal     → accessible at any age (with possible penalty)
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
  if (account.allowsEarlyWithdrawal) return true;

  if (!date) return false;

  const ownerId   = account.ownerId ?? Object.keys(state.people ?? {})[0];
  const birthDate = getBirthDate(state, ownerId);
  if (!birthDate) return false;

  const age = (date - birthDate) / MS_PER_YEAR;
  return age >= account.minimumAge;
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
 *       * allowsEarlyWithdrawal=true → included at any age (e.g. IRA, 401k, Roth)
 *       * allowsEarlyWithdrawal=false + minimumAge set (e.g. AU Superannuation)
 *         → included only once the owner is old enough
 *
 * This value reaches zero at the same moment an OutOfFunds event fires.
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
    if (typeof val.balance !== 'number') continue;
    if (val.drawdownPriority == null) continue;
    if (!isAccessible(val, state, date)) continue;

    const currency = val.currency?.code ?? val.currency ?? baseCurrency;

    if (currency === baseCurrency) {
      total += val.balance;
    } else {
      const pairId = `${baseCurrency}_${currency}`;
      const rate   = state.effectiveExchangeRates?.[pairId] ?? 1;
      total += val.balance / rate;
    }
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
