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
  SsIncomeApplyReducer, WagesIncomeApplyReducer, WagesWithheldApplyReducer,
  SeIncomeUsApplyReducer, BonusApplyReducer, CompanySaleApplyReducer,
  SsIncomeHandler, WagesIncomeHandler, WagesWithheldHandler,
  SeIncomeUsHandler, BonusHandler, CompanySaleHandler,
} from '../../finance/account-rules/us/us-income-classes.js';

/**
 * US_INCOME toolset — US income event mechanics (SS, wages, SE, bonus, company sale).
 *
 * Capabilities: us-income
 * Depends on: US_TAX
 *
 * No guard: income reducers/handlers are always registered; they process events
 * that only fire when income is actually dispatched.
 */
export const US_INCOME = {
  id: 'US_INCOME',
  capabilities: ['us-income'],
  dependencies: ['US_TAX'],

  paramSchema(context) { return []; },
  state(context) { return {}; },
  schedules(context) { return []; },

  handlers(context) {
    return [
      new SsIncomeHandler(),
      new WagesIncomeHandler(),
      new WagesWithheldHandler(),
      new SeIncomeUsHandler(),
      new BonusHandler(),
      new CompanySaleHandler(),
    ];
  },

  reducers(context) {
    const accountService = context.accountService;
    return [
      new SsIncomeApplyReducer({ accountService }),
      new WagesIncomeApplyReducer({ accountService }),
      new WagesWithheldApplyReducer({ accountService }),
      new SeIncomeUsApplyReducer({ accountService }),
      new BonusApplyReducer({ accountService }),
      new CompanySaleApplyReducer({ accountService }),
    ];
  },
};
