/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { UsTaxRatesBase } from './us-tax-rates-base.js';

/**
 * Return the gross ordinary income (usOrdinaryIncomeYTD) at the TOP of the
 * MFJ ordinary-income bracket with the given marginal rate, for the given year.
 *
 * "Top of bracket" = lower threshold of the next higher bracket (in taxable-income
 * space) + standard deduction.  The result is the usOrdinaryIncomeYTD level at
 * which a household crosses into the next bracket.
 *
 * Brackets are inflation-indexed from the 2025 base using the provided annual rate.
 * Returns Infinity for the 37% (top) bracket.
 *
 * @param {number} rate            - Target marginal rate, e.g. 0.22
 * @param {number} year            - Tax year to compute for
 * @param {number} annualInflation - Annual inflation rate for bracket indexing (default 0.03)
 * @returns {number}
 */
export function usBracketGrossIncomeCeiling(rate, year, annualInflation = 0.03) {
  const base    = new UsTaxRates2025();
  const factor  = Math.pow(1 + annualInflation, year - 2025);
  const brackets = base._brackets_mfj.map(([t, r]) => [t * factor, r]);
  const stdDed   = base._stdDeduction_mfj * factor;

  const idx = brackets.findIndex(([, r]) => r === rate);
  if (idx < 0 || idx + 1 >= brackets.length) return Infinity;
  return brackets[idx + 1][0] + stdDed;
}

/**
 * UsTaxRates2025 — US federal tax rates for tax year 2025.
 *
 * Source: IRS Rev. Proc. 2024-40.
 * Filing status: Married Filing Jointly (MFJ).
 */
export class UsTaxRates2025 extends UsTaxRatesBase {
  get year() { return 2025; }

  constructor() {
    super();

    // MFJ ordinary income brackets (IRS Rev. Proc. 2024-40)
    this._brackets_mfj = [
      [        0, 0.10],
      [   23_850, 0.12],
      [   96_950, 0.22],
      [  206_700, 0.24],
      [  394_600, 0.32],
      [  501_050, 0.35],
      [  751_600, 0.37],
    ];

    // MFJ long-term capital gains brackets
    this._ltcg_mfj = [
      [        0, 0.00],
      [   96_700, 0.15],
      [  600_050, 0.20],
    ];

    this._stdDeduction_mfj = 30_000;

    // Single ordinary income brackets (IRS Rev. Proc. 2024-40)
    this._brackets_single = [
      [        0, 0.10],
      [   11_925, 0.12],
      [   48_475, 0.22],
      [  103_350, 0.24],
      [  197_300, 0.32],
      [  250_525, 0.35],
      [  626_350, 0.37],
    ];

    // Single long-term capital gains brackets
    this._ltcg_single = [
      [        0, 0.00],
      [   48_350, 0.15],
      [  533_400, 0.20],
    ];

    this._stdDeduction_single = 15_000;
    this._ficaWageBase        = 176_100; // IRS Social Security wage base 2025
  }
}
