/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { AuAccountModule2025 } from './au-account-module-2025.js';

/**
 * AuAccountModule2024 — AU account mechanics rules for FY 2024-25.
 *
 * Extends AuAccountModule2025 with the same rules.
 * year=2024 denotes the financial year starting July 2024 (FY 2024-25).
 * Override individual _register*() methods here when FY2024-25 account
 * rules diverge from FY2025-26 (e.g. different superannuation caps).
 */
export class AuAccountModule2024 extends AuAccountModule2025 {
  get year() { return 2024; }
}
