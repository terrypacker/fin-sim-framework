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
    this._ficaWageBase     = 176_100; // IRS Social Security wage base 2025
  }
}
