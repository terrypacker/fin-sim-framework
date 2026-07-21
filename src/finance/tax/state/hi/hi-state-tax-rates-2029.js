/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HiStateTaxRates2028 } from './hi-state-tax-rates-2028.js';

/**
 * HiStateTaxRates2029 — Hawaii individual income tax, tax year 2029.
 *
 * Act 46 bracket step 3 of 3 — the final schedule, effective 2029 "and
 * thereafter". The 11% bracket starts at $950,000 MFJ. Only the standard
 * deduction moves after this (2030, 2031); brackets are not inflation-indexed,
 * so this table is the terminal one for every later year.
 *
 * Source: Hawaii DOTAX Announcement No. 2024-03 (Act 46, SLH 2024).
 */
export class HiStateTaxRates2029 extends HiStateTaxRates2028 {
  get year() { return 2029; }

  constructor() {
    super();
    this._brackets_mfj = [
      [      0, 0.014],
      [ 38_400, 0.032],
      [ 48_000, 0.055],
      [ 72_000, 0.064],
      [ 96_000, 0.068],
      [250_000, 0.072],
      [350_000, 0.076],
      [450_000, 0.079],
      [550_000, 0.0825],
      [650_000, 0.09],
      [800_000, 0.1],
      [950_000, 0.11],
    ];
    this._brackets_single = [
      [      0, 0.014],
      [ 19_200, 0.032],
      [ 24_000, 0.055],
      [ 36_000, 0.064],
      [ 48_000, 0.068],
      [125_000, 0.072],
      [175_000, 0.076],
      [225_000, 0.079],
      [275_000, 0.0825],
      [325_000, 0.09],
      [400_000, 0.1],
      [475_000, 0.11],
    ];
  }
}
