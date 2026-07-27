/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HiStateTaxRates2027 } from './hi-state-tax-rates-2027.js';

/**
 * HiStateTaxRates2028 — Hawaii individual income tax, tax year 2028.
 *
 * Act 46 standard-deduction step: MFJ $16,000 → $18,000, single $8,000 → $9,000.
 * Brackets are unchanged from 2027.
 *
 * Source: Hawaii DOTAX Announcement No. 2024-03 (Act 46, SLH 2024).
 */
export class HiStateTaxRates2028 extends HiStateTaxRates2027 {
  get year() { return 2028; }

  constructor() {
    super();
    this._stdDeduction_mfj    = 18_000;
    this._stdDeduction_single = 9_000;
  }
}
