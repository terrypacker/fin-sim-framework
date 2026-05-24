/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { UsTaxDocument2026 } from './us-tax-document-2026.js';

/**
 * UsTaxDocument2025 — US federal income tax document formatter for 2025.
 *
 * Extends UsTaxDocument2026 with the same structure.  Override generate()
 * here when the 2025 document layout diverges from 2026.
 */
export class UsTaxDocument2025 extends UsTaxDocument2026 {
  get year() { return 2025; }
}
