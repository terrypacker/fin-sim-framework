/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HiStateTaxRates2029 } from './hi-state-tax-rates-2029.js';

/**
 * HiStateTaxRates2030 — Hawaii individual income tax, tax year 2030.
 *
 * Act 46 standard-deduction step: MFJ $18,000 → $20,000, single $9,000 → $10,000.
 * Brackets are unchanged from 2029.
 *
 * Source: Hawaii DOTAX Announcement No. 2024-03 (Act 46, SLH 2024).
 */
export class HiStateTaxRates2030 extends HiStateTaxRates2029 {
  get year() { return 2030; }

  constructor() {
    super();
    this._stdDeduction_mfj    = 20_000;
    this._stdDeduction_single = 10_000;
  }
}
