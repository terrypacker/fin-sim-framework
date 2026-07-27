/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HiStateTaxRates2025 } from './hi-state-tax-rates-2025.js';

/**
 * HiStateTaxRates2026 — Hawaii individual income tax, tax year 2026.
 *
 * Act 46 standard-deduction step: MFJ $8,800 → $16,000, single $4,400 → $8,000.
 * Brackets are unchanged from 2025.
 *
 * Source: Hawaii DOTAX Announcement No. 2024-03 (Act 46, SLH 2024).
 */
export class HiStateTaxRates2026 extends HiStateTaxRates2025 {
  get year() { return 2026; }

  constructor() {
    super();
    this._stdDeduction_mfj    = 16_000;
    this._stdDeduction_single = 8_000;
  }
}
