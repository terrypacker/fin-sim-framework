/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { AuTaxDocument2026 } from './au-tax-document-2026.js';

/**
 * AuTaxDocument2025 — Australian individual tax document formatter for FY2025-26.
 *
 * Extends AuTaxDocument2026 with the same structure.  Override generate()
 * here when the FY2025-26 document layout diverges from FY2026-27.
 */
export class AuTaxDocument2025 extends AuTaxDocument2026 {
  get year() { return 2025; }
}
