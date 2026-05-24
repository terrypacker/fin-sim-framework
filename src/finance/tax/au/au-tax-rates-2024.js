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

    // Resident rates — Stage 3 tax cuts (ATO FY2024-25)
    this._brackets = [
      [        0, 0.00],
      [   18_200, 0.19],
      [   45_000, 0.325],
      [  120_000, 0.37],
      [  180_000, 0.45],
    ];

    // Non-resident rates — no tax-free threshold (ATO FY2024-25)
    this._nonResidentBrackets = [
      [        0, 0.325],
      [  135_000, 0.37],
      [  190_000, 0.45],
    ];

    // Medicare levy — 2% with low-income phase-in (ATO FY2024-25)
    this._medicareLevy = { rate: 0.02, lowerThreshold: 26_000, phaseInRate: 0.10 };
  }
}
