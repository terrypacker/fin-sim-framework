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
 *   auSuperTaxYTD, auFrankingCreditYTD, people[*].residency
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
    } = state;

    // Resident if any person in state.people has residency === 'AUS'
    const primaryKey   = Object.keys(state.people ?? {})[0];
    const isAuResident = state.people?.[primaryKey]?.residency === 'AUS';

    if (isAuResident) {
      // Resident: apply 50% CGT discount (ATO Division 115)
      const cgtDiscount        = auCapitalGainsYTD * 0.5;
      const discountedIncome   = auOrdinaryIncomeYTD + cgtDiscount;
      const assessableIncome   = Math.max(0, discountedIncome);
      const baseTax            = _applyBrackets(assessableIncome, this._brackets);
      const medicareLevy       = this._computeMedicareLevy(discountedIncome);
      const frankingOffset     = Math.min(auFrankingCreditYTD, baseTax);
      const grossTax           = Math.max(0, baseTax + medicareLevy - frankingOffset) + auSuperTaxYTD;
      const netLiability       = grossTax;

      const totalGrossIncome   = auOrdinaryIncomeYTD + auCapitalGainsYTD;
      const effectiveRate      = totalGrossIncome > 0 ? netLiability / totalGrossIncome : 0;
      const marginalRate       = _marginalBracketRate(assessableIncome, this._brackets);

      return {
        inputs: {
          ordinaryIncome:         auOrdinaryIncomeYTD,
          capitalGains:           auCapitalGainsYTD,
          nonResidentWithholding: auNonResidentWithholdingYTD,
          superTax:               auSuperTaxYTD,
          frankingCredits:        auFrankingCreditYTD,
          isResident:             true,
        },
        isResident:               true,
        cgtDiscount,
        discountedCapitalGains:   cgtDiscount,
        assessableIncome,
        baseTax,
        medicareLevy,
        frankingOffset,
        nonResidentWithholdingTax: 0,
        grossTax:                 baseTax + medicareLevy + auSuperTaxYTD,
        credits:                  frankingOffset,
        netLiability,
        effectiveRate,
        marginalRate,
        lineItems: [
          { label: 'Ordinary Income',               amount:  auOrdinaryIncomeYTD },
          { label: 'Capital Gains (before discount)', amount: auCapitalGainsYTD },
          { label: 'CGT 50% Discount',              amount: -cgtDiscount },
          { label: 'Net Capital Gains',             amount:  cgtDiscount },
          { label: 'Total Assessable Income',       amount:  assessableIncome },
          { label: 'Tax on Income',                 amount:  baseTax },
          { label: 'Medicare Levy',                 amount:  medicareLevy },
          { label: 'Super Tax',                     amount:  auSuperTaxYTD },
          { label: 'Gross Tax',                     amount:  baseTax + medicareLevy + auSuperTaxYTD },
          { label: 'Franking Credits',              amount: -frankingOffset },
          { label: 'Net Tax Liability',             amount:  netLiability },
        ],
      };
    } else {
      // Non-resident: no CGT discount; NR withholding income taxed at flat 15% rate
      const totalIncome              = auOrdinaryIncomeYTD + auCapitalGainsYTD;
      const assessableIncome         = Math.max(0, totalIncome);
      const baseTax                  = _applyBrackets(assessableIncome, this._nonResidentBrackets);
      const nonResidentWithholdingTax = auNonResidentWithholdingYTD * 0.15;
      const grossTax                 = Math.max(0, baseTax) + auSuperTaxYTD + nonResidentWithholdingTax;
      const netLiability             = grossTax;

      const totalGrossIncome   = totalIncome + auNonResidentWithholdingYTD;
      const effectiveRate      = totalGrossIncome > 0 ? netLiability / totalGrossIncome : 0;
      const marginalRate       = _marginalBracketRate(assessableIncome, this._nonResidentBrackets);

      return {
        inputs: {
          ordinaryIncome:         auOrdinaryIncomeYTD,
          capitalGains:           auCapitalGainsYTD,
          nonResidentWithholding: auNonResidentWithholdingYTD,
          superTax:               auSuperTaxYTD,
          frankingCredits:        auFrankingCreditYTD,
          isResident:             false,
        },
        isResident:               false,
        cgtDiscount:              0,
        discountedCapitalGains:   auCapitalGainsYTD,
        assessableIncome,
        baseTax,
        medicareLevy:             0,
        frankingOffset:           0,
        nonResidentWithholdingTax,
        grossTax,
        credits:                  0,
        netLiability,
        effectiveRate,
        marginalRate,
        lineItems: [
          { label: 'Ordinary Income',                         amount:  auOrdinaryIncomeYTD },
          { label: 'Capital Gains (no CGT discount)',         amount:  auCapitalGainsYTD },
          { label: 'Total Assessable Income',                 amount:  assessableIncome },
          { label: 'Tax on Income (Non-Resident Brackets)',   amount:  baseTax },
          { label: 'Non-Resident Withholding Tax (15%)',      amount:  nonResidentWithholdingTax },
          { label: 'Super Tax',                               amount:  auSuperTaxYTD },
          { label: 'Net Tax Liability',                       amount:  netLiability },
        ],
      };
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

/** Return the marginal rate of the highest bracket reached by income. */
function _marginalBracketRate(income, brackets) {
  if (income <= 0 || brackets.length === 0) return 0;
  let rate = 0;
  for (const [lo, r] of brackets) {
    if (income > lo) rate = r;
  }
  return rate;
}
