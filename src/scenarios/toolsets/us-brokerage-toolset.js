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
      // residency is projected onto every report row (JournalDataSource._project), so it
      // must be declared or the row's value goes null once the manifest gate is wired.
      { type: 'STOCK_DIVIDEND_APPLY',           fields: { amount: ValueType.currency('USD'), residency: ValueType.text() } },
      { type: 'STOCK_DIVIDEND_TAX',             fields: { amount: ValueType.currency('USD'), residency: ValueType.text() , stateKey: ValueType.text()} },
      { type: 'BOND_COUPON_APPLY',              fields: { amount: ValueType.currency('USD'), federalTaxableAmount: ValueType.currency('USD'), stateTaxableAmount: ValueType.currency('USD'), stateKey: ValueType.text(), residency: ValueType.text() } },
      { type: 'BOND_COUPON_CASH_APPLY',         fields: { amount: ValueType.currency('USD'), federalTaxableAmount: ValueType.currency('USD'), stateTaxableAmount: ValueType.currency('USD'), stateKey: ValueType.text(), residency: ValueType.text() } },
      { type: 'BOND_COUPON_TAX',                fields: { amount: ValueType.currency('USD'), federalTaxableAmount: ValueType.currency('USD'), stateTaxableAmount: ValueType.currency('USD'), residency: ValueType.text() , stateKey: ValueType.text()} },
      { type: 'STOCK_EARNINGS_APPLY',           fields: { amount: ValueType.currency('USD'), stateKey: ValueType.text() } },
      { type: 'STOCK_WITHDRAWAL_APPLY', family: 'WITHDRAWAL', cc: 'US',
        fields: { salePrice: ValueType.currency('USD'), costBasis: ValueType.currency('USD'), residency: ValueType.text() } },
      // The au* trio rides on a US disposal because an AU resident is taxed on
      // worldwide gains: auGain measures from the s855-45 stepped-up basis,
      // auIndexedGain from the CPI-indexed one, and auDiscountableGain is the slice
      // held ≥12 months. Emitted by three paths (StockWithdrawalApplyReducer,
      // AccountService.replenishSavings, the rebalancer), which between them cover
      // all three fields.
      // Currency on the disposal money (design 91 §8). Every money field here is USD —
      // the `au*` ones INCLUDED. The prefix means "measured on the AU basis" (the
      // s855-45 stepped-up cost base, the 12-month discount test), NOT "denominated in
      // AUD": the emitter works in the asset's currency and the consumer converts, e.g.
      // `toAUD(auGain, 'USD', state)` in us-tax-module-2026. Typing auGain as AUD would
      // be precisely the error this declaration exists to prevent.
      // `currency` names the DRAWN ACCOUNT's denomination. The service drawdown path
      // emits this action for an AU-domiciled brokerage too, whose money fields are
      // AUD; consumers read this field rather than assuming USD. The static
      // `currency('USD')` declarations below stay right for the US-domiciled case the
      // manifest can express — it has no way to say "whatever this row's currency
      // field says" — so an AU-domiciled disposal is mislabelled in the journal's
      // display layer while every computation on it is correct.
      { type: 'STOCK_WITHDRAWAL_TAX', family: 'CAPITAL_GAINS', cc: 'US',
        fields: { currency: ValueType.text(), gain: ValueType.currency('USD'), auGain: ValueType.currency('USD'), auIndexedGain: ValueType.currency('USD'), auDiscountableGain: ValueType.currency('USD'), usShortTermGain: ValueType.currency('USD'), usLongTermGain: ValueType.currency('USD'), auShortTermGain: ValueType.currency('USD'), auLongTermGain: ValueType.currency('USD'), residency: ValueType.text(), proceeds: ValueType.currency('USD'), costBasis: ValueType.currency('USD'), description: ValueType.text() , stateKey: ValueType.text(),
          // design 94 §8.1j — the part of this disposal's loss that §1091(a) disallowed and
          // §1091(d) moved into the replacement's basis. Declared because `pickPayload` keeps
          // only declared fields: an undeclared one never reaches the tax documents, and a
          // tax adjustment nobody can drill from the journal is exactly the shape this repo
          // has been bitten by. Zero or absent on every disposal that was not a wash.
          washDisallowed: ValueType.currency('USD')} },
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
