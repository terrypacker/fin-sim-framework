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
  AuSavingsContributionApplyReducer, AuSavingsWithdrawalApplyReducer,
  AuSavingsEarningsApplyReducer,
  AuSavingsContributionHandler, AuSavingsWithdrawalHandler, AuSavingsEarningsHandler,
} from './au-savings-classes.js';
import {
  SuperContributionApplyReducer, SuperWithdrawalContribApplyReducer,
  SuperWithdrawalEarningsApplyReducer, SuperEarningsApplyReducer,
  SuperContributionHandler, SuperWithdrawalContributionsHandler,
  SuperWithdrawalEarningsHandler, SuperEarningsDirectHandler,
} from './au-super-classes.js';
import {
  AuDividendFrankedResidentApplyReducer, AuDividendFrankedNonResidentApplyReducer,
  AuDividendUnfrankedResidentApplyReducer, AuDividendUnfrankedNonResidentApplyReducer,
  AuStockEarningsApplyReducer, AuStockWithdrawalApplyReducer,
  AuDividendFrankedResidentHandler, AuDividendFrankedNonResidentHandler,
  AuDividendUnfrankedResidentHandler, AuDividendUnfrankedNonResidentHandler,
  AuStockEarningsHandler, AuStockWithdrawalHandler,
} from './au-brokerage-classes.js';
import {
  AuSeIncomeApplyReducer, AuSeIncomeHandler,
} from './au-income-classes.js';


/**
 * AuAccountModule2026 — AU account mechanics rules for 2026.
 *
 * Registers Stage-1 (CASH_FLOW priority) reducers and event handlers for all
 * AU account types.  Each reducer that produces a tax effect emits a _TAX child
 * action via next:[] for the AU tax module to handle.
 *
 * Covered events:
 *   EVT-16 to 19  AU Savings
 *   EVT-20 to 23  Superannuation
 *   EVT-26 to 32  AU Brokerage
 *   EVT-33        AU House Sale
 *   EVT-49        AU Self-Employment Income
 */
export class AuAccountModule2026 extends BaseAccountModule {
  get countryCode() { return 'AU'; }
  get year()        { return 2026; }

  createReducers(accountService) {
    return [
      // AU Savings
      new AuSavingsContributionApplyReducer({ accountService }),
      new AuSavingsWithdrawalApplyReducer({ accountService }),
      new AuSavingsEarningsApplyReducer({ accountService }),
      // Superannuation
      new SuperContributionApplyReducer({ accountService }),
      new SuperWithdrawalContribApplyReducer({ accountService }),
      new SuperWithdrawalEarningsApplyReducer({ accountService }),
      new SuperEarningsApplyReducer({ accountService }),
      // AU Brokerage
      new AuDividendFrankedResidentApplyReducer({ accountService }),
      new AuDividendFrankedNonResidentApplyReducer({ accountService }),
      new AuDividendUnfrankedResidentApplyReducer({ accountService }),
      new AuDividendUnfrankedNonResidentApplyReducer({ accountService }),
      new AuStockEarningsApplyReducer({ accountService }),
      new AuStockWithdrawalApplyReducer({ accountService }),
      // AU Income
      new AuSeIncomeApplyReducer({ accountService }),
    ];
  }

  createHandlers() {
    return [
      // AU Savings
      new AuSavingsContributionHandler(),
      new AuSavingsWithdrawalHandler(),
      new AuSavingsEarningsHandler(),
      // Superannuation
      new SuperContributionHandler(),
      new SuperWithdrawalContributionsHandler(),
      new SuperWithdrawalEarningsHandler(),
      new SuperEarningsDirectHandler(),
      // AU Brokerage
      new AuDividendFrankedResidentHandler(),
      new AuDividendFrankedNonResidentHandler(),
      new AuDividendUnfrankedResidentHandler(),
      new AuDividendUnfrankedNonResidentHandler(),
      new AuStockEarningsHandler(),
      new AuStockWithdrawalHandler(),
      // AU Income
      new AuSeIncomeHandler(),
    ];
  }
}
