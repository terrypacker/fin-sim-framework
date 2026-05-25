/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseAccountModule } from '../base-account-module.js';

/**
 * AuAccountModule2026 — AU account rule hooks for 2026.
 *
 * Provides year-specific rule queries used by the AccountRulesEngine.
 * Handler and reducer registration is handled exclusively by toolsets.
 */
export class AuAccountModule2026 extends BaseAccountModule {
  get countryCode() { return 'AU'; }
  get year()        { return 2026; }
}
