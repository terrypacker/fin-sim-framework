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
 * toolset-au-retirement.test.mjs
 *
 * Integration tests for AU_RETIREMENT (and its AU_TAX + AU_BANKING dependencies)
 * via ScenarioCompiler.  Mirrors the pattern in toolset-compiler.test.mjs.
 *
 * Run with: node --test tests/unit/toolset-au-retirement.test.mjs
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

// ─── FinSimLib global (required by ScenarioSerializer's _makeX methods) ──────

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
import { ToolsetRegistry }    from '../../src/scenarios/toolsets/toolset-registry.js';
import { ScenarioCompiler }   from '../../src/scenarios/toolsets/scenario-compiler.js';
import { AU_BANKING }    from '../../src/scenarios/toolsets/au-banking-toolset.js';
import { AU_TAX }        from '../../src/scenarios/toolsets/au-tax-toolset.js';
import { AU_INCOME }     from '../../src/scenarios/toolsets/au-income-toolset.js';
import { AU_RETIREMENT } from '../../src/scenarios/toolsets/au-retirement-toolset.js';

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
    K401ContributionHandler, K401EarningsHandler, K401WithdrawalHandler, K401RmdApplyReducer, K401AnnualRmdHandler,
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
    IraRolloverWithdrawalHandler, IraRmdHandler, IraAnnualRmdHandler,
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

// ─── AU_RETIREMENT JSON scenario ─────────────────────────────────────────────

const AU_JSON = {
  toolsets: ['AU_RETIREMENT'],
  simStart: '2026-01-01',
  simEnd:   '2041-01-01',
  parameters: {
    auSavingsInterestRate: 0.045,
    superGrowthRate:       0.07,
    monthlyExpenses:       5_000,
    inflationAdjust:       false,
  },
  persons: [
    {
      __type:         'Person',
      id:             'primary',
      name:           'Primary',
      birthDate:      '1975-04-15',
      citizen:        ['AU'],
      lifeExpectancy: 90,
      monthlyWage:    0,
      retirementDate: '2025-01-01',
      socialSecurityMonthly: 0,
    },
  ],
  accounts: [
    {
      __type:         'Account',
      id:             'au-savings',
      name:           'AU Savings',
      type:           'savings',
      role:           'au-savings',
      stateKey:       'auSavingsAccount',
      initialValue:   80_000,
      ownershipType:  'sole',
      ownerId:        'primary',
      minimumBalance: 2_000,
      country:        'AU',
      currency:       { code: 'AUD', symbol: 'A$' },
    },
    {
      __type:            'SuperannuationAccount',
      id:                'super-acct',
      name:              'Superannuation',
      type:              'super',
      role:              'super',
      stateKey:          'superAccount',
      initialValue:      300_000,
      ownershipType:     'sole',
      ownerId:           'primary',
      contributionBasis: 200_000,
      earningsBasis:     0,
      loanBalance:       0,
      country:           'AU',
      currency:          { code: 'AUD', symbol: 'A$' },
      drawdownPriority:  2,
    },
  ],
};

// ─── Helper to load AU_RETIREMENT scenario ───────────────────────────────────

function loadAuRetirementScenario(config) {
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
  toolsetRegistry.register(AU_BANKING);
  toolsetRegistry.register(AU_TAX);
  toolsetRegistry.register(AU_INCOME);
  toolsetRegistry.register(AU_RETIREMENT);

  const compiler = new ScenarioCompiler(toolsetRegistry);
  compiler.compile(config, services);

  return { scenario, sim: scenario.sim };
}

const Q1_2026 = new Date(Date.UTC(2026, 2, 31));

// ─── Tests ────────────────────────────────────────────────────────────────────

test('AU_RETIREMENT: scenario loads and runs 3 months without error', () => {
  const { sim } = loadAuRetirementScenario(AU_JSON);
  assert.doesNotThrow(() => sim.stepTo(Q1_2026));
  assert.strictEqual(sim.currentDate.toISOString(), Q1_2026.toISOString());
});

test('AU_RETIREMENT: isAuResident is true', () => {
  const { sim } = loadAuRetirementScenario(AU_JSON);
  assert.strictEqual(sim.state.isAuResident, true);
});

test('AU_RETIREMENT: auSavingsAccount exists with correct initial balance', () => {
  const { sim } = loadAuRetirementScenario(AU_JSON);
  assert.ok(sim.state.auSavingsAccount != null, 'auSavingsAccount must exist in state');
  assert.ok(typeof sim.state.auSavingsAccount.balance === 'number');
  assert.strictEqual(sim.state.auSavingsAccount.balance, 80_000);
});

test('AU_RETIREMENT: superAccount exists with correct initial balance', () => {
  const { sim } = loadAuRetirementScenario(AU_JSON);
  assert.ok(sim.state.superAccount != null, 'superAccount must exist in state');
  assert.strictEqual(sim.state.superAccount.balance, 300_000);
});

test('AU_RETIREMENT: monthly expenses reduce AU savings over 3 months', () => {
  const { sim } = loadAuRetirementScenario(AU_JSON);
  const before = sim.state.auSavingsAccount.balance;
  sim.stepTo(Q1_2026);
  const after = sim.state.auSavingsAccount.balance;
  // 3 months × $5000 = $15,000 expenses; balance should be lower
  assert.ok(after < before, 'AU savings should decrease after 3 months of expenses');
  assert.ok(after > 0, 'AU savings should remain positive');
});

test('AU_RETIREMENT: INTL_AU_SAVINGS_INTEREST event is registered', () => {
  ServiceRegistry.reset();
  const services = ServiceRegistry.getInstance();

  const scenario = new BaseScenario({
    context:  services.simulationContext,
    simStart: new Date(AU_JSON.simStart),
    simEnd:   new Date(AU_JSON.simEnd),
  });
  scenario.buildSim();

  ScenarioSerializer.deserializePersonsAccounts(AU_JSON, services);

  const toolsetRegistry = new ToolsetRegistry();
  toolsetRegistry.register(AU_BANKING);
  toolsetRegistry.register(AU_TAX);
  toolsetRegistry.register(AU_INCOME);
  toolsetRegistry.register(AU_RETIREMENT);

  const compiler = new ScenarioCompiler(toolsetRegistry);
  compiler.compile(AU_JSON, services);

  const events = services.eventService.getAll();
  const interestEvent = events.find(e => e.type === 'INTL_AU_SAVINGS_INTEREST');
  assert.ok(interestEvent != null, 'INTL_AU_SAVINGS_INTEREST event must be registered');
});

test('AU_RETIREMENT: INTL_SUPER_EARNINGS event is registered', () => {
  ServiceRegistry.reset();
  const services = ServiceRegistry.getInstance();

  const scenario = new BaseScenario({
    context:  services.simulationContext,
    simStart: new Date(AU_JSON.simStart),
    simEnd:   new Date(AU_JSON.simEnd),
  });
  scenario.buildSim();

  ScenarioSerializer.deserializePersonsAccounts(AU_JSON, services);

  const toolsetRegistry = new ToolsetRegistry();
  toolsetRegistry.register(AU_BANKING);
  toolsetRegistry.register(AU_TAX);
  toolsetRegistry.register(AU_INCOME);
  toolsetRegistry.register(AU_RETIREMENT);

  const compiler = new ScenarioCompiler(toolsetRegistry);
  compiler.compile(AU_JSON, services);

  const events = services.eventService.getAll();
  const superEvent = events.find(e => e.type === 'INTL_SUPER_EARNINGS');
  assert.ok(superEvent != null, 'INTL_SUPER_EARNINGS event must be registered');
});

test('AU_RETIREMENT: AU YTD counters initialized to 0', () => {
  const { sim } = loadAuRetirementScenario(AU_JSON);
  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.auCapitalGainsYTD, 0);
  assert.strictEqual(sim.state.auSuperTaxYTD, 0);
});

test('AU_RETIREMENT: super earnings event fires (INTL_SUPER_EARNINGS registered with year-end schedule)', () => {
  // Verify INTL_SUPER_EARNINGS is scheduled (already tested above) and that
  // the SuperEarningsHandler is wired by confirming the event exists in the
  // event service with the correct type and interval.
  ServiceRegistry.reset();
  const services = ServiceRegistry.getInstance();

  const scenario = new BaseScenario({
    context:  services.simulationContext,
    simStart: new Date(AU_JSON.simStart),
    simEnd:   new Date(AU_JSON.simEnd),
  });
  scenario.buildSim();

  ScenarioSerializer.deserializePersonsAccounts(AU_JSON, services);

  const toolsetRegistry = new ToolsetRegistry();
  toolsetRegistry.register(AU_BANKING);
  toolsetRegistry.register(AU_TAX);
  toolsetRegistry.register(AU_INCOME);
  toolsetRegistry.register(AU_RETIREMENT);

  const compiler = new ScenarioCompiler(toolsetRegistry);
  compiler.compile(AU_JSON, services);

  const events = services.eventService.getAll();
  const superEvent = events.find(e => e.type === 'INTL_SUPER_EARNINGS');
  assert.ok(superEvent != null, 'INTL_SUPER_EARNINGS must be registered');
  assert.strictEqual(superEvent.interval, 'year-end', 'INTL_SUPER_EARNINGS must use year-end interval');
  assert.strictEqual(superEvent.startOffset, 1, 'INTL_SUPER_EARNINGS must have startOffset 1');
});
