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
 * UsTaxRates2027 — US federal tax rates for tax year 2027.
 *
 * Source: IRS Rev. Proc. 2026-35, on disk at
 * `docs/us-tax/IRS-Rev-Proc-2026-35-Inflation-Adjustments-2027.txt`:
 * §3.01 Tables 1 and 3 (ordinary brackets), §3.03 (maximum zero / 15 percent rate
 * amounts), §3.15 (standard deduction), §3.41 (§911 exclusion).
 * Filing status: Married Filing Jointly (MFJ) and Single.
 */
export class UsTaxRates2027 extends UsTaxRatesBase {
  get year() { return 2027; }

  constructor() {
    super();

    // MFJ ordinary income brackets (Rev. Proc. 2026-35 §3.01 Table 1)
    this._brackets_mfj = [
      [        0, 0.10],
      [   25_600, 0.12],
      [  104_050, 0.22],
      [  218_250, 0.24],
      [  416_650, 0.32],
      [  529_100, 0.35],
      [  793_650, 0.37],
    ];

    // MFJ long-term capital gains brackets (§3.03)
    this._ltcg_mfj = [
      [        0, 0.00],
      [  102_100, 0.15],
      [  633_600, 0.20],
    ];

    this._stdDeduction_mfj = 33_200;   // §3.15

    // Single ordinary income brackets (§3.01 Table 3)
    this._brackets_single = [
      [        0, 0.10],
      [   12_800, 0.12],
      [   52_025, 0.22],
      [  109_125, 0.24],
      [  208_325, 0.32],
      [  264_550, 0.35],
      [  661_375, 0.37],
    ];

    // Single ("All Other Individuals") long-term capital gains brackets (§3.03)
    this._ltcg_single = [
      [        0, 0.00],
      [   51_050, 0.15],
      [  563_200, 0.20],
    ];

    this._stdDeduction_single = 16_600;   // §3.15
    this._ficaWageBase        = ficaWageBase(2027);  // §3121(a)(1), from fica-rates.js
    this._feieCap             = 137_300; // §3.41 — Foreign Earned Income Exclusion (IRC §911)
  }
}
