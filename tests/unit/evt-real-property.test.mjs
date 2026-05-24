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
 * evt-real-property.test.mjs
 * Tests for Real Property events: EVT-33 and EVT-34
 *
 * EVT-33  Australian House Sale  into checking  US: capital gain, AU: always NR withholding rate, FTC
 * EVT-34  US House Sale          into checking  US: capital gain after $500K exemption,
 *                                                AU: TODO (??) if resident, FTC
 *
 * Run with: node --test tests/evt-real-property.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert   from 'node:assert/strict';

import { FinancialState } from '../../src/finance/state/financial-state.js';
import { Simulation } from '../../src/simulation-framework/simulation.js';
import { TaxService } from '../../src/finance/tax-service.js';
import { ServiceRegistry } from '../../src/services/service-registry.js';
import { PeriodService } from '../../src/finance/period/period-service.js';
import { buildUsCalendarYear, buildAuFiscalYear, applyTo } from '../../src/finance/period/period-builder.js';
import {ScenarioLoader} from "../../src/scenarios/scenario-loader.js";
import {BaseScenario} from "../../src/index.js";

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

const US_HOUSE_JSON = {
  toolsets: ['US_RETIREMENT', 'US_REAL_PROPERTY'],
  simStart: '2026-01-01',
  simEnd:   '2041-01-01',
  parameters: {

  },
  persons: [
    {
      __type:         'Person',
      id:             'primary',
      name:           'Primary',
      birthDate:      '1975-04-15',
      citizen:        ['US'],
      lifeExpectancy: 90,
      monthlyWage:    0,
      retirementDate: '2025-01-01',
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
      initialValue:   5000,
      ownershipType:  'sole',
      ownerId:        'primary',
      minimumBalance: 2_000,
      country:        'US',
      currency:       { code: 'USD', symbol: '$' },
    }
  ],
  realProperties: [
    {
      __type: "RealProperty",
      id: "re1",
      name: "US House",
      appreciationRate: 0.04,
      costBasis: 800000,
      country: "US",
      drawdownPriority: null,
      isPrimaryResidence: true,
      monthlyMortgage: 0,
      mortgageBalance: 0,
      ownerId: "primary",
      owners: [],
      ownershipType: "joint",
      plannedSaleYear: 2027,
      saleDestinationAccount: "usSavingsAccount",
      stateKey: "usHouseProperty",
      value: 1000000
    }
  ]
};

const AU_HOUSE_JSON = {
  toolsets: ['AU_RETIREMENT', 'AU_REAL_PROPERTY', 'US_TAX'],
  simStart: '2026-01-01',
  simEnd:   '2041-01-01',
  parameters: {

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
      __type:         'SavingsAccount',
      id:             'au-savings',
      name:           'AU Savings',
      type:           'savings',
      role:           'au-savings',
      stateKey:       'auSavingsAccount',
      initialValue:   5000,
      ownershipType:  'sole',
      ownerId:        'primary',
      minimumBalance: 2_000,
      country:        'AU',
      currency:       { code: 'AUD', symbol: 'A$' },
    }
  ],
  realProperties: [
    {
      __type: "RealProperty",
      id: "re1",
      name: "AU House",
      appreciationRate: 0.04,
      costBasis: 800000,
      country: "AU",
      drawdownPriority: null,
      isPrimaryResidence: true,
      monthlyMortgage: 0,
      mortgageBalance: 0,
      ownerId: "primary",
      owners: [],
      ownershipType: "joint",
      plannedSaleYear: 2027,
      saleDestinationAccount: "auSavingsAccount",
      stateKey: "auHouseProperty",
      value: 1200000
    }
  ]
};

const CROSS_BORDER_HOUSE_JSON = {
  toolsets: ['AU_RETIREMENT', 'AU_REAL_PROPERTY', 'US_TAX', 'US_AU_CROSS_BORDER'],
  simStart: '2026-01-01',
  simEnd:   '2041-01-01',
  parameters: {

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
      __type:         'SavingsAccount',
      id:             'us-savings',
      name:           'US Savings',
      type:           'savings',
      role:           'us-savings',
      stateKey:       'usSavingsAccount',
      initialValue:   5000,
      ownershipType:  'sole',
      ownerId:        'primary',
      minimumBalance: 2_000,
      country:        'US',
      currency:       { code: 'USD', symbol: '$' },
    },
    {
      __type:         'SavingsAccount',
      id:             'au-savings',
      name:           'AU Savings',
      type:           'savings',
      role:           'au-savings',
      stateKey:       'auSavingsAccount',
      initialValue:   5000,
      ownershipType:  'sole',
      ownerId:        'primary',
      minimumBalance: 2_000,
      country:        'AU',
      currency:       { code: 'AUD', symbol: 'A$' },
    }
  ],
  realProperties: [
    {
      __type: "RealProperty",
      id: "re1",
      name: "AU House",
      appreciationRate: 0.04,
      costBasis: 800000,
      country: "AU",
      drawdownPriority: null,
      isPrimaryResidence: true,
      monthlyMortgage: 0,
      mortgageBalance: 0,
      ownerId: "primary",
      owners: [],
      ownershipType: "joint",
      plannedSaleYear: 2027,
      saleDestinationAccount: "auSavingsAccount",
      stateKey: "auHouseProperty",
      value: 1200000
    }
  ]
};

/**
 * Load and run a toolset scenario from a declarative JSON config.
 * Returns { scenario, sim } after running ScenarioLoader.load() (persons/accounts
 * are deserialized and US_RETIREMENT is compiled).
 */
function loadToolsetScenario(config) {
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

// End of first quarter 2028 — 3 month-end events (Jan 31, Feb 28, Mar 31).
const Q1_2028 = new Date(Date.UTC(2028, 2, 31));

// Jan 1 2026: US calendar year 2026, AU fiscal year starting Jul 1 2025 (FY2025-26).
function buildMixedPeriodService() {
  const ps = new PeriodService();
  applyTo(ps, buildUsCalendarYear(2026));
  applyTo(ps, buildAuFiscalYear(2025));
  return ps;
}

const START_DATE = new Date(2026, 0, 1);

function buildRealPropertySim({
  initialChecking  = 5000,
  isAuResident     = false,
} = {}) {
  const registry = ServiceRegistry.getInstance();
  const sim = new Simulation(START_DATE, { initialState: new FinancialState({
    checkingAccount: new Account(initialChecking),
    isAuResident,
    usCapitalGainsYTD:           0,
    auCapitalGainsYTD:           0,
    auNonResidentWithholdingYTD: 0,
    ftcYTD:                      0,
  }) });
  registry.simulationRegistry.register('primary', sim);
  registry.simulationSync.setSimStart(START_DATE);
  // EVT-33 (AU house) + EVT-34 (US house) — needs both country modules
  const taxService = new TaxService();
  taxService.setup(sim, ['AU', 'US'], buildMixedPeriodService());
  taxService.registerHandlersAndReducers(registry, ['AU', 'US']);

  return { sim };
}

beforeEach(() => ServiceRegistry.reset());

// ══════════════════════════════════════════════════════════════════════════════
// EVT-33: Australian House Sale
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-33: AU house sale credits full sale proceeds to savings', () => {
  const { sim } = loadToolsetScenario(AU_HOUSE_JSON);
  //Step past planned sale year: 2027
  assert.doesNotThrow(() => sim.stepTo(Q1_2028), 'stepTo should not throw');

  const journalEntry = sim.journal.getActions('AU_HOUSE_SALE_APPLY');
  assert.ok(journalEntry);
  assert.ok(journalEntry.length > 0);
  assert.strictEqual(journalEntry[0].stateDiff[0].delta, AU_HOUSE_JSON.realProperties[0].value); //House value
});

test('EVT-33: AU house sale records US capital gain (sale price - cost basis)', () => {
  const { sim } = loadToolsetScenario(AU_HOUSE_JSON);
  //Step past planned sale year: 2027
  assert.doesNotThrow(() => sim.stepTo(Q1_2028), 'stepTo should not throw');

  const journalEntry = sim.journal.getActions('AU_HOUSE_SALE_APPLY');
  assert.ok(journalEntry);
  assert.ok(journalEntry.length > 0);
  assert.strictEqual(journalEntry[0].stateDiff[0].delta, AU_HOUSE_JSON.realProperties[0].value); //House value

  const auTaxJournalEntry = sim.journal.getActions('AU_HOUSE_SALE_TAX');
  assert.ok(auTaxJournalEntry);
  assert.ok(auTaxJournalEntry.length > 0);
  //state.usCaptialGainsYTD
  assert.strictEqual(auTaxJournalEntry[0].stateDiff[2].field, 'usCapitalGainsYTD');
  assert.strictEqual(auTaxJournalEntry[0].stateDiff[2].delta, AU_HOUSE_JSON.realProperties[0].value - AU_HOUSE_JSON.realProperties[0].costBasis);
});

test('EVT-33: AU house sale is always AU taxable at non-resident withholding rate', () => {
  const { sim } = loadToolsetScenario(CROSS_BORDER_HOUSE_JSON);
  //Step past planned sale year: 2027
  assert.doesNotThrow(() => sim.stepTo(Q1_2028), 'stepTo should not throw');

  const journalEntry = sim.journal.getActions('AU_HOUSE_SALE_APPLY');
  assert.ok(journalEntry);
  assert.ok(journalEntry.length > 0);
  assert.strictEqual(journalEntry[0].stateDiff[0].delta, AU_HOUSE_JSON.realProperties[0].value); //House value

  const auTaxJournalEntry = sim.journal.getActions('AU_HOUSE_SALE_TAX');
  assert.ok(auTaxJournalEntry);
  assert.ok(auTaxJournalEntry.length > 0);
  //state.auPersonNonResidentWithholdingYTD.primary
  assert.strictEqual(auTaxJournalEntry[0].stateDiff[1].field, 'auPersonNonResidentWithholdingYTD.primary');
  assert.strictEqual(auTaxJournalEntry[0].stateDiff[1].delta, AU_HOUSE_JSON.realProperties[0].value - AU_HOUSE_JSON.realProperties[0].costBasis);
});

test('EVT-33: AU house sale generates a Foreign Tax Credit', () => {

  const { sim } = loadToolsetScenario(CROSS_BORDER_HOUSE_JSON);
  //Step past planned sale year: 2027
  assert.doesNotThrow(() => sim.stepTo(Q1_2028), 'stepTo should not throw');

  const journalEntry = sim.journal.getActions('AU_HOUSE_SALE_APPLY');
  assert.ok(journalEntry);
  assert.ok(journalEntry.length > 0);
  assert.strictEqual(journalEntry[0].stateDiff[0].delta, AU_HOUSE_JSON.realProperties[0].value); //House value

  const auTaxJournalEntry = sim.journal.getActions('AU_HOUSE_SALE_TAX');
  assert.ok(auTaxJournalEntry);
  assert.ok(auTaxJournalEntry.length > 0);
  //state.ftcYTD
  assert.strictEqual(auTaxJournalEntry[0].stateDiff[0].field, 'ftcYTD');
  assert.strictEqual(auTaxJournalEntry[0].stateDiff[0].delta, AU_HOUSE_JSON.realProperties[0].value - AU_HOUSE_JSON.realProperties[0].costBasis);
});

test('EVT-33: AU house sale with no gain has zero capital gains tax exposure', () => {
  const config = structuredClone(CROSS_BORDER_HOUSE_JSON);
  config.realProperties[0].costBasis = config.realProperties[0].value;

  const { sim } = loadToolsetScenario(config);
  //Step past planned sale year: 2027
  assert.doesNotThrow(() => sim.stepTo(Q1_2028), 'stepTo should not throw');

  const journalEntry = sim.journal.getActions('AU_HOUSE_SALE_APPLY');
  assert.ok(journalEntry);
  assert.ok(journalEntry.length > 0);
  assert.strictEqual(journalEntry[0].stateDiff[0].delta, AU_HOUSE_JSON.realProperties[0].value); //House value

  const auTaxJournalEntry = sim.journal.getActions('AU_HOUSE_SALE_TAX');
  assert.ok(auTaxJournalEntry);
  assert.ok(auTaxJournalEntry.length > 0);

  //Expect no tax changes applied
  assert.strictEqual(auTaxJournalEntry[0].stateDiff.length,0);

});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-34: US House Sale
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-34: US house sale credits full sale proceeds to savings', () => {
  const { sim } = loadToolsetScenario(US_HOUSE_JSON);
  //Step past planned sale year: 2027
  assert.doesNotThrow(() => sim.stepTo(Q1_2028), 'stepTo should not throw');

  const journalEntry = sim.journal.getActions('US_HOUSE_SALE_APPLY');
  assert.ok(journalEntry);
  assert.ok(journalEntry.length > 0);
  assert.strictEqual(journalEntry[0].stateDiff[0].delta, US_HOUSE_JSON.realProperties[0].value); //House value
});

test('EVT-34: US house sale applies $500K primary residence exemption to capital gain', () => {
  const config = structuredClone(US_HOUSE_JSON);
  config.realProperties[0].costBasis = config.realProperties[0].value - 600_000;
  const { sim } = loadToolsetScenario(config);
  //Step past planned sale year: 2027
  assert.doesNotThrow(() => sim.stepTo(Q1_2028), 'stepTo should not throw');

  const journalEntry = sim.journal.getActions('US_HOUSE_SALE_APPLY');
  assert.ok(journalEntry);
  assert.ok(journalEntry.length > 0);
  assert.strictEqual(journalEntry[0].stateDiff[0].delta, config.realProperties[0].value); //House value

  const usTaxJournalEntry = sim.journal.getActions('US_HOUSE_SALE_TAX');
  assert.ok(usTaxJournalEntry);
  assert.ok(usTaxJournalEntry.length > 0);
  //state.usCaptialGainsYTD
  assert.strictEqual(usTaxJournalEntry[0].stateDiff[0].field, 'usCapitalGainsYTD');
  assert.strictEqual(usTaxJournalEntry[0].stateDiff[0].delta, (config.realProperties[0].value - config.realProperties[0].costBasis) - 500_000);
});

test('EVT-34: US house sale with gain under $500K has zero taxable capital gain', () => {
  const config = structuredClone(US_HOUSE_JSON);
  config.realProperties[0].costBasis = 500_000;
  config.realProperties[0].value = 600_000;
  const { sim } = loadToolsetScenario(config);
  //Step past planned sale year: 2027
  assert.doesNotThrow(() => sim.stepTo(Q1_2028), 'stepTo should not throw');

  const journalEntry = sim.journal.getActions('US_HOUSE_SALE_APPLY');
  assert.ok(journalEntry);
  assert.ok(journalEntry.length > 0);
  assert.strictEqual(journalEntry[0].stateDiff[0].delta, config.realProperties[0].value); //House value

  const usTaxJournalEntry = sim.journal.getActions('US_HOUSE_SALE_TAX');
  assert.ok(usTaxJournalEntry);
  assert.ok(usTaxJournalEntry.length > 0);
  //Expect no tax changes applied
  assert.strictEqual(usTaxJournalEntry[0].stateDiff.length,0);
});

test('EVT-34: US house sale with no gain has zero capital gains exposure', () => {
  const config = structuredClone(US_HOUSE_JSON);
  config.realProperties[0].costBasis = 500_000;
  config.realProperties[0].value = 500_000;
  const { sim } = loadToolsetScenario(config);
  //Step past planned sale year: 2027
  assert.doesNotThrow(() => sim.stepTo(Q1_2028), 'stepTo should not throw');

  const journalEntry = sim.journal.getActions('US_HOUSE_SALE_APPLY');
  assert.ok(journalEntry);
  assert.ok(journalEntry.length > 0);
  assert.strictEqual(journalEntry[0].stateDiff[0].delta, config.realProperties[0].value); //House value

  const usTaxJournalEntry = sim.journal.getActions('US_HOUSE_SALE_TAX');
  assert.ok(usTaxJournalEntry);
  assert.ok(usTaxJournalEntry.length > 0);
  //Expect no tax changes applied
  assert.strictEqual(usTaxJournalEntry[0].stateDiff.length,0);
});

// TODO (EVT-34): AU tax treatment for a US house sale when the person is an AU resident is
// unresolved (CSV: "??"). When clarified, add assertions here for auCapitalGainsYTD or
// auNonResidentWithholdingYTD as applicable.
