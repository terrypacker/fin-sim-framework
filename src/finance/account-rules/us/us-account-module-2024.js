/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { UsAccountModule2025 } from './us-account-module-2025.js';

/**
 * UsAccountModule2024 — US account mechanics rules for 2024.
 *
 * Extends UsAccountModule2025 with the same rules.  Override individual
 * _register*() methods here when 2024 account rules diverge from 2025
 * (e.g. different contribution limits, age gates).
 */
export class UsAccountModule2024 extends UsAccountModule2025 {
  get year() { return 2024; }
}
