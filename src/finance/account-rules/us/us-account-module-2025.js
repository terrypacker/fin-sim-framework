/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { UsAccountModule2026 } from './us-account-module-2026.js';

/**
 * UsAccountModule2025 — US account mechanics rules for 2025.
 *
 * Extends UsAccountModule2026 with the same rules.  Override individual
 * _register*() methods here when 2025 account rules diverge from 2026
 * (e.g., different contribution limits, age gates).
 */
export class UsAccountModule2025 extends UsAccountModule2026 {
  get year() { return 2025; }
}
