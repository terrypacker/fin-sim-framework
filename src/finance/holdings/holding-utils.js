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
