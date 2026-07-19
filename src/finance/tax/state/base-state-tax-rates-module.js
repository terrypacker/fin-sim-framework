/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import {
  applyBracketsDetailed,
  marginalBracketRate as _marginalBracketRate,
  flatRateBand,
} from '../bracket-schedule.js';

/**
 * BaseStateTaxRatesModule — abstract base for US state + year income-tax rate
 * modules (design 34). The state analog of UsTaxRatesBase.
 *
 * `computeTax(state)` derives state taxable income from the household state
 * accumulators (`stateOrdinaryIncomeYTD`, `statePensionIncomeYTD`,
 * `stateSsIncomeYTD`, `stateCapitalGainsYTD`) and applies the state's brackets,
 * deduction, and treatment flags. All cross-state variation lives in the flags
 * a subclass sets — most states only set brackets + a standard deduction.
 *
 * Treatment flags (subclass-settable):
 *   hasIncomeTax            — false ⇒ zero tax (e.g. South Dakota). No-op states.
 *   _taxesSocialSecurity    — true ⇒ 85% of gross SS is taxable ordinary income.
 *   _pensionExclusionFraction — fraction of statePensionIncomeYTD excluded (HI=1).
 *   _capitalGainsMode       — 'ordinary' (fold CG into the bracket base) or
 *                             'alternative' (tax CG separately at _capitalGainsAltRate, HI).
 *
 * Filing status follows the federal `usFilingSingle` flag for parity.
 */
export class BaseStateTaxRatesModule {
  /** @returns {string}  two-letter state code, e.g. 'NE' | 'HI' | 'SD' */
  get stateCode() { throw new Error(`${this.constructor.name}: stateCode not implemented`); }
  /** @returns {number}  tax year, e.g. 2024 */
  get year()      { throw new Error(`${this.constructor.name}: year not implemented`); }

  /** States with no individual income tax set this false (SD). */
  hasIncomeTax = true;

  // Subclasses set the following in their constructors:
  _brackets_mfj    = [];   // [[threshold, rate], ...] ascending by threshold
  _brackets_single = [];
  _stdDeduction_mfj    = 0;
  _stdDeduction_single = 0;

  _taxesSocialSecurity      = false;  // most modeled states exempt SS
  _pensionExclusionFraction = 0;      // 0 = pension fully taxable; 1 = fully excluded (HI)
  _capitalGainsMode         = 'ordinary'; // 'ordinary' | 'alternative'
  _capitalGainsAltRate      = 0;      // used when mode === 'alternative' (HI 0.0725)

  computeTax(state) {
    const {
      stateOrdinaryIncomeYTD = 0,
      statePensionIncomeYTD  = 0,
      stateSsIncomeYTD       = 0,
      stateCapitalGainsYTD   = 0,
      usFilingSingle         = false,
    } = state;

    const filingStatus = usFilingSingle ? 'Single' : 'Married Filing Jointly';

    if (!this.hasIncomeTax) {
      return _zeroResult(this.stateCode, filingStatus, {
        stateOrdinaryIncomeYTD, statePensionIncomeYTD, stateSsIncomeYTD, stateCapitalGainsYTD,
      });
    }

    const brackets     = usFilingSingle ? this._brackets_single     : this._brackets_mfj;
    const stdDeduction = usFilingSingle ? this._stdDeduction_single : this._stdDeduction_mfj;

    const pensionTaxable = Math.max(0, statePensionIncomeYTD) * (1 - this._pensionExclusionFraction);
    const ssTaxable      = this._taxesSocialSecurity ? Math.max(0, stateSsIncomeYTD) * 0.85 : 0;
    const cg             = Math.max(0, stateCapitalGainsYTD);
    const cgInOrdinary   = this._capitalGainsMode === 'alternative' ? 0 : cg;

    const taxableOrdinary  = Math.max(0, stateOrdinaryIncomeYTD + pensionTaxable + ssTaxable + cgInOrdinary - stdDeduction);
    // `.tax` is identical to the scalar applyBrackets; the bands ride along for the
    // worksheet export (design 71 §11.3).
    const ordinarySchedule = applyBracketsDetailed(taxableOrdinary, brackets);
    const ordinaryTax      = ordinarySchedule.tax;

    // Hawaii-style alternative capital-gains tax: CG taxed at a flat preferential
    // rate instead of folding into the ordinary base.
    const capitalGainsTax = this._capitalGainsMode === 'alternative' ? cg * this._capitalGainsAltRate : 0;

    const netLiability = Math.max(0, ordinaryTax + capitalGainsTax);

    const totalGrossIncome = stateOrdinaryIncomeYTD + Math.max(0, statePensionIncomeYTD) + Math.max(0, stateSsIncomeYTD) + cg;
    const effectiveRate    = totalGrossIncome > 0 ? netLiability / totalGrossIncome : 0;
    const marginalRate     = _marginalBracketRate(taxableOrdinary, brackets);

    return {
      stateCode:    this.stateCode,
      filingStatus,
      inputs: {
        ordinaryIncome:  stateOrdinaryIncomeYTD,
        pensionIncome:   statePensionIncomeYTD,
        socialSecurity:  stateSsIncomeYTD,
        capitalGains:    stateCapitalGainsYTD,
        standardDeduction: stdDeduction,
        pensionExclusionFraction: this._pensionExclusionFraction,
        taxesSocialSecurity:      this._taxesSocialSecurity,
      },
      taxableIncome:   taxableOrdinary,
      ordinaryTax,
      capitalGainsTax,
      netLiability,
      effectiveRate,
      marginalRate,
      brackets: {
        table:    filingStatus === 'Single' ? 'Single' : 'MFJ',
        ordinary: ordinarySchedule.bands,
        // Only meaningful in 'alternative' mode (Hawaii-style flat preferential CG
        // rate); null when capital gains are folded into the ordinary base, where
        // they are already inside the ordinary bands above.
        capitalGains: this._capitalGainsMode === 'alternative'
          ? flatRateBand(this._capitalGainsAltRate, cg, capitalGainsTax)
          : null,
      },
      lineItems: [
        { label: 'State Ordinary Income',          amount:  stateOrdinaryIncomeYTD },
        { label: 'Pension/Retirement Income',      amount:  statePensionIncomeYTD },
        { label: 'Pension Excluded',               amount: -(statePensionIncomeYTD - pensionTaxable) },
        { label: 'Social Security (taxable)',      amount:  ssTaxable },
        { label: 'Capital Gains (in ordinary)',    amount:  cgInOrdinary },
        { label: 'Standard Deduction',             amount: -stdDeduction },
        { label: 'Taxable Income',                 amount:  taxableOrdinary },
        { label: 'Tax on Ordinary Income',         amount:  ordinaryTax },
        { label: 'Capital Gains Tax (alternative)', amount:  capitalGainsTax },
        { label: 'Net State Tax Liability',        amount:  netLiability },
      ],
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
//
// `_applyBrackets` / `_marginalBracketRate` no longer live here: design 71 §3 moved
// them (and the byte-identical copies in the US federal and AU rate modules) to the
// shared `../bracket-schedule.js`, imported at the top under the same local names.
// The state per-band breakdown is deferred with the state worksheet (design 71 §9).

function _zeroResult(stateCode, filingStatus, inputs) {
  return {
    stateCode, filingStatus, inputs,
    taxableIncome: 0, ordinaryTax: 0, capitalGainsTax: 0,
    netLiability: 0, effectiveRate: 0, marginalRate: 0,
    // A no-income-tax state has no schedule at all — an empty band list, not a
    // missing field, so consumers can read `brackets.ordinary` unconditionally.
    brackets: { table: filingStatus === 'Single' ? 'Single' : 'MFJ', ordinary: [], capitalGains: null },
    lineItems: [{ label: 'Net State Tax Liability', amount: 0 }],
  };
}
