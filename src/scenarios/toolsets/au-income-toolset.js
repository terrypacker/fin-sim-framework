/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import {
  AuSeIncomeApplyReducer, AuSeIncomeHandler,
} from '../../finance/account-rules/au/au-income-classes.js';
import { ValueType } from '../../simulation-framework/type-registry.js';

/**
 * AU_INCOME toolset — AU income event mechanics (self-employment income).
 *
 * Capabilities: au-income
 * Depends on: AU_TAX
 */
export const AU_INCOME = {
  id: 'AU_INCOME',
  capabilities: ['au-income'],
  dependencies: ['AU_TAX'],

  types: {
    handlers: [AuSeIncomeHandler],
    reducers: [AuSeIncomeApplyReducer],
    actions: [
      { type: 'SE_INCOME_AU_APPLY', fields: { amount: ValueType.currency('AUD') } },
      { type: 'AU_SE_INCOME_TAX',   fields: { amount: ValueType.currency('AUD'), isAuResident: ValueType.boolean(), personKey: ValueType.text() } },
    ],
  },

  paramSchema(context) { return []; },
  state(context) { return {}; },
  schedules(context) { return []; },

  handlers(context) {
    return [new AuSeIncomeHandler()];
  },

  reducers(context) {
    return [new AuSeIncomeApplyReducer({ accountService: context.accountService })];
  },
};
