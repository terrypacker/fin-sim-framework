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

import {
  RothContributionApplyReducer, RothWithdrawalContribApplyReducer,
  RothWithdrawalEarningsApplyReducer, RothEarningsApplyReducer,
  RothContributionHandler, RothWithdrawalContributionsHandler,
  RothWithdrawalEarningsHandler, RothEarningsHandler,
} from './roth-classes.js';
import {
  IraContributionApplyReducer, IraWithdrawalContribApplyReducer,
  IraWithdrawalEarningsApplyReducer, IraEarningsApplyReducer,
  IraContributionHandler, IraWithdrawalContributionsHandler,
  IraWithdrawalEarningsHandler, IraEarningsHandler,
} from './ira-classes.js';
import {
  K401ContributionApplyReducer, K401EarningsApplyReducer, K401WithdrawalApplyReducer,
  K401ContributionHandler, K401EarningsHandler, K401WithdrawalHandler,
} from './k401-classes.js';
import {
  FixedIncomeContributionApplyReducer, FixedIncomeWithdrawalApplyReducer,
  FixedIncomeEarningsApplyReducer, StockContributionApplyReducer,
  StockDividendApplyReducer, StockEarningsApplyReducer, StockWithdrawalApplyReducer,
  FixedIncomeContributionHandler, FixedIncomeWithdrawalHandler, FixedIncomeEarningsHandler,
  StockContributionHandler, StockDividendHandler, StockEarningsHandler, StockWithdrawalHandler,
} from './us-brokerage-classes.js';
import {
  UsHouseSaleApplyReducer, UsHouseSaleHandler,
} from './us-real-property-classes.js';


/**
 * UsAccountModule2026 — US account mechanics rules for 2026.
 *
 * Registers Stage-1 (CASH_FLOW priority) reducers and event handlers for all
 * US account types.  Each reducer that produces a tax effect emits a _TAX child
 * action via next:[] for the US tax module to handle.
 *
 * Covered events:
 *   EVT-1 to 4   Roth IRA
 *   EVT-5 to 8   Traditional IRA
 *   EVT-9 to 15  US Brokerage (fixed income + stocks)
 *   EVT-24/25    401k
 *   EVT-34       US House Sale
 */
export class UsAccountModule2026 extends BaseAccountModule {
  get countryCode() { return 'US'; }
  get year()        { return 2026; }

  createReducers(accountService) {
    return [
      // Roth IRA
      new RothContributionApplyReducer({ accountService }),
      new RothWithdrawalContribApplyReducer({ accountService }),
      new RothWithdrawalEarningsApplyReducer({ accountService }),
      new RothEarningsApplyReducer({ accountService }),
      // Traditional IRA
      new IraContributionApplyReducer({ accountService }),
      new IraWithdrawalContribApplyReducer({ accountService }),
      new IraWithdrawalEarningsApplyReducer({ accountService }),
      new IraEarningsApplyReducer({ accountService }),
      // 401k
      new K401ContributionApplyReducer({ accountService }),
      new K401EarningsApplyReducer({ accountService }),
      new K401WithdrawalApplyReducer({ accountService }),
      // US Brokerage (Fixed Income + Stock)
      new FixedIncomeContributionApplyReducer({ accountService }),
      new FixedIncomeWithdrawalApplyReducer({ accountService }),
      new FixedIncomeEarningsApplyReducer({ accountService }),
      new StockContributionApplyReducer({ accountService }),
      new StockDividendApplyReducer({ accountService }),
      new StockEarningsApplyReducer({ accountService }),
      new StockWithdrawalApplyReducer({ accountService }),
      // Real Property
      new UsHouseSaleApplyReducer({ accountService }),
    ];
  }

  createHandlers() {
    return [
      // Roth IRA
      new RothContributionHandler(),
      new RothWithdrawalContributionsHandler(),
      new RothWithdrawalEarningsHandler(),
      new RothEarningsHandler(),
      // Traditional IRA
      new IraContributionHandler(),
      new IraWithdrawalContributionsHandler(),
      new IraWithdrawalEarningsHandler(),
      new IraEarningsHandler(),
      // 401k
      new K401ContributionHandler(),
      new K401EarningsHandler(),
      new K401WithdrawalHandler(),
      // US Brokerage
      new FixedIncomeContributionHandler(),
      new FixedIncomeWithdrawalHandler(),
      new FixedIncomeEarningsHandler(),
      new StockContributionHandler(),
      new StockDividendHandler(),
      new StockEarningsHandler(),
      new StockWithdrawalHandler(),
      // Real Property
      new UsHouseSaleHandler(),
    ];
  }
}
