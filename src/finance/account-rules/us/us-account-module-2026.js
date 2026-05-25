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
import { getUsEarlyWithdrawalRules } from './us-early-withdrawal-rules.js';


/**
 * UsAccountModule2026 — US account rule hooks for 2026.
 *
 * Provides year-specific rule queries used by the AccountRulesEngine.
 * Handler and reducer registration is handled exclusively by toolsets.
 */
export class UsAccountModule2026 extends BaseAccountModule {
  get countryCode() { return 'US'; }
  get year()        { return 2026; }

  getEarlyWithdrawalRules(accountType) {
    return getUsEarlyWithdrawalRules(accountType, this.year);
  }
}
