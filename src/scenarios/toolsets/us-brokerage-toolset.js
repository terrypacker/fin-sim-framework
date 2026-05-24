/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ACCOUNT_ROLES } from '../../finance/state/account-roles.js';
import {
  FixedIncomeContributionApplyReducer, FixedIncomeWithdrawalApplyReducer,
  FixedIncomeEarningsApplyReducer, StockContributionApplyReducer,
  StockDividendApplyReducer, StockEarningsApplyReducer, StockWithdrawalApplyReducer,
  FixedIncomeContributionHandler, FixedIncomeWithdrawalHandler, FixedIncomeEarningsHandler,
  StockContributionHandler, StockDividendHandler, StockEarningsHandler, StockWithdrawalHandler,
} from '../../finance/account-rules/us/us-brokerage-classes.js';

/**
 * US_BROKERAGE toolset — US fixed-income and stock account mechanics.
 *
 * Capabilities: brokerage
 * Depends on: US_TAX
 *
 * Guards: handlers/reducers only registered when FIXED_INCOME or US_STOCK
 * accounts are present. Role constants remain in account-roles.js.
 */
export const US_BROKERAGE = {
  id: 'US_BROKERAGE',
  capabilities: ['brokerage'],
  dependencies: ['US_TAX'],

  paramSchema(context) { return []; },
  state(context) { return {}; },
  schedules(context) { return []; },

  handlers(context) {
    const hasFI = context.accounts.some(a => a.role === ACCOUNT_ROLES.FIXED_INCOME);
    const hasST = context.accounts.some(a => a.role === ACCOUNT_ROLES.US_STOCK);
    if (!hasFI && !hasST) return [];
    const handlers = [];
    if (hasFI) handlers.push(
      new FixedIncomeContributionHandler(),
      new FixedIncomeWithdrawalHandler(),
      new FixedIncomeEarningsHandler(),
    );
    if (hasST) handlers.push(
      new StockContributionHandler(),
      new StockDividendHandler(),
      new StockEarningsHandler(),
      new StockWithdrawalHandler(),
    );
    return handlers;
  },

  reducers(context) {
    const hasFI = context.accounts.some(a => a.role === ACCOUNT_ROLES.FIXED_INCOME);
    const hasST = context.accounts.some(a => a.role === ACCOUNT_ROLES.US_STOCK);
    if (!hasFI && !hasST) return [];
    const accountService = context.accountService;
    const reducers = [];
    if (hasFI) reducers.push(
      new FixedIncomeContributionApplyReducer({ accountService }),
      new FixedIncomeWithdrawalApplyReducer({ accountService }),
      new FixedIncomeEarningsApplyReducer({ accountService }),
    );
    if (hasST) reducers.push(
      new StockContributionApplyReducer({ accountService }),
      new StockDividendApplyReducer({ accountService }),
      new StockEarningsApplyReducer({ accountService }),
      new StockWithdrawalApplyReducer({ accountService }),
    );
    return reducers;
  },
};
