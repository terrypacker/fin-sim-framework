/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseTaxRatesModule } from '../base-tax-rates-module.js';

/**
 * UsTaxRatesBase — base class for US federal tax rate computation.
 *
 * Implements computeTax() using MFJ ordinary income brackets, LTCG brackets,
 * standard deduction, and the Foreign Tax Credit (FTC) offset.
 *
 * Filing status: Married Filing Jointly (MFJ).
 * Subclasses set year-specific bracket tables and deduction amounts.
 *
 * State fields consumed:
 *   usOrdinaryIncomeYTD, usNegativeIncomeYTD, usCapitalGainsYTD,
 *   usPenaltyYTD, ftcYTD
 */
export class UsTaxRatesBase extends BaseTaxRatesModule {
  get countryCode() { return 'US'; }

  // Subclasses set these in their constructors:

  /** Ordinary income brackets: [[threshold, rate], ...] ascending by threshold */
  _brackets_mfj     = [];
  /** Long-term capital gains brackets: [[threshold, rate], ...] ascending */
  _ltcg_mfj         = [];
  /** Standard deduction for MFJ filing status */
  _stdDeduction_mfj = 0;
  /** Social Security wage base (informational; not used in income tax calc) */
  _ficaWageBase     = 0;

  computeTax(state) {
    const {
      usOrdinaryIncomeYTD = 0,
      usNegativeIncomeYTD = 0,
      usCapitalGainsYTD   = 0,
      usPenaltyYTD        = 0,
      ftcYTD              = 0,
    } = state;

    // Step 1: taxable ordinary income after pre-tax deductions and standard deduction
    const taxableOrdinary = Math.max(
      0,
      usOrdinaryIncomeYTD - usNegativeIncomeYTD - this._stdDeduction_mfj,
    );

    // Step 2: ordinary income tax via marginal brackets
    const ordinaryTax = _applyBrackets(taxableOrdinary, this._brackets_mfj);

    // Step 3: long-term capital gains tax
    const cgTax = _applyBrackets(Math.max(0, usCapitalGainsYTD), this._ltcg_mfj);

    // Step 4: gross liability including early-withdrawal penalties
    const gross = ordinaryTax + cgTax + usPenaltyYTD;

    // Step 5: Foreign Tax Credit (capped at gross liability)
    const ftcCredit = Math.min(ftcYTD, gross);

    return Math.max(0, gross - ftcCredit);
  }
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Apply marginal brackets to an income amount.
 * brackets: [[threshold, rate], ...] sorted ascending by threshold.
 */
function _applyBrackets(income, brackets) {
  if (income <= 0) return 0;
  let tax = 0;
  for (let i = 0; i < brackets.length; i++) {
    const [lo, rate] = brackets[i];
    const hi = i + 1 < brackets.length ? brackets[i + 1][0] : Infinity;
    if (income <= lo) break;
    tax += (Math.min(income, hi) - lo) * rate;
  }
  return tax;
}
