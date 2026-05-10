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
      usOrdinaryIncomeYTD    = 0,
      usNegativeIncomeYTD    = 0,
      usCapitalGainsYTD      = 0,
      usCollectibleGainsYTD  = 0,
      usPenaltyYTD           = 0,
      ftcYTD                 = 0,
    } = state;

    // Step 1: AGI and taxable ordinary income
    const agi             = usOrdinaryIncomeYTD - usNegativeIncomeYTD;
    const taxableOrdinary = Math.max(0, agi - this._stdDeduction_mfj);

    // Step 2: ordinary income tax via marginal brackets
    const ordinaryTax    = _applyBrackets(taxableOrdinary, this._brackets_mfj);

    // Step 3: long-term capital gains tax
    const cg             = Math.max(0, usCapitalGainsYTD);
    const capitalGainsTax = _applyBrackets(cg, this._ltcg_mfj);

    // Step 4: collectibles taxed at flat 28% rate (IRS §1(h)(4))
    const collectibles    = Math.max(0, usCollectibleGainsYTD);
    const collectiblesTax = collectibles * 0.28;

    // Step 5: gross liability including early-withdrawal penalties
    const penaltyTax = Math.max(0, usPenaltyYTD);
    const grossTax   = ordinaryTax + capitalGainsTax + collectiblesTax + penaltyTax;

    // Step 6: Foreign Tax Credit (capped at gross liability)
    const credits      = Math.min(ftcYTD, grossTax);
    const netLiability = Math.max(0, grossTax - credits);

    const totalGrossIncome = usOrdinaryIncomeYTD + cg + collectibles;
    const effectiveRate    = totalGrossIncome > 0 ? netLiability / totalGrossIncome : 0;
    const marginalRate     = _marginalBracketRate(taxableOrdinary, this._brackets_mfj);

    return {
      inputs: {
        grossOrdinaryIncome: usOrdinaryIncomeYTD,
        adjustments:         usNegativeIncomeYTD,
        capitalGains:        usCapitalGainsYTD,
        collectibleGains:    usCollectibleGainsYTD,
        penalties:           usPenaltyYTD,
        foreignTaxCredit:    ftcYTD,
        standardDeduction:   this._stdDeduction_mfj,
      },
      adjustedGrossIncome: agi,
      taxableIncome:       taxableOrdinary,
      ordinaryTax,
      capitalGainsTax,
      collectiblesTax,
      penaltyTax,
      grossTax,
      credits,
      netLiability,
      effectiveRate,
      marginalRate,
      lineItems: [
        { label: 'Gross Ordinary Income',               amount:  usOrdinaryIncomeYTD },
        { label: 'Adjustments (Pre-tax Contributions)', amount: -usNegativeIncomeYTD },
        { label: 'Adjusted Gross Income',               amount:  agi },
        { label: 'Standard Deduction',                  amount: -this._stdDeduction_mfj },
        { label: 'Taxable Ordinary Income',             amount:  taxableOrdinary },
        { label: 'Tax on Ordinary Income',              amount:  ordinaryTax },
        { label: 'Long-Term Capital Gains Tax',         amount:  capitalGainsTax },
        { label: 'Collectibles Tax (28%)',              amount:  collectiblesTax },
        { label: 'Early Withdrawal Penalties',          amount:  penaltyTax },
        { label: 'Gross Tax',                           amount:  grossTax },
        { label: 'Foreign Tax Credit',                  amount: -credits },
        { label: 'Net Tax Liability',                   amount:  netLiability },
      ],
    };
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

/** Return the marginal rate of the highest bracket reached by income. */
function _marginalBracketRate(income, brackets) {
  if (income <= 0 || brackets.length === 0) return 0;
  let rate = 0;
  for (const [lo, r] of brackets) {
    if (income > lo) rate = r;
  }
  return rate;
}
