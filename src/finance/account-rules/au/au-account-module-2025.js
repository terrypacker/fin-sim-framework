/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { AuAccountModule2026 } from './au-account-module-2026.js';

/**
 * AuAccountModule2025 — AU account mechanics rules for 2025.
 *
 * Extends AuAccountModule2026 with the same rules.  Override individual
 * _register*() methods here when 2025 account rules diverge from 2026
 * (e.g., different superannuation preservation age, contribution caps).
 */
export class AuAccountModule2025 extends AuAccountModule2026 {
  get year() { return 2025; }
}
