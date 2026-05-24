/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { UsTaxDocument2025 } from './us-tax-document-2025.js';

/**
 * UsTaxDocument2024 — US federal income tax document formatter for 2024.
 *
 * Extends UsTaxDocument2025 with the same structure.  Override generate()
 * here when the 2024 document layout diverges from 2025.
 */
export class UsTaxDocument2024 extends UsTaxDocument2025 {
  get year() { return 2024; }
}
