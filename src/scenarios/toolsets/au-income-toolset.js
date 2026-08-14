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
  AuWagesIncomeApplyReducer,
} from '../../finance/account-rules/au/au-income-classes.js';
import { ValueType } from '../../simulation-framework/type-registry.js';

/**
 * AU_INCOME toolset — AU income event mechanics (self-employment income,
 * AU-source wages).
 *
 * The AU wage apply reducer (design 50) is dispatched by MonthlyWagesHandler
 * (registered by the retirement toolsets) for any person whose wageCurrency is
 * AUD, so it credits the AUD account and chains AU_WAGES_INCOME_TAX.
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
    reducers: [AuSeIncomeApplyReducer, AuWagesIncomeApplyReducer],
    actions: [
      // workCountry — see the US_INCOME manifest: the design 73 source test, stamped by
      // MonthlyWagesHandler on the apply and forwarded to AU_WAGES_INCOME_TAX, which is
      // where au-tax-module-2026 reads it to decide whether the wage is AU-sourced.
      { type: 'SE_INCOME_AU_APPLY',    fields: { amount: ValueType.currency('AUD'), residency: ValueType.text(), personKey: ValueType.text(), targetKey: ValueType.text(), workCountry: ValueType.text() } },
      { type: 'AU_SE_INCOME_TAX',      fields: { amount: ValueType.currency('AUD'), residency: ValueType.text(), personKey: ValueType.text() } },
      { type: 'AU_WAGES_INCOME_APPLY', fields: { amount: ValueType.currency('AUD'), residency: ValueType.text(), personKey: ValueType.text(), targetKey: ValueType.text(), workCountry: ValueType.text() } },
      { type: 'AU_WAGES_INCOME_TAX',   fields: { amount: ValueType.currency('AUD'), residency: ValueType.text(), personKey: ValueType.text(), workCountry: ValueType.text() } },
    ],
  },

  paramSchema(context) { return []; },
  state(context) { return {}; },
  schedules(context) { return []; },

  handlers(context) {
    return [new AuSeIncomeHandler()];
  },

  reducers(context) {
    return [
      new AuSeIncomeApplyReducer({ accountService: context.accountService, stateRegistry: context.stateRegistry }),
      new AuWagesIncomeApplyReducer({ accountService: context.accountService, stateRegistry: context.stateRegistry }),
    ];
  },
};
