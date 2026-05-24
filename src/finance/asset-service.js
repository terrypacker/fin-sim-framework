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
 * AssetService — operations on Asset state objects (and any object
 * that carries value / loanBalance / balanceAtResidencyChange fields).
 *
 * Methods mutate the asset object in-place following the same pattern
 * as AccountService.transaction.
 */
export class AssetService {

  /**
   * Returns the asset value attributable to one person.
   * Joint ownership splits value 50/50.
   * @param {import('./asset.js').Asset} asset
   * @returns {number}
   */
  getPersonShare(asset) {
    return asset.ownershipType === 'joint' ? asset.value / 2 : asset.value;
  }

  /**
   * Snapshots the current value as balanceAtResidencyChange (one-time capture).
   * No-op if already set (preserves the first residency-change snapshot).
   * @param {import('./asset.js').Asset} asset
   */
  recordResidencyChange(asset) {
    if (asset.balanceAtResidencyChange === null) {
      asset.balanceAtResidencyChange = asset.value;
    }
  }

  /**
   * Increases the outstanding loan balance on the asset.
   * Works for both Asset (real property) and InvestmentAccount (AU stocks).
   * @param {object} asset   - Any object carrying a loanBalance field
   * @param {number} amount  - Positive loan amount
   */
  takeLoan(asset, amount) {
    asset.loanBalance = (asset.loanBalance ?? 0) + amount;
  }

  /**
   * Decreases the outstanding loan balance, floored at 0.
   * @param {object} asset   - Any object carrying a loanBalance field
   * @param {number} amount  - Positive repayment amount
   */
  repayLoan(asset, amount) {
    asset.loanBalance = Math.max(0, (asset.loanBalance ?? 0) - amount);
  }
}
