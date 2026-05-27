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
 * toolset-cross-border.test.mjs
 *
 * Integration tests for US_AU_CROSS_BORDER toolset (and its full dependency
 * graph: US_BANKING, US_TAX, AU_BANKING, AU_TAX, AU_RETIREMENT, US_RETIREMENT).
 *
 * Run with: node --test tests/unit/toolset-cross-border.test.mjs
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

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
import { US_BANKING }         from '../../src/scenarios/toolsets/us-banking-toolset.js';
import { US_TAX }             from '../../src/scenarios/toolsets/us-tax-toolset.js';
import { US_INCOME }          from '../../src/scenarios/toolsets/us-income-toolset.js';
import { US_BROKERAGE }       from '../../src/scenarios/toolsets/us-brokerage-toolset.js';
import { US_RETIREMENT }      from '../../src/scenarios/toolsets/us-retirement-toolset.js';
import { AU_BANKING }         from '../../src/scenarios/toolsets/au-banking-toolset.js';
import { AU_TAX }             from '../../src/scenarios/toolsets/au-tax-toolset.js';
import { AU_INCOME }          from '../../src/scenarios/toolsets/au-income-toolset.js';
import { AU_RETIREMENT }      from '../../src/scenarios/toolsets/au-retirement-toolset.js';
import { US_AU_CROSS_BORDER } from '../../src/scenarios/toolsets/us-au-cross-border-toolset.js';

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

// ─── Cross-border JSON scenario ──────────────────────────────────────────────

const CROSS_BORDER_JSON = {
  toolsets: ['US_RETIREMENT', 'AU_RETIREMENT', 'US_AU_CROSS_BORDER'],
  simStart: '2026-01-01',
  simEnd:   '2046-01-01',
  parameters: {
    inflationRate:         0.03,
    auInflationRate:       0.03,
    usSavingsInterestRate: 0.03,
    iraGrowthRate:         0.07,
    k401GrowthRate:        0.07,
    superGrowthRate:       0.07,
    monthlyExpenses:       6_000,
    inflationAdjust:       false,
    moveYear:              2026,   // move Jul 1 2026 (within test window)
  },
  persons: [
    {
      __type:         'Person',
      id:             'primary',
      name:           'Primary',
      birthDate:      '1978-04-15',
      citizen:        ['US'],
      lifeExpectancy: 90,
      monthlyWage:    8_000,
      retirementDate: '2040-01-01',
      socialSecurityMonthly: 0,
    },
  ],
  accounts: [
    {
      __type:         'SavingsAccount',
      id:             'us-savings',
      name:           'US Savings',
      type:           'savings',
      role:           'us-savings',
      stateKey:       'usSavingsAccount',
      initialValue:   50_000,
      ownershipType:  'sole',
      ownerId:        'primary',
      minimumBalance: 3_000,
      country:        'US',
      currency:       { code: 'USD', symbol: '$' },
    },
    {
      __type:         'Account',
      id:             'au-savings',
      name:           'AU Savings',
      type:           'savings',
      role:           'au-savings',
      stateKey:       'auSavingsAccount',
      initialValue:   20_000,
      ownershipType:  'sole',
      ownerId:        'primary',
      minimumBalance: 0,
      country:        'AU',
      currency:       { code: 'AUD', symbol: 'A$' },
    },
    {
      __type:            'TraditionalIRAAccount',
      id:                'ira',
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
      __type:            'SuperannuationAccount',
      id:                'super-acct',
      name:              'Superannuation',
      type:              'super',
      role:              'super',
      stateKey:          'superAccount',
      initialValue:      100_000,
      ownershipType:     'sole',
      ownerId:           'primary',
      contributionBasis: 80_000,
      earningsBasis:     0,
      loanBalance:       0,
      country:           'AU',
      currency:          { code: 'AUD', symbol: 'A$' },
      drawdownPriority:  2,
    },
  ],
};

// ─── Helper to load cross-border scenario ────────────────────────────────────

function loadCrossBorderScenario(config) {
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
  toolsetRegistry.register(AU_BANKING);
  toolsetRegistry.register(AU_TAX);
  toolsetRegistry.register(AU_INCOME);
  toolsetRegistry.register(AU_RETIREMENT);
  toolsetRegistry.register(US_AU_CROSS_BORDER);

  const compiler = new ScenarioCompiler(toolsetRegistry);
  compiler.compile(config, services);

  return { scenario, sim: scenario.sim };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('cross-border: scenario loads without error', () => {
  assert.doesNotThrow(() => loadCrossBorderScenario(CROSS_BORDER_JSON));
});

test('cross-border: isAuResident starts as false (US_AU_CROSS_BORDER overrides AU_RETIREMENT)', () => {
  const { sim } = loadCrossBorderScenario(CROSS_BORDER_JSON);
  assert.strictEqual(sim.state.isAuResident, false);
});

test('cross-border: inflationRates has both US and AU keys', () => {
  const { sim } = loadCrossBorderScenario(CROSS_BORDER_JSON);
  assert.ok(sim.state.inflationRates != null, 'inflationRates must exist');
  assert.ok('US' in sim.state.inflationRates, 'US inflation rate must be present');
  assert.ok('AU' in sim.state.inflationRates, 'AU inflation rate must be present');
});

test('cross-border: inflationAccumulator has both US and AU keys', () => {
  const { sim } = loadCrossBorderScenario(CROSS_BORDER_JSON);
  assert.ok(sim.state.inflationAccumulator != null, 'inflationAccumulator must exist');
  assert.ok('US' in sim.state.inflationAccumulator);
  assert.ok('AU' in sim.state.inflationAccumulator);
});

test('cross-border: CHANGE_RESIDENCY event registered when moveYear is set', () => {
  ServiceRegistry.reset();
  const services = ServiceRegistry.getInstance();

  const scenario = new BaseScenario({
    context:  services.simulationContext,
    simStart: new Date(CROSS_BORDER_JSON.simStart),
    simEnd:   new Date(CROSS_BORDER_JSON.simEnd),
  });
  scenario.buildSim();

  ScenarioSerializer.deserializePersonsAccounts(CROSS_BORDER_JSON, services);

  const toolsetRegistry = new ToolsetRegistry();
  toolsetRegistry.register(US_BANKING);
  toolsetRegistry.register(US_TAX);
  toolsetRegistry.register(US_INCOME);
  toolsetRegistry.register(US_BROKERAGE);
  toolsetRegistry.register(US_RETIREMENT);
  toolsetRegistry.register(AU_BANKING);
  toolsetRegistry.register(AU_TAX);
  toolsetRegistry.register(AU_INCOME);
  toolsetRegistry.register(AU_RETIREMENT);
  toolsetRegistry.register(US_AU_CROSS_BORDER);

  const compiler = new ScenarioCompiler(toolsetRegistry);
  compiler.compile(CROSS_BORDER_JSON, services);

  const events = services.eventService.getAll();
  const changeEvent = events.find(e => e.type === 'CHANGE_RESIDENCY');
  assert.ok(changeEvent != null, 'CHANGE_RESIDENCY event must be registered when moveYear is set');
});

test('cross-border: CHANGE_RESIDENCY event not registered when moveYear is unset', () => {
  const configNoMove = {
    ...CROSS_BORDER_JSON,
    parameters: { ...CROSS_BORDER_JSON.parameters, moveYear: undefined },
  };

  ServiceRegistry.reset();
  const services = ServiceRegistry.getInstance();

  const scenario = new BaseScenario({
    context:  services.simulationContext,
    simStart: new Date(configNoMove.simStart),
    simEnd:   new Date(configNoMove.simEnd),
  });
  scenario.buildSim();

  ScenarioSerializer.deserializePersonsAccounts(configNoMove, services);

  const toolsetRegistry = new ToolsetRegistry();
  toolsetRegistry.register(US_BANKING);
  toolsetRegistry.register(US_TAX);
  toolsetRegistry.register(US_INCOME);
  toolsetRegistry.register(US_BROKERAGE);
  toolsetRegistry.register(US_RETIREMENT);
  toolsetRegistry.register(AU_BANKING);
  toolsetRegistry.register(AU_TAX);
  toolsetRegistry.register(AU_INCOME);
  toolsetRegistry.register(AU_RETIREMENT);
  toolsetRegistry.register(US_AU_CROSS_BORDER);

  const compiler = new ScenarioCompiler(toolsetRegistry);
  compiler.compile(configNoMove, services);

  const events = services.eventService.getAll();
  const changeEvent = events.find(e => e.type === 'CHANGE_RESIDENCY');
  assert.ok(changeEvent == null, 'CHANGE_RESIDENCY event must NOT be registered when moveYear is unset');
});

test('cross-border: runs 3 months without error', () => {
  const { sim } = loadCrossBorderScenario(CROSS_BORDER_JSON);
  const Q1_2026 = new Date(Date.UTC(2026, 2, 31));
  assert.doesNotThrow(() => sim.stepTo(Q1_2026));
});

test('cross-border: isAuResident becomes true after moveYear Jul 1', () => {
  const { sim } = loadCrossBorderScenario(CROSS_BORDER_JSON);
  // Before move: should be false
  assert.strictEqual(sim.state.isAuResident, false);
  // Step past Jul 1 2026 — CHANGE_RESIDENCY event fires
  const afterMove = new Date(Date.UTC(2026, 7, 1));  // Aug 1 2026
  sim.stepTo(afterMove);
  assert.strictEqual(sim.state.isAuResident, true, 'isAuResident must be true after moveYear Jul 1');
});

test('cross-border: usSavingsAccount and auSavingsAccount both in state', () => {
  const { sim } = loadCrossBorderScenario(CROSS_BORDER_JSON);
  assert.ok(sim.state.usSavingsAccount != null, 'usSavingsAccount must exist');
  assert.ok(sim.state.auSavingsAccount != null, 'auSavingsAccount must exist');
  assert.strictEqual(sim.state.usSavingsAccount.balance, 50_000);
  assert.strictEqual(sim.state.auSavingsAccount.balance, 20_000);
});

test('cross-border: AU and US YTD counters both initialized', () => {
  const { sim } = loadCrossBorderScenario(CROSS_BORDER_JSON);
  // US
  assert.strictEqual(sim.state.usOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.usCapitalGainsYTD, 0);
  // AU
  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0);
  assert.strictEqual(sim.state.auCapitalGainsYTD, 0);
});
