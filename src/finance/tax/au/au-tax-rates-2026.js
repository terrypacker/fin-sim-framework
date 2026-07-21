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
 * AuTaxRates2026 — Australian income tax rates for FY 2026-27.
 *
 * year=2026 denotes the financial year starting July 2026 (FY 2026-27).
 *
 * Key change from FY2025-26: the personal tax cut lowers the
 * $18,201–$45,000 bracket rate from 16% to 15% (legislated in the 2026-27
 * Budget package; the same package cuts it again to 14% from 1 July 2027).
 * CGT treatment is UNCHANGED — the flat 50% Division 115 discount still
 * applies. The CGT reform (indexation + 30% minimum tax) only affects CGT
 * events on/after 1 July 2027 and lands in AuTaxRates2027 (design 57 §6.2).
 *
 * NOTE: this class extends AuTaxRatesBase directly rather than AuTaxRates2025.
 * AuTaxRates2025 carries 19% on the $18,201–$45,000 band (au-tax-rates-2025.js),
 * which predates the Stage-3 cuts that set it to 16% from FY2024-25. That figure
 * looks like a pre-existing inaccuracy; correcting it is out of scope for design
 * 57, so this module sets the FY2026-27 brackets explicitly.
 */
export class AuTaxRates2026 extends AuTaxRatesBase {
  get year() { return 2026; }

  constructor() {
    super();

    // Resident rates (ATO FY2026-27) — $18,201–$45,000 band cut 16% → 15%.
    this._brackets = [
      [        0, 0.00],
      [   18_200, 0.15],  // 16% → 15% (FY2026-27 legislated personal tax cut)
      [   45_000, 0.30],
      [  135_000, 0.37],
      [  190_000, 0.45],
    ];

    // Non-resident rates — unchanged from FY2025-26.
    this._nonResidentBrackets = [
      [        0, 0.30],
      [  135_000, 0.37],
      [  190_000, 0.45],
    ];

    // Medicare levy — thresholds unchanged from FY2025-26.
    this._medicareLevy = { rate: 0.02, lowerThreshold: 26_000, phaseInRate: 0.10 };
  }
}
