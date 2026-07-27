/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HiStateTaxRates2030 } from './hi-state-tax-rates-2030.js';

/**
 * HiStateTaxRates2031 — Hawaii individual income tax, tax year 2031.
 *
 * Act 46 final standard-deduction step, effective 2031 "and thereafter": MFJ
 * $20,000 → $24,000, single $10,000 → $12,000. This is the terminal Hawaii
 * module — nothing in Act 46 changes after it, and neither the brackets nor the
 * deduction are inflation-indexed, so every later year files on this table.
 *
 * Source: Hawaii DOTAX Announcement No. 2024-03 (Act 46, SLH 2024).
 */
export class HiStateTaxRates2031 extends HiStateTaxRates2030 {
  get year() { return 2031; }

  constructor() {
    super();
    this._stdDeduction_mfj    = 24_000;
    this._stdDeduction_single = 12_000;
  }
}
