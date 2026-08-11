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
  StockDividendApplyReducer, BondCouponApplyReducer, StockEarningsApplyReducer, StockWithdrawalApplyReducer,
  FixedIncomeContributionHandler, FixedIncomeWithdrawalHandler, FixedIncomeEarningsHandler,
  StockContributionHandler, StockDividendHandler, StockEarningsHandler, StockWithdrawalHandler,
} from '../../finance/account-rules/us/us-brokerage-classes.js';
import { ValueType } from '../../simulation-framework/type-registry.js';

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

  types: {
    handlers: [FixedIncomeContributionHandler, FixedIncomeWithdrawalHandler, FixedIncomeEarningsHandler, StockContributionHandler, StockDividendHandler, StockEarningsHandler, StockWithdrawalHandler],
    reducers: [FixedIncomeContributionApplyReducer, FixedIncomeWithdrawalApplyReducer, FixedIncomeEarningsApplyReducer, StockContributionApplyReducer, StockDividendApplyReducer, BondCouponApplyReducer, StockEarningsApplyReducer, StockWithdrawalApplyReducer],
    actions: [
      { type: 'FIXED_INCOME_CONTRIBUTION_APPLY', fields: { amount: ValueType.currency('USD') } },
      { type: 'FIXED_INCOME_WITHDRAWAL_APPLY', family: 'WITHDRAWAL', fields: { amount: ValueType.currency('USD') } },
      { type: 'FIXED_INCOME_EARNINGS_APPLY',   fields: { amount: ValueType.currency('USD'), stateKey: ValueType.text(), residency: ValueType.text() } },
      { type: 'STOCK_CONTRIBUTION_APPLY',       fields: { amount: ValueType.currency('USD') } },
      { type: 'STOCK_DIVIDEND_APPLY',           fields: { amount: ValueType.currency('USD') } },
      { type: 'STOCK_DIVIDEND_TAX',             fields: { amount: ValueType.currency('USD'), residency: ValueType.text() , stateKey: ValueType.text()} },
      { type: 'BOND_COUPON_APPLY',              fields: { amount: ValueType.currency('USD'), federalTaxableAmount: ValueType.currency('USD'), stateTaxableAmount: ValueType.currency('USD'), stateKey: ValueType.text(), residency: ValueType.text() } },
      { type: 'BOND_COUPON_CASH_APPLY',         fields: { amount: ValueType.currency('USD'), federalTaxableAmount: ValueType.currency('USD'), stateTaxableAmount: ValueType.currency('USD'), stateKey: ValueType.text(), residency: ValueType.text() } },
      { type: 'BOND_COUPON_TAX',                fields: { amount: ValueType.currency('USD'), federalTaxableAmount: ValueType.currency('USD'), stateTaxableAmount: ValueType.currency('USD'), residency: ValueType.text() , stateKey: ValueType.text()} },
      { type: 'STOCK_EARNINGS_APPLY',           fields: { amount: ValueType.currency('USD'), stateKey: ValueType.text() } },
      { type: 'STOCK_WITHDRAWAL_APPLY', family: 'WITHDRAWAL', cc: 'US',
        fields: { salePrice: ValueType.number(), costBasis: ValueType.number(), residency: ValueType.text() } },
      // The au* trio rides on a US disposal because an AU resident is taxed on
      // worldwide gains: auGain measures from the s855-45 stepped-up basis,
      // auIndexedGain from the CPI-indexed one, and auDiscountableGain is the slice
      // held ≥12 months. Emitted by three paths (StockWithdrawalApplyReducer,
      // AccountService.replenishSavings, the rebalancer), which between them cover
      // all three fields.
      { type: 'STOCK_WITHDRAWAL_TAX', family: 'CAPITAL_GAINS', cc: 'US',
        fields: { gain: ValueType.number(), auGain: ValueType.number(), auIndexedGain: ValueType.number(), auDiscountableGain: ValueType.number(), usShortTermGain: ValueType.number(), usLongTermGain: ValueType.number(), auShortTermGain: ValueType.number(), auLongTermGain: ValueType.number(), residency: ValueType.text(), proceeds: ValueType.number(), costBasis: ValueType.number(), description: ValueType.text() , stateKey: ValueType.text()} },
      { type: 'FIXED_INCOME_EARNINGS_TAX',
        fields: { amount: ValueType.currency('USD'), residency: ValueType.text() , stateKey: ValueType.text()} },
    ],
  },

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
    const stateRegistry  = context.stateRegistry;
    const reducers = [];
    if (hasFI) reducers.push(
      new FixedIncomeContributionApplyReducer({ accountService, stateRegistry }),
      new FixedIncomeWithdrawalApplyReducer({ accountService, stateRegistry }),
      new FixedIncomeEarningsApplyReducer({ accountService, stateRegistry }),
    );
    if (hasST) reducers.push(
      new StockContributionApplyReducer({ accountService, stateRegistry }),
      new StockDividendApplyReducer({ accountService, stateRegistry }),
      new BondCouponApplyReducer({ accountService, stateRegistry }),
      new StockEarningsApplyReducer({ accountService, stateRegistry }),
      new StockWithdrawalApplyReducer({ accountService, stateRegistry }),
    );
    return reducers;
  },
};
