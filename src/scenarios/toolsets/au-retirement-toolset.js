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
import { OneOffEvent }                from '../../simulation-framework/events/one-off-event.js';
import { ACCOUNT_ROLES }              from '../../finance/state/account-roles.js';
import { MonthlyExpensesHandler }     from '../../finance/handlers/monthly-expenses-handler.js';
import { RetirementDateHandler }      from '../../finance/spending/strategies/retirement-date-handler.js';
import { HealthcareEventHandler }     from '../../finance/spending/strategies/healthcare-event-handler.js';
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
import { AccumulateTaxesPaidReducer } from '../../finance/reducers/accumulate-taxes-paid-reducer.js';
import { AccumulateConsumptionReducer } from '../../finance/reducers/accumulate-consumption-reducer.js';
import { AccumulateConsumptionUtilityReducer } from '../../finance/reducers/accumulate-consumption-utility-reducer.js';
import { OutOfFundsReducer }          from '../../finance/reducers/out-of-funds-reducer.js';
import { InflationAdjustReducer }         from '../../finance/reducers/inflation-adjust-reducer.js';
import { SpendingStrategyApplyReducer }   from '../../finance/spending/spending-strategy-apply-reducer.js';
import { SPENDING_STRATEGY_REGISTRY }     from '../../finance/spending/spending-strategy-registry.js';
import { ValueType } from '../../simulation-framework/type-registry.js';
import {
  SuperContributionApplyReducer, SuperWithdrawalContribApplyReducer,
  SuperWithdrawalEarningsApplyReducer, SuperEarningsApplyReducer,
  SuperContributionHandler, SuperWithdrawalContributionsHandler,
  SuperWithdrawalEarningsHandler, SuperEarningsDirectHandler,
} from '../../finance/account-rules/au/au-super-classes.js';
import { MortalityHandler }                      from '../../finance/handlers/mortality-handler.js';
import { PersonDiedApplyReducer }                from '../../finance/reducers/person-died-apply-reducer.js';
import { SocialSecuritySurvivorApplyReducer }    from '../../finance/reducers/social-security-survivor-apply-reducer.js';
import { AccountRetitleApplyReducer }            from '../../finance/reducers/account-retitle-apply-reducer.js';
import { ScenarioCompleteReducer }               from '../../finance/reducers/scenario-complete-reducer.js';
import { LateLifeCareHandler }                  from '../../finance/spending/strategies/late-life-care-handler.js';
import { LateLifeCareApplyReducer }             from '../../finance/spending/strategies/late-life-care-apply-reducer.js';

/**
 * AU_RETIREMENT toolset — AU retirement/superannuation scenario wiring.
 *
 * Capabilities: superannuation
 * Depends on: AU_TAX, AU_BANKING
 *
 * State ownership:
 *   Initializes: people (with residency='AU'), monthlyExpenses, inflationRates,
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
      { type: 'GUARDRAIL_BASELINE_APPLY',   fields: { initialWithdrawalRate: ValueType.number(), portfolioValue: ValueType.number(), annualSpending: ValueType.number(), date: ValueType.any() } },
      { type: 'GUARDRAIL_ADJUST_APPLY',     fields: { multiplier: ValueType.number(), cause: ValueType.text(), date: ValueType.any() } },
      { type: 'HEALTHCARE_EXPENSE_APPLY',   fields: { amount: ValueType.number() } },
      { type: 'LATE_LIFE_CARE_APPLY',       fields: { active: ValueType.boolean(), factor: ValueType.number(), personId: ValueType.text() } },
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
        // Shared key with US_RETIREMENT (merge dedupes by key). Kept identical in
        // its Money metadata so the effective param is consistent regardless of
        // toolset merge order (design/10 §Phase 5, design/32). Household-base,
        // default USD; per-residency expense currency is a later phase.
        key: 'monthlyExpenses', label: 'Monthly Expenses',
        type: 'Money', group: 'Spending', mc: true, opt: true,
        defaultValue: 6_000,
        defaultCurrency: 'USD',
        currencyStateKeys: ['monthlyExpenses', 'expenses.essential', 'expenses.discretionary'],
        description: 'Monthly household expenses drawn from savings',
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
      {
        key: 'discretionarySharePct', label: 'Discretionary Share',
        type: 'Number', group: 'Spending', mc: false, opt: true,
        defaultValue: 0.30,
        description: 'Fraction of monthly expenses treated as discretionary (0.30 = 30%)',
      },
      {
        key: 'spendingStrategy', label: 'Spending Strategy',
        type: 'EnumMulti', group: 'Spending', mc: false, opt: true,
        options: ['FIXED', 'REGIME_AWARE', 'GUARDRAIL', 'HEALTHCARE', 'AGE_BANDED', 'EXPLICIT_BANDS'],
        defaultValue: ['FIXED'],
        description: 'Active spending strategies; FIXED = inflation-adjusted scalar (default), REGIME_AWARE = cut discretionary under economic-stress regimes, GUARDRAIL = Guyton-Klinger withdrawal-rate bands, HEALTHCARE = one-off healthcare expense events, AGE_BANDED = age-driven real spending smile (go-go/slow-go/no-go), EXPLICIT_BANDS = absolute monthly amount per age band (design 38 §6.1)',
      },
      ...SPENDING_STRATEGY_REGISTRY.REGIME_AWARE.paramSchema(),
      ...SPENDING_STRATEGY_REGISTRY.GUARDRAIL.paramSchema(),
      ...SPENDING_STRATEGY_REGISTRY.HEALTHCARE.paramSchema(),
      ...SPENDING_STRATEGY_REGISTRY.AGE_BANDED.paramSchema(),
      ...SPENDING_STRATEGY_REGISTRY.EXPLICIT_BANDS.paramSchema(),
      {
        key: 'mortalityEnabled', label: 'Mortality Enabled',
        type: 'Boolean', group: 'Mortality', mc: false, opt: true,
        defaultValue: true,
        description: 'If true, PERSON_DIED events are scheduled and processed',
      },
      {
        key: 'survivorEssentialMultiplier', label: 'Survivor Essential Multiplier',
        type: 'Number', group: 'Mortality', mc: false, opt: true,
        defaultValue: 0.85,
        description: 'Fraction of essential expenses retained after a spouse dies',
      },
      {
        key: 'survivorDiscretionaryMultiplier', label: 'Survivor Discretionary Multiplier',
        type: 'Number', group: 'Mortality', mc: false, opt: true,
        defaultValue: 0.50,
        description: 'Fraction of discretionary expenses retained after a spouse dies',
      },
      {
        key: 'lateLifeCareMonths', label: 'Late-Life Care Window (months)',
        type: 'Number', group: 'Mortality', mc: false, opt: true,
        defaultValue: 0,
        description: 'Number of months before death to apply the late-life care expense multiplier; 0 = disabled',
      },
      {
        key: 'lateLifeCareFactor', label: 'Late-Life Care Factor',
        type: 'Number', group: 'Mortality', mc: false, opt: true,
        defaultValue: 2.0,
        description: 'Multiplier applied to all monthly expenses during the late-life care window',
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
        wageCurrency:          person.wageCurrency          ?? 'AUD',
        retirementDate:        person.retirementDate        ?? null,
        socialSecurityMonthly: person.socialSecurityMonthly ?? 0,
        lifeExpectancy:        person.lifeExpectancy        ?? 90,
        citizen:               person.citizen               ?? ['AU'],
        residency:             'AU',
      };
    }

    const patches = {
      inflationRates:          { AU: p.inflationRate },
      inflationAccumulator:    { AU: 1.0 },
      superWithdrawalBlocked:  false,
    };

    if (!sharedAlreadySetup) {
      const metrics               = {};
      const monthlyExpenses       = p.monthlyExpenses;
      const discretionarySharePct = p.discretionarySharePct ?? 0.30;
      patches.monthlyExpenses       = monthlyExpenses;
      patches.discretionarySharePct = discretionarySharePct;
      patches.expenses = {
        essential:     monthlyExpenses * (1 - discretionarySharePct),
        discretionary: monthlyExpenses * discretionarySharePct,
      };
      patches.metrics = metrics;
      patches.people  = people;
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

    // Guardrail — RETIREMENT_DATE_REACHED (not delegated to US_RETIREMENT here).
    const p        = context.parameters;
    const strategies = p.spendingStrategy ?? ['FIXED'];
    if (strategies.includes('GUARDRAIL') && !context._auSharedDelegated) {
      const simStart = context.simStart ?? new Date();
      for (const person of people) {
        if (!person.retirementDate) continue;
        const retDate = new Date(person.retirementDate);
        if (retDate > simStart && !context.schedulesById['RETIREMENT_DATE_REACHED']) {
          schedules.push(new OneOffEvent({
            name:    `Retirement Date — ${person.name}`,
            type:    'RETIREMENT_DATE_REACHED',
            date:    retDate,
            data:    { personId: person.id },
            enabled: true,
            color:   '#FF9800',
          }));
        }
      }
    }

    // Healthcare — HEALTHCARE_EXPENSE one-off events.
    if (strategies.includes('HEALTHCARE') && !context._auSharedDelegated) {
      const healthcareEvents = p.healthcareEvents ?? [];
      for (const evt of healthcareEvents) {
        if (!evt.date || !evt.amount) continue;
        schedules.push(new OneOffEvent({
          name:    `Healthcare Expense${evt.category ? ` — ${evt.category}` : ''}`,
          type:    'HEALTHCARE_EXPENSE',
          date:    new Date(evt.date),
          data:    { amount: evt.amount, category: evt.category ?? 'healthcare', personId: evt.personId ?? null },
          enabled: true,
          color:   '#E91E63',
        }));
      }
    }

    // Mortality — PERSON_DIED one-off events (design/27).
    // Only schedule if not already registered by US_RETIREMENT in a cross-border scenario.
    const mortalityEnabled   = p.mortalityEnabled ?? true;
    const lateLifeCareMonths = p.lateLifeCareMonths ?? 0;
    const lateLifeCareFactor = p.lateLifeCareFactor ?? 2.0;

    if (mortalityEnabled && !context._auSharedDelegated) {
      const simEnd = context.simEnd ? new Date(context.simEnd) : null;
      for (const person of people) {
        const lifeExpectancy = p.people?.[person.id]?.lifeExpectancy ?? person.lifeExpectancy;
        if (!person.birthDate || !lifeExpectancy) continue;
        const birth     = new Date(person.birthDate);
        const deathDate = new Date(Date.UTC(
          birth.getUTCFullYear() + Math.round(lifeExpectancy),
          birth.getUTCMonth(),
          birth.getUTCDate(),
        ));
        if (simEnd && deathDate > simEnd) continue;
        schedules.push(new OneOffEvent({
          name:    `Death — ${person.name ?? person.id}`,
          type:    'PERSON_DIED',
          date:    deathDate,
          data:    { personId: person.id },
          enabled: true,
          color:   '#37474F',
        }));

        if (lateLifeCareMonths > 0) {
          const careBegin = new Date(deathDate);
          careBegin.setUTCMonth(careBegin.getUTCMonth() - lateLifeCareMonths);
          schedules.push(new OneOffEvent({
            name:    `Late-Life Care Begin — ${person.name ?? person.id}`,
            type:    'LATE_LIFE_CARE_BEGIN',
            date:    careBegin,
            data:    { personId: person.id, factor: lateLifeCareFactor },
            enabled: true,
            color:   '#BF360C',
          }));
          schedules.push(new OneOffEvent({
            name:    `Late-Life Care End — ${person.name ?? person.id}`,
            type:    'LATE_LIFE_CARE_END',
            date:    new Date(deathDate),
            data:    { personId: person.id },
            enabled: true,
            color:   '#BF360C',
          }));
        }
      }
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
        stateRegistry:    sr,
        monthlyExpenses:  p.monthlyExpenses,
        expensesCurrency: p.monthlyExpensesCurrency ?? 'USD',
        usRole:           ACCOUNT_ROLES.US_SAVINGS, usOwnerId: null,
        auRole:           ACCOUNT_ROLES.AU_SAVINGS,  auOwnerId: primaryId,
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
          defaultRate:   acct.growthRate ?? p.superGrowthRate,
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
          growthRate:    acct.growthRate ?? p.auStockGrowthRate,
        });
        earningsH.handledEvents.push(stockEvent);
        handlers.push(earningsH);

        const divH = new IntlAuStockDividendHandler({
          stateRegistry: sr,
          role:          ACCOUNT_ROLES.AU_STOCK,
          ownerId:       acct.ownerId,
          dividendRate:  acct.dividendRate ?? p.auStockDividendRate,
        });
        divH.handledEvents.push(divEvent);
        handlers.push(divH);
      }
    }

    // Guardrail + Healthcare handlers (only if not delegated to US_RETIREMENT).
    if (!context._auSharedDelegated) {
      const strategiesH = p.spendingStrategy ?? ['FIXED'];
      if (strategiesH.includes('GUARDRAIL')) {
        const retDateEvents = Object.values(context.schedulesById).filter(e => e?.type === 'RETIREMENT_DATE_REACHED');
        if (retDateEvents.length > 0) {
          const retH = new RetirementDateHandler({
            baseCurrency: p.guardrailBaseCurrency ?? 'AUD',
          });
          for (const evt of retDateEvents) retH.handledEvents.push(evt);
          handlers.push(retH);
        }
      }
      if (strategiesH.includes('HEALTHCARE')) {
        const hcEvents = Object.values(context.schedulesById).filter(e => e?.type === 'HEALTHCARE_EXPENSE');
        if (hcEvents.length > 0) {
          const hcH = new HealthcareEventHandler({
            stateRegistry: sr,
            expensesCurrency: p.monthlyExpensesCurrency ?? 'USD',
            usRole: ACCOUNT_ROLES.US_SAVINGS, usOwnerId: null,
            auRole: ACCOUNT_ROLES.AU_SAVINGS,  auOwnerId: primaryId,
          });
          for (const evt of hcEvents) hcH.handledEvents.push(evt);
          handlers.push(hcH);
        }
      }

      // Mortality handler — only if not already registered by US_RETIREMENT.
      const mortalityEnabledH = p.mortalityEnabled ?? true;
      if (mortalityEnabledH) {
        const deathEvents = Object.values(context.schedulesById).filter(e => e?.type === 'PERSON_DIED');
        if (deathEvents.length > 0) {
          const mortalityH = new MortalityHandler({
            survivorEssentialMultiplier:     p.survivorEssentialMultiplier     ?? 0.85,
            survivorDiscretionaryMultiplier: p.survivorDiscretionaryMultiplier ?? 0.50,
          });
          for (const evt of deathEvents) mortalityH.handledEvents.push(evt);
          handlers.push(mortalityH);
        }

        // Late-life care handler (design/27 Increment 2).
        const llcBeginEvents = Object.values(context.schedulesById).filter(e => e?.type === 'LATE_LIFE_CARE_BEGIN');
        const llcEndEvents   = Object.values(context.schedulesById).filter(e => e?.type === 'LATE_LIFE_CARE_END');
        if (llcBeginEvents.length > 0 || llcEndEvents.length > 0) {
          const llcH = new LateLifeCareHandler();
          for (const evt of [...llcBeginEvents, ...llcEndEvents]) llcH.handledEvents.push(evt);
          handlers.push(llcH);
        }
      }
    }

    return handlers;
  },

  reducers(context) {
    const p          = context.parameters;
    const accountSvc = context.accountService;
    const sr         = context.stateRegistry;
    const reducers   = [];

    // Skip reducers already registered by US_RETIREMENT.
    if (!context._auSharedDelegated) {
      const recordMetricReducer = ReducerBuilder.metric(null).name('Record Metric').build();
      recordMetricReducer.reducedActionTypes = ['RECORD_METRIC'];
      reducers.push(recordMetricReducer);

      reducers.push(new ExpenseDebitReducer({ accountService: accountSvc, stateRegistry: sr }));
      reducers.push(new ReplenishSavingsReducer({ accountService: accountSvc, stateRegistry: sr }));
      reducers.push(new SetOutOfFundsDateReducer());
      reducers.push(new AccumulateDeficitReducer());
      reducers.push(new AccumulateTaxesPaidReducer());
      reducers.push(new AccumulateConsumptionReducer());
      reducers.push(new AccumulateConsumptionUtilityReducer({ gamma: p.crraGamma ?? 1.5 }));
      reducers.push(new OutOfFundsReducer());

      if (p.inflationAdjust) {
        reducers.push(new InflationAdjustReducer());
      }

      reducers.push(new SpendingStrategyApplyReducer());

      const strategies = p.spendingStrategy ?? ['FIXED'];
      for (const stratKey of strategies) {
        if (stratKey !== 'FIXED' && SPENDING_STRATEGY_REGISTRY[stratKey]) {
          reducers.push(...SPENDING_STRATEGY_REGISTRY[stratKey].reducers(context));
        }
      }
    }

    // Super account mechanics
    const superAccts = context.accounts.filter(a => a.role === ACCOUNT_ROLES.SUPER);
    if (superAccts.length > 0) reducers.push(
      new SuperContributionApplyReducer({ accountService: accountSvc, stateRegistry: sr }),
      new SuperWithdrawalContribApplyReducer({ accountService: accountSvc, stateRegistry: sr }),
      new SuperWithdrawalEarningsApplyReducer({ accountService: accountSvc, stateRegistry: sr }),
      new SuperEarningsApplyReducer({ accountService: accountSvc, stateRegistry: sr }),
    );

    // Mortality reducers (only if not already registered by US_RETIREMENT).
    if (!context._auSharedDelegated) {
      const mortalityEnabledR = p.mortalityEnabled ?? true;
      if (mortalityEnabledR) {
        reducers.push(new PersonDiedApplyReducer());
        reducers.push(new SocialSecuritySurvivorApplyReducer());
        reducers.push(new AccountRetitleApplyReducer());
        reducers.push(new ScenarioCompleteReducer());
        if ((p.lateLifeCareMonths ?? 0) > 0) {
          reducers.push(new LateLifeCareApplyReducer());
        }
      }
    }

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
  // OffsetAccount link (design 53 §3 / 54 P3): carry the property key into runtime
  // state so offsetBalanceForLoan() can find it — otherwise the offset is invisible.
  if (account.offsetsPropertyKey !== undefined) {
    plain.offsetsPropertyKey = account.offsetsPropertyKey ?? null;
  }
  if (account.contributionBasis !== undefined) {
    plain.contributionBasis        = account.contributionBasis;
    plain.earningsBasis            = account.earningsBasis ?? 0;
    plain.loanBalance              = account.loanBalance   ?? 0;
    plain.minimumAge               = account.minimumAge    ?? null;
    plain.balanceAtResidencyChange = account.balanceAtResidencyChange ?? null;
    // Per-country residency cost-base step-up (design 36 §12.2); null until a move.
    plain.costBaseStepUpByCountry  = account.costBaseStepUpByCountry ?? null;
    if (account.rolloverContribBasis  !== undefined) plain.rolloverContribBasis  = account.rolloverContribBasis;
    if (account.rolloverEarningsBasis !== undefined) plain.rolloverEarningsBasis = account.rolloverEarningsBasis;
    // Dated conversion lots backing the §408A(d)(3)(F) 5-year recapture (EVT-43).
    if (account.rolloverContribBasis  !== undefined) plain.rolloverConversions   = (account.rolloverConversions ?? []).map(l => ({ ...l }));
  }
  return plain;
}
