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
 * Proportionally scale all holdings so that Σ holdings[i].marketValue === newBalance.
 *
 * §4.4 invariant: every reducer that changes account.balance must also call this
 * so that the next earnings event (which uses computeHoldingsGrowth on holdings[])
 * and the subsequent _syncBalance call do not overwrite the correct balance with
 * a stale holdings sum.
 *
 * @param {Array}  holdings   - account.holdings array (may be null / undefined / empty)
 * @param {number} oldBalance - account.balance before the operation
 * @param {number} newBalance - account.balance after the operation
 * @returns {Array} updated holdings array (same reference if no change needed)
 */
export function scaleHoldings(holdings, oldBalance, newBalance) {
  if (!Array.isArray(holdings) || holdings.length === 0) return holdings;
  if (oldBalance <= 0) {
    if (newBalance <= 0) return holdings;
    return holdings.map((h, i) => i === 0
      ? { ...h, marketValue: +newBalance.toFixed(2), costBasis: +newBalance.toFixed(2) }
      : h
    );
  }
  const factor = newBalance / oldBalance;
  return holdings.map(h => ({
    ...h,
    marketValue: +((h.marketValue ?? 0) * factor).toFixed(2),
    costBasis:   +((h.costBasis   ?? 0) * factor).toFixed(2),
  }));
}

/**
 * Reconcile a balance edit to the holdings so the §4.4 invariant
 * (Σ holdings[i].marketValue === balance) holds, scaling by the holdings'
 * CURRENT market-value sum rather than a (possibly already-stale) stored
 * balance. Pure: returns a NEW array of NEW holding objects and never mutates
 * the input holdings (so a holding already recorded in the journal can't be
 * rewritten by a later rescale — the journal-aliasing invariant). Callers must
 * assign the result back (`account.holdings = rescaleHoldingsToBalance(...)`).
 * The spread produces plain records; the serializer wraps any non-Holding leaf
 * in `new Holding(h)` before toJSON, so the class is not required here.
 *
 * Reconciliation rules (design 25 §4.4, design 43 §3 invariant 3):
 *   - empty / no holdings           → no-op (input array returned unchanged)
 *   - Σ current marketValue > 0     → scale every holding's marketValue AND
 *                                     costBasis by targetBalance / Σmv,
 *                                     preserving the sleeve mix and gain ratio
 *                                     (this includes the single-holding case —
 *                                     a balance edit must NOT reset cost basis to
 *                                     market value and wipe the unrealized gain)
 *   - Σ current marketValue == 0    → assign the full targetBalance to the
 *                                     first holding (marketValue = costBasis); the
 *                                     only branch where costBasis is set to target,
 *                                     since there is no gain ratio to preserve
 * Penny rounding drift is absorbed by the largest-marketValue holding.
 *
 * @param {Array}  holdings      - account.holdings (plain records or Holding[])
 * @param {number} targetBalance - the new account balance to match
 * @returns {Array} a new holdings array (input returned as-is only when empty)
 */
export function rescaleHoldingsToBalance(holdings, targetBalance) {
  if (!Array.isArray(holdings) || holdings.length === 0) return holdings;
  const target = +(+(targetBalance ?? 0)).toFixed(2);

  const curSum = holdings.reduce((s, h) => s + (h?.marketValue ?? 0), 0);

  if (curSum <= 0) {
    return holdings.map((h, i) => ({
      ...h,
      marketValue: i === 0 ? target : 0,
      costBasis:   i === 0 ? target : 0,
    }));
  }

  const factor = target / curSum;
  const scaled = holdings.map(h => ({
    ...h,
    marketValue: +((h.marketValue ?? 0) * factor).toFixed(2),
    costBasis:   +((h.costBasis   ?? 0) * factor).toFixed(2),
  }));

  // Absorb rounding drift into the largest-marketValue holding.
  const newSum = +scaled.reduce((s, h) => s + (h.marketValue ?? 0), 0).toFixed(2);
  const drift  = +(target - newSum).toFixed(2);
  if (drift !== 0) {
    let li = 0;
    for (let i = 1; i < scaled.length; i++) {
      if ((scaled[i].marketValue ?? 0) > (scaled[li].marketValue ?? 0)) li = i;
    }
    scaled[li] = { ...scaled[li], marketValue: +((scaled[li].marketValue ?? 0) + drift).toFixed(2) };
  }
  return scaled;
}

/**
 * Distribute a cash credit (dividend reinvest / contribution) across an
 * account's holdings, weighted by each holding's current market value, adding
 * the share to BOTH marketValue and costBasis (the reinvested cash carries basis
 * equal to its market value). Σ marketValue rises by exactly `amount`, keeping
 * the §4.4 invariant intact when the caller credits `balance` by the same amount.
 *
 * Unlike scaleHoldings (which scales basis by the balance ratio and so
 * under-adds basis when a position carries an unrealized gain), this adds the
 * full credit to basis — the correct treatment for reinvested cash.
 *
 * @param {Array}  holdings - account.holdings (returns a new array; originals untouched)
 * @param {number} amount   - positive cash amount being reinvested
 * @returns {Array} new holdings array
 */
export function distributeHoldingsCredit(holdings, amount) {
  if (!Array.isArray(holdings) || holdings.length === 0 || amount === 0) return holdings;
  const total = holdings.reduce((s, h) => s + (h?.marketValue ?? 0), 0);
  if (total <= 0) {
    // No market value to weight against — land the whole credit in the first holding.
    return holdings.map((h, i) => i === 0
      ? { ...h, marketValue: +((h.marketValue ?? 0) + amount).toFixed(2), costBasis: +((h.costBasis ?? 0) + amount).toFixed(2) }
      : h);
  }
  let distributed = 0;
  const out = holdings.map((h, i) => {
    // Give the last holding the residual so the parts sum to `amount` exactly.
    const share = i === holdings.length - 1
      ? +(amount - distributed).toFixed(2)
      : +(amount * ((h.marketValue ?? 0) / total)).toFixed(2);
    distributed += share;
    return {
      ...h,
      marketValue: +((h.marketValue ?? 0) + share).toFixed(2),
      costBasis:   +((h.costBasis   ?? 0) + share).toFixed(2),
    };
  });
  return out;
}

/**
 * True when an account's holdings sum is out of sync with its balance beyond a
 * one-cent tolerance (the condition the on-load auto-heal repairs).
 *
 * @param {object} account - { balance, holdings }
 * @returns {boolean}
 */
export function holdingsOutOfSync(account) {
  const holdings = account?.holdings;
  if (!Array.isArray(holdings) || holdings.length === 0) return false;
  const sum = holdings.reduce((s, h) => s + (h?.marketValue ?? 0), 0);
  return Math.abs(sum - (account.balance ?? 0)) > 0.01;
}
