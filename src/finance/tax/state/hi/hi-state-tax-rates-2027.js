/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HiStateTaxRates2026 } from './hi-state-tax-rates-2026.js';

/**
 * HiStateTaxRates2027 — Hawaii individual income tax, tax year 2027.
 *
 * Act 46 bracket step 2 of 3 — thresholds widen again; the 11% bracket starts at
 * $800,000 MFJ. Standard deductions are unchanged from 2026.
 *
 * Source: Hawaii DOTAX Announcement No. 2024-03 (Act 46, SLH 2024).
 */
export class HiStateTaxRates2027 extends HiStateTaxRates2026 {
  get year() { return 2027; }

  constructor() {
    super();
    this._brackets_mfj = [
      [      0, 0.014],
      [ 28_800, 0.032],
      [ 38_400, 0.055],
      [ 48_000, 0.064],
      [ 72_000, 0.068],
      [ 96_000, 0.072],
      [250_000, 0.076],
      [350_000, 0.079],
      [450_000, 0.0825],
      [550_000, 0.09],
      [650_000, 0.1],
      [800_000, 0.11],
    ];
    this._brackets_single = [
      [      0, 0.014],
      [ 14_400, 0.032],
      [ 19_200, 0.055],
      [ 24_000, 0.064],
      [ 36_000, 0.068],
      [ 48_000, 0.072],
      [125_000, 0.076],
      [175_000, 0.079],
      [225_000, 0.0825],
      [275_000, 0.09],
      [325_000, 0.1],
      [400_000, 0.11],
    ];
  }
}
