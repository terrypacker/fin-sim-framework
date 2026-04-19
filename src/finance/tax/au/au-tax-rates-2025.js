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
 * AuTaxRates2025 — Australian income tax rates for FY 2025-26.
 *
 * Source: ATO — 2025 Federal Budget; 30% bracket extended to $135k.
 * year=2025 denotes the financial year starting July 2025 (FY 2025-26).
 *
 * Key change from FY2024-25: the 32.5% bracket is replaced by 30%,
 * and the 30% rate now extends to $135,000 (up from $120,000 at 32.5%).
 */
export class AuTaxRates2025 extends AuTaxRatesBase {
  get year() { return 2025; }

  constructor() {
    super();

    // Resident rates (ATO FY2025-26)
    this._brackets = [
      [        0, 0.00],
      [   18_200, 0.19],
      [   45_000, 0.30],  // 30% bracket extended to $135k (was 32.5% to $120k)
      [  135_000, 0.37],
      [  190_000, 0.45],
    ];

    // Non-resident rates — unchanged from FY2024-25 (ATO FY2025-26)
    this._nonResidentBrackets = [
      [        0, 0.325],
      [  135_000, 0.37],
      [  190_000, 0.45],
    ];

    // Medicare levy — thresholds unchanged from FY2024-25
    this._medicareLevy = { rate: 0.02, lowerThreshold: 26_000, phaseInRate: 0.10 };
  }
}
