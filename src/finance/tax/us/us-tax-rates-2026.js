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
import { ficaWageBase } from './fica-rates.js';

/**
 * UsTaxRates2026 — US federal tax rates for tax year 2026.
 *
 * Source: IRS Rev. Proc. 2025-32 (the first inflation adjustment made under the
 * permanent OBBBA rate schedule — the 2026 thresholds are NOT a plain CPI step
 * up from 2025, so they cannot be reproduced by inflating the 2025 module).
 * Filing status: Married Filing Jointly (MFJ) and Single.
 */
export class UsTaxRates2026 extends UsTaxRatesBase {
  get year() { return 2026; }

  constructor() {
    super();

    // MFJ ordinary income brackets (IRS Rev. Proc. 2025-32)
    this._brackets_mfj = [
      [        0, 0.10],
      [   24_800, 0.12],
      [  100_800, 0.22],
      [  211_400, 0.24],
      [  403_550, 0.32],
      [  512_450, 0.35],
      [  768_700, 0.37],
    ];

    // MFJ long-term capital gains brackets
    this._ltcg_mfj = [
      [        0, 0.00],
      [   98_900, 0.15],
      [  613_700, 0.20],
    ];

    this._stdDeduction_mfj = 32_200;

    // Single ordinary income brackets (IRS Rev. Proc. 2025-32)
    this._brackets_single = [
      [        0, 0.10],
      [   12_400, 0.12],
      [   50_400, 0.22],
      [  105_700, 0.24],
      [  201_775, 0.32],
      [  256_225, 0.35],
      [  640_600, 0.37],
    ];

    // Single long-term capital gains brackets
    this._ltcg_single = [
      [        0, 0.00],
      [   49_450, 0.15],
      [  545_500, 0.20],
    ];

    this._stdDeduction_single = 16_100;
    this._ficaWageBase        = ficaWageBase(2026);  // §3121(a)(1), from fica-rates.js
    this._feieCap             = 132_900; // Foreign Earned Income Exclusion cap 2026 (IRC §911)
  }
}
