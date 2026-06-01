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
  AuDividendFrankedResidentApplyReducer, AuDividendFrankedNonResidentApplyReducer,
  AuDividendUnfrankedResidentApplyReducer, AuDividendUnfrankedNonResidentApplyReducer,
  AuStockEarningsApplyReducer, AuStockWithdrawalApplyReducer,
  AuDividendFrankedResidentHandler, AuDividendFrankedNonResidentHandler,
  AuDividendUnfrankedResidentHandler, AuDividendUnfrankedNonResidentHandler,
  AuStockEarningsHandler, AuStockWithdrawalHandler,
} from '../../finance/account-rules/au/au-brokerage-classes.js';
import { ValueType } from '../../simulation-framework/type-registry.js';

/**
 * AU_BROKERAGE toolset — AU stock and dividend account mechanics.
 *
 * Capabilities: au-brokerage
 * Depends on: AU_TAX
 *
 * Guard: handlers/reducers only registered when AU_STOCK accounts are present.
 */
export const AU_BROKERAGE = {
  id: 'AU_BROKERAGE',
  capabilities: ['au-brokerage'],
  dependencies: ['AU_TAX'],

  types: {
    handlers: [AuDividendFrankedResidentHandler, AuDividendFrankedNonResidentHandler, AuDividendUnfrankedResidentHandler, AuDividendUnfrankedNonResidentHandler, AuStockEarningsHandler, AuStockWithdrawalHandler],
    reducers: [AuDividendFrankedResidentApplyReducer, AuDividendFrankedNonResidentApplyReducer, AuDividendUnfrankedResidentApplyReducer, AuDividendUnfrankedNonResidentApplyReducer, AuStockEarningsApplyReducer, AuStockWithdrawalApplyReducer],
    actions: [
      { type: 'AU_DIVIDEND_FRANKED_RESIDENT_APPLY',    fields: { amount: ValueType.currency('AUD') } },
      { type: 'AU_DIVIDEND_FRANKED_NONRESIDENT_APPLY', fields: { amount: ValueType.currency('AUD') } },
      { type: 'AU_DIVIDEND_UNFRANKED_RESIDENT_APPLY',  fields: { amount: ValueType.currency('AUD') } },
      { type: 'AU_DIVIDEND_UNFRANKED_NONRESIDENT_APPLY', fields: { amount: ValueType.currency('AUD') } },
      { type: 'AU_STOCK_EARNINGS_APPLY', fields: { amount: ValueType.currency('AUD') } },
      { type: 'AU_STOCK_WITHDRAWAL_APPLY', family: 'WITHDRAWAL', cc: 'AU',
        fields: { salePrice: ValueType.number(), costBasis: ValueType.number(), isAuResident: ValueType.boolean() } },
      { type: 'AU_STOCK_WITHDRAWAL_TAX', family: 'CAPITAL_GAINS', cc: 'AU',
        fields: { gain: ValueType.number(), isAuResident: ValueType.boolean(), proceeds: ValueType.number(), costBasis: ValueType.number(), description: ValueType.text() } },
      { type: 'AU_DIVIDEND_FRANKED_RESIDENT_TAX',    fields: { amount: ValueType.currency('AUD') } },
      { type: 'AU_DIVIDEND_UNFRANKED_RESIDENT_TAX',  fields: { amount: ValueType.currency('AUD') } },
      { type: 'AU_DIVIDEND_UNFRANKED_NONRESIDENT_TAX', fields: { amount: ValueType.currency('AUD') } },
    ],
  },

  paramSchema(context) { return []; },
  state(context) { return {}; },
  schedules(context) { return []; },

  handlers(context) {
    if (!context.accounts.some(a => a.role === ACCOUNT_ROLES.AU_STOCK)) return [];
    return [
      new AuDividendFrankedResidentHandler(),
      new AuDividendFrankedNonResidentHandler(),
      new AuDividendUnfrankedResidentHandler(),
      new AuDividendUnfrankedNonResidentHandler(),
      new AuStockEarningsHandler(),
      new AuStockWithdrawalHandler(),
    ];
  },

  reducers(context) {
    if (!context.accounts.some(a => a.role === ACCOUNT_ROLES.AU_STOCK)) return [];
    const accountService = context.accountService;
    return [
      new AuDividendFrankedResidentApplyReducer({ accountService }),
      new AuDividendFrankedNonResidentApplyReducer({ accountService }),
      new AuDividendUnfrankedResidentApplyReducer({ accountService }),
      new AuDividendUnfrankedNonResidentApplyReducer({ accountService }),
      new AuStockEarningsApplyReducer({ accountService }),
      new AuStockWithdrawalApplyReducer({ accountService }),
    ];
  },
};
