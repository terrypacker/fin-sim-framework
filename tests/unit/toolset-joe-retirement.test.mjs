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
 * toolset-joe-retirement.test.mjs
 *
 * Integration tests for a US-only retired person using the us-retirement toolset.
 *
 * Joe is already retired (retirementDate in the past), has no wages, receives
 * $1,000/month Social Security (stored in state.people — not auto-fired by the
 * toolset), and holds five accounts:
 *   - Checking ($10k, us-savings)          — primary cash / expense drawdown
 *   - Brokerage TOD/SAM ($2.1M, us-stock)  — main investment, drawdown priority 2
 *   - Brokerage ($100k, us-stock)          — secondary investment, drawdown priority 3
 *   - IRA ($100k, ira)                     — tax-deferred, drawdown priority 4
 *   - Inherited IRA ($30k, ira)            — tax-deferred, drawdown priority 5
 *
 * Tests mirror the pattern in toolset-us-retirement.test.mjs.
 *
 * Run with: node --test tests/unit/toolset-joe-retirement.test.mjs
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
import { ScenarioLoader } from '../../src/scenarios/scenario-loader.js';
import { UsTaxRates2025 }      from '../../src/finance/tax/us/us-tax-rates-2025.js';

import { TaxService }           from '../../src/finance/tax-service.js';
import { DynamicTaxReducer }    from '../../src/finance/tax/dynamic-tax-reducer.js';
import { UsPeriodAdvanceReducer, AuPeriodAdvanceReducer, UsPeriodAdvanceHandler, AuPeriodAdvanceHandler }
  from '../../src/finance/tax/period-advance-classes.js';
import { UsTaxSettleHandler, AuTaxSettleHandler, UsTaxSettleApplyReducer, AuTaxSettleApplyReducer, UsTaxPaymentDebitReducer, AuTaxPaymentDebitReducer }
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
  K401ContributionHandler, K401EarningsHandler, K401WithdrawalHandler, K401RmdApplyReducer, K401AnnualRmdHandler,
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
  IraRolloverWithdrawalHandler, IraRmdHandler, IraAnnualRmdHandler,
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

// ─── Scenario config ──────────────────────────────────────────────────────────

/**
 * Joe: already retired (retirementDate in the past), US citizen only,
 * $1k/month SS (stored in state.people — not auto-fired by the toolset),
 * no wages, $10k/month expenses.
 *
 * Account stateKey: any unique key works for the US cash account. MonthlyExpensesHandler
 * resolves it via StateRegistry and passes it as action.targetKey to EXPENSE_DEBIT;
 * ExpenseDebitReducer reads action.targetKey first (falling back to 'usSavingsAccount'
 * only for manually dispatched actions). UsSavingsInterestCreditReducer also uses
 * StateRegistry. So 'checkingAccount' is valid and semantically correct here.
 *
 * Multiple accounts of the same role and same owner are supported: each
 * per-account handler is constructed with stateKey = acct.stateKey so it
 * targets the correct state entry directly rather than relying on the
 * role+owner stateRegistry lookup (which only returns the first match).
 *
 * Note: this is the inner toolset config object — the UI import format wraps
 * this in { "scenarios": [{ "id": "u:1", ... }] }, but tests use it directly.
 */
const JOE_CONFIG = {
  toolsets: ['US_RETIREMENT'],
  simStart: '2026-05-01',
  simEnd:   '2050-01-01',
  parameters: {
    inflationRate:           0.03,
    usSavingsInterestRate:   0.03,
    iraGrowthRate:           0.07,
    rothGrowthRate:          0.07,
    k401GrowthRate:          0.07,
    brokerageGrowthRate:     0.05,
    brokerageDividendRate:   0.02,
    dividendReinvest:        false,
    monthlyExpenses:         10_000,
    inflationAdjust:         true,
  },
  persons: [
    {
      __type:                'Person',
      id:                    'joe',
      name:                  'Joe',
      birthDate:             '1954-01-01',
      citizen:               ['US'],
      lifeExpectancy:        95,
      socialSecurityMonthly: 1_000,
      monthlyWage:           0,
      retirementDate:        '2020-01-01',
    },
  ],
  accounts: [
    {
      __type:         'SavingsAccount',
      id:             'acct-checking',
      name:           'Checking',
      type:           'savings',
      role:           'us-savings',
      stateKey:       'checkingAccount',
      initialValue:   10_000,
      ownershipType:  'sole',
      ownerId:        'joe',
      minimumBalance: 2_000,
      drawdownPriority: 1,
      country:        'US',
      currency:       { code: 'USD', symbol: '$' },
    },
    {
      __type:            'BrokerageAccount',
      id:                'acct-brokerage-tod',
      name:              'Brokerage TOD/SAM',
      type:              'brokerage',
      role:              'us-stock',
      stateKey:          'brokerageTodAccount',
      initialValue:      2_100_000,
      ownershipType:     'sole',
      ownerId:           'joe',
      contributionBasis: 1_000_000,
      earningsBasis:     0,
      loanBalance:       0,
      drawdownPriority:  2,
      country:           'US',
      currency:          { code: 'USD', symbol: '$' },
    },
    {
      __type:            'BrokerageAccount',
      id:                'acct-brokerage',
      name:              'Brokerage',
      type:              'brokerage',
      role:              'us-stock',
      stateKey:          'brokerageAccount',
      initialValue:      100_000,
      ownershipType:     'sole',
      ownerId:           'joe',
      contributionBasis: 80_000,
      earningsBasis:     0,
      loanBalance:       0,
      drawdownPriority:  3,
      country:           'US',
      currency:          { code: 'USD', symbol: '$' },
    },
    {
      __type:            'TraditionalIRAAccount',
      id:                'acct-ira',
      name:              'IRA',
      type:              'ira',
      role:              'ira',
      stateKey:          'iraAccount',
      initialValue:      100_000,
      ownershipType:     'sole',
      ownerId:           'joe',
      contributionBasis: 0,
      earningsBasis:     0,
      loanBalance:       0,
      minimumAge:        59.5,
      drawdownPriority:  4,
      country:           'US',
      currency:          { code: 'USD', symbol: '$' },
    },
    {
      __type:            'TraditionalIRAAccount',
      id:                'acct-inherited-ira',
      name:              'Inherited IRA',
      type:              'ira',
      role:              'ira',
      stateKey:          'inheritedIraAccount',
      initialValue:      30_000,
      ownershipType:     'sole',
      ownerId:           'joe',
      contributionBasis: 0,
      earningsBasis:     0,
      loanBalance:       0,
      minimumAge:        null,
      drawdownPriority:  5,
      country:           'US',
      currency:          { code: 'USD', symbol: '$' },
    },
  ],
};

// ─── Helper ───────────────────────────────────────────────────────────────────

function loadToolsetScenario(config) {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();

  const scenario = new BaseScenario({
    context:  services.simulationContext,
    simStart: new Date(config.simStart),
    simEnd:   new Date(config.simEnd),
  });
  scenario.buildSim();

  new ScenarioLoader().load(structuredClone(config), services);

  return { scenario, sim: scenario.sim };
}

// End of first month of the sim (May 31 2026).
const MAY_END_2026 = new Date(Date.UTC(2026, 4, 31));
// End of 2026 — brokerage and IRA year-end earnings fire after this.
const END_2026     = new Date(Date.UTC(2026, 11, 31));

// ─── Tests ────────────────────────────────────────────────────────────────────

test('joe: toolset loads and runs one month without error', () => {
  const { sim } = loadToolsetScenario(JOE_CONFIG);
  assert.doesNotThrow(() => sim.stepTo(MAY_END_2026));
  assert.strictEqual(sim.currentDate.toISOString(), MAY_END_2026.toISOString());
});

test('joe: deserializePersonsAccounts loads Joe into personService', () => {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  const scenario = new BaseScenario({
    context:  services.simulationContext,
    simStart: new Date(JOE_CONFIG.simStart),
    simEnd:   new Date(JOE_CONFIG.simEnd),
  });
  scenario.buildSim();
  ScenarioSerializer.deserializePersonsAccounts(JOE_CONFIG, services);

  const persons = services.personService.getAll();
  assert.strictEqual(persons.length, 1, 'exactly one person');
  assert.strictEqual(persons[0].id, 'joe');
  assert.strictEqual(persons[0].name, 'Joe');
  assert.strictEqual(persons[0].monthlyWage, 0);
  assert.strictEqual(persons[0].socialSecurityMonthly, 1_000);
  assert.strictEqual(persons[0].lifeExpectancy, 95);
});

test('joe: all five accounts are registered in accountService', () => {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  const scenario = new BaseScenario({
    context:  services.simulationContext,
    simStart: new Date(JOE_CONFIG.simStart),
    simEnd:   new Date(JOE_CONFIG.simEnd),
  });
  scenario.buildSim();
  ScenarioSerializer.deserializePersonsAccounts(JOE_CONFIG, services);

  const accounts = services.accountService.getAll();
  assert.strictEqual(accounts.length, 5, 'five accounts should be registered');

  const checking     = accounts.find(a => a.stateKey === 'checkingAccount');
  const brokerageTod = accounts.find(a => a.stateKey === 'brokerageTodAccount');
  const brokerage    = accounts.find(a => a.stateKey === 'brokerageAccount');
  const ira          = accounts.find(a => a.stateKey === 'iraAccount');
  const inheritedIra = accounts.find(a => a.stateKey === 'inheritedIraAccount');

  assert.ok(checking,     'checkingAccount should be registered');
  assert.ok(brokerageTod, 'brokerageTodAccount should be registered');
  assert.ok(brokerage,    'brokerageAccount should be registered');
  assert.ok(ira,          'iraAccount should be registered');
  assert.ok(inheritedIra, 'inheritedIraAccount should be registered');

  assert.strictEqual(checking.balance,     10_000);
  assert.strictEqual(brokerageTod.balance, 2_100_000);
  assert.strictEqual(brokerage.balance,    100_000);
  assert.strictEqual(ira.balance,          100_000);
  assert.strictEqual(inheritedIra.balance, 30_000);
});

test('joe: all five accounts exist in sim state after setup', () => {
  const { sim } = loadToolsetScenario(JOE_CONFIG);
  assert.ok(sim.state.checkingAccount     != null, 'checkingAccount in state');
  assert.ok(sim.state.brokerageTodAccount != null, 'brokerageTodAccount in state');
  assert.ok(sim.state.brokerageAccount    != null, 'brokerageAccount in state');
  assert.ok(sim.state.iraAccount          != null, 'iraAccount in state');
  assert.ok(sim.state.inheritedIraAccount != null, 'inheritedIraAccount in state');
});

test('joe: checking account balance is $10k before any events fire', () => {
  const { sim } = loadToolsetScenario(JOE_CONFIG);
  assert.strictEqual(sim.state.checkingAccount.balance, 10_000);
});

test('joe: $10k/month expenses reduce checking after one month', () => {
  const { sim } = loadToolsetScenario(JOE_CONFIG);
  const before = sim.state.checkingAccount.balance;
  sim.stepTo(MAY_END_2026);
  const after = sim.state.checkingAccount.balance;
  // Checking starts below the $10k expense; ReplenishSavingsReducer should
  // pull from brokerage (priority 2) to cover the shortfall.  Checking may
  // end near minimumBalance ($2k) or the brokerage may have been tapped.
  assert.ok(after < before || sim.state.brokerageTodAccount.balance < 2_100_000,
    'either checking fell or brokerage TOD was tapped to cover $10k expense');
});

test('joe: no wages fire because monthlyWage is 0', () => {
  const { sim } = loadToolsetScenario(JOE_CONFIG);
  // Run a full year — wages event fires monthly but should produce no actions.
  sim.stepTo(END_2026);
  // US ordinary income should only reflect tax-settled amounts, not wages.
  // Brokerage year-end earnings don't fire until end of 2027 (startOffset=1), so
  // total brokerage should not exceed initial values before that point.
  const brokerageTotal = sim.state.brokerageTodAccount.balance + sim.state.brokerageAccount.balance;
  assert.ok(
    brokerageTotal <= 2_200_000,
    'brokerage accounts should not show wage-driven growth (only drawdown before year-end earnings)',
  );
});

test('joe: brokerage accounts grow by year-end earnings', () => {
  const { sim } = loadToolsetScenario(JOE_CONFIG);
  const todBefore = sim.state.brokerageTodAccount.balance;
  const broBefore = sim.state.brokerageAccount.balance;

  // startOffset=1 means earnings fire after the first year-end, i.e. end of 2027.
  const END_2027 = new Date(Date.UTC(2027, 11, 31));
  sim.stepTo(END_2027);

  const todAfter = sim.state.brokerageTodAccount.balance;
  const broAfter = sim.state.brokerageAccount.balance;

  // After expenses and one year of 5% growth, each brokerage balance should have changed.
  assert.ok(todAfter !== todBefore, 'brokerageTodAccount balance should change after year-end earnings');
  assert.ok(broAfter !== broBefore, 'brokerageAccount balance should change after year-end earnings');
});

test('joe: IRA accounts hold their initial balances before first year-end earnings', () => {
  const { sim } = loadToolsetScenario(JOE_CONFIG);
  sim.stepTo(MAY_END_2026);
  // IRA earnings have startOffset=1 — they don't fire until end of 2027.
  assert.strictEqual(sim.state.iraAccount.balance,          100_000,
    'IRA balance unchanged before first year-end earnings');
  assert.strictEqual(sim.state.inheritedIraAccount.balance, 30_000,
    'Inherited IRA balance unchanged before first year-end earnings');
});

test('joe: IRA accounts grow after first year-end earnings fire', () => {
  const { sim } = loadToolsetScenario(JOE_CONFIG);
  const END_2027 = new Date(Date.UTC(2027, 11, 31));
  sim.stepTo(END_2027);
  assert.ok(sim.state.iraAccount.balance > 100_000,
    `IRA should grow from $100k; got ${sim.state.iraAccount.balance}`);
  assert.ok(sim.state.inheritedIraAccount.balance > 30_000,
    `Inherited IRA should grow from $30k; got ${sim.state.inheritedIraAccount.balance}`);
});

test('joe: Joe is in state.people with correct socialSecurityMonthly', () => {
  const { sim } = loadToolsetScenario(JOE_CONFIG);
  assert.ok(sim.state.people?.joe != null, 'state.people.joe should exist');
  assert.strictEqual(sim.state.people.joe.socialSecurityMonthly, 1_000);
  assert.strictEqual(sim.state.people.joe.monthlyWage, 0);
});

test('joe: drawdown priorities are set correctly on all accounts', () => {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  const scenario = new BaseScenario({
    context:  services.simulationContext,
    simStart: new Date(JOE_CONFIG.simStart),
    simEnd:   new Date(JOE_CONFIG.simEnd),
  });
  scenario.buildSim();
  ScenarioSerializer.deserializePersonsAccounts(JOE_CONFIG, services);

  const accounts = services.accountService.getAll();
  const byKey = Object.fromEntries(accounts.map(a => [a.stateKey, a]));

  assert.strictEqual(byKey.checkingAccount.drawdownPriority,     1);
  assert.strictEqual(byKey.brokerageTodAccount.drawdownPriority, 2);
  assert.strictEqual(byKey.brokerageAccount.drawdownPriority,    3);
  assert.strictEqual(byKey.iraAccount.drawdownPriority,          4);
  assert.strictEqual(byKey.inheritedIraAccount.drawdownPriority, 5);
});

// ─── Filing Status tests ──────────────────────────────────────────────────────

test('joe: single person auto-detected as single filer (usFilingSingle=true)', () => {
  const { sim } = loadToolsetScenario(JOE_CONFIG);
  assert.strictEqual(sim.state.usFilingSingle, true,
    'Joe is the only person — toolset should set usFilingSingle=true');
});

test('joe: explicit usFilingSingle=false overrides single-person auto-detect', () => {
  const config = {
    ...JOE_CONFIG,
    parameters: { ...JOE_CONFIG.parameters, usFilingSingle: false },
  };
  const { sim } = loadToolsetScenario(config);
  assert.strictEqual(sim.state.usFilingSingle, false,
    'explicit usFilingSingle=false should be honored even with 1 person');
});

test('joe: usFilingSingle=true causes tax engine to use single brackets ($15k std deduction)', () => {
  const { sim } = loadToolsetScenario(JOE_CONFIG);
  assert.strictEqual(sim.state.usFilingSingle, true);

  // Inject a synthetic state to verify the tax engine picks up single-filer deduction
  const rates = new UsTaxRates2025();
  const result = rates.computeTax({
    usOrdinaryIncomeYTD:   20_000,
    usNegativeIncomeYTD:   0,
    usCapitalGainsYTD:     0,
    usCollectibleGainsYTD: 0,
    usPenaltyYTD:          0,
    ftcYTD:                0,
    usFilingSingle:        true,
  });
  assert.strictEqual(result.inputs.standardDeduction, 15_000,
    'single-filer std deduction should be $15,000');
  assert.strictEqual(result.filingStatus, 'Single');
  // $20k − $15k = $5k taxable @ 10% = $500
  assert.strictEqual(result.netLiability, 500,
    '$20k income − $15k deduction = $5k taxable @ 10% = $500');
});
