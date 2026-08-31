/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { EventBuilder }            from '../../simulation-framework/builders/event-builder.js';
import { ACCOUNT_ROLES }           from '../../finance/state/account-roles.js';
import { AuSavingsInterestHandler, AuFixedIncomeInterestMonthlyHandler }
  from '../../finance/handlers/earnings-handlers.js';
import {
  AuSavingsContributionApplyReducer, AuSavingsWithdrawalApplyReducer,
  AuSavingsEarningsApplyReducer,
  AuSavingsContributionHandler, AuSavingsWithdrawalHandler, AuSavingsEarningsHandler,
} from '../../finance/account-rules/au/au-savings-classes.js';
import {
  AuFixedIncomeEarningsApplyReducer,
} from '../../finance/account-rules/au/au-fixed-income-classes.js';
import { ValueType } from '../../simulation-framework/type-registry.js';
import { assertInterestBearingHoldings } from '../../finance/holdings/default-allocations.js';

/**
 * AU_BANKING toolset — AU savings and fixed income account interest and cash-flow machinery.
 *
 * Capabilities: banking
 * Depends on: (none)
 *
 * State ownership:
 *   Contributes: INTL_AU_SAVINGS_INTEREST schedule (monthly), INTL_AU_FIXED_INCOME_INTEREST
 *                schedule (monthly), per-account handlers and reducers.
 */
export const AU_BANKING = {
  id: 'AU_BANKING',
  capabilities: ['banking'],
  dependencies: [],

  types: {
    handlers: [AuSavingsContributionHandler, AuSavingsWithdrawalHandler, AuSavingsEarningsHandler, AuSavingsInterestHandler, AuFixedIncomeInterestMonthlyHandler],
    reducers: [AuSavingsContributionApplyReducer, AuSavingsWithdrawalApplyReducer, AuSavingsEarningsApplyReducer, AuFixedIncomeEarningsApplyReducer],
    actions: [
      { type: 'AU_SAVINGS_CONTRIBUTION_APPLY', fields: { amount: ValueType.currency('AUD') } },
      { type: 'AU_SAVINGS_WITHDRAWAL_APPLY', family: 'WITHDRAWAL', cc: 'AU',
        fields: { amount: ValueType.currency('AUD') } },
      { type: 'AU_SAVINGS_EARNINGS_APPLY',   fields: { amount: ValueType.currency('AUD'), stateKey: ValueType.text(), residency: ValueType.text() } },
      { type: 'AU_SAVINGS_EARNINGS_TAX',     fields: { amount: ValueType.currency('AUD'), residency: ValueType.text(), stateKey: ValueType.text() } },
      // stateKey names the sleeve the interest was credited to. Declared on the paired
      // AU_FIXED_INCOME_EARNINGS_TAX and on ~50 other types; this was the odd one out.
      { type: 'AU_FIXED_INCOME_EARNINGS_APPLY', fields: { amount: ValueType.currency('AUD'), residency: ValueType.text(), stateKey: ValueType.text() } },
      { type: 'AU_FIXED_INCOME_EARNINGS_TAX',   fields: { amount: ValueType.currency('AUD'), residency: ValueType.text(), stateKey: ValueType.text() } },
    ],
  },

  paramSchema(context) {
    return [
      {
        key: 'auSavingsInterestRate', label: 'AU Savings Interest Rate',
        // Retired as an MC/Opt rate knob (design 56 Decision 6 / §3.1): Prime is now the
        // systemic rate sweep. Still a seed param — the fallback baseline when no primeSpread.
        type: 'Number', group: 'AU Banking', mc: false, opt: false,
        defaultValue: 0.045,
        description: 'Annual interest rate for AU savings accounts (seed / fallback baseline; rate sweeps go through AU Prime — design 56).',
      },
      {
        key: 'auFixedIncomeInterestRate', label: 'AU Fixed Income Interest Rate',
        type: 'Number', group: 'AU Banking', mc: true, opt: true,
        defaultValue: 0.04,
        description: 'Annual interest rate for AU fixed income accounts',
      },
      {
        // RBA policy ("Prime") rate (design 56) — see usPrimeRate. Prime is THE systemic
        // rate sweep (Decision 6 / §3.1): mc/opt true in Phase 2a; per-account rate levers
        // retire so a rate sweep is a Prime sweep, fanning out coherently.
        key: 'auPrimeRate', label: 'AU Prime Rate (RBA policy)',
        type: 'Number', group: 'AU Banking', mc: true, opt: true,
        defaultValue: 0.0435,
        description: 'AU central-bank (RBA) policy rate. Prime-linked cash accounts and variable loans earn/pay Prime + their spread.',
      },
    ];
  },

  state(context) {
    return {};
  },

  schedules(context) {
    const schedules = [];
    if (context.accounts.some(a => a.role === ACCOUNT_ROLES.AU_SAVINGS)) {
      schedules.push(
        EventBuilder.eventSeries()
          .name('AU Savings Interest').type('INTL_AU_SAVINGS_INTEREST')
          .interval('month-end').enabled(true).color('#FF9800').build()
      );
    }
    if (context.accounts.some(a => a.role === ACCOUNT_ROLES.AU_FIXED_INCOME)) {
      schedules.push(
        EventBuilder.eventSeries()
          .name('AU Fixed Income Interest').type('INTL_AU_FIXED_INCOME_INTEREST')
          .interval('month-end').enabled(true).color('#FF6F00').build()
      );
    }
    return schedules;
  },

  handlers(context) {
    const handlers = [];
    const savingsAccounts    = context.accounts.filter(a => a.role === ACCOUNT_ROLES.AU_SAVINGS);
    const fixedIncomeAccounts = context.accounts.filter(a => a.role === ACCOUNT_ROLES.AU_FIXED_INCOME);

    if (savingsAccounts.length > 0) {
      handlers.push(
        new AuSavingsContributionHandler(),
        new AuSavingsWithdrawalHandler(),
        new AuSavingsEarningsHandler(),
      );
      const event = context.schedulesById['INTL_AU_SAVINGS_INTEREST'];
      const rate  = context.parameters.auSavingsInterestRate;
      savingsAccounts.forEach(acct => {
        const h = new AuSavingsInterestHandler({
          stateRegistry: context.stateRegistry,
          role:          ACCOUNT_ROLES.AU_SAVINGS,
          ownerId:       acct.ownerId,
          stateKey:      acct.stateKey,
          interestRate:  acct.interestRate ?? rate,
        });
        h.handledEvents.push(event);
        handlers.push(h);
      });
    }

    if (fixedIncomeAccounts.length > 0) {
      const event = context.schedulesById['INTL_AU_FIXED_INCOME_INTEREST'];
      const rate  = context.parameters.auFixedIncomeInterestRate;
      fixedIncomeAccounts.forEach(acct => {
        // The AU mirror of the US check — same coupling, same two wrong numbers if an
        // EQUITY or GOLD lot lands here (design 97 §20.20).
        assertInterestBearingHoldings(acct);
        const h = new AuFixedIncomeInterestMonthlyHandler({
          stateRegistry: context.stateRegistry,
          role:          ACCOUNT_ROLES.AU_FIXED_INCOME,
          ownerId:       acct.ownerId,
          interestRate:  acct.interestRate ?? rate,
        });
        h.handledEvents.push(event);
        handlers.push(h);
      });
    }

    return handlers;
  },

  reducers(context) {
    const reducers = [];
    const accountService = context.accountService;

    if (context.accounts.some(a => a.role === ACCOUNT_ROLES.AU_SAVINGS)) {
      reducers.push(
        new AuSavingsContributionApplyReducer({ accountService }),
        new AuSavingsWithdrawalApplyReducer({ accountService }),
        new AuSavingsEarningsApplyReducer({ accountService }),
      );
    }

    if (context.accounts.some(a => a.role === ACCOUNT_ROLES.AU_FIXED_INCOME)) {
      reducers.push(
        new AuFixedIncomeEarningsApplyReducer({ accountService }),
      );
    }

    return reducers;
  },
};
