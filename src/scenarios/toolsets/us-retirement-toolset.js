/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { EventBuilder }         from '../../simulation-framework/builders/event-builder.js';
import { ReducerBuilder }       from '../../simulation-framework/builders/reducer-builder.js';
import { OneOffEvent }          from '../../simulation-framework/events/one-off-event.js';
import { ACCOUNT_ROLES }        from '../../finance/state/account-roles.js';
import { MonthlyExpensesHandler }       from '../../finance/handlers/monthly-expenses-handler.js';
import { MonthlyWagesHandler }          from '../../finance/handlers/monthly-wages-handler.js';
import { MonthlySocialSecurityHandler } from '../../finance/handlers/monthly-social-security-handler.js';
import { DividendScheduledHandler }     from '../../finance/handlers/dividend-scheduled-handler.js';
import {
  FixedIncomeInterestHandler,
  IntlIraEarningsHandler, IntlRothEarningsHandler, IntlK401EarningsHandler,
  IntlUsStockEarningsHandler,
} from '../../finance/handlers/earnings-handlers.js';
import { OutOfFundsHandler }            from '../../finance/handlers/out-of-funds-handler.js';
import { ExpenseDebitReducer }          from '../../finance/reducers/expense-debit-reducer.js';
import { ReplenishSavingsReducer }      from '../../finance/reducers/replenish-savings-reducer.js';
import { StockDividendCashApplyReducer }    from '../../finance/reducers/stock-dividend-cash-apply-reducer.js';
import { SetOutOfFundsDateReducer }     from '../../finance/reducers/set-out-of-funds-date-reducer.js';
import { AccumulateDeficitReducer }     from '../../finance/reducers/accumulate-deficit-reducer.js';
import { OutOfFundsReducer }            from '../../finance/reducers/out-of-funds-reducer.js';
import { InflationAdjustReducer }       from '../../finance/reducers/inflation-adjust-reducer.js';
import {
  RothContributionApplyReducer, RothWithdrawalContribApplyReducer,
  RothWithdrawalEarningsApplyReducer, RothEarningsApplyReducer,
  RothContributionHandler, RothWithdrawalContributionsHandler,
  RothWithdrawalEarningsHandler, RothEarningsHandler,
} from '../../finance/account-rules/us/roth-classes.js';
import {
  IraContributionApplyReducer, IraWithdrawalContribApplyReducer,
  IraWithdrawalEarningsApplyReducer, IraEarningsApplyReducer,
  IraContributionHandler, IraWithdrawalContributionsHandler,
  IraWithdrawalEarningsHandler, IraEarningsHandler,
} from '../../finance/account-rules/us/ira-classes.js';
import {
  K401ContributionApplyReducer, K401EarningsApplyReducer, K401WithdrawalApplyReducer,
  K401ContributionHandler, K401EarningsHandler, K401WithdrawalHandler,
  K401RmdApplyReducer, K401AnnualRmdHandler,
  K401ToIraConversionHandler, K401ToIraConversionApplyReducer,
} from '../../finance/account-rules/us/k401-classes.js';
import {
  IraRolloverWithdrawalApplyReducer, IraRmdApplyReducer,
  IraRolloverWithdrawalHandler, IraRmdHandler, IraAnnualRmdHandler,
} from '../../finance/account-rules/us/ira-rollover-classes.js';
import { TaxService } from '../../finance/tax-service.js';
import {
  RothRolloverContributionApplyReducer, RothRolloverEarningsApplyReducer,
  RothRolloverWithdrawalContribApplyReducer, RothRolloverWithdrawalEarningsApplyReducer,
  RothRolloverContributionHandler, RothRolloverEarningsHandler,
  RothRolloverWithdrawalContributionsHandler, RothRolloverWithdrawalEarningsHandler,
} from '../../finance/account-rules/us/roth-rollover-classes.js';

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

/**
 * US_RETIREMENT toolset — declarative shape for ScenarioCompiler.
 *
 * Capabilities: retirement
 * Depends on: US_BANKING, US_TAX (pulled in automatically by the dependency graph)
 *
 * State ownership:
 *   Initializes: isAuResident, monthlyExpenses, inflationRates,
 *                inflationAccumulator, metrics, people, per-account state entries
 *   Reads: us* keys from US_TAX; US_SAVINGS_INTEREST_MONTHLY from US_BANKING
 */
export const US_RETIREMENT = {
  id: 'US_RETIREMENT',
  capabilities: ['retirement'],
  dependencies: ['US_BANKING', 'US_TAX', 'US_INCOME', 'US_BROKERAGE'],

  paramSchema(context) {
    return [
      {
        key: 'inflationRate', label: 'Inflation Rate',
        type: 'Number', group: 'US Retirement', mc: true, opt: true,
        defaultValue: 0.03,
        description: 'Annual inflation rate applied to expenses',
      },
      {
        key: 'iraGrowthRate', label: 'IRA Growth Rate',
        type: 'Number', group: 'US Retirement', mc: true, opt: true,
        defaultValue: 0.07,
        description: 'Annual growth rate for Traditional IRA accounts',
      },
      {
        key: 'rothGrowthRate', label: 'Roth IRA Growth Rate',
        type: 'Number', group: 'US Retirement', mc: true, opt: true,
        defaultValue: 0.07,
        description: 'Annual growth rate for Roth IRA accounts',
      },
      {
        key: 'k401GrowthRate', label: '401(k) Growth Rate',
        type: 'Number', group: 'US Retirement', mc: true, opt: true,
        defaultValue: 0.07,
        description: 'Annual growth rate for 401(k) accounts',
      },
      {
        key: 'brokerageGrowthRate', label: 'Brokerage Growth Rate',
        type: 'Number', group: 'US Retirement', mc: true, opt: true,
        defaultValue: 0.05,
        description: 'Annual growth rate for US brokerage stock accounts',
      },
      {
        key: 'brokerageDividendRate', label: 'Brokerage Dividend Rate',
        type: 'Number', group: 'US Retirement', mc: true, opt: true,
        defaultValue: 0.02,
        description: 'Annual dividend yield for US brokerage stock accounts',
      },
      {
        key: 'dividendReinvest', label: 'Reinvest Dividends',
        type: 'Boolean', group: 'US Retirement', mc: false, opt: true,
        defaultValue: false,
        description: 'If true, US stock dividends are reinvested rather than taken as cash',
      },
      {
        key: 'fixedIncomeInterestRate', label: 'Fixed Income Interest Rate',
        type: 'Number', group: 'US Retirement', mc: true, opt: true,
        defaultValue: 0.04,
        description: 'Annual interest rate for fixed income accounts',
      },
      {
        key: 'monthlyExpenses', label: 'Monthly Expenses (USD)',
        type: 'Number', group: 'US Retirement', mc: true, opt: true,
        defaultValue: 6_000,
        description: 'Monthly household expenses drawn from savings',
      },
      {
        key: 'inflationAdjust', label: 'Inflation-Adjust Expenses',
        type: 'Boolean', group: 'US Retirement', mc: false, opt: true,
        defaultValue: true,
        description: 'If true, monthly expenses grow with inflation each year',
      },
      {
        key: 'k401ToIraConversionEnabled', label: '401(k)→IRA Conversion Enabled',
        type: 'Boolean', group: 'US Retirement', mc: false, opt: false,
        defaultValue: true,
        description: 'If true, each 401(k) is rolled into the owner\'s first IRA on the owner\'s retirement date',
      },
      {
        key: 'k401ToIraConversionMonth', label: '401(k)→IRA Conversion Month',
        type: 'Number', group: 'US Retirement', mc: false, opt: true,
        defaultValue: null,
        description: 'Month (1–12) of the conversion; null = use the owner\'s retirement month',
      },
      {
        key: 'k401ToIraConversionDay', label: '401(k)→IRA Conversion Day',
        type: 'Number', group: 'US Retirement', mc: false, opt: true,
        defaultValue: null,
        description: 'Day of month for the conversion; null = use the owner\'s retirement day',
      },
      {
        key: 'k401ToIraConversionYear', label: '401(k)→IRA Conversion Year',
        type: 'Number', group: 'US Retirement', mc: false, opt: true,
        defaultValue: null,
        description: 'Year of the conversion; null = use the owner\'s retirement year',
      },
    ];
  },

  state(context) {
    const p = context.parameters;

    // Build people map (same shape as UsRetirementToolset.setup())
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
        citizen:               person.citizen               ?? ['US'],
      };
    }

    const patches = {
      isAuResident:         false,
      monthlyExpenses:      p.monthlyExpenses,
      inflationRates:       { US: p.inflationRate },
      inflationAccumulator: { US: 1.0 },
      metrics:              {},
      people,
      outOfFundsDate:       null,
      scenarioFailed:       false,
      cumulativeDeficit:    0,
      deficitMonths:        0,
      personBirthDate:      context.people[0]?.birthDate ?? null,
    };

    // Account state entries (handlers read state[stateKey] for balance lookups)
    for (const account of context.accounts) {
      if (account.stateKey && patches[account.stateKey] === undefined) {
        patches[account.stateKey] = _accountToStatePlain(account);
      }
    }

    return patches;
  },

  schedules(context) {
    const p        = context.parameters;
    const accounts = context.accounts;
    const people   = context.people;

    const usSavingsAccounts   = accounts.filter(a => a.role === ACCOUNT_ROLES.US_SAVINGS);
    const iraAccounts         = accounts.filter(a => a.role === ACCOUNT_ROLES.IRA);
    const rothAccounts        = accounts.filter(a => a.role === ACCOUNT_ROLES.ROTH);
    const k401Accounts        = accounts.filter(a => a.role === ACCOUNT_ROLES.K401);
    const usStockAccounts     = accounts.filter(a => a.role === ACCOUNT_ROLES.US_STOCK);
    const fixedIncomeAccounts = accounts.filter(a => a.role === ACCOUNT_ROLES.FIXED_INCOME);
    const personsWithSS       = people.filter(pe => (pe.socialSecurityMonthly ?? 0) > 0);

    const schedules = [
      EventBuilder.eventSeries()
        .name('Monthly Expenses').type('MONTHLY_EXPENSES')
        .interval('month-end').enabled(true).color('#F44336').build(),
      EventBuilder.eventSeries()
        .name('Monthly Wages').type('MONTHLY_WAGES')
        .interval('month-end').enabled(true).color('#4CAF50').build(),
    ];

    if (personsWithSS.length > 0) {
      schedules.push(
        EventBuilder.eventSeries()
          .name('Monthly Social Security').type('MONTHLY_SS_INCOME')
          .interval('month-end').enabled(true).color('#3F51B5').build()
      );
    }

    if (iraAccounts.length > 0) {
      schedules.push(
        EventBuilder.eventSeries()
          .name('IRA Earnings').type('INTL_IRA_EARNINGS')
          .interval('year-end').startOffset(1).enabled(true).color('#5C6BC0').build()
      );
      schedules.push(
        EventBuilder.eventSeries()
          .name('IRA Annual RMD').type('IRA_ANNUAL_RMD')
          .interval('year-end').startOffset(1).enabled(true).color('#E65100').build()
      );
    }

    if (rothAccounts.length > 0) {
      schedules.push(
        EventBuilder.eventSeries()
          .name('Roth IRA Earnings').type('INTL_ROTH_EARNINGS')
          .interval('year-end').startOffset(1).enabled(true).color('#7E57C2').build()
      );
    }

    if (k401Accounts.length > 0) {
      schedules.push(
        EventBuilder.eventSeries()
          .name('401k Earnings').type('INTL_K401_EARNINGS')
          .interval('year-end').startOffset(1).enabled(true).color('#42A5F5').build()
      );
      schedules.push(
        EventBuilder.eventSeries()
          .name('401k Annual RMD').type('K401_ANNUAL_RMD')
          .interval('year-end').startOffset(1).enabled(true).color('#BF360C').build()
      );
    }

    if (usStockAccounts.length > 0) {
      schedules.push(
        EventBuilder.eventSeries()
          .name('US Stock Earnings').type('INTL_STOCK_EARNINGS')
          .interval('year-end').startOffset(1).enabled(true).color('#26A69A').build()
      );
      schedules.push(
        EventBuilder.eventSeries()
          .name('US Stock Dividends').type('DIVIDEND_SCHEDULED')
          .interval('year-end').startOffset(1).enabled(true).color('#4CAF50').build()
      );
    }

    if (fixedIncomeAccounts.length > 0) {
      schedules.push(
        EventBuilder.eventSeries()
          .name('Fixed Income Interest').type('INTL_FIXED_INCOME_INTEREST')
          .interval('year-end').startOffset(1).enabled(true).color('#2196F3').build()
      );
    }

    if (p.k401ToIraConversionEnabled && k401Accounts.length > 0) {
      for (const k401 of k401Accounts) {
        const owner = people.find(pe => pe.id === k401.ownerId);
        if (!owner?.retirementDate) continue;
        const ownerIra = iraAccounts.find(a => a.ownerId === k401.ownerId);
        if (!ownerIra) continue;

        const retirement = new Date(owner.retirementDate);
        const year  = p.k401ToIraConversionYear  ?? retirement.getUTCFullYear();
        const month = (p.k401ToIraConversionMonth ?? (retirement.getUTCMonth() + 1)) - 1;
        const day   = p.k401ToIraConversionDay   ?? retirement.getUTCDate();

        schedules.push(new OneOffEvent({
          name:    `401(k)→IRA Conversion (${owner.name})`,
          type:    'K401_TO_IRA_CONVERSION',
          date:    new Date(Date.UTC(year, month, day)),
          data:    { k401Key: k401.stateKey, iraKey: ownerIra.stateKey },
          enabled: true,
          color:   '#BF360C',
        }));
      }
    }

    return schedules;
  },

  handlers(context) {
    const p        = context.parameters;
    const accounts = context.accounts;
    const people   = context.people;
    const sr       = context.stateRegistry;

    const usSavingsAccounts   = accounts.filter(a => a.role === ACCOUNT_ROLES.US_SAVINGS);
    const iraAccounts         = accounts.filter(a => a.role === ACCOUNT_ROLES.IRA);
    const rothAccounts        = accounts.filter(a => a.role === ACCOUNT_ROLES.ROTH);
    const k401Accounts        = accounts.filter(a => a.role === ACCOUNT_ROLES.K401);
    const usStockAccounts     = accounts.filter(a => a.role === ACCOUNT_ROLES.US_STOCK);
    const fixedIncomeAccounts = accounts.filter(a => a.role === ACCOUNT_ROLES.FIXED_INCOME);
    const personsWithSS       = people.filter(pe => (pe.socialSecurityMonthly ?? 0) > 0);

    const primaryId         = usSavingsAccounts[0]?.ownerId ?? (people[0]?.id ?? null);
    const accountRulesEngine = new TaxService().accountRulesEngine;
    const handlers          = [];

    // Monthly Expenses
    const expensesHandler = new MonthlyExpensesHandler({
      stateRegistry:   sr,
      monthlyExpenses: p.monthlyExpenses,
      usRole:          ACCOUNT_ROLES.US_SAVINGS, usOwnerId: primaryId,
      auRole:          ACCOUNT_ROLES.AU_SAVINGS,  auOwnerId: primaryId,
    });
    expensesHandler.handledEvents.push(context.schedulesById['MONTHLY_EXPENSES']);
    handlers.push(expensesHandler);

    // Monthly Wages
    const wagesHandler = new MonthlyWagesHandler({ stateRegistry: sr });
    wagesHandler.handledEvents.push(context.schedulesById['MONTHLY_WAGES']);
    handlers.push(wagesHandler);

    // Social Security
    if (personsWithSS.length > 0) {
      const ssHandler = new MonthlySocialSecurityHandler({ stateRegistry: sr, accountRulesEngine });
      ssHandler.handledEvents.push(context.schedulesById['MONTHLY_SS_INCOME']);
      handlers.push(ssHandler);
    }

    // IRA earnings + annual RMD
    const iraEvent   = context.schedulesById['INTL_IRA_EARNINGS'];
    const rmdEvent   = context.schedulesById['IRA_ANNUAL_RMD'];
    if (iraEvent) {
      for (const acct of iraAccounts) {
        const h = new IntlIraEarningsHandler({
          stateRegistry: sr, role: ACCOUNT_ROLES.IRA,
          ownerId: acct.ownerId, stateKey: acct.stateKey,
          growthRate: p.iraGrowthRate,
        });
        h.handledEvents.push(iraEvent);
        handlers.push(h);

        if (rmdEvent) {
          const rmdH = new IraAnnualRmdHandler({
            stateRegistry: sr, role: ACCOUNT_ROLES.IRA,
            ownerId: acct.ownerId, stateKey: acct.stateKey,
            accountRulesEngine,
          });
          rmdH.handledEvents.push(rmdEvent);
          handlers.push(rmdH);
        }
      }
    }

    // Roth IRA earnings
    const rothEvent = context.schedulesById['INTL_ROTH_EARNINGS'];
    if (rothEvent) {
      for (const acct of rothAccounts) {
        const h = new IntlRothEarningsHandler({
          stateRegistry: sr, role: ACCOUNT_ROLES.ROTH,
          ownerId: acct.ownerId, stateKey: acct.stateKey,
          growthRate: p.rothGrowthRate,
        });
        h.handledEvents.push(rothEvent);
        handlers.push(h);
      }
    }

    // 401(k) earnings + annual RMD
    const k401Event    = context.schedulesById['INTL_K401_EARNINGS'];
    const k401RmdEvent = context.schedulesById['K401_ANNUAL_RMD'];
    if (k401Event) {
      for (const acct of k401Accounts) {
        const h = new IntlK401EarningsHandler({
          stateRegistry: sr, role: ACCOUNT_ROLES.K401,
          ownerId: acct.ownerId, stateKey: acct.stateKey,
          growthRate: p.k401GrowthRate,
        });
        h.handledEvents.push(k401Event);
        handlers.push(h);

        if (k401RmdEvent) {
          const rmdH = new K401AnnualRmdHandler({
            stateRegistry: sr, role: ACCOUNT_ROLES.K401,
            ownerId: acct.ownerId, stateKey: acct.stateKey,
            accountRulesEngine,
          });
          rmdH.handledEvents.push(k401RmdEvent);
          handlers.push(rmdH);
        }
      }
    }

    // US Stock earnings + dividends
    const stockEvent = context.schedulesById['INTL_STOCK_EARNINGS'];
    const divEvent   = context.schedulesById['DIVIDEND_SCHEDULED'];
    if (stockEvent) {
      for (const acct of usStockAccounts) {
        const earningsH = new IntlUsStockEarningsHandler({
          stateRegistry: sr, role: ACCOUNT_ROLES.US_STOCK,
          ownerId: acct.ownerId, stateKey: acct.stateKey,
          growthRate: p.brokerageGrowthRate,
        });
        earningsH.handledEvents.push(stockEvent);
        handlers.push(earningsH);

        const divH = new DividendScheduledHandler({
          stateRegistry: sr, role: ACCOUNT_ROLES.US_STOCK,
          ownerId: acct.ownerId, stateKey: acct.stateKey,
          dividendRate: p.brokerageDividendRate,
          reinvest:     p.dividendReinvest,
        });
        divH.handledEvents.push(divEvent);
        handlers.push(divH);
      }
    }

    // Fixed income interest
    const fiEvent = context.schedulesById['INTL_FIXED_INCOME_INTEREST'];
    if (fiEvent) {
      for (const acct of fixedIncomeAccounts) {
        const h = new FixedIncomeInterestHandler({
          stateRegistry: sr, role: ACCOUNT_ROLES.FIXED_INCOME,
          ownerId: acct.ownerId, stateKey: acct.stateKey,
          interestRate: p.fixedIncomeInterestRate,
        });
        h.handledEvents.push(fiEvent);
        handlers.push(h);
      }
    }

    // Roth IRA mechanics
    if (rothAccounts.length > 0) handlers.push(
      new RothContributionHandler(), new RothWithdrawalContributionsHandler(),
      new RothWithdrawalEarningsHandler(), new RothEarningsHandler(),
      new RothRolloverContributionHandler(), new RothRolloverEarningsHandler(),
      new RothRolloverWithdrawalContributionsHandler(), new RothRolloverWithdrawalEarningsHandler(),
    );

    // Traditional IRA mechanics
    if (iraAccounts.length > 0) handlers.push(
      new IraContributionHandler(), new IraWithdrawalContributionsHandler(),
      new IraWithdrawalEarningsHandler(), new IraEarningsHandler(),
      new IraRolloverWithdrawalHandler(), new IraRmdHandler(),
    );

    // 401(k) mechanics
    if (k401Accounts.length > 0) handlers.push(
      new K401ContributionHandler(), new K401EarningsHandler(), new K401WithdrawalHandler(),
    );

    // 401(k)→IRA conversion (only when both account types exist)
    if (k401Accounts.length > 0 && iraAccounts.length > 0) {
      const convEvent = context.schedulesById['K401_TO_IRA_CONVERSION'];
      const convH = new K401ToIraConversionHandler();
      if (convEvent) convH.handledEvents.push(convEvent);
      handlers.push(convH);
    }

    // Out-of-funds handler (no event binding)
    handlers.push(new OutOfFundsHandler());

    return handlers;
  },

  reducers(context) {
    const p           = context.parameters;
    const accounts    = context.accounts;
    const accountSvc  = context.accountService;
    const sr          = context.stateRegistry;

    const usSavingsAccounts = accounts.filter(a => a.role === ACCOUNT_ROLES.US_SAVINGS);
    const usStockAccounts   = accounts.filter(a => a.role === ACCOUNT_ROLES.US_STOCK);
    const rothAccounts      = accounts.filter(a => a.role === ACCOUNT_ROLES.ROTH);
    const iraAccounts       = accounts.filter(a => a.role === ACCOUNT_ROLES.IRA);
    const k401Accounts      = accounts.filter(a => a.role === ACCOUNT_ROLES.K401);
    const primaryId = usSavingsAccounts[0]?.ownerId ?? (context.people[0]?.id ?? null);

    const reducers = [];

    const recordMetricReducer = ReducerBuilder.metric(null).name('Record Metric').build();
    recordMetricReducer.reducedActionTypes = ['RECORD_METRIC'];
    reducers.push(recordMetricReducer);

    reducers.push(new ExpenseDebitReducer({ accountService: accountSvc }));
    reducers.push(new ReplenishSavingsReducer({ accountService: accountSvc }));

    if (usStockAccounts.length > 0) {
      reducers.push(new StockDividendCashApplyReducer({
        accountService: accountSvc, stateRegistry: sr,
        role: ACCOUNT_ROLES.US_SAVINGS, ownerId: primaryId,
      }));
    }

    reducers.push(new SetOutOfFundsDateReducer());
    reducers.push(new AccumulateDeficitReducer());
    reducers.push(new OutOfFundsReducer());

    if (p.inflationAdjust) {
      reducers.push(new InflationAdjustReducer());
    }

    // Roth IRA mechanics
    if (rothAccounts.length > 0) reducers.push(
      new RothContributionApplyReducer({ accountService: accountSvc }),
      new RothWithdrawalContribApplyReducer({ accountService: accountSvc }),
      new RothWithdrawalEarningsApplyReducer({ accountService: accountSvc }),
      new RothEarningsApplyReducer({ accountService: accountSvc }),
      new RothRolloverContributionApplyReducer({ accountService: accountSvc }),
      new RothRolloverEarningsApplyReducer({ accountService: accountSvc }),
      new RothRolloverWithdrawalContribApplyReducer({ accountService: accountSvc }),
      new RothRolloverWithdrawalEarningsApplyReducer({ accountService: accountSvc }),
    );

    // Traditional IRA mechanics
    if (iraAccounts.length > 0) reducers.push(
      new IraContributionApplyReducer({ accountService: accountSvc }),
      new IraWithdrawalContribApplyReducer({ accountService: accountSvc }),
      new IraWithdrawalEarningsApplyReducer({ accountService: accountSvc }),
      new IraEarningsApplyReducer({ accountService: accountSvc }),
      new IraRolloverWithdrawalApplyReducer({ accountService: accountSvc }),
      new IraRmdApplyReducer({ accountService: accountSvc }),
    );

    // 401(k) mechanics
    if (k401Accounts.length > 0) reducers.push(
      new K401ContributionApplyReducer({ accountService: accountSvc }),
      new K401EarningsApplyReducer({ accountService: accountSvc }),
      new K401WithdrawalApplyReducer({ accountService: accountSvc }),
      new K401RmdApplyReducer({ accountService: accountSvc }),
    );

    // 401(k)→IRA conversion (no cash pool / tax — direct rollover)
    if (k401Accounts.length > 0 && iraAccounts.length > 0) {
      reducers.push(new K401ToIraConversionApplyReducer({ accountService: accountSvc }));
    }

    return reducers;
  },
};
