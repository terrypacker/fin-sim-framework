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
 * AuTaxRatesBase — base class for Australian income tax rate computation.
 *
 * Implements computeTax() covering both resident and non-resident cases.
 *
 * Resident path:
 *   - Progressive marginal brackets on (ordinary income + capital gains)
 *   - Medicare levy with low-income phase-in threshold
 *   - Franking credits offset ordinary tax before Medicare levy
 *   - Super tax (already a flat amount, added directly)
 *
 * Non-resident path:
 *   - Separate non-resident brackets (no tax-free threshold)
 *   - No Medicare levy, no franking credit offset
 *   - Non-resident withholding already deducted at source (added directly)
 *   - Super tax added directly
 *
 * The `year` property on each subclass refers to the financial year start
 * (e.g. year=2024 means FY 2024-25, beginning July 2024).
 *
 * State fields consumed:
 *   auOrdinaryIncomeYTD, auCapitalGainsYTD, auNonResidentWithholdingYTD,
 *   auSuperTaxYTD, auFrankingCreditYTD, isAuResident
 */
export class AuTaxRatesBase extends BaseTaxRatesModule {
  get countryCode() { return 'AU'; }

  // Subclasses set these in their constructors:

  /** Resident marginal brackets: [[threshold, rate], ...] ascending by threshold */
  _brackets            = [];
  /** Non-resident brackets: [[threshold, rate], ...] ascending (no tax-free threshold) */
  _nonResidentBrackets = [];
  /**
   * Medicare levy parameters (ATO).
   *   rate:           flat rate above upper phase-in threshold
   *   lowerThreshold: income below which no levy applies
   *   phaseInRate:    rate applied to (income − lowerThreshold) in the phase-in band
   */
  _medicareLevy = { rate: 0.02, lowerThreshold: 26_000, phaseInRate: 0.10 };

  computeTax(state) {
    const {
      auOrdinaryIncomeYTD         = 0,
      auCapitalGainsYTD           = 0,
      auNonResidentWithholdingYTD = 0,
      auSuperTaxYTD               = 0,
      auFrankingCreditYTD         = 0,
      isAuResident                = false,
    } = state;

    const totalIncome = auOrdinaryIncomeYTD + auCapitalGainsYTD;

    if (isAuResident) {
      const baseTax     = _applyBrackets(Math.max(0, totalIncome), this._brackets);
      const medicare    = this._computeMedicareLevy(totalIncome);
      const frankingOff = Math.min(auFrankingCreditYTD, baseTax);
      const ordinaryNet = Math.max(0, baseTax + medicare - frankingOff);
      return ordinaryNet + auSuperTaxYTD;
    } else {
      const baseTax = _applyBrackets(Math.max(0, totalIncome), this._nonResidentBrackets);
      return Math.max(0, baseTax) + auSuperTaxYTD + auNonResidentWithholdingYTD;
    }
  }

  /**
   * Medicare levy with low-income phase-in (ATO).
   *
   * Below lowerThreshold: no levy.
   * Phase-in band [lowerThreshold, upperThreshold): levy = (income - lowerThreshold) * phaseInRate.
   * Above upperThreshold: levy = income * rate.
   *
   * upperThreshold is the income where phaseInRate × (income − lower) = rate × income,
   * i.e. lowerThreshold / (1 − rate / phaseInRate).
   */
  _computeMedicareLevy(income) {
    const { rate, lowerThreshold, phaseInRate } = this._medicareLevy;
    if (income <= lowerThreshold) return 0;
    const upperThreshold = lowerThreshold / (1 - rate / phaseInRate);
    if (income < upperThreshold) {
      return (income - lowerThreshold) * phaseInRate;
    }
    return income * rate;
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
