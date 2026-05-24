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
 * toolset-compiler.test.mjs
 *
 * Unit and integration tests for ToolsetRegistry and ScenarioCompiler.
 *
 * Phase 1 (infrastructure): dependency resolution, duplicate-dep handling,
 * unknown-ID error.
 *
 * Phase 2-3 (integration): full US_RETIREMENT scenario via ScenarioCompiler
 * produces correct simulation state and runs 3 months without error.
 *
 * Run with: node --test tests/unit/toolset-compiler.test.mjs
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { ToolsetRegistry }  from '../../src/scenarios/toolsets/toolset-registry.js';
import { ScenarioCompiler } from '../../src/scenarios/toolsets/scenario-compiler.js';

// ─── Stub toolsets for unit tests ────────────────────────────────────────────

const TOOLSET_A = {
  id: 'A',
  dependencies: [],
  paramSchema: () => [{ key: 'aRate', defaultValue: 0.1 }],
  state:     (ctx) => ({ aState: ctx.parameters.aRate }),
  schedules: ()    => [],
  handlers:  ()    => [],
  reducers:  ()    => [],
};

const TOOLSET_B = {
  id: 'B',
  dependencies: ['A'],
  paramSchema: () => [{ key: 'bRate', defaultValue: 0.2 }],
  state:     ()    => ({ bState: 42 }),
  schedules: ()    => [],
  handlers:  ()    => [],
  reducers:  ()    => [],
};

const TOOLSET_C = {
  id: 'C',
  dependencies: ['B', 'A'],  // A appears via both C→B→A and C→A
  paramSchema: () => [],
  state:     ()    => ({ cState: true }),
  schedules: ()    => [],
  handlers:  ()    => [],
  reducers:  ()    => [],
};

// ─── Minimal fake services for unit tests ────────────────────────────────────

function makeFakeServices(extraState = {}) {
  const state = { ...extraState };
  return {
    personService:      { getAll: () => [] },
    accountService:     { getAll: () => [] },
    stateRegistry:      {},
    simulationRegistry: { getPrimary: () => ({ state }) },
    eventService:       { register: () => {} },
    handlerService:     { register: () => {} },
    reducerService:     { register: () => {} },
  };
}

// ─── ToolsetRegistry unit tests ───────────────────────────────────────────────

test('ToolsetRegistry: register and get a toolset', () => {
  const reg = new ToolsetRegistry();
  reg.register(TOOLSET_A);
  assert.strictEqual(reg.get('A'), TOOLSET_A);
});

test('ToolsetRegistry: has() returns true for registered, false for unknown', () => {
  const reg = new ToolsetRegistry();
  reg.register(TOOLSET_A);
  assert.ok(reg.has('A'));
  assert.ok(!reg.has('Z'));
});

test('ToolsetRegistry: get() throws for unregistered ID', () => {
  const reg = new ToolsetRegistry();
  assert.throws(() => reg.get('UNKNOWN'), /UNKNOWN/);
});

test('ToolsetRegistry: register overwrites existing entry for same ID', () => {
  const reg = new ToolsetRegistry();
  const v1 = { id: 'A', dependencies: [], paramSchema: () => [], state: () => ({}), schedules: () => [], handlers: () => [], reducers: () => [] };
  const v2 = { id: 'A', dependencies: [], paramSchema: () => [], state: () => ({}), schedules: () => [], handlers: () => [], reducers: () => [] };
  reg.register(v1);
  reg.register(v2);
  assert.strictEqual(reg.get('A'), v2);
});

// ─── ScenarioCompiler dependency resolution unit tests ───────────────────────

test('ScenarioCompiler: resolves single toolset with no dependencies', () => {
  const reg = new ToolsetRegistry();
  reg.register(TOOLSET_A);
  const compiler = new ScenarioCompiler(reg);

  const services = makeFakeServices();
  const definition = { toolsets: ['A'], simStart: '2026-01-01', simEnd: '2041-01-01' };
  compiler.compile(definition, services);

  // state.aState should be 0.1 (from defaults)
  const sim = services.simulationRegistry.getPrimary();
  assert.strictEqual(sim.state.aState, 0.1);
});

test('ScenarioCompiler: resolves dependency chain B → A in correct order', () => {
  const reg = new ToolsetRegistry();
  reg.register(TOOLSET_A);
  reg.register(TOOLSET_B);
  const compiler = new ScenarioCompiler(reg);

  const services = makeFakeServices();
  const definition = { toolsets: ['B'], simStart: '2026-01-01', simEnd: '2041-01-01' };
  compiler.compile(definition, services);

  const sim = services.simulationRegistry.getPrimary();
  // Both A and B state patches should be present
  assert.strictEqual(sim.state.aState, 0.1);
  assert.strictEqual(sim.state.bState, 42);
});

test('ScenarioCompiler: deduplicates shared dependency A via C → B → A and C → A', () => {
  const visitOrder = [];
  const trackingA = {
    ...TOOLSET_A,
    state: (ctx) => { visitOrder.push('A'); return { aState: 1 }; },
  };
  const trackingB = {
    ...TOOLSET_B,
    dependencies: ['A'],
    state: () => { visitOrder.push('B'); return { bState: 2 }; },
  };
  const trackingC = {
    ...TOOLSET_C,
    dependencies: ['B', 'A'],
    state: () => { visitOrder.push('C'); return { cState: 3 }; },
  };

  const reg = new ToolsetRegistry();
  reg.register(trackingA);
  reg.register(trackingB);
  reg.register(trackingC);

  const compiler = new ScenarioCompiler(reg);
  const services = makeFakeServices();
  compiler.compile({ toolsets: ['C'], simStart: '2026-01-01', simEnd: '2041-01-01' }, services);

  // A should appear exactly once, before B, before C
  assert.deepStrictEqual(visitOrder, ['A', 'B', 'C'],
    'dependency order must be: A, B, C (A deduplicated)');
});

test('ScenarioCompiler: throws for unknown toolset ID', () => {
  const reg = new ToolsetRegistry();
  const compiler = new ScenarioCompiler(reg);
  const services = makeFakeServices();
  assert.throws(
    () => compiler.compile({ toolsets: ['NONEXISTENT'], simStart: '2026-01-01', simEnd: '2041-01-01' }, services),
    /NONEXISTENT/
  );
});

test('ScenarioCompiler: parameter defaults merged with definition overrides', () => {
  const reg = new ToolsetRegistry();
  reg.register(TOOLSET_A);
  const compiler = new ScenarioCompiler(reg);

  const services = makeFakeServices();
  const definition = {
    toolsets: ['A'],
    simStart: '2026-01-01',
    simEnd:   '2041-01-01',
    parameters: { aRate: 0.99 },  // overrides default 0.1
  };
  compiler.compile(definition, services);

  const sim = services.simulationRegistry.getPrimary();
  // state.aState = context.parameters.aRate = 0.99 (override wins)
  assert.strictEqual(sim.state.aState, 0.99);
});

test('ScenarioCompiler: compiling empty toolsets array is a no-op', () => {
  const reg = new ToolsetRegistry();
  const compiler = new ScenarioCompiler(reg);
  const services = makeFakeServices();
  assert.doesNotThrow(() =>
    compiler.compile({ toolsets: [], simStart: '2026-01-01', simEnd: '2041-01-01' }, services)
  );
});

// ─── Integration test: US_RETIREMENT via ScenarioCompiler ────────────────────
// (These tests mirror toolset-us-retirement.test.mjs but use the new format)

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
import { US_BANKING }    from '../../src/scenarios/toolsets/us-banking-toolset.js';
import { US_TAX }        from '../../src/scenarios/toolsets/us-tax-toolset.js';
import { US_INCOME }     from '../../src/scenarios/toolsets/us-income-toolset.js';
import { US_BROKERAGE }  from '../../src/scenarios/toolsets/us-brokerage-toolset.js';
import { US_RETIREMENT } from '../../src/scenarios/toolsets/us-retirement-toolset.js';

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
import { MonthlySocialSecurityHandler }     from '../../src/finance/handlers/monthly-social-security-handler.js';
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

// ─── FinSimLib global (required by ScenarioSerializer's _makeX methods) ──────

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
    UsSavingsInterestMonthlyHandler, MonthlyExpensesHandler, MonthlyWagesHandler, MonthlySocialSecurityHandler,
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

// ─── New-format JSON scenario (uses "toolsets": [...]) ───────────────────────

const NEW_FORMAT_JSON = {
  toolsets: ['US_RETIREMENT'],
  simStart: '2026-01-01',
  simEnd:   '2041-01-01',
  parameters: {
    inflationRate:          0.03,
    usSavingsInterestRate:  0.03,
    iraGrowthRate:          0.07,
    k401GrowthRate:         0.07,
    brokerageGrowthRate:    0.05,
    brokerageDividendRate:  0.02,
    dividendReinvest:       false,
    monthlyExpenses:        6_000,
    inflationAdjust:        false,
  },
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
      __type:         'SavingsAccount',
      id:             'acct-savings',
      name:           'US Savings',
      type:           'savings',
      role:           'us-savings',
      stateKey:       'usSavingsAccount',
      initialValue:   30_000,
      ownershipType:  'sole',
      ownerId:        'primary',
      minimumBalance: 3_000,
      country:        'US',
      currency:       { code: 'USD', symbol: '$' },
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

function loadNewFormatScenario(config) {
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

  const toolsetRegistry = new ToolsetRegistry();
  toolsetRegistry.register(US_BANKING);
  toolsetRegistry.register(US_TAX);
  toolsetRegistry.register(US_INCOME);
  toolsetRegistry.register(US_BROKERAGE);
  toolsetRegistry.register(US_RETIREMENT);

  const compiler = new ScenarioCompiler(toolsetRegistry);
  compiler.compile(config, services);

  return { scenario, sim: scenario.sim };
}

const Q1_2026 = new Date(Date.UTC(2026, 2, 31));

test('compiler: US_RETIREMENT scenario loads and runs 3 months without error', () => {
  const { sim } = loadNewFormatScenario(NEW_FORMAT_JSON);
  assert.doesNotThrow(() => sim.stepTo(Q1_2026));
  assert.strictEqual(sim.currentDate.toISOString(), Q1_2026.toISOString());
});

test('compiler: US savings account exists and has a balance', () => {
  const { sim } = loadNewFormatScenario(NEW_FORMAT_JSON);
  sim.stepTo(Q1_2026);
  assert.ok(sim.state.usSavingsAccount != null);
  assert.ok(typeof sim.state.usSavingsAccount.balance === 'number');
});

test('compiler: monthly expenses reduce savings over 3 months (wages mostly offset)', () => {
  const { sim } = loadNewFormatScenario(NEW_FORMAT_JSON);
  const before = sim.state.usSavingsAccount?.balance ?? 0;
  assert.ok(before > 0);
  sim.stepTo(Q1_2026);
  const after = sim.state.usSavingsAccount?.balance ?? 0;
  assert.ok(after > 0, 'savings must stay positive after 3 months');
  assert.ok(after < before + 10_000, 'balance must not exceed wages × 3 months unreasonably');
});

test('compiler: IRA account initialized in state', () => {
  const { sim } = loadNewFormatScenario(NEW_FORMAT_JSON);
  sim.stepTo(Q1_2026);
  assert.ok(sim.state.iraAccount != null);
  assert.strictEqual(sim.state.iraAccount.balance, 200_000);
});

test('compiler: 401k account initialized in state', () => {
  const { sim } = loadNewFormatScenario(NEW_FORMAT_JSON);
  sim.stepTo(Q1_2026);
  assert.ok(sim.state.k401Account != null);
  assert.strictEqual(sim.state.k401Account.balance, 300_000);
});

test('compiler: usFilingSingle auto-detected as true for 1 person', () => {
  const { sim } = loadNewFormatScenario(NEW_FORMAT_JSON);
  assert.strictEqual(sim.state.usFilingSingle, true);
});

test('compiler: usFilingSingle can be overridden via parameters', () => {
  const config = { ...NEW_FORMAT_JSON, parameters: { ...NEW_FORMAT_JSON.parameters, usFilingSingle: false } };
  const { sim } = loadNewFormatScenario(config);
  assert.strictEqual(sim.state.usFilingSingle, false);
});

test('compiler: SS income credited after 1 month (person past retirement)', () => {
  const { sim } = loadNewFormatScenario(NEW_FORMAT_JSON);
  const before = sim.state.usSavingsAccount.balance;
  sim.stepTo(new Date(Date.UTC(2026, 0, 31)));
  // After 1 month: wages ($8k) + SS ($2.8k) − expenses ($6k) > 0
  const after = sim.state.usSavingsAccount.balance;
  assert.ok(after > before, 'balance should grow when wages + SS exceed expenses');
});

test('compiler: paramSchema returned contains all toolset schemas merged', () => {
  ServiceRegistry.reset();
  const services = ServiceRegistry.getInstance();
  const scenario = new BaseScenario({
    context:  services.simulationContext,
    simStart: new Date(NEW_FORMAT_JSON.simStart),
    simEnd:   new Date(NEW_FORMAT_JSON.simEnd),
  });
  scenario.buildSim();

  const toolsetRegistry = new ToolsetRegistry();
  toolsetRegistry.register(US_BANKING);
  toolsetRegistry.register(US_TAX);
  toolsetRegistry.register(US_INCOME);
  toolsetRegistry.register(US_BROKERAGE);
  toolsetRegistry.register(US_RETIREMENT);

  const compiler = new ScenarioCompiler(toolsetRegistry);
  const { paramSchema } = compiler.compile(NEW_FORMAT_JSON, services);

  assert.ok(Array.isArray(paramSchema), 'paramSchema must be an array');
  const keys = paramSchema.map(e => e.key);
  assert.ok(keys.includes('usSavingsInterestRate'), 'US_BANKING param must be in schema');
  assert.ok(keys.includes('iraGrowthRate'), 'US_RETIREMENT param must be in schema');
  assert.ok(keys.includes('monthlyExpenses'), 'monthlyExpenses must be in schema');
});
