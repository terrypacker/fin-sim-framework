/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { UsTaxModule2025 } from './us-tax-module-2025.js';

/**
 * UsTaxModule2024 — US tax classification rules for 2024.
 *
 * Extends UsTaxModule2025 with the same income classification rules.
 * Override individual reducer methods here when 2024 classification
 * rules diverge from 2025 (e.g. different penalty gates).
 */
export class UsTaxModule2024 extends UsTaxModule2025 {
  get year() { return 2024; }
}
