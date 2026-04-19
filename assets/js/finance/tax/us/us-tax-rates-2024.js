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
 * UsTaxRates2024 — US federal tax rates for tax year 2024.
 *
 * Source: IRS Rev. Proc. 2023-34.
 * Filing status: Married Filing Jointly (MFJ).
 */
export class UsTaxRates2024 extends UsTaxRatesBase {
  get year() { return 2024; }

  constructor() {
    super();

    // MFJ ordinary income brackets (IRS Rev. Proc. 2023-34)
    this._brackets_mfj = [
      [        0, 0.10],
      [   23_200, 0.12],
      [   94_300, 0.22],
      [  201_050, 0.24],
      [  383_900, 0.32],
      [  487_450, 0.35],
      [  731_200, 0.37],
    ];

    // MFJ long-term capital gains brackets
    this._ltcg_mfj = [
      [        0, 0.00],
      [   94_050, 0.15],
      [  583_750, 0.20],
    ];

    this._stdDeduction_mfj = 29_200;
    this._ficaWageBase     = 168_600; // IRS Social Security wage base 2024
  }
}
