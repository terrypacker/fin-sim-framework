/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { AuTaxDocument2025 } from './au-tax-document-2025.js';

/**
 * AuTaxDocument2024 — Australian individual tax document formatter for FY2024-25.
 *
 * Extends AuTaxDocument2025 with the same structure.  Override generate()
 * here when the FY2024-25 document layout diverges from FY2025-26.
 */
export class AuTaxDocument2024 extends AuTaxDocument2025 {
  get year() { return 2024; }
}
