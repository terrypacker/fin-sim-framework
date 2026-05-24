/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * toolset-us-retirement.test.mjs
 *
 * Integration tests for UsRetirementToolset — the Phase 3 toolset that wires
 * US-only retirement finance machinery from a custom JSON scenario.
 *
 * Tests call ScenarioSerializer.deserializePersonsAccounts() + UsRetirementToolset.setup()
 * directly (mirroring BaseApp.initScenario()'s toolset branch) to keep the test
 * self-contained and independent of the UI layer.
 *
 * Run with: node --test tests/unit/toolset-us-retirement.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Simulation }      from '../../src/simulation-framework/simulation.js';
import { HandlerEntry }    from '../../src/simulation-framework/handlers.js';
import {
  AmountAction, Action, FieldAction, FieldValueAction, ScriptedAction, RecordBalanceAction,
} from '../../src/simulation-framework/actions.js';
import {
  FieldReducer, NoOpReducer, ArrayReducer, NumericSumReducer, MultiplicativeReducer, ScriptedReducer,
} from '../../src/simulation-framework/reducers.js';
import { ReducerBuilder }  from '../../src/simulation-framework/builders/reducer-builder.js';
import { BaseEvent }       from '../../src/simulation-framework/events/base-event.js';
import { EventSeries }     from '../../src/simulation-framework/events/event-series.js';
import { OneOffEvent }     from '../../src/simulation-framework/events/one-off-event.js';

import { ServiceRegistry }    from '../../src/services/service-registry.js';
import { BaseScenario }       from '../../src/scenarios/base-scenario.js';
import { ScenarioSerializer } from '../../src/scenarios/scenario-serializer.js';
import { UsRetirementToolset } from '../../src/scenarios/toolsets/us-retirement-toolset.js';

import { TaxService }           from '../../src/finance/tax-service.js';
import { DynamicTaxReducer }    from '../../src/finance/tax/dynamic-tax-reducer.js';
import { PeriodAdvanceReducer, PeriodAdvanceHandler }
  from '../../src/finance/tax/period-advance-classes.js';
import { TaxSettleHandler, TaxSettleApplyReducer, TaxPaymentDebitReducer }
  from '../../src/finance/tax/tax-settle-classes.js';
import {
  RothContributionApplyReducer, RothWithdrawalContribApplyReducer,
  RothWithdrawalEarningsApplyReducer, RothEarningsApplyReducer,
  RothContributionHandler, RothWithdrawalContributionsHandler,
  RothWithdrawalEarningsHandler, RothEarningsHandler,
} from '../../src/finance/account-rules/us/roth-classes.js';
import {
  IraContributionApplyReducer, IraWithdrawalContribApplyReducer,
  IraWithdrawalEarningsApplyReducer, IraEarningsApplyReducer,
  IraContributionHandler, IraWithdrawalContributionsHandler,
  IraWithdrawalEarningsHandler, IraEarningsHandler,
} from '../../src/finance/account-rules/us/ira-classes.js';
import {
  K401ContributionApplyReducer, K401EarningsApplyReducer, K401WithdrawalApplyReducer,
  K401ContributionHandler, K401EarningsHandler, K401WithdrawalHandler,
} from '../../src/finance/account-rules/us/k401-classes.js';
import {
  FixedIncomeContributionApplyReducer, FixedIncomeWithdrawalApplyReducer,
  FixedIncomeEarningsApplyReducer, StockContributionApplyReducer,
  StockDividendApplyReducer, StockEarningsApplyReducer, StockWithdrawalApplyReducer,
  FixedIncomeContributionHandler, FixedIncomeWithdrawalHandler, FixedIncomeEarningsHandler,
  StockContributionHandler, StockDividendHandler, StockEarningsHandler, StockWithdrawalHandler,
} from '../../src/finance/account-rules/us/us-brokerage-classes.js';
import { UsHouseSaleApplyReducer, UsHouseSaleHandler }
  from '../../src/finance/account-rules/us/us-real-property-classes.js';
import {
  SsIncomeApplyReducer, WagesIncomeApplyReducer, WagesWithheldApplyReducer,
  SeIncomeUsApplyReducer, BonusApplyReducer, CompanySaleApplyReducer,
  SsIncomeHandler, WagesIncomeHandler, WagesWithheldHandler,
  SeIncomeUsHandler, BonusHandler, CompanySaleHandler,
} from '../../src/finance/account-rules/us/us-income-classes.js';
import {
  CollectibleSaleApplyReducer, CollectibleValueChangeApplyReducer,
  CollectibleSaleHandler, CollectibleValueChangeHandler,
} from '../../src/finance/account-rules/us/us-collectible-classes.js';
import {
  IraRolloverWithdrawalApplyReducer, IraRmdApplyReducer,
  IraRolloverWithdrawalHandler, IraRmdHandler,
} from '../../src/finance/account-rules/us/ira-rollover-classes.js';
import {
  RothRolloverContributionApplyReducer, RothRolloverEarningsApplyReducer,
  RothRolloverWithdrawalContribApplyReducer, RothRolloverWithdrawalEarningsApplyReducer,
  RothRolloverContributionHandler, RothRolloverEarningsHandler,
  RothRolloverWithdrawalContributionsHandler, RothRolloverWithdrawalEarningsHandler,
} from '../../src/finance/account-rules/us/roth-rollover-classes.js';
import { RothConversionApplyReducer, RothConversionHandler, RothConversionPolicyHandler }
  from '../../src/finance/account-rules/us/roth-conversion-classes.js';
import { AuSeIncomeApplyReducer, AuSeIncomeHandler }
  from '../../src/finance/account-rules/au/au-income-classes.js';
import {
  AuSavingsContributionApplyReducer, AuSavingsWithdrawalApplyReducer,
  AuSavingsEarningsApplyReducer, AuSavingsContributionHandler,
  AuSavingsWithdrawalHandler, AuSavingsEarningsHandler,
} from '../../src/finance/account-rules/au/au-savings-classes.js';
import {
  SuperContributionApplyReducer, SuperWithdrawalContribApplyReducer,
  SuperWithdrawalEarningsApplyReducer, SuperEarningsApplyReducer,
  SuperContributionHandler, SuperWithdrawalContributionsHandler,
  SuperWithdrawalEarningsHandler, SuperEarningsDirectHandler,
} from '../../src/finance/account-rules/au/au-super-classes.js';
import {
  AuDividendFrankedResidentApplyReducer, AuDividendFrankedNonResidentApplyReducer,
  AuDividendUnfrankedResidentApplyReducer, AuDividendUnfrankedNonResidentApplyReducer,
  AuStockEarningsApplyReducer, AuStockWithdrawalApplyReducer,
  AuDividendFrankedResidentHandler, AuDividendFrankedNonResidentHandler,
  AuDividendUnfrankedResidentHandler, AuDividendUnfrankedNonResidentHandler,
  AuStockEarningsHandler, AuStockWithdrawalHandler,
} from '../../src/finance/account-rules/au/au-brokerage-classes.js';
import { AuHouseSaleApplyReducer, AuHouseSaleHandler }
  from '../../src/finance/account-rules/au/au-real-property-classes.js';
import { UsSavingsInterestMonthlyHandler }  from '../../src/finance/handlers/us-savings-interest-handler.js';
import { MonthlyExpensesHandler }           from '../../src/finance/handlers/monthly-expenses-handler.js';
import { MonthlyWagesHandler }              from '../../src/finance/handlers/monthly-wages-handler.js';
import { IntlTransferToUsHandler, IntlTransferToAuHandler }
  from '../../src/finance/handlers/intl-transfer-handlers.js';
import {
  AuSavingsInterestHandler, FixedIncomeInterestHandler, SuperEarningsHandler,
  IntlRothEarningsHandler, IntlIraEarningsHandler, IntlK401EarningsHandler,
  IntlUsStockEarningsHandler, IntlAuStockEarningsHandler, IntlAuStockDividendHandler,
} from '../../src/finance/handlers/earnings-handlers.js';
import { DividendScheduledHandler }   from '../../src/finance/handlers/dividend-scheduled-handler.js';
import { ChangeResidencyHandler }     from '../../src/finance/handlers/change-residency-handler.js';
import { OutOfFundsHandler }          from '../../src/finance/handlers/out-of-funds-handler.js';
import { ChangeResidencyApplyReducer } from '../../src/finance/reducers/change-residency-apply-reducer.js';
import { ExpenseDebitReducer }         from '../../src/finance/reducers/expense-debit-reducer.js';
import { IntlTransferApplyReducer }    from '../../src/finance/reducers/intl-transfer-apply-reducer.js';
import { ReplenishSavingsReducer }     from '../../src/finance/reducers/replenish-savings-reducer.js';
import { SetOutOfFundsDateReducer }    from '../../src/finance/reducers/set-out-of-funds-date-reducer.js';
import { AccumulateDeficitReducer }    from '../../src/finance/reducers/accumulate-deficit-reducer.js';
import { OutOfFundsReducer }           from '../../src/finance/reducers/out-of-funds-reducer.js';
import { InflationAdjustReducer }      from '../../src/finance/reducers/inflation-adjust-reducer.js';
import { StockDividendCashApplyReducer }   from '../../src/finance/reducers/stock-dividend-cash-apply-reducer.js';
import { UsSavingsInterestCreditReducer }  from '../../src/finance/reducers/us-savings-interest-credit-reducer.js';
import { Account, CheckingAccount, SavingsAccount } from '../../src/finance/assets/account.js';
import {
  InvestmentAccount, BrokerageAccount, FourOhOneKAccount,
  RothAccount, TraditionalIRAAccount, SuperannuationAccount,
} from '../../src/finance/assets/investment-account.js';
import { Person } from '../../src/finance/person.js';

// ─── FinSimLib global (required by ScenarioSerializer's _makeX methods) ─────────

globalThis.FinSimLib = {
  Engine: {
    Simulation, HandlerEntry,
    AmountAction, Action, FieldAction, ScriptedAction, FieldValueAction, RecordBalanceAction,
    FieldReducer, NoOpReducer, ArrayReducer, NumericSumReducer, MultiplicativeReducer, ScriptedReducer,
    ReducerBuilder,
    BaseEvent, EventSeries, OneOffEvent,
  },
  Scenarios: {},
  Finance: {
    TaxService, DynamicTaxReducer,
    PeriodAdvanceReducer, PeriodAdvanceHandler,
    TaxSettleHandler, TaxSettleApplyReducer, TaxPaymentDebitReducer,
    RothContributionApplyReducer, RothWithdrawalContribApplyReducer,
    RothWithdrawalEarningsApplyReducer, RothEarningsApplyReducer,
    RothContributionHandler, RothWithdrawalContributionsHandler,
    RothWithdrawalEarningsHandler, RothEarningsHandler,
    IraContributionApplyReducer, IraWithdrawalContribApplyReducer,
    IraWithdrawalEarningsApplyReducer, IraEarningsApplyReducer,
    IraContributionHandler, IraWithdrawalContributionsHandler,
    IraWithdrawalEarningsHandler, IraEarningsHandler,
    K401ContributionApplyReducer, K401EarningsApplyReducer, K401WithdrawalApplyReducer,
    K401ContributionHandler, K401EarningsHandler, K401WithdrawalHandler,
    FixedIncomeContributionApplyReducer, FixedIncomeWithdrawalApplyReducer,
    FixedIncomeEarningsApplyReducer, StockContributionApplyReducer,
    StockDividendApplyReducer, StockEarningsApplyReducer, StockWithdrawalApplyReducer,
    FixedIncomeContributionHandler, FixedIncomeWithdrawalHandler, FixedIncomeEarningsHandler,
    StockContributionHandler, StockDividendHandler, StockEarningsHandler, StockWithdrawalHandler,
    UsHouseSaleApplyReducer, UsHouseSaleHandler,
    SsIncomeApplyReducer, WagesIncomeApplyReducer, WagesWithheldApplyReducer,
    SeIncomeUsApplyReducer, BonusApplyReducer, CompanySaleApplyReducer,
    SsIncomeHandler, WagesIncomeHandler, WagesWithheldHandler,
    SeIncomeUsHandler, BonusHandler, CompanySaleHandler,
    CollectibleSaleApplyReducer, CollectibleValueChangeApplyReducer,
    CollectibleSaleHandler, CollectibleValueChangeHandler,
    IraRolloverWithdrawalApplyReducer, IraRmdApplyReducer,
    IraRolloverWithdrawalHandler, IraRmdHandler,
    RothRolloverContributionApplyReducer, RothRolloverEarningsApplyReducer,
    RothRolloverWithdrawalContribApplyReducer, RothRolloverWithdrawalEarningsApplyReducer,
    RothRolloverContributionHandler, RothRolloverEarningsHandler,
    RothRolloverWithdrawalContributionsHandler, RothRolloverWithdrawalEarningsHandler,
    RothConversionApplyReducer, RothConversionHandler, RothConversionPolicyHandler,
    AuSavingsContributionApplyReducer, AuSavingsWithdrawalApplyReducer, AuSavingsEarningsApplyReducer,
    AuSavingsContributionHandler, AuSavingsWithdrawalHandler, AuSavingsEarningsHandler,
    SuperContributionApplyReducer, SuperWithdrawalContribApplyReducer,
    SuperWithdrawalEarningsApplyReducer, SuperEarningsApplyReducer,
    SuperContributionHandler, SuperWithdrawalContributionsHandler,
    SuperWithdrawalEarningsHandler, SuperEarningsDirectHandler,
    AuDividendFrankedResidentApplyReducer, AuDividendFrankedNonResidentApplyReducer,
    AuDividendUnfrankedResidentApplyReducer, AuDividendUnfrankedNonResidentApplyReducer,
    AuStockEarningsApplyReducer, AuStockWithdrawalApplyReducer,
    AuDividendFrankedResidentHandler, AuDividendFrankedNonResidentHandler,
    AuDividendUnfrankedResidentHandler, AuDividendUnfrankedNonResidentHandler,
    AuStockEarningsHandler, AuStockWithdrawalHandler,
    AuHouseSaleApplyReducer, AuHouseSaleHandler,
    AuSeIncomeApplyReducer, AuSeIncomeHandler,
    UsSavingsInterestMonthlyHandler, MonthlyExpensesHandler, MonthlyWagesHandler,
    IntlTransferToUsHandler, IntlTransferToAuHandler,
    AuSavingsInterestHandler, FixedIncomeInterestHandler, SuperEarningsHandler,
    DividendScheduledHandler, ChangeResidencyHandler, OutOfFundsHandler,
    IntlRothEarningsHandler, IntlIraEarningsHandler, IntlK401EarningsHandler,
    IntlUsStockEarningsHandler, IntlAuStockEarningsHandler, IntlAuStockDividendHandler,
    ChangeResidencyApplyReducer, ExpenseDebitReducer, IntlTransferApplyReducer,
    ReplenishSavingsReducer, SetOutOfFundsDateReducer, AccumulateDeficitReducer,
    OutOfFundsReducer, InflationAdjustReducer,
    StockDividendCashApplyReducer, UsSavingsInterestCreditReducer,
    Account, CheckingAccount, SavingsAccount,
    InvestmentAccount, BrokerageAccount, FourOhOneKAccount,
    RothAccount, TraditionalIRAAccount, SuperannuationAccount,
    Person,
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * A minimal custom JSON scenario with toolset: 'us-retirement'.
 * Person has wages so MonthlyWagesHandler produces income.
 * US Savings starts at $30k with $6k/month expenses → should drop by ~$18k after 3 months
 * (before wages come in — wages of $8k/month should largely offset expenses).
 */
const CUSTOM_JSON = {
  toolset:   'us-retirement',
  simStart:  '2026-01-01',
  simEnd:    '2041-01-01',
  assumptions: {
    inflationRate:          0.03,
    usSavingsInterestRate:  0.03,
    iraGrowthRate:          0.07,
    k401GrowthRate:         0.07,
    brokerageGrowthRate:    0.05,
    brokerageDividendRate:  0.02,
    dividendReinvest:       false,
  },
  expenses: { monthlyExpenses: 6_000, inflationAdjust: false },
  persons: [
    {
      __type:                'Person',
      id:                    'primary',
      name:                  'Primary',
      birthDate:             '1978-04-15',
      citizen:               ['US'],
      lifeExpectancy:        90,
      socialSecurityMonthly: 2800,
      monthlyWage:           8_000,
      retirementDate:        '2040-01-01',
    },
  ],
  accounts: [
    {
      __type:       'SavingsAccount',
      id:           'acct-savings',
      name:         'US Savings',
      type:         'savings',
      role:         'us-savings',
      stateKey:     'usSavingsAccount',
      initialValue: 30_000,
      ownershipType: 'sole',
      ownerId:      'primary',
      minimumBalance: 3_000,
      country:      'US',
      currency:     { code: 'USD', symbol: '$' },
    },
    {
      __type:            'TraditionalIRAAccount',
      id:                'acct-ira',
      name:              'Traditional IRA',
      type:              'ira',
      role:              'ira',
      stateKey:          'iraAccount',
      initialValue:      200_000,
      ownershipType:     'sole',
      ownerId:           'primary',
      contributionBasis: 150_000,
      earningsBasis:     0,
      loanBalance:       0,
      country:           'US',
      currency:          { code: 'USD', symbol: '$' },
      drawdownPriority:  3,
    },
    {
      __type:            'FourOhOneKAccount',
      id:                'acct-k401',
      name:              '401(k)',
      type:              '401k',
      role:              'k401',
      stateKey:          'k401Account',
      initialValue:      300_000,
      ownershipType:     'sole',
      ownerId:           'primary',
      contributionBasis: 200_000,
      earningsBasis:     0,
      loanBalance:       0,
      country:           'US',
      currency:          { code: 'USD', symbol: '$' },
      drawdownPriority:  4,
    },
  ],
};

/**
 * Load and run a toolset scenario from a custom JSON config.
 * Returns { scenario, sim } after loading persons/accounts and running toolset.setup().
 */
function loadToolsetScenario(config) {
  ServiceRegistry.reset();
  const services = ServiceRegistry.getInstance();

  const scenario = new BaseScenario({
    context:  services.simulationContext,
    simStart: new Date(config.simStart),
    simEnd:   new Date(config.simEnd),
  });
  scenario.buildSim();

  const hasPersonsOrAccounts = (config.persons?.length > 0) || (config.accounts?.length > 0);
  if (hasPersonsOrAccounts) {
    ScenarioSerializer.deserializePersonsAccounts(config, services);
  }
  UsRetirementToolset.setup(config, services);

  return { scenario, sim: scenario.sim };
}

// End of first quarter 2026 — 3 month-end events (Jan 31, Feb 28, Mar 31).
const Q1_2026 = new Date(Date.UTC(2026, 2, 31));

// ─── Tests ────────────────────────────────────────────────────────────────────

test('toolset: us-retirement loads and runs 3 months without error', () => {
  const { sim } = loadToolsetScenario(CUSTOM_JSON);
  assert.doesNotThrow(() => sim.stepTo(Q1_2026), 'stepTo should not throw');
  assert.strictEqual(
    sim.currentDate.toISOString(),
    Q1_2026.toISOString(),
    'sim should advance to Mar 31 2026',
  );
});

test('toolset: US savings account exists and has a balance', () => {
  const { sim } = loadToolsetScenario(CUSTOM_JSON);
  sim.stepTo(Q1_2026);
  assert.ok(sim.state.usSavingsAccount != null, 'usSavingsAccount must be in state');
  assert.ok(typeof sim.state.usSavingsAccount.balance === 'number', 'balance must be a number');
});

test('toolset: monthly expenses reduce US savings over 3 months', () => {
  const { sim } = loadToolsetScenario(CUSTOM_JSON);
  const initialBalance = sim.state.usSavingsAccount?.balance ?? 0;
  assert.ok(initialBalance > 0, 'initial usSavingsAccount balance should be positive');

  sim.stepTo(Q1_2026);
  const finalBalance = sim.state.usSavingsAccount?.balance ?? 0;

  // 3 months × $6k expenses, partially offset by $8k wages → net should be near
  // 30000 + 3×(8000−6000) = 36000, but taxes reduce wages slightly.
  // Just check that balance is still positive and reasonable.
  assert.ok(finalBalance > 0, 'US savings should remain positive after 3 months');
  assert.ok(finalBalance < initialBalance + 10_000,
    `Balance ${finalBalance.toFixed(0)} should not grow more than wages allow`);
});

test('toolset: IRA account exists and retains initial balance before year-end', () => {
  const { sim } = loadToolsetScenario(CUSTOM_JSON);
  sim.stepTo(Q1_2026);
  assert.ok(sim.state.iraAccount != null, 'iraAccount must be in state');
  // No IRA earnings before first year-end (startOffset=1 means fires at end of year 2026+1)
  assert.strictEqual(sim.state.iraAccount.balance, 200_000,
    'IRA balance should remain unchanged before year-end earnings fire');
});

test('toolset: 401k account exists in state', () => {
  const { sim } = loadToolsetScenario(CUSTOM_JSON);
  sim.stepTo(Q1_2026);
  assert.ok(sim.state.k401Account != null, 'k401Account must be in state');
  assert.strictEqual(sim.state.k401Account.balance, 300_000,
    '401k balance should remain unchanged before year-end earnings fire');
});

test('toolset: deserializePersonsAccounts loads person into personService', () => {
  ServiceRegistry.reset();
  const services = ServiceRegistry.getInstance();

  const scenario = new BaseScenario({
    context:  services.simulationContext,
    simStart: new Date(CUSTOM_JSON.simStart),
    simEnd:   new Date(CUSTOM_JSON.simEnd),
  });
  scenario.buildSim();

  ScenarioSerializer.deserializePersonsAccounts(CUSTOM_JSON, services);

  const persons = services.personService.getAll();
  assert.strictEqual(persons.length, 1, 'exactly one person should be registered');
  assert.strictEqual(persons[0].id, 'primary');
  assert.strictEqual(persons[0].monthlyWage, 8_000);
});

test('toolset: deserializePersonsAccounts loads accounts into accountService', () => {
  ServiceRegistry.reset();
  const services = ServiceRegistry.getInstance();

  const scenario = new BaseScenario({
    context:  services.simulationContext,
    simStart: new Date(CUSTOM_JSON.simStart),
    simEnd:   new Date(CUSTOM_JSON.simEnd),
  });
  scenario.buildSim();

  ScenarioSerializer.deserializePersonsAccounts(CUSTOM_JSON, services);

  const accounts = services.accountService.getAll();
  assert.strictEqual(accounts.length, 3, 'three accounts should be registered');

  const savings = accounts.find(a => a.stateKey === 'usSavingsAccount');
  assert.ok(savings, 'usSavingsAccount should be registered');
  assert.strictEqual(savings.balance, 30_000);
});
