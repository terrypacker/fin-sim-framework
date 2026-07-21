/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { AuTaxRatesBase } from './au-tax-rates-base.js';

/**
 * AuTaxRates2024 — Australian income tax rates for FY 2024-25.
 *
 * Source: ATO — Stage 3 tax cuts effective 1 July 2024.
 * year=2024 denotes the financial year starting July 2024 (FY 2024-25).
 */
export class AuTaxRates2024 extends AuTaxRatesBase {
  get year() { return 2024; }

  constructor() {
    super();

    // Resident rates — Stage 3 tax cuts (ATO FY2024-25). The whole schedule here
    // used to be the pre-Stage-3 (FY2023-24) one — 19%/32.5% at $120k/$180k —
    // despite the comment; Stage 3 applied from 1 Jul 2024.
    this._brackets = [
      [        0, 0.00],
      [   18_200, 0.16],   // 19% → 16%
      [   45_000, 0.30],   // 32.5% → 30%, ceiling $120k → $135k
      [  135_000, 0.37],
      [  190_000, 0.45],
    ];

    // Non-resident rates — no tax-free threshold (ATO FY2024-25).
    // Stage 3 (from 1 Jul 2024) cut the first foreign-resident rate 32.5% → 30%
    // AND widened its ceiling $120k → $135k. Only the threshold half of that
    // change had been applied here, pairing the old rate with the new band.
    this._nonResidentBrackets = [
      [        0, 0.30],
      [  135_000, 0.37],
      [  190_000, 0.45],
    ];

    // Medicare levy — 2% with low-income phase-in (ATO FY2024-25)
    this._medicareLevy = { rate: 0.02, lowerThreshold: 26_000, phaseInRate: 0.10 };
  }
}
