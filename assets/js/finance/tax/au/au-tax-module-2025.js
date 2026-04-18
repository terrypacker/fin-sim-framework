/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { AuTaxModule2026 } from './au-tax-module-2026.js';

/**
 * AuTaxModule2025 — AU tax classification rules for 2025.
 *
 * Extends AuTaxModule2026 with the same rules.  Override individual
 * _register*Tax() methods here when 2025 rules diverge from 2026
 * (e.g., different super tax rates, NR withholding rates).
 */
export class AuTaxModule2025 extends AuTaxModule2026 {
  get year() { return 2025; }
}
