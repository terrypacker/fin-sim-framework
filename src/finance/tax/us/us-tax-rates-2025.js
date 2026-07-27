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

// `usBracketGrossIncomeCeiling` used to live here, hard-pinned to the 2025 tables.
// It now resolves the year's registered statutory module and is exported from
// `tax-settle-service.js` (which owns the year→module registry), so the
// Roth-conversion ceilings track the same brackets the settle path applies.

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
    this._feieCap             = 130_000; // Foreign Earned Income Exclusion cap 2025 (IRC §911)
  }
}
