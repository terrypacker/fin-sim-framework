/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseStateTaxRatesModule } from '../base-state-tax-rates-module.js';

/**
 * NeStateTaxRates2024 — Nebraska individual income tax, tax year 2024.
 *
 * Source: Nebraska DOR 2024 rate schedules. Top rate 5.84% (LB 754 begins its
 * multi-year glide toward a flat 3.99% by 2027 — see NeStateTaxRates2025 for the
 * first step, which is exactly the year-over-year change the per-year modules exist for).
 *
 * Social Security: fully exempt from Nebraska income tax beginning 2024
 * (LB 873, accelerated). Retirement/pension distributions: taxed (no general
 * exclusion). Capital gains: taxed as ordinary income.
 *
 * Bracket figures are starting values; refine against the official schedule
 * (design 34 §12 Q1).
 */
export class NeStateTaxRates2024 extends BaseStateTaxRatesModule {
  get stateCode() { return 'NE'; }
  get year()      { return 2024; }

  constructor() {
    super();
    this._brackets_mfj = [
      [      0, 0.0246],
      [  7_390, 0.0351],
      [ 44_310, 0.0501],
      [ 71_360, 0.0584],
    ];
    this._brackets_single = [
      [      0, 0.0246],
      [  3_700, 0.0351],
      [ 22_170, 0.0501],
      [ 35_690, 0.0584],
    ];
    this._stdDeduction_mfj    = 15_000;
    this._stdDeduction_single =  7_500;

    this._taxesSocialSecurity      = false; // SS exempt 2024+
    this._pensionExclusionFraction = 0;     // pensions taxed
    this._capitalGainsMode         = 'ordinary';
  }
}
