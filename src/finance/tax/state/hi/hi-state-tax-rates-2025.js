/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HiStateTaxRates2024 } from './hi-state-tax-rates-2024.js';

/**
 * HiStateTaxRates2025 — Hawaii individual income tax, tax year 2025.
 *
 * Act 46 (2024) bracket step 1 of 3. The rate ladder is unchanged (twelve
 * brackets, 1.4% → 11%); every threshold widens, and the top bracket starts at
 * $650,000 MFJ instead of $400,000. Standard deductions are unchanged from 2024.
 *
 * Source: Hawaii DOTAX Announcement No. 2024-03 (Act 46, SLH 2024).
 */
export class HiStateTaxRates2025 extends HiStateTaxRates2024 {
  get year() { return 2025; }

  constructor() {
    super();
    this._brackets_mfj = [
      [      0, 0.014],
      [ 19_200, 0.032],
      [ 28_800, 0.055],
      [ 38_400, 0.064],
      [ 48_000, 0.068],
      [ 72_000, 0.072],
      [ 96_000, 0.076],
      [250_000, 0.079],
      [350_000, 0.0825],
      [450_000, 0.09],
      [550_000, 0.1],
      [650_000, 0.11],
    ];
    this._brackets_single = [
      [      0, 0.014],
      [  9_600, 0.032],
      [ 14_400, 0.055],
      [ 19_200, 0.064],
      [ 24_000, 0.068],
      [ 36_000, 0.072],
      [ 48_000, 0.076],
      [125_000, 0.079],
      [175_000, 0.0825],
      [225_000, 0.09],
      [275_000, 0.1],
      [325_000, 0.11],
    ];
  }
}
