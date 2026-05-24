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
 * intl-retirement-scenario.test.mjs
 *
 * Integration tests for IntlRetirementScenario.
 * Focuses on the year-boundary transition at end of 2027 which exposed
 * an infinite-loop bug in the PERIOD_ADVANCE / TAX_SETTLE event scheduling.
 *
 * Run with: node --test tests/unit/intl-retirement-scenario.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Simulation }      from '../../src/simulation-framework/simulation.js';
import { HandlerEntry }    from '../../src/simulation-framework/handlers.js';
import { AmountAction, Action, FieldAction, ScriptedAction, RecordBalanceAction, FieldValueAction } from '../../src/simulation-framework/actions.js';
import { FieldReducer, NoOpReducer, ArrayReducer, NumericSumReducer, MultiplicativeReducer, ScriptedReducer } from '../../src/simulation-framework/reducers.js';
import { ReducerBuilder } from '../../src/simulation-framework/builders/reducer-builder.js';
import { BaseEvent }       from '../../src/simulation-framework/events/base-event.js';
import { EventSeries }     from '../../src/simulation-framework/events/event-series.js';
import { OneOffEvent }     from '../../src/simulation-framework/events/one-off-event.js';
import { ServiceRegistry }     from '../../src/services/service-registry.js';
import { BaseScenario }            from '../../src/scenarios/base-scenario.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioSerializer }     from '../../src/scenarios/scenario-serializer.js';

// Finance classes needed by ScenarioSerializer._makeReducer / _makeHandler
import { TaxService }           from '../../src/finance/tax-service.js';
import { DynamicTaxReducer }    from '../../src/finance/tax/dynamic-tax-reducer.js';
import { PeriodAdvanceReducer, PeriodAdvanceHandler }                                 from '../../src/finance/tax/period-advance-classes.js';
import { TaxSettleHandler, TaxSettleApplyReducer, TaxPaymentDebitReducer }           from '../../src/finance/tax/tax-settle-classes.js';
import { RothContributionApplyReducer, RothWithdrawalContribApplyReducer, RothWithdrawalEarningsApplyReducer, RothEarningsApplyReducer, RothContributionHandler, RothWithdrawalContributionsHandler, RothWithdrawalEarningsHandler, RothEarningsHandler }             from '../../src/finance/account-rules/us/roth-classes.js';
import { IraContributionApplyReducer, IraWithdrawalContribApplyReducer, IraWithdrawalEarningsApplyReducer, IraEarningsApplyReducer, IraContributionHandler, IraWithdrawalContributionsHandler, IraWithdrawalEarningsHandler, IraEarningsHandler }                     from '../../src/finance/account-rules/us/ira-classes.js';
import { K401ContributionApplyReducer, K401EarningsApplyReducer, K401WithdrawalApplyReducer, K401ContributionHandler, K401EarningsHandler, K401WithdrawalHandler }                                                                                                     from '../../src/finance/account-rules/us/k401-classes.js';
import { FixedIncomeContributionApplyReducer, FixedIncomeWithdrawalApplyReducer, FixedIncomeEarningsApplyReducer, StockContributionApplyReducer, StockDividendApplyReducer, StockEarningsApplyReducer, StockWithdrawalApplyReducer, FixedIncomeContributionHandler, FixedIncomeWithdrawalHandler, FixedIncomeEarningsHandler, StockContributionHandler, StockDividendHandler, StockEarningsHandler, StockWithdrawalHandler } from '../../src/finance/account-rules/us/us-brokerage-classes.js';
import { UsHouseSaleApplyReducer, UsHouseSaleHandler }                               from '../../src/finance/account-rules/us/us-real-property-classes.js';
import { SsIncomeApplyReducer, WagesIncomeApplyReducer, WagesWithheldApplyReducer, SeIncomeUsApplyReducer, BonusApplyReducer, CompanySaleApplyReducer, SsIncomeHandler, WagesIncomeHandler, WagesWithheldHandler, SeIncomeUsHandler, BonusHandler, CompanySaleHandler } from '../../src/finance/account-rules/us/us-income-classes.js';
import { CollectibleSaleApplyReducer, CollectibleValueChangeApplyReducer, CollectibleSaleHandler, CollectibleValueChangeHandler } from '../../src/finance/account-rules/us/us-collectible-classes.js';
import { IraRolloverWithdrawalApplyReducer, IraRmdApplyReducer, IraRolloverWithdrawalHandler, IraRmdHandler } from '../../src/finance/account-rules/us/ira-rollover-classes.js';
import { RothRolloverContributionApplyReducer, RothRolloverEarningsApplyReducer, RothRolloverWithdrawalContribApplyReducer, RothRolloverWithdrawalEarningsApplyReducer, RothRolloverContributionHandler, RothRolloverEarningsHandler, RothRolloverWithdrawalContributionsHandler, RothRolloverWithdrawalEarningsHandler } from '../../src/finance/account-rules/us/roth-rollover-classes.js';
import { RothConversionApplyReducer, RothConversionHandler, RothConversionPolicyHandler } from '../../src/finance/account-rules/us/roth-conversion-classes.js';
import { AuSeIncomeApplyReducer, AuSeIncomeHandler }                                 from '../../src/finance/account-rules/au/au-income-classes.js';
import { AuSavingsContributionApplyReducer, AuSavingsWithdrawalApplyReducer, AuSavingsEarningsApplyReducer, AuSavingsContributionHandler, AuSavingsWithdrawalHandler, AuSavingsEarningsHandler }                                                                     from '../../src/finance/account-rules/au/au-savings-classes.js';
import { SuperContributionApplyReducer, SuperWithdrawalContribApplyReducer, SuperWithdrawalEarningsApplyReducer, SuperEarningsApplyReducer, SuperContributionHandler, SuperWithdrawalContributionsHandler, SuperWithdrawalEarningsHandler, SuperEarningsDirectHandler } from '../../src/finance/account-rules/au/au-super-classes.js';
import { AuDividendFrankedResidentApplyReducer, AuDividendFrankedNonResidentApplyReducer, AuDividendUnfrankedResidentApplyReducer, AuDividendUnfrankedNonResidentApplyReducer, AuStockEarningsApplyReducer, AuStockWithdrawalApplyReducer, AuDividendFrankedResidentHandler, AuDividendFrankedNonResidentHandler, AuDividendUnfrankedResidentHandler, AuDividendUnfrankedNonResidentHandler, AuStockEarningsHandler, AuStockWithdrawalHandler } from '../../src/finance/account-rules/au/au-brokerage-classes.js';
import { AuHouseSaleApplyReducer, AuHouseSaleHandler }                               from '../../src/finance/account-rules/au/au-real-property-classes.js';
import { UsSavingsInterestMonthlyHandler }                                           from '../../src/finance/handlers/us-savings-interest-handler.js';
import { MonthlyExpensesHandler }                                                    from '../../src/finance/handlers/monthly-expenses-handler.js';
import { MonthlyWagesHandler }                                                       from '../../src/finance/handlers/monthly-wages-handler.js';
import { IntlTransferToUsHandler, IntlTransferToAuHandler }                          from '../../src/finance/handlers/intl-transfer-handlers.js';
import {
  AuSavingsInterestHandler, FixedIncomeInterestHandler, SuperEarningsHandler,
  IntlRothEarningsHandler, IntlIraEarningsHandler, IntlK401EarningsHandler,
  IntlUsStockEarningsHandler, IntlAuStockEarningsHandler, IntlAuStockDividendHandler,
} from '../../src/finance/handlers/earnings-handlers.js';
import { DividendScheduledHandler }                                                  from '../../src/finance/handlers/dividend-scheduled-handler.js';
import { ChangeResidencyHandler }                                                    from '../../src/finance/handlers/change-residency-handler.js';
import { OutOfFundsHandler }                                                         from '../../src/finance/handlers/out-of-funds-handler.js';
import { ChangeResidencyApplyReducer }                                               from '../../src/finance/reducers/change-residency-apply-reducer.js';
import { ExpenseDebitReducer }                                                       from '../../src/finance/reducers/expense-debit-reducer.js';
import { IntlTransferApplyReducer }                                                  from '../../src/finance/reducers/intl-transfer-apply-reducer.js';
import { ReplenishSavingsReducer }                                                   from '../../src/finance/reducers/replenish-savings-reducer.js';
import { SetOutOfFundsDateReducer }                                                  from '../../src/finance/reducers/set-out-of-funds-date-reducer.js';
import { AccumulateDeficitReducer }                                                  from '../../src/finance/reducers/accumulate-deficit-reducer.js';
import { OutOfFundsReducer }                                                         from '../../src/finance/reducers/out-of-funds-reducer.js';
import { InflationAdjustReducer }                                                    from '../../src/finance/reducers/inflation-adjust-reducer.js';
import { StockDividendCashApplyReducer }                                             from '../../src/finance/reducers/stock-dividend-cash-apply-reducer.js';
import { UsSavingsInterestCreditReducer }                                            from '../../src/finance/reducers/us-savings-interest-credit-reducer.js';
import { Account, CheckingAccount, SavingsAccount }                                  from '../../src/finance/assets/account.js';
import { InvestmentAccount, BrokerageAccount, FourOhOneKAccount, RothAccount, TraditionalIRAAccount, SuperannuationAccount } from '../../src/finance/assets/investment-account.js';
import { RealProperty }  from '../../src/finance/assets/real-property.js';
import { Collectible }   from '../../src/finance/assets/collectible.js';
import { Person }                                                                    from '../../src/finance/person.js';
// ─── Provide the FinSimLib global that BaseScenario.buildSim() needs ──────────

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
    // Tax infrastructure
    TaxService, DynamicTaxReducer,
    PeriodAdvanceReducer, PeriodAdvanceHandler,
    TaxSettleHandler, TaxSettleApplyReducer, TaxPaymentDebitReducer,
    // US account module
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
    // US — Income
    SsIncomeApplyReducer, WagesIncomeApplyReducer, WagesWithheldApplyReducer,
    SeIncomeUsApplyReducer, BonusApplyReducer, CompanySaleApplyReducer,
    SsIncomeHandler, WagesIncomeHandler, WagesWithheldHandler,
    SeIncomeUsHandler, BonusHandler, CompanySaleHandler,
    // US — Collectibles
    CollectibleSaleApplyReducer, CollectibleValueChangeApplyReducer,
    CollectibleSaleHandler, CollectibleValueChangeHandler,
    // US — IRA Rollover + RMD
    IraRolloverWithdrawalApplyReducer, IraRmdApplyReducer,
    IraRolloverWithdrawalHandler, IraRmdHandler,
    // US — Roth Rollover
    RothRolloverContributionApplyReducer, RothRolloverEarningsApplyReducer,
    RothRolloverWithdrawalContribApplyReducer, RothRolloverWithdrawalEarningsApplyReducer,
    RothRolloverContributionHandler, RothRolloverEarningsHandler,
    RothRolloverWithdrawalContributionsHandler, RothRolloverWithdrawalEarningsHandler,
    // US — Roth Conversion
    RothConversionApplyReducer, RothConversionHandler, RothConversionPolicyHandler,
    // AU account module
    AuSavingsContributionApplyReducer, AuSavingsWithdrawalApplyReducer,
    AuSavingsEarningsApplyReducer,
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
    // AU — Income
    AuSeIncomeApplyReducer, AuSeIncomeHandler,
    // Scenario-level handlers and reducers
    UsSavingsInterestMonthlyHandler, MonthlyExpensesHandler, MonthlyWagesHandler,
    IntlTransferToUsHandler, IntlTransferToAuHandler,
    AuSavingsInterestHandler, FixedIncomeInterestHandler, SuperEarningsHandler,
    DividendScheduledHandler, ChangeResidencyHandler, OutOfFundsHandler,
    IntlRothEarningsHandler, IntlIraEarningsHandler, IntlK401EarningsHandler,
    IntlUsStockEarningsHandler, IntlAuStockEarningsHandler, IntlAuStockDividendHandler,
    ChangeResidencyApplyReducer, ExpenseDebitReducer, IntlTransferApplyReducer,
    ReplenishSavingsReducer, SetOutOfFundsDateReducer, AccumulateDeficitReducer, OutOfFundsReducer, InflationAdjustReducer,
    StockDividendCashApplyReducer, UsSavingsInterestCreditReducer,
    // Account types
    Account, CheckingAccount, SavingsAccount,
    InvestmentAccount, BrokerageAccount, FourOhOneKAccount,
    RothAccount, TraditionalIRAAccount, SuperannuationAccount,
    RealProperty, Collectible,
    Person,
  },
};

// ─── Stub EventSchedulerUI ────────────────────────────────────────────────────

function makeStubUI() {
  const stub = {
    nodes: [],
    _listeners: { eventCreated: [], handlerCreated: [], actionCreated: [], reducerCreated: [] },
    registerEventCreatedListener(l)   { stub._listeners.eventCreated.push(l); },
    registerHandlerCreatedListener(l) { stub._listeners.handlerCreated.push(l); },
    registerActionCreatedListener(l)  { stub._listeners.actionCreated.push(l); },
    registerReducerCreatedListener(l) { stub._listeners.reducerCreated.push(l); },
    addEvent(e)   { stub.nodes.push(e); },
    addHandler(h) { stub.nodes.push(h); },
    addAction(a)  { stub.nodes.push(a); },
    addReducer(r) { stub.nodes.push(r); },
    editNode()    {},
  };
  return stub;
}

// ─── Build helpers ────────────────────────────────────────────────────────────

/**
 * Build and initialise an IntlRetirementScenario.
 * Returns { scenario, sim } ready to step.
 */
function buildScenario(params = {}) {
  ServiceRegistry.reset();
  const ui       = makeStubUI();
  const scenario = new IntlRetirementScenario({
    eventSchedulerUI: ui,
    context: ServiceRegistry.getInstance().simulationContext,
    params: params
  });
  scenario.buildSim();
  scenario.loadDefaults();
  const sim = scenario.sim;
  return { scenario, sim };
}

/**
 * Step the simulation in daily increments up to targetDate.
 * Throws if the queue processes more than maxEvents events total — a guard
 * against the infinite-loop bug we are testing for.
 *
 * Returns the number of events processed.
 */
function stepWithGuard(sim, targetDate, maxEvents = 5000) {
  let count = 0;
  const origPop = sim.queue.pop.bind(sim.queue);
  sim.queue.pop = function() {
    if (++count > maxEvents) {
      throw new Error(
        `stepWithGuard: exceeded ${maxEvents} events — likely infinite loop at ` +
        sim.currentDate.toISOString()
      );
    }
    return origPop();
  };

  sim.stepTo(targetDate);

  // Restore
  sim.queue.pop = origPop;
  return count;
}

// ═════════════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════════════

test('scenario builds without error', () => {
  const { sim } = buildScenario();
  assert.ok(sim, 'sim should be defined');
  assert.ok(sim.queue.size() > 0, 'queue should have events scheduled');
});

test('scenario advances through year 1 (2026) without looping', () => {
  const { sim } = buildScenario();
  const endOf2026 = new Date(Date.UTC(2026, 11, 31));
  const count = stepWithGuard(sim, endOf2026);
  assert.ok(count > 0, `should have processed events, got ${count}`);
  assert.strictEqual(sim.currentDate.toISOString(), endOf2026.toISOString(),
    'sim.currentDate should be Dec 31 2026');
});

test('scenario advances through Nov 30 2027 without looping', () => {
  const { sim } = buildScenario();
  const nov30 = new Date(Date.UTC(2027, 10, 30));
  const count = stepWithGuard(sim, nov30);
  assert.ok(count > 0, `should have processed events`);
  assert.strictEqual(sim.currentDate.toISOString(), nov30.toISOString(),
    'sim.currentDate should be Nov 30 2027');
});

test('scenario advances through Dec 31 2027 (year-end boundary) without looping', () => {
  const { sim } = buildScenario();
  // First advance to Nov 30 2027 (as the user described the repro)
  const nov30 = new Date(Date.UTC(2027, 10, 30));
  stepWithGuard(sim, nov30);

  // Then advance to Dec 31 2027 — this is where the loop was reported
  const dec31 = new Date(Date.UTC(2027, 11, 31));
  const count = stepWithGuard(sim, dec31);
  assert.ok(count > 0, `should have processed events in Dec 2027`);
  assert.strictEqual(sim.currentDate.toISOString(), dec31.toISOString(),
    'sim.currentDate should reach Dec 31 2027');
});

test('scenario advances through year 3 (end of 2028) without looping', () => {
  const { sim } = buildScenario();
  const endOf2028 = new Date(Date.UTC(2028, 11, 31));
  const count = stepWithGuard(sim, endOf2028, 10000);
  assert.ok(count > 0);
  assert.strictEqual(sim.currentDate.toISOString(), endOf2028.toISOString());
});

test('US tax YTD resets after Dec 31 2026 settlement (Dec interest re-adds)', () => {
  const { sim } = buildScenario();
  sim.stepTo(new Date(Date.UTC(2026, 11, 31)));
  // TAX_SETTLE resets usOrdinaryIncomeYTD to 0 but the same-day Dec 31
  // US_SAVINGS_INTEREST_MONTHLY event fires and adds December's interest back,
  // so the value should be a small positive number (not the full year's YTD).
  assert.ok(sim.state.usOrdinaryIncomeYTD >= 0,
    'usOrdinaryIncomeYTD should be non-negative after US tax settlement + Dec interest');
  // Sanity: it should be less than one month's worth of interest (~75 max)
  assert.ok(sim.state.usOrdinaryIncomeYTD < 100,
    `usOrdinaryIncomeYTD should be a single month's interest, got ${sim.state.usOrdinaryIncomeYTD}`);
});

test('AU tax YTD resets to 0 after Jun 30 2026 settlement', () => {
  const { sim } = buildScenario();
  sim.stepTo(new Date(Date.UTC(2026, 5, 30)));  // Jun 30, 2026
  // The AU FY2025-2026 TAX_SETTLE should have fired, resetting AU YTD
  assert.strictEqual(sim.state.auOrdinaryIncomeYTD, 0,
    'auOrdinaryIncomeYTD should be reset after AU tax settlement');
});

test('currentPeriods.US advances to 2027 after Jan 1 2027 PERIOD_ADVANCE', () => {
  const { sim } = buildScenario();
  sim.stepTo(new Date(Date.UTC(2027, 0, 2)));  // Jan 2, 2027 (one day after advance)
  const period = sim.state.currentPeriods?.US;
  assert.ok(period, 'currentPeriods.US should exist');
  const startYear = new Date(period.startMs).getUTCFullYear();
  assert.strictEqual(startYear, 2027, 'US period should be 2027 after Jan 1 PERIOD_ADVANCE');
});

test('currentPeriods.AU advances to FY2026-27 after Jul 1 2026 PERIOD_ADVANCE', () => {
  const { sim } = buildScenario();
  sim.stepTo(new Date(Date.UTC(2026, 6, 2)));  // Jul 2, 2026 (one day after advance)
  const period = sim.state.currentPeriods?.AU;
  assert.ok(period, 'currentPeriods.AU should exist');
  const startYear = new Date(period.startMs).getUTCFullYear();
  assert.strictEqual(startYear, 2026,
    'AU period should start in 2026 (FY2026-27 starts Jul 1 2026)');
});

// ═════════════════════════════════════════════════════════════════════════════
// Serialization round-trip tests
// Regression coverage: ScenarioSerializer must be able to deserialize every
// reducer and handler type that registerHandlersAndReducers() produces.
// ═════════════════════════════════════════════════════════════════════════════

test('serialize → deserialize round-trip reconstructs all TaxService reducers', () => {
  const { scenario } = buildScenario();
  const services = ServiceRegistry.getInstance();

  const config = ScenarioSerializer.serialize(
    services, 'Test',
    new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2041, 0, 1)),
    scenario.sim.state, {}
  );

  // Rebuild the sim (phase 1 only) then deserialize the saved config.
  ServiceRegistry.reset();
  const scenario2 = new IntlRetirementScenario({
    eventSchedulerUI: makeStubUI(),
    context: ServiceRegistry.getInstance().simulationContext
  });
  scenario2.buildSim();
  assert.doesNotThrow(
    () => ScenarioSerializer.deserialize(config, ServiceRegistry.getInstance()),
    'ScenarioSerializer.deserialize should not throw for any TaxService reducer type'
  );

  const reducerTypes = ServiceRegistry.getInstance().reducerService.getAll()
    .map(r => r.reducerType);

  // Tax infrastructure
  assert.ok(reducerTypes.includes('PeriodAdvanceReducer'),   'PeriodAdvanceReducer missing after round-trip');
  assert.ok(reducerTypes.includes('TaxSettleApplyReducer'),  'TaxSettleApplyReducer missing after round-trip');
  assert.ok(reducerTypes.includes('TaxPaymentDebitReducer'), 'TaxPaymentDebitReducer missing after round-trip');
  assert.ok(reducerTypes.some(t => t === 'DynamicTaxReducer'), 'DynamicTaxReducer missing after round-trip');

  // US account module (spot-check one per category)
  assert.ok(reducerTypes.includes('RothContributionApplyReducer'),        'RothContributionApplyReducer missing');
  assert.ok(reducerTypes.includes('IraWithdrawalEarningsApplyReducer'),   'IraWithdrawalEarningsApplyReducer missing');
  assert.ok(reducerTypes.includes('K401WithdrawalApplyReducer'),          'K401WithdrawalApplyReducer missing');
  assert.ok(reducerTypes.includes('StockDividendApplyReducer'),           'StockDividendApplyReducer missing');
  assert.ok(reducerTypes.includes('FixedIncomeEarningsApplyReducer'),     'FixedIncomeEarningsApplyReducer missing');
  assert.ok(reducerTypes.includes('UsHouseSaleApplyReducer'),             'UsHouseSaleApplyReducer missing');

  // AU account module (spot-check one per category)
  assert.ok(reducerTypes.includes('AuSavingsEarningsApplyReducer'),               'AuSavingsEarningsApplyReducer missing');
  assert.ok(reducerTypes.includes('SuperWithdrawalEarningsApplyReducer'),         'SuperWithdrawalEarningsApplyReducer missing');
  assert.ok(reducerTypes.includes('AuDividendFrankedNonResidentApplyReducer'),    'AuDividendFrankedNonResidentApplyReducer missing');
  assert.ok(reducerTypes.includes('AuStockWithdrawalApplyReducer'),               'AuStockWithdrawalApplyReducer missing');
  assert.ok(reducerTypes.includes('AuHouseSaleApplyReducer'),                     'AuHouseSaleApplyReducer missing');
});

test('serialize → deserialize round-trip reconstructs all TaxService handlers', () => {
  const { scenario } = buildScenario();
  const services = ServiceRegistry.getInstance();

  const config = ScenarioSerializer.serialize(
    services, 'Test',
    new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2041, 0, 1)),
    scenario.sim.state, {}
  );

  ServiceRegistry.reset();
  const scenario2 = new IntlRetirementScenario({
    eventSchedulerUI: makeStubUI(),
    context: ServiceRegistry.getInstance().simulationContext
  });
  scenario2.buildSim();
  ScenarioSerializer.deserialize(config, ServiceRegistry.getInstance());

  const handlerTypes = ServiceRegistry.getInstance().handlerService.getAll()
    .map(h => h.handlerClass);

  // Tax infrastructure
  assert.ok(handlerTypes.includes('PeriodAdvanceHandler'), 'PeriodAdvanceHandler missing after round-trip');
  assert.ok(handlerTypes.includes('TaxSettleHandler'),     'TaxSettleHandler missing after round-trip');

  // US account module (spot-check)
  assert.ok(handlerTypes.includes('RothContributionHandler'),           'RothContributionHandler missing');
  assert.ok(handlerTypes.includes('IraWithdrawalEarningsHandler'),      'IraWithdrawalEarningsHandler missing');
  assert.ok(handlerTypes.includes('K401WithdrawalHandler'),             'K401WithdrawalHandler missing');
  assert.ok(handlerTypes.includes('StockWithdrawalHandler'),            'StockWithdrawalHandler missing');
  assert.ok(handlerTypes.includes('UsHouseSaleHandler'),                'UsHouseSaleHandler missing');

  // AU account module (spot-check)
  assert.ok(handlerTypes.includes('AuSavingsContributionHandler'),      'AuSavingsContributionHandler missing');
  assert.ok(handlerTypes.includes('SuperEarningsDirectHandler'),        'SuperEarningsDirectHandler missing');
  assert.ok(handlerTypes.includes('AuStockWithdrawalHandler'),          'AuStockWithdrawalHandler missing');
  assert.ok(handlerTypes.includes('AuHouseSaleHandler'),                'AuHouseSaleHandler missing');
});

// ═════════════════════════════════════════════════════════════════════════════
// Metrics: investment account balances captured in state.metrics
// ═════════════════════════════════════════════════════════════════════════════

test('DIVIDEND_SCHEDULED: state.metrics.usStockAccount is set after year-end dividend', () => {
  // dividendsEvent has startOffset(1), so first DIVIDEND_SCHEDULED fires Dec 31 2027
  const { sim } = buildScenario();
  sim.stepTo(new Date(Date.UTC(2027, 11, 31)));

  assert.ok(
    sim.state.metrics?.usStockAccount != null,
    `state.metrics.usStockAccount should be set after DIVIDEND_SCHEDULED; got ${JSON.stringify(sim.state.metrics)}`
  );
  assert.ok(
    typeof sim.state.metrics.usStockAccount === 'number' && sim.state.metrics.usStockAccount > 0,
    `state.metrics.usStockAccount should be a positive number, got ${sim.state.metrics.usStockAccount}`
  );
});

test('REPLENISH_SAVINGS: state.metrics captures balance of each drawn account', () => {
  // Low savings forces immediate drawdown from fixedIncomeAccount (drawdownPriority 1)
  // on the first month-end expense.
  const { sim } = buildScenario({ initialUsSavings: 3000 });
  sim.stepTo(new Date(Date.UTC(2026, 0, 31)));  // Jan 31 2026 — first MONTHLY_EXPENSES

  assert.ok(
    sim.state.metrics?.fixedIncomeAccount != null,
    `state.metrics.fixedIncomeAccount should be set after drawdown; got ${JSON.stringify(sim.state.metrics)}`
  );
  assert.ok(
    typeof sim.state.metrics.fixedIncomeAccount === 'number',
    `state.metrics.fixedIncomeAccount should be a number, got ${sim.state.metrics.fixedIncomeAccount}`
  );
});

test('DynamicTaxReducer round-trip preserves cc and actionType', () => {
  const { scenario } = buildScenario();
  const services = ServiceRegistry.getInstance();

  const config = ScenarioSerializer.serialize(
    services, 'Test',
    new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2041, 0, 1)),
    scenario.sim.state, {}
  );

  ServiceRegistry.reset();
  const scenario2 = new IntlRetirementScenario({
    eventSchedulerUI: makeStubUI(),
    context: ServiceRegistry.getInstance().simulationContext
  });
  scenario2.buildSim();
  ScenarioSerializer.deserialize(config, ServiceRegistry.getInstance());

  const dynamicReducers = ServiceRegistry.getInstance().reducerService.getAll()
    .filter(r => r.reducerType === 'DynamicTaxReducer');

  assert.ok(dynamicReducers.length > 0, 'no DynamicTaxReducers restored');

  for (const r of dynamicReducers) {
    assert.ok(r.cc === 'US' || r.cc === 'AU', `DynamicTaxReducer.cc should be US or AU, got '${r.cc}'`);
    assert.ok(r.reducedActionTypes.length === 1, 'DynamicTaxReducer should handle exactly one action type');
    assert.ok(typeof r.reducedActionTypes[0] === 'string', 'action type should be a string');
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Early withdrawal: account types and allowsEarlyWithdrawal flags
// Regression: accounts were created as generic InvestmentAccount, leaving
// type=null and allowsEarlyWithdrawal=false, so replenishSavings Phase 2
// silently skipped them and triggered premature OUT_OF_FUNDS.
// ═════════════════════════════════════════════════════════════════════════════

test('EW-INTL-1: iraAccount has type ira and allowsEarlyWithdrawal true', () => {
  const { sim } = buildScenario();
  const ira = sim.state.iraAccount;
  assert.strictEqual(ira.type, 'ira', 'iraAccount.type should be "ira"');
  assert.strictEqual(ira.allowsEarlyWithdrawal, true, 'iraAccount.allowsEarlyWithdrawal should be true');
  assert.strictEqual(ira.minimumAge, 60, 'iraAccount.minimumAge should be 60 (TraditionalIRAAccount default)');
});

test('EW-INTL-1: k401Account has type 401k and allowsEarlyWithdrawal true', () => {
  const { sim } = buildScenario();
  const k401 = sim.state.k401Account;
  assert.strictEqual(k401.type, '401k', 'k401Account.type should be "401k"');
  assert.strictEqual(k401.allowsEarlyWithdrawal, true, 'k401Account.allowsEarlyWithdrawal should be true');
  assert.strictEqual(k401.minimumAge, 59.5, 'k401Account.minimumAge should be 59.5 (FourOhOneKAccount default)');
});

test('EW-INTL-1: rothAccount has type roth and allowsEarlyWithdrawal true', () => {
  const { sim } = buildScenario();
  const roth = sim.state.rothAccount;
  assert.strictEqual(roth.type, 'roth', 'rothAccount.type should be "roth"');
  assert.strictEqual(roth.allowsEarlyWithdrawal, true, 'rothAccount.allowsEarlyWithdrawal should be true');
  assert.strictEqual(roth.minimumAge, 59.5, 'rothAccount.minimumAge should be 59.5 (RothAccount default)');
});

// ═════════════════════════════════════════════════════════════════════════════
// Early retirement scenario: retiring in 2028 should NOT trigger OUT_OF_FUNDS
// in 2028 given ample retirement account balances (IRA + 401k + Roth).
// The primary person is born 1978-04-15 → age ~50 in 2028, well below the
// 59.5/60 age gates, so early-withdrawal code paths are exercised.
// ═════════════════════════════════════════════════════════════════════════════

test('EW-INTL-2: early retirement in 2028 does not trigger OUT_OF_FUNDS through end of 2028', () => {
  const { sim } = buildScenario({
    primaryRetirementDate: new Date(Date.UTC(2028, 0, 1)),
    spouseRetirementDate:  new Date(Date.UTC(2028, 0, 1)),
    // Drain non-retirement US savings so early withdrawal is required
    initialUsSavings:   10_000,
    fixedIncomeBalance:  5_000,
    stockBalance:        5_000,
    // Retirement accounts have plenty of funds
    iraBalance:   200_000,
    k401Balance:  300_000,
    rothBalance:   80_000,
  });

  const end2028 = new Date(Date.UTC(2028, 11, 31));
  stepWithGuard(sim, end2028, 15000);

  assert.strictEqual(
    sim.state.outOfFundsDate, null,
    `outOfFundsDate should remain null through 2028 with retirement accounts available; got ${sim.state.outOfFundsDate}`
  );
});

test('EW-INTL-3: early retirement draws from retirement accounts before triggering OUT_OF_FUNDS', () => {
  // Retire both people at sim start so wages never flow in.
  // Non-retirement accounts are empty, so drawdown from retirement accounts must fire immediately.
  // Roth contributions (always accessible, Phase 1) are drawn first, then IRA/401k via
  // Phase 2 early withdrawal once Roth contributions are exhausted.
  const { sim } = buildScenario({
    primaryRetirementDate: new Date(Date.UTC(2026, 0, 1)),
    spouseRetirementDate:  new Date(Date.UTC(2026, 0, 1)),
    initialUsSavings:   3_000,
    usSavingsMinBalance: 0,
    fixedIncomeBalance:     0,
    stockBalance:           0,
    // Retirement accounts are the only source
    iraBalance:   200_000,  iraBasis: 200_000,
    k401Balance:  300_000,  k401Basis: 300_000,
    rothBalance:   80_000,  rothBasis:  80_000,
  });

  const end2026 = new Date(Date.UTC(2026, 11, 31));
  stepWithGuard(sim, end2026, 10000);

  // With no wages and no non-retirement cash, retirement accounts must be drawn.
  // Roth contributions (drawdownPriority 5) are drawn in Phase 1 (always accessible).
  // If Roth is exhausted, IRA (priority 3) or 401k (priority 4) follow via Phase 2
  // early withdrawal (primary person is ~48 years old, below all age gates).
  const rothBalance = sim.state.rothAccount.balance;
  const iraBalance  = sim.state.iraAccount.balance;
  const k401Balance = sim.state.k401Account.balance;

  assert.ok(
    rothBalance < 80_000 || iraBalance < 200_000 || k401Balance < 300_000,
    `Expected at least one retirement account drawn; Roth=${rothBalance}, IRA=${iraBalance}, 401k=${k401Balance}`
  );

  assert.strictEqual(
    sim.state.outOfFundsDate, null,
    `outOfFundsDate should remain null; got ${sim.state.outOfFundsDate}`
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// Spouse retirement accounts — Session 4 additions
// Verify that all 4 spouse accounts exist in state with correct roles/ownerIds,
// and that their balances grow via the earnings handlers.
// ═════════════════════════════════════════════════════════════════════════════

test('SPOUSE-1: spouse retirement accounts exist in initial state', () => {
  const { sim } = buildScenario();
  const s = sim.state;

  assert.ok(s.spouseRothAccount,  'spouseRothAccount missing from state');
  assert.ok(s.spouseIraAccount,   'spouseIraAccount missing from state');
  assert.ok(s.spouseK401Account,  'spouseK401Account missing from state');
  assert.ok(s.spouseSuperAccount, 'spouseSuperAccount missing from state');
});

test('SPOUSE-2: spouse accounts have correct role and ownerId', () => {
  const { sim } = buildScenario();
  const s = sim.state;

  assert.strictEqual(s.spouseRothAccount.role,    'roth-ira', 'spouseRothAccount.role');
  assert.strictEqual(s.spouseIraAccount.role,     'ira',      'spouseIraAccount.role');
  assert.strictEqual(s.spouseK401Account.role,    'k401',     'spouseK401Account.role');
  assert.strictEqual(s.spouseSuperAccount.role,   'super',    'spouseSuperAccount.role');

  assert.strictEqual(s.spouseRothAccount.ownerId,  'spouse', 'spouseRothAccount.ownerId');
  assert.strictEqual(s.spouseIraAccount.ownerId,   'spouse', 'spouseIraAccount.ownerId');
  assert.strictEqual(s.spouseK401Account.ownerId,  'spouse', 'spouseK401Account.ownerId');
  assert.strictEqual(s.spouseSuperAccount.ownerId, 'spouse', 'spouseSuperAccount.ownerId');
});

test('SPOUSE-3: spouse accounts initialize with correct default balances', () => {
  const { sim } = buildScenario();
  const s = sim.state;

  assert.strictEqual(s.spouseRothAccount.balance,  40_000,  'spouseRothAccount initial balance');
  assert.strictEqual(s.spouseIraAccount.balance,   100_000, 'spouseIraAccount initial balance');
  assert.strictEqual(s.spouseK401Account.balance,  150_000, 'spouseK401Account initial balance');
  assert.strictEqual(s.spouseSuperAccount.balance, 125_000, 'spouseSuperAccount initial balance');
});

test('SPOUSE-4: spouse account balances grow independently after year-end earnings', () => {
  const { sim } = buildScenario();
  const initialSpouseRoth  = sim.state.spouseRothAccount.balance;
  const initialPrimaryRoth = sim.state.rothAccount.balance;

  // Advance to first earnings event (startOffset(1) means Dec 31 2027)
  sim.stepTo(new Date(Date.UTC(2027, 11, 31)));

  const spouseRothAfter  = sim.state.spouseRothAccount.balance;
  const primaryRothAfter = sim.state.rothAccount.balance;

  assert.ok(spouseRothAfter > initialSpouseRoth,
    `spouseRothAccount should grow; was ${initialSpouseRoth}, now ${spouseRothAfter}`);
  assert.ok(primaryRothAfter > initialPrimaryRoth,
    `rothAccount should grow; was ${initialPrimaryRoth}, now ${primaryRothAfter}`);

  // Each grows by its own rate × balance — they should grow independently
  const spouseGrowth  = spouseRothAfter - initialSpouseRoth;
  const primaryGrowth = primaryRothAfter - initialPrimaryRoth;
  assert.ok(spouseGrowth > 0,  `spouse Roth growth should be positive; got ${spouseGrowth}`);
  assert.ok(primaryGrowth > 0, `primary Roth growth should be positive; got ${primaryGrowth}`);
  // Primary started with 80k, spouse with 40k; same rate → primary growth ~ 2× spouse growth
  assert.ok(
    Math.abs(primaryGrowth / spouseGrowth - 2) < 0.01,
    `primaryGrowth (${primaryGrowth}) should be ~2× spouseGrowth (${spouseGrowth})`
  );
});

test('SPOUSE-5: ROTH_EARNINGS_APPLY credits spouse account, not primary', () => {
  // Set spouse balance to 0 so any earnings would be from primary only if routing is wrong.
  const { sim } = buildScenario({ spouseRothBalance: 0, spouseRothBasis: 0 });

  const initialPrimaryRoth = sim.state.rothAccount.balance;
  sim.stepTo(new Date(Date.UTC(2027, 11, 31)));

  // Primary should still grow; spouse should stay at 0 (no earnings on zero balance)
  assert.ok(sim.state.rothAccount.balance > initialPrimaryRoth,
    'primary rothAccount should grow regardless');
  assert.strictEqual(sim.state.spouseRothAccount.balance, 0,
    'spouseRothAccount with 0 balance should stay 0 — earnings must not leak to primary');
});

test('SPOUSE-6: serialize → deserialize round-trip preserves spouse accounts', () => {
  const { scenario } = buildScenario();
  const services = ServiceRegistry.getInstance();

  const config = ScenarioSerializer.serialize(
    services, 'Test',
    new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2041, 0, 1)),
    scenario.sim.state, {}
  );

  // Verify spouse accounts appear in serialized config
  const accountNames = config.accounts.map(a => a.name);
  assert.ok(accountNames.some(n => n.includes('Spouse') && n.includes('Roth')),
    `Roth IRA (Spouse) missing from serialized accounts; got: ${accountNames}`);
  assert.ok(accountNames.some(n => n.includes('Spouse') && n.includes('IRA')),
    `Traditional IRA (Spouse) missing from serialized accounts`);
  assert.ok(accountNames.some(n => n.includes('Spouse') && n.includes('401')),
    `401(k) (Spouse) missing from serialized accounts`);
  assert.ok(accountNames.some(n => n.includes('Spouse') && n.includes('Super')),
    `Superannuation (Spouse) missing from serialized accounts`);

  // Verify role is preserved in serialized data
  const spouseRothData = config.accounts.find(a => a.name === 'Roth IRA (Spouse)');
  assert.ok(spouseRothData, 'Roth IRA (Spouse) account data not found');
  assert.strictEqual(spouseRothData.role,    'roth-ira', 'role should be preserved');
  assert.strictEqual(spouseRothData.ownerId, 'spouse',   'ownerId should be preserved');

  // Deserialize and verify accounts are restored
  ServiceRegistry.reset();
  const scenario2 = new IntlRetirementScenario({
    eventSchedulerUI: makeStubUI(),
    context: ServiceRegistry.getInstance().simulationContext,
  });
  scenario2.buildSim();
  assert.doesNotThrow(
    () => ScenarioSerializer.deserialize(config, ServiceRegistry.getInstance()),
    'deserialize should not throw with spouse accounts'
  );

  const restoredAccounts = ServiceRegistry.getInstance().accountService.getAll();
  const restoredNames = restoredAccounts.map(a => a.name);
  assert.ok(restoredNames.some(n => n === 'Roth IRA (Spouse)'),
    `Roth IRA (Spouse) not restored after deserialize; got: ${restoredNames}`);
});

// ─── Roth conversion param type-mismatch guard ────────────────────────────────

test('rothConversionStartYear: Date object falls back to primary retirement year', () => {
  // Regression: changing the UI type dropdown from Number→Date persists a Date
  // object that caused the loadDefaults() year loop to run with a non-numeric
  // start, producing thousands of events and hanging the browser.
  const { scenario } = buildScenario({
    rothConversionEnabled:   true,
    rothConversionStartYear: new Date('2026-05-16'), // Date where milliseconds << year
  });
  const events = ServiceRegistry.getInstance().eventService.getAll()
    .filter(e => e.type === 'ROTH_CONVERSION_POLICY_EVALUATE');
  // With a Date object, toFiniteYear() falls back to primaryRetirementDate year,
  // so the loop runs a small bounded number of times (retirement → RMD year).
  assert.ok(events.length < 100,
    `Expected < 100 Roth conversion events but got ${events.length} — type guard may not be working`);
});

test('rothConversionStartYear: empty-string falls back to primary retirement year', () => {
  // Regression: an empty-string value (e.g. date picker cleared after type change)
  // coerces to 0 in the loop comparison, causing ~2038 iterations and a browser hang.
  const { scenario } = buildScenario({
    rothConversionEnabled:   true,
    rothConversionStartYear: '', // empty string coerces to 0 via numeric comparison
  });
  const events = ServiceRegistry.getInstance().eventService.getAll()
    .filter(e => e.type === 'ROTH_CONVERSION_POLICY_EVALUATE');
  assert.ok(events.length < 100,
    `Expected < 100 Roth conversion events but got ${events.length} — empty-string guard may not be working`);
});

test('rothConversionEndYear: Date object falls back to RMD year', () => {
  const { scenario } = buildScenario({
    rothConversionEnabled: true,
    rothConversionEndYear: new Date('2060-01-01'),
  });
  const events = ServiceRegistry.getInstance().eventService.getAll()
    .filter(e => e.type === 'ROTH_CONVERSION_POLICY_EVALUATE');
  assert.ok(events.length < 100,
    `Expected < 100 Roth conversion events but got ${events.length} — end-year Date guard may not be working`);
});

// ═════════════════════════════════════════════════════════════════════════════
// Event data round-trip: PERIOD_ADVANCE and TAX_SETTLE events must carry their
// data field (cc, period) through serialize → deserialize so that handlers fire
// correctly in imported scenarios.  Missing data was the root cause of a bug
// where imported scenarios computed incorrect balances vs the original.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Build and initialise an IntlRetirementScenario, serialize it, then rebuild
 * it as a BaseScenario via ScenarioSerializer.deserialize() — exactly the path
 * the browser takes when a user exports and re-imports a scenario.
 */
function buildRoundTripped(params = {}) {
  const { scenario: orig } = buildScenario(params);
  const registry = ServiceRegistry.getInstance();

  const config = ScenarioSerializer.serialize(
    registry,
    orig.id ?? 'test-rt',
    'Round-trip Test',
    100,
    true,
    orig.simStart,
    orig.simEnd,
    orig.initialState,
    orig.params ?? [],
  );

  ServiceRegistry.reset();
  const scenario2 = new BaseScenario({
    context:      ServiceRegistry.getInstance().simulationContext,
    params:       config.params ?? [],
    initialState: config.initialState ?? {},
    simStart:     orig.simStart,
    simEnd:       orig.simEnd,
  });
  scenario2.buildSim();
  ScenarioSerializer.deserialize(config, ServiceRegistry.getInstance());

  return { scenario: scenario2, sim: scenario2.sim };
}

test('RT-1: PERIOD_ADVANCE events serialize with data.cc and data.period', () => {
  const { scenario } = buildScenario();
  const registry = ServiceRegistry.getInstance();
  const config = ScenarioSerializer.serialize(
    registry,
    'test-rt', 'RT Test', 100, true,
    scenario.simStart, scenario.simEnd,
    scenario.initialState, scenario.params ?? [],
  );

  const events = config.events.filter(e => e.type === 'PERIOD_ADVANCE');
  assert.ok(events.length > 0, 'should have PERIOD_ADVANCE events in serialized config');
  for (const e of events) {
    assert.ok(e.data,        `event "${e.name}" is missing data field`);
    assert.ok(e.data.cc,     `event "${e.name}" data is missing cc`);
    assert.ok(e.data.period, `event "${e.name}" data is missing period`);
    assert.ok(typeof e.data.period.startMs === 'number',
      `event "${e.name}" data.period.startMs should be a number, got ${typeof e.data.period.startMs}`);
  }
});

test('RT-2: TAX_SETTLE events serialize with data.cc', () => {
  const { scenario } = buildScenario();
  const registry = ServiceRegistry.getInstance();
  const config = ScenarioSerializer.serialize(
    registry,
    'test-rt', 'RT Test', 100, true,
    scenario.simStart, scenario.simEnd,
    scenario.initialState, scenario.params ?? [],
  );

  const events = config.events.filter(e => e.type === 'TAX_SETTLE');
  assert.ok(events.length > 0, 'should have TAX_SETTLE events in serialized config');
  for (const e of events) {
    assert.ok(e.data,    `event "${e.name}" is missing data field`);
    assert.ok(e.data.cc, `event "${e.name}" data is missing cc`);
    assert.ok(e.data.cc === 'US' || e.data.cc === 'AU',
      `event "${e.name}" data.cc should be "US" or "AU", got "${e.data.cc}"`);
  }
});

test('RT-3: round-trip simulation matches original US savings balance at end of 2026', () => {
  const endOf2026 = new Date(Date.UTC(2026, 11, 31));

  // Run original scenario to end of 2026
  const { sim: sim1 } = buildScenario();
  stepWithGuard(sim1, endOf2026);
  const origBalance = sim1.state.usSavingsAccount.balance;

  // Run round-tripped scenario (serialize → BaseScenario + deserialize) to same date
  const { sim: sim2 } = buildRoundTripped();
  stepWithGuard(sim2, endOf2026);
  const rtBalance = sim2.state.usSavingsAccount.balance;

  assert.ok(origBalance > 0,
    `original US savings should be positive at end of 2026, got ${origBalance}`);
  assert.ok(
    Math.abs(origBalance - rtBalance) < 1.0,
    `round-trip US savings should match original (within $1); orig=${origBalance.toFixed(2)}, rt=${rtBalance.toFixed(2)}`
  );
});

test('RT-4: round-trip simulation advances currentPeriods.US to 2027 after Jan 1 2027', () => {
  const jan2027 = new Date(Date.UTC(2027, 0, 2));
  const { sim } = buildRoundTripped();
  stepWithGuard(sim, jan2027);

  const period = sim.state.currentPeriods?.US;
  assert.ok(period, 'currentPeriods.US should exist after round-trip');
  const startYear = new Date(period.startMs).getUTCFullYear();
  assert.strictEqual(startYear, 2027,
    `round-trip: US period should advance to 2027 after Jan 1 PERIOD_ADVANCE, got ${startYear}`);
});

test('RT-5: round-trip simulation resets usOrdinaryIncomeYTD after Dec 31 2026 settlement', () => {
  const { sim } = buildRoundTripped();
  sim.stepTo(new Date(Date.UTC(2026, 11, 31)));
  assert.ok(sim.state.usOrdinaryIncomeYTD >= 0,
    'usOrdinaryIncomeYTD should be non-negative after round-trip US tax settlement');
  assert.ok(sim.state.usOrdinaryIncomeYTD < 100,
    `round-trip: usOrdinaryIncomeYTD should be a single month's interest after settlement, got ${sim.state.usOrdinaryIncomeYTD}`);
});

// ═════════════════════════════════════════════════════════════════════════════
// Real Property and Collectible assets
// Regression coverage: assets must exist in initial state with correct values,
// stateKey stamps, service registration, handler/reducer wiring, and
// serialize → deserialize round-trip.
// ═════════════════════════════════════════════════════════════════════════════

test('ASSET-1: usHouseProperty exists in initial state with correct value and country', () => {
  const { sim } = buildScenario();
  const prop = sim.state.usHouseProperty;
  assert.ok(prop, 'usHouseProperty should exist in state');
  assert.strictEqual(prop.value, 1_000_000, 'usHouseProperty initial value should be $1M');
  assert.strictEqual(prop.country, 'US');
  assert.strictEqual(prop.isPrimaryResidence, true);
  assert.strictEqual(prop.costBasis, 800_000);
});

test('ASSET-2: auHouseProperty exists in initial state with correct value and country', () => {
  const { sim } = buildScenario();
  const prop = sim.state.auHouseProperty;
  assert.ok(prop, 'auHouseProperty should exist in state');
  assert.strictEqual(prop.value, 1_000_000, 'auHouseProperty initial value should be $1M AUD');
  assert.strictEqual(prop.country, 'AU');
  assert.strictEqual(prop.isPrimaryResidence, true);
  assert.strictEqual(prop.costBasis, 900_000);
});

test('ASSET-3: collectibleAccount exists in initial state with correct value and country', () => {
  const { sim } = buildScenario();
  const col = sim.state.collectibleAccount;
  assert.ok(col, 'collectibleAccount should exist in state');
  assert.strictEqual(col.value, 100_000, 'collectibleAccount initial value should be $100K');
  assert.strictEqual(col.country, 'US');
  assert.strictEqual(col.costBasis, 60_000);
});

test('ASSET-4: assets have correct stateKey stamps', () => {
  const { sim } = buildScenario();
  assert.strictEqual(sim.state.usHouseProperty.stateKey,   'usHouseProperty');
  assert.strictEqual(sim.state.auHouseProperty.stateKey,   'auHouseProperty');
  assert.strictEqual(sim.state.collectibleAccount.stateKey, 'collectibleAccount');
});

test('ASSET-5: realPropertyService contains exactly 2 properties after loadDefaults()', () => {
  buildScenario();
  const props = ServiceRegistry.getInstance().realPropertyService.getAll();
  assert.strictEqual(props.length, 2, `expected 2 real properties, got ${props.length}`);
});

test('ASSET-6: collectibleService contains exactly 1 collectible after loadDefaults()', () => {
  buildScenario();
  const cols = ServiceRegistry.getInstance().collectibleService.getAll();
  assert.strictEqual(cols.length, 1, `expected 1 collectible, got ${cols.length}`);
});

test('ASSET-7: realPropertyService contains both US and AU house after loadDefaults()', () => {
  buildScenario();
  const props = ServiceRegistry.getInstance().realPropertyService.getAll();
  const countries = props.map(p => p.country).sort();
  assert.deepStrictEqual(countries, ['AU', 'US']);
});

test('ASSET-8: CollectibleSaleHandler is registered after loadDefaults()', () => {
  buildScenario();
  const handlers = ServiceRegistry.getInstance().handlerService.getAll();
  const types = handlers.map(h => h.handlerClass);
  assert.ok(types.includes('CollectibleSaleHandler'),
    `CollectibleSaleHandler missing; handlers: ${types.join(', ')}`);
});

test('ASSET-8: CollectibleSaleApplyReducer is registered after loadDefaults()', () => {
  buildScenario();
  const reducers = ServiceRegistry.getInstance().reducerService.getAll();
  const types = reducers.map(r => r.reducerType);
  assert.ok(types.includes('CollectibleSaleApplyReducer'),
    `CollectibleSaleApplyReducer missing; reducers: ${types.join(', ')}`);
});

test('ASSET-9: serialize includes realProperties array with US and AU house entries', () => {
  const { scenario } = buildScenario();
  const services = ServiceRegistry.getInstance();

  const config = ScenarioSerializer.serialize(
    services, 'test-assets', 'Asset Test', 1, true,
    new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2041, 0, 1)),
    scenario.sim.state, []
  );

  assert.ok(Array.isArray(config.realProperties), 'realProperties should be an array');
  assert.strictEqual(config.realProperties.length, 2, 'should have 2 real properties');

  const usHouse = config.realProperties.find(p => p.country === 'US');
  assert.ok(usHouse, 'US house missing from serialized realProperties');
  assert.strictEqual(usHouse.value, 1_000_000);
  assert.strictEqual(usHouse.stateKey, 'usHouseProperty');
  assert.strictEqual(usHouse.isPrimaryResidence, true);

  const auHouse = config.realProperties.find(p => p.country === 'AU');
  assert.ok(auHouse, 'AU house missing from serialized realProperties');
  assert.strictEqual(auHouse.value, 1_000_000);
  assert.strictEqual(auHouse.stateKey, 'auHouseProperty');
});

test('ASSET-10: serialize includes collectibles array with Gold entry', () => {
  const { scenario } = buildScenario();
  const services = ServiceRegistry.getInstance();

  const config = ScenarioSerializer.serialize(
    services, 'test-assets', 'Asset Test', 1, true,
    new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2041, 0, 1)),
    scenario.sim.state, []
  );

  assert.ok(Array.isArray(config.collectibles), 'collectibles should be an array');
  assert.strictEqual(config.collectibles.length, 1, 'should have 1 collectible');

  const gold = config.collectibles[0];
  assert.strictEqual(gold.name, 'Gold');
  assert.strictEqual(gold.value, 100_000);
  assert.strictEqual(gold.country, 'US');
  assert.strictEqual(gold.stateKey, 'collectibleAccount');
  assert.strictEqual(gold.costBasis, 60_000);
});

test('ASSET-11: realProperties and collectibles survive serialize → deserialize round-trip', () => {
  const { scenario } = buildScenario();
  const services = ServiceRegistry.getInstance();

  const config = ScenarioSerializer.serialize(
    services, 'test-rt', 'RT Test', 1, true,
    new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2041, 0, 1)),
    scenario.sim.state, []
  );

  // Rebuild and deserialize into a fresh registry
  ServiceRegistry.reset();
  const scenario2 = new IntlRetirementScenario({
    eventSchedulerUI: makeStubUI(),
    context: ServiceRegistry.getInstance().simulationContext,
  });
  scenario2.buildSim();

  assert.doesNotThrow(
    () => ScenarioSerializer.deserialize(config, ServiceRegistry.getInstance()),
    'deserialize should not throw with realProperties and collectibles'
  );

  const registry2 = ServiceRegistry.getInstance();
  assert.strictEqual(registry2.realPropertyService.getAll().length, 2,
    'round-trip should restore 2 real properties');
  assert.strictEqual(registry2.collectibleService.getAll().length, 1,
    'round-trip should restore 1 collectible');

  const props = registry2.realPropertyService.getAll();
  const usHouse = props.find(p => p.country === 'US');
  assert.ok(usHouse, 'US house should survive round-trip');
  assert.strictEqual(usHouse.value, 1_000_000);
  assert.strictEqual(usHouse.stateKey, 'usHouseProperty');

  const gold = registry2.collectibleService.getAll()[0];
  assert.strictEqual(gold.name, 'Gold');
  assert.strictEqual(gold.stateKey, 'collectibleAccount');
});
