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
 * HiStateTaxRates2024 — Hawaii individual income tax, tax year 2024.
 *
 * Source: Hawaii DOTAX 2024 rate schedules. Twelve brackets, top rate 11% —
 * among the highest state rates.
 *
 * Social Security: exempt. Employer-funded pensions / qualifying retirement
 * distributions: excluded (modeled as a full exclusion of statePensionIncomeYTD).
 * Capital gains: taxed under the alternative flat rate of 7.25% rather than as
 * ordinary income (design 34 §6, §12 Q2).
 *
 * Bracket figures are starting values; refine against the official schedule.
 */
export class HiStateTaxRates2024 extends BaseStateTaxRatesModule {
  get stateCode() { return 'HI'; }
  get year()      { return 2024; }

  constructor() {
    super();
    this._brackets_mfj = [
      [       0, 0.014],
      [   4_800, 0.032],
      [   9_600, 0.055],
      [  19_200, 0.064],
      [  28_800, 0.068],
      [  38_400, 0.072],
      [  48_000, 0.076],
      [  72_000, 0.079],
      [  96_000, 0.0825],
      [ 300_000, 0.09],
      [ 350_000, 0.10],
      [ 400_000, 0.11],
    ];
    this._brackets_single = [
      [       0, 0.014],
      [   2_400, 0.032],
      [   4_800, 0.055],
      [   9_600, 0.064],
      [  14_400, 0.068],
      [  19_200, 0.072],
      [  24_000, 0.076],
      [  36_000, 0.079],
      [  48_000, 0.0825],
      [ 150_000, 0.09],
      [ 175_000, 0.10],
      [ 200_000, 0.11],
    ];
    this._stdDeduction_mfj    = 4_400;
    this._stdDeduction_single = 2_200;

    this._taxesSocialSecurity      = false; // SS exempt
    this._pensionExclusionFraction = 1;     // employer pension / retirement distributions excluded
    this._capitalGainsMode         = 'alternative';
    this._capitalGainsAltRate      = 0.0725;
  }
}
