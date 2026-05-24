/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { UsTaxModule2026 } from './us-tax-module-2026.js';

/**
 * UsTaxModule2025 — US tax classification rules for 2025.
 *
 * Extends UsTaxModule2026 with the same rules.  Override individual
 * _register*Tax() methods here when 2025 rules diverge from 2026.
 */
export class UsTaxModule2025 extends UsTaxModule2026 {
  get year() { return 2025; }
}
