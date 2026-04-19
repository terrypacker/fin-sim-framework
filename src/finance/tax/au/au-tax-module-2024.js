/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { AuTaxModule2025 } from './au-tax-module-2025.js';

/**
 * AuTaxModule2024 — AU tax classification rules for FY 2024-25.
 *
 * Extends AuTaxModule2025 with the same income classification rules.
 * year=2024 denotes the financial year starting July 2024 (FY 2024-25).
 * Override individual reducer methods here when FY2024-25 classification
 * rules diverge from FY2025-26 (e.g. different super rates, NR withholding).
 */
export class AuTaxModule2024 extends AuTaxModule2025 {
  get year() { return 2024; }
}
