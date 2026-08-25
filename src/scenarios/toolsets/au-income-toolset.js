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
 * The AU wage apply reducer (design 50) is dispatched by PayrollHandler
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
      // PayrollHandler on the apply and forwarded to AU_WAGES_INCOME_TAX and
      // AU_SE_INCOME_TAX (design 73 §6b), which is where au-tax-module-2026 reads it to
      // decide whether the services income is AU-sourced.
      { type: 'SE_INCOME_AU_APPLY',    fields: { amount: ValueType.currency('AUD'), residency: ValueType.text(), personKey: ValueType.text(), targetKey: ValueType.text(), workCountry: ValueType.text() , netAmount: ValueType.currency('AUD'), splits: ValueType.any()} },
      { type: 'AU_SE_INCOME_TAX',      fields: { amount: ValueType.currency('AUD'), residency: ValueType.text(), personKey: ValueType.text(), workCountry: ValueType.text() } },
      // `sacrificed` — design 95 §9.1 phase 6b. How much of the package went to super
      // before this wage existed. `amount` is ALREADY net of it, unlike the US
      // withholding's `netAmount`, because sacrifice reduces assessable income as
      // well as cash. Declared or pickPayload strips it and the journal shows a wage
      // that shrank for no visible reason — the `alreadyNetted` defect from phase 5,
      // repeated on the one field that explains a smaller number.
      { type: 'AU_WAGES_INCOME_APPLY', fields: { amount: ValueType.currency('AUD'), residency: ValueType.text(), personKey: ValueType.text(), targetKey: ValueType.text(), workCountry: ValueType.text() , netAmount: ValueType.currency('AUD'), splits: ValueType.any(), sacrificed: ValueType.currency('AUD')} },
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
