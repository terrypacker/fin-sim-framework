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
 * SdStateTaxRates2024 — South Dakota, tax year 2024.
 *
 * South Dakota levies NO individual income tax. Modeled as a real (no-op)
 * module rather than a special case (design 34 §11): `hasIncomeTax = false`
 * makes `computeTax()` return a zero liability for any input. One module covers
 * every year via the highest-year-≤ fallback (SD has nothing to change). This
 * is the template for other no-tax states (TX, FL, WA, …).
 */
export class SdStateTaxRates2024 extends BaseStateTaxRatesModule {
  get stateCode() { return 'SD'; }
  get year()      { return 2024; }

  hasIncomeTax = false;
}
