/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { EventBuilder }               from '../../simulation-framework/builders/event-builder.js';
import { ReducerBuilder }             from '../../simulation-framework/builders/reducer-builder.js';
import { ACCOUNT_ROLES }              from '../../finance/state/account-roles.js';
import { MonthlyExpensesHandler }     from '../../finance/handlers/monthly-expenses-handler.js';
import { MonthlyWagesHandler }        from '../../finance/handlers/monthly-wages-handler.js';
import { MonthlySocialSecurityHandler }
  from '../../finance/handlers/monthly-social-security-handler.js';
import {
  SuperEarningsHandler,
  IntlAuStockEarningsHandler,
  IntlAuStockDividendHandler,
} from '../../finance/handlers/earnings-handlers.js';
import { OutOfFundsHandler }          from '../../finance/handlers/out-of-funds-handler.js';
import { ExpenseDebitReducer }        from '../../finance/reducers/expense-debit-reducer.js';
import { ReplenishSavingsReducer }    from '../../finance/reducers/replenish-savings-reducer.js';
import { SetOutOfFundsDateReducer }   from '../../finance/reducers/set-out-of-funds-date-reducer.js';
import { AccumulateDeficitReducer }   from '../../finance/reducers/accumulate-deficit-reducer.js';
import { OutOfFundsReducer }          from '../../finance/reducers/out-of-funds-reducer.js';
import { InflationAdjustReducer }     from '../../finance/reducers/inflation-adjust-reducer.js';
import { ValueType } from '../../simulation-framework/type-registry.js';
import {
  SuperContributionApplyReducer, SuperWithdrawalContribApplyReducer,
  SuperWithdrawalEarningsApplyReducer, SuperEarningsApplyReducer,
  SuperContributionHandler, SuperWithdrawalContributionsHandler,
  SuperWithdrawalEarningsHandler, SuperEarningsDirectHandler,
} from '../../finance/account-rules/au/au-super-classes.js';

/**
 * AU_RETIREMENT toolset — AU retirement/superannuation scenario wiring.
 *
 * Capabilities: superannuation
 * Depends on: AU_TAX, AU_BANKING
 *
 * State ownership:
 *   Initializes: people (with residency='AUS'), monthlyExpenses, inflationRates,
 *                inflationAccumulator, metrics, per-account state entries
 *   Reads: au* YTD keys from AU_TAX; INTL_AU_SAVINGS_INTEREST from AU_BANKING
 *
 * Note: MONTHLY_EXPENSES and MONTHLY_WAGES conflict with US_RETIREMENT in
 * cross-border scenarios.  US_AU_CROSS_BORDER is responsible for any
 * unified expense/wage handling in that case.
 */
export const AU_RETIREMENT = {
  id: 'AU_RETIREMENT',
  capabilities: ['superannuation'],
  dependencies: ['AU_TAX', 'AU_BANKING', 'AU_INCOME'],

  types: {
    handlers: [
      MonthlyExpensesHandler, MonthlyWagesHandler, MonthlySocialSecurityHandler,
      OutOfFundsHandler,
      SuperContributionHandler, SuperWithdrawalContributionsHandler,
      SuperWithdrawalEarningsHandler, SuperEarningsDirectHandler, SuperEarningsHandler,
      IntlAuStockEarningsHandler, IntlAuStockDividendHandler,
    ],
    reducers: [
      ExpenseDebitReducer, ReplenishSavingsReducer,
      SetOutOfFundsDateReducer, AccumulateDeficitReducer, OutOfFundsReducer, InflationAdjustReducer,
      SuperContributionApplyReducer, SuperWithdrawalContribApplyReducer,
      SuperWithdrawalEarningsApplyReducer, SuperEarningsApplyReducer,
    ],
    actions: [
      { type: 'EXPENSE_DEBIT',         fields: { amount: ValueType.number(), targetKey: ValueType.text() } },
      { type: 'REPLENISH_SAVINGS',  fields: { deficit: ValueType.number(), targetKey: ValueType.text() } },
      { type: 'RECORD_METRIC',         fields: { fieldName: ValueType.text(), value: ValueType.number() } },
      { type: 'SET_OUT_OF_FUNDS_DATE', fields: { date: ValueType.any() } },
      { type: 'ACCUMULATE_DEFICIT',    fields: { amount: ValueType.number() } },
      { type: 'OUT_OF_FUNDS',          fields: { deficit: ValueType.number(), currency: ValueType.text() } },
      { type: 'SUPER_CONTRIBUTION_APPLY',          fields: { amount: ValueType.currency('AUD') } },
      { type: 'SUPER_CONTRIBUTION_TAX',            fields: { amount: ValueType.currency('AUD') } },
      { type: 'SUPER_WITHDRAWAL_CONTRIB_APPLY',  family: 'WITHDRAWAL', cc: 'AU', fields: { amount: ValueType.currency('AUD') } },
      { type: 'SUPER_WITHDRAWAL_EARNINGS_APPLY', family: 'WITHDRAWAL', cc: 'AU', fields: { amount: ValueType.currency('AUD') } },
      { type: 'SUPER_WITHDRAWAL_EARNINGS_TAX',   fields: { amount: ValueType.currency('AUD') } },
      { type: 'SUPER_EARNINGS_APPLY',              fields: { amount: ValueType.currency('AUD'), stateKey: ValueType.text() } },
      { type: 'SUPER_EARNINGS_TAX',               fields: { amount: ValueType.currency('AUD'), stateKey: ValueType.text() } },
    ],
  },

  paramSchema(context) {
    return [
      {
        key: 'superGrowthRate', label: 'Super Growth Rate',
        type: 'Number', group: 'AU Retirement', mc: true, opt: true,
        defaultValue: 0.07,
        description: 'Annual growth rate for superannuation accounts',
      },
      {
        key: 'auStockGrowthRate', label: 'AU Stock Growth Rate',
        type: 'Number', group: 'AU Retirement', mc: true, opt: true,
        defaultValue: 0.07,
        description: 'Annual growth rate for AU brokerage stock accounts',
      },
      {
        key: 'auStockDividendRate', label: 'AU Stock Dividend Rate',
        type: 'Number', group: 'AU Retirement', mc: true, opt: true,
        defaultValue: 0.04,
        description: 'Annual dividend yield for AU stock accounts',
      },
      {
        key: 'monthlyExpenses', label: 'Monthly Expenses (AUD)',
        type: 'Number', group: 'AU Retirement', mc: true, opt: true,
        defaultValue: 6_000,
        description: 'Monthly household expenses drawn from AU savings',
      },
      {
        key: 'inflationRate', label: 'AU Inflation Rate',
        type: 'Number', group: 'AU Retirement', mc: true, opt: true,
        defaultValue: 0.03,
        description: 'Annual AU inflation rate applied to expenses',
      },
      {
        key: 'inflationAdjust', label: 'Inflation-Adjust Expenses',
        type: 'Boolean', group: 'AU Retirement', mc: false, opt: true,
        defaultValue: true,
        description: 'If true, monthly expenses grow with inflation each year',
      },
    ];
  },

  state(context) {
    const p = context.parameters;
    // When US_RETIREMENT ran first it already set up shared state (MONTHLY_EXPENSES
    // was registered before AU_RETIREMENT.state() is called).  Don't override
    // the people/metrics/monthlyExpenses patches in that case —
    // US_AU_CROSS_BORDER will set the correct residency for cross-border scenarios.
    const sharedAlreadySetup = !!context.schedulesById['MONTHLY_EXPENSES'];
    context._auSharedDelegated = sharedAlreadySetup;

    const people = {};
    for (const person of context.people) {
      people[person.id] = {
        id:                    person.id,
        name:                  person.name,
        birthDate:             person.birthDate,
        monthlyWage:           person.monthlyWage           ?? 0,
        retirementDate:        person.retirementDate        ?? null,
        socialSecurityMonthly: person.socialSecurityMonthly ?? 0,
        lifeExpectancy:        person.lifeExpectancy        ?? 90,
        citizen:               person.citizen               ?? ['AUS'],
        residency:             'AUS',
      };
    }

    const patches = {
      inflationRates:          { AU: p.inflationRate },
      inflationAccumulator:    { AU: 1.0 },
      superWithdrawalBlocked:  false,
    };

    if (!sharedAlreadySetup) {
      const metrics = {};
      patches.monthlyExpenses = p.monthlyExpenses;
      patches.metrics         = metrics;
      patches.people          = people;
      for (const account of context.accounts) {
        if (account.stateKey != null && account.balance != null) {
          metrics[account.stateKey] = account.balance;
        }
      }
    }

    for (const account of context.accounts) {
      if (account.stateKey && patches[account.stateKey] === undefined) {
        patches[account.stateKey] = _accountToStatePlain(account);
      }
    }

    return patches;
  },

  schedules(context) {
    const accounts     = context.accounts;
    const people       = context.people;
    const superAccts   = accounts.filter(a => a.role === ACCOUNT_ROLES.SUPER);
    const auStockAccts = accounts.filter(a => a.role === ACCOUNT_ROLES.AU_STOCK);
    const withSS       = people.filter(p => (p.socialSecurityMonthly ?? 0) > 0);

    const schedules = [];

    // Skip shared events if US_RETIREMENT already registered them.
    if (!context.schedulesById['MONTHLY_EXPENSES']) {
      schedules.push(
        EventBuilder.eventSeries()
          .name('Monthly Expenses').type('MONTHLY_EXPENSES')
          .interval('month-end').enabled(true).color('#F44336').build()
      );
    }
    if (!context.schedulesById['MONTHLY_WAGES']) {
      schedules.push(
        EventBuilder.eventSeries()
          .name('Monthly Wages').type('MONTHLY_WAGES')
          .interval('month-end').enabled(true).color('#4CAF50').build()
      );
    }

    if (withSS.length > 0 && !context.schedulesById['MONTHLY_SS_INCOME']) {
      schedules.push(
        EventBuilder.eventSeries()
          .name('Monthly Social Security').type('MONTHLY_SS_INCOME')
          .interval('month-end').enabled(true).color('#3F51B5').build()
      );
    }

    if (superAccts.length > 0) {
      schedules.push(
        EventBuilder.eventSeries()
          .name('Super Earnings').type('INTL_SUPER_EARNINGS')
          .interval('year-end').startOffset(1).enabled(true).color('#9C27B0').build()
      );
    }

    if (auStockAccts.length > 0) {
      schedules.push(
        EventBuilder.eventSeries()
          .name('AU Stock Earnings').type('INTL_AU_STOCK_EARNINGS')
          .interval('year-end').startOffset(1).enabled(true).color('#66BB6A').build()
      );
      schedules.push(
        EventBuilder.eventSeries()
          .name('AU Stock Dividend').type('INTL_AU_STOCK_DIVIDEND')
          .interval('year-end').startOffset(1).enabled(true).color('#FFA726').build()
      );
    }

    return schedules;
  },

  handlers(context) {
    const p            = context.parameters;
    const accounts     = context.accounts;
    const people       = context.people;
    const sr           = context.stateRegistry;
    const superAccts   = accounts.filter(a => a.role === ACCOUNT_ROLES.SUPER);
    const auStockAccts = accounts.filter(a => a.role === ACCOUNT_ROLES.AU_STOCK);
    const auSavAccts   = accounts.filter(a => a.role === ACCOUNT_ROLES.AU_SAVINGS);
    const withSS       = people.filter(pe => (pe.socialSecurityMonthly ?? 0) > 0);

    const primaryId = auSavAccts[0]?.ownerId ?? (people[0]?.id ?? null);
    const handlers  = [];

    // Only register shared handlers if US_RETIREMENT did not already do so.
    if (!context._auSharedDelegated) {
      const expHandler = new MonthlyExpensesHandler({
        stateRegistry:   sr,
        monthlyExpenses: p.monthlyExpenses,
        usRole:          ACCOUNT_ROLES.US_SAVINGS, usOwnerId: null,
        auRole:          ACCOUNT_ROLES.AU_SAVINGS,  auOwnerId: primaryId,
      });
      expHandler.handledEvents.push(context.schedulesById['MONTHLY_EXPENSES']);
      handlers.push(expHandler);

      const wagesHandler = new MonthlyWagesHandler({ stateRegistry: sr });
      wagesHandler.handledEvents.push(context.schedulesById['MONTHLY_WAGES']);
      handlers.push(wagesHandler);

      handlers.push(new OutOfFundsHandler());
    }

    // Social Security / AU Age Pension
    if (withSS.length > 0 && !context._auSharedDelegated) {
      const ssHandler = new MonthlySocialSecurityHandler({ stateRegistry: sr });
      ssHandler.handledEvents.push(context.schedulesById['MONTHLY_SS_INCOME']);
      handlers.push(ssHandler);
    }

    // Super account mechanics
    if (superAccts.length > 0) handlers.push(
      new SuperContributionHandler(),
      new SuperWithdrawalContributionsHandler(),
      new SuperWithdrawalEarningsHandler(),
      new SuperEarningsDirectHandler(),
    );

    // Super Earnings (one handler per SUPER account)
    const superEvent = context.schedulesById['INTL_SUPER_EARNINGS'];
    if (superEvent) {
      for (const acct of superAccts) {
        const h = new SuperEarningsHandler({
          stateRegistry: sr,
          role:          ACCOUNT_ROLES.SUPER,
          ownerId:       acct.ownerId,
          defaultRate:   p.superGrowthRate,
        });
        h.handledEvents.push(superEvent);
        handlers.push(h);
      }
    }

    // AU Stock Earnings + Dividends
    const stockEvent = context.schedulesById['INTL_AU_STOCK_EARNINGS'];
    const divEvent   = context.schedulesById['INTL_AU_STOCK_DIVIDEND'];
    if (stockEvent) {
      for (const acct of auStockAccts) {
        const earningsH = new IntlAuStockEarningsHandler({
          stateRegistry: sr,
          role:          ACCOUNT_ROLES.AU_STOCK,
          ownerId:       acct.ownerId,
          growthRate:    p.auStockGrowthRate,
        });
        earningsH.handledEvents.push(stockEvent);
        handlers.push(earningsH);

        const divH = new IntlAuStockDividendHandler({
          stateRegistry: sr,
          role:          ACCOUNT_ROLES.AU_STOCK,
          ownerId:       acct.ownerId,
          dividendRate:  p.auStockDividendRate,
        });
        divH.handledEvents.push(divEvent);
        handlers.push(divH);
      }
    }

    return handlers;
  },

  reducers(context) {
    const p          = context.parameters;
    const accountSvc = context.accountService;
    const reducers   = [];

    // Skip reducers already registered by US_RETIREMENT.
    if (!context._auSharedDelegated) {
      const recordMetricReducer = ReducerBuilder.metric(null).name('Record Metric').build();
      recordMetricReducer.reducedActionTypes = ['RECORD_METRIC'];
      reducers.push(recordMetricReducer);

      reducers.push(new ExpenseDebitReducer({ accountService: accountSvc }));
      reducers.push(new ReplenishSavingsReducer({ accountService: accountSvc }));
      reducers.push(new SetOutOfFundsDateReducer());
      reducers.push(new AccumulateDeficitReducer());
      reducers.push(new OutOfFundsReducer());

      if (p.inflationAdjust) {
        reducers.push(new InflationAdjustReducer());
      }
    }

    // Super account mechanics
    const superAccts = context.accounts.filter(a => a.role === ACCOUNT_ROLES.SUPER);
    if (superAccts.length > 0) reducers.push(
      new SuperContributionApplyReducer({ accountService: accountSvc }),
      new SuperWithdrawalContribApplyReducer({ accountService: accountSvc }),
      new SuperWithdrawalEarningsApplyReducer({ accountService: accountSvc }),
      new SuperEarningsApplyReducer({ accountService: accountSvc }),
    );

    return reducers;
  },
};

function _accountToStatePlain(account) {
  const plain = {
    balance:               account.balance,
    stateKey:              account.stateKey,
    type:                  account.type                  ?? null,
    country:               account.country               ?? null,
    currency:              account.currency              ?? null,
    role:                  account.role                  ?? null,
    ownerId:               account.ownerId               ?? null,
    minimumBalance:        account.minimumBalance        ?? 0,
    drawdownPriority:      account.drawdownPriority      ?? null,
    allowsEarlyWithdrawal: account.allowsEarlyWithdrawal ?? false,
    // Holdings — plain-data array (no methods), structuredClone-safe.
    holdings:              (account.holdings ?? []).map(h => ({ ...h })),
  };
  if (account.contributionBasis !== undefined) {
    plain.contributionBasis        = account.contributionBasis;
    plain.earningsBasis            = account.earningsBasis ?? 0;
    plain.loanBalance              = account.loanBalance   ?? 0;
    plain.minimumAge               = account.minimumAge    ?? null;
    plain.balanceAtResidencyChange = account.balanceAtResidencyChange ?? null;
    if (account.rolloverContribBasis  !== undefined) plain.rolloverContribBasis  = account.rolloverContribBasis;
    if (account.rolloverEarningsBasis !== undefined) plain.rolloverEarningsBasis = account.rolloverEarningsBasis;
  }
  return plain;
}
