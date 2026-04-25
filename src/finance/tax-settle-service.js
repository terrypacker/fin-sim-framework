/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { UsTaxRates2024 } from './tax/us/us-tax-rates-2024.js';
import { UsTaxRates2025 } from './tax/us/us-tax-rates-2025.js';
import { AuTaxRates2024 } from './tax/au/au-tax-rates-2024.js';
import { AuTaxRates2025 } from './tax/au/au-tax-rates-2025.js';

/**
 * TaxSettleService — year-aware computation of end-of-period tax liability.
 *
 * Holds a registry of BaseTaxRatesModule instances keyed by country+year.
 * At settlement time, the correct module is resolved from state.currentPeriods,
 * using the same highest-year-<= logic as TaxEngine.
 *
 * Registered modules (ordered by country and financial year):
 *   US 2024  — IRS Rev. Proc. 2023-34 MFJ brackets
 *   US 2025  — IRS Rev. Proc. 2024-40 MFJ brackets
 *   AU 2024  — ATO FY2024-25 (Stage 3 tax cuts)
 *   AU 2025  — ATO FY2025-26 (30% bracket extended to $135k)
 *
 * For years beyond the highest registered year, the highest available module
 * is used as a forward-compatibility fallback.
 */
export class TaxSettleService {
  constructor() {
    /** @type {Record<string, import('./tax/base-tax-rates-module.js').BaseTaxRatesModule>} */
    this._modules = {};

    for (const m of [
      new UsTaxRates2024(),
      new UsTaxRates2025(),
      new AuTaxRates2024(),
      new AuTaxRates2025(),
    ]) {
      this._modules[`${m.countryCode}_${m.year}`] = m;
    }
  }

  /**
   * Compute total US federal tax liability for the period.
   *
   * Resolves the correct year's module from state.currentPeriods.US.
   * Filing status: Married Filing Jointly (MFJ).
   * FTC credit applied after computing gross liability (cannot exceed liability).
   *
   * @param {object} state - Simulation state snapshot
   * @returns {number} Net US tax owed (>= 0)
   */
  computeUsTax(state) {
    return this._getModule('US', state).computeTax(state);
  }

  /**
   * Compute total AU tax liability for the period.
   *
   * Resolves the correct year's module from state.currentPeriods.AU.
   * Resident:     progressive brackets + Medicare levy, franking credits offset.
   * Non-resident: flat brackets (no threshold), withholding added directly.
   *
   * @param {object} state - Simulation state snapshot
   * @returns {number} Net AU tax owed (>= 0)
   */
  computeAuTax(state) {
    return this._getModule('AU', state).computeTax(state);
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  /**
   * Resolve the best-matching rates module for the given country.
   *
   * Uses state.currentPeriods[cc].startMs to derive the tax year, then picks
   * the highest registered year <= that year (same strategy as TaxEngine.get()).
   * Falls back to the highest available year if no period is set in state.
   *
   * @param {string} cc    Country code ('US' or 'AU')
   * @param {object} state Simulation state snapshot
   * @returns {import('./tax/base-tax-rates-module.js').BaseTaxRatesModule}
   */
  _getModule(cc, state) {
    const available = Object.keys(this._modules)
      .filter(k => k.startsWith(cc + '_'))
      .map(k => parseInt(k.split('_')[1], 10))
      .sort((a, b) => a - b);

    if (available.length === 0) {
      throw new Error(`[TaxSettleService] No rates module registered for country: ${cc}`);
    }

    const period = state.currentPeriods?.[cc];
    if (period) {
      const taxYear = new Date(period.startMs).getUTCFullYear();
      const best    = available.filter(y => y <= taxYear).pop() ?? available[0];
      return this._modules[`${cc}_${best}`];
    }

    // No period in state — use highest available year as fallback
    return this._modules[`${cc}_${available[available.length - 1]}`];
  }
}
