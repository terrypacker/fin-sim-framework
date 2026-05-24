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
import { AuSeIncomeApplyReducer, AuSeIncomeHandler }                                 from '../../src/finance/account-rules/au/au-income-classes.js';
import { AuSavingsContributionApplyReducer, AuSavingsWithdrawalApplyReducer, AuSavingsEarningsApplyReducer, AuSavingsContributionHandler, AuSavingsWithdrawalHandler, AuSavingsEarningsHandler }                                                                     from '../../src/finance/account-rules/au/au-savings-classes.js';
import { SuperContributionApplyReducer, SuperWithdrawalContribApplyReducer, SuperWithdrawalEarningsApplyReducer, SuperEarningsApplyReducer, SuperContributionHandler, SuperWithdrawalContributionsHandler, SuperWithdrawalEarningsHandler, SuperEarningsDirectHandler } from '../../src/finance/account-rules/au/au-super-classes.js';
import { AuDividendFrankedResidentApplyReducer, AuDividendFrankedNonResidentApplyReducer, AuDividendUnfrankedResidentApplyReducer, AuDividendUnfrankedNonResidentApplyReducer, AuStockEarningsApplyReducer, AuStockWithdrawalApplyReducer, AuDividendFrankedResidentHandler, AuDividendFrankedNonResidentHandler, AuDividendUnfrankedResidentHandler, AuDividendUnfrankedNonResidentHandler, AuStockEarningsHandler, AuStockWithdrawalHandler } from '../../src/finance/account-rules/au/au-brokerage-classes.js';
import { AuHouseSaleApplyReducer, AuHouseSaleHandler }                               from '../../src/finance/account-rules/au/au-real-property-classes.js';
import { UsSavingsInterestMonthlyHandler }                                           from '../../src/finance/handlers/us-savings-interest-handler.js';
import { MonthlyExpensesHandler }                                                    from '../../src/finance/handlers/monthly-expenses-handler.js';
import { MonthlyWagesHandler }                                                       from '../../src/finance/handlers/monthly-wages-handler.js';
import { IntlTransferToUsHandler, IntlTransferToAuHandler }                          from '../../src/finance/handlers/intl-transfer-handlers.js';
import { AuSavingsInterestHandler, FixedIncomeInterestHandler, SuperEarningsHandler } from '../../src/finance/handlers/earnings-handlers.js';
import { DividendScheduledHandler }                                                  from '../../src/finance/handlers/dividend-scheduled-handler.js';
import { ChangeResidencyHandler }                                                    from '../../src/finance/handlers/change-residency-handler.js';
import { OutOfFundsHandler }                                                         from '../../src/finance/handlers/out-of-funds-handler.js';
import { ChangeResidencyApplyReducer }                                               from '../../src/finance/reducers/change-residency-apply-reducer.js';
import { ExpenseDebitReducer }                                                       from '../../src/finance/reducers/expense-debit-reducer.js';
import { IntlTransferApplyReducer }                                                  from '../../src/finance/reducers/intl-transfer-apply-reducer.js';
import { ReplenishSavingsReducer }                                                   from '../../src/finance/reducers/replenish-savings-reducer.js';
import { SetOutOfFundsDateReducer }                                                  from '../../src/finance/reducers/set-out-of-funds-date-reducer.js';
import { InflationAdjustReducer }                                                    from '../../src/finance/reducers/inflation-adjust-reducer.js';
import { StockDividendCashApplyReducer }                                             from '../../src/finance/reducers/stock-dividend-cash-apply-reducer.js';
import { UsSavingsInterestCreditReducer }                                            from '../../src/finance/reducers/us-savings-interest-credit-reducer.js';
import { Account, CheckingAccount, SavingsAccount }                                  from '../../src/finance/assets/account.js';
import { InvestmentAccount, BrokerageAccount, FourOhOneKAccount, RothAccount, TraditionalIRAAccount, SuperannuationAccount } from '../../src/finance/assets/investment-account.js';
import { Person }                                                                    from '../../src/finance/person.js';
import {
  SIMULATION_BUS_MESSAGES
} from "../../src/simulation-framework/bus-messages.js";

// ─── Provide the FinSimLib global that BaseScenario.buildSim() needs ──────────

globalThis.FinSimLib = {
  Core: {
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
    ChangeResidencyApplyReducer, ExpenseDebitReducer, IntlTransferApplyReducer,
    ReplenishSavingsReducer, SetOutOfFundsDateReducer, InflationAdjustReducer,
    StockDividendCashApplyReducer, UsSavingsInterestCreditReducer,
    // Account types
    Account, CheckingAccount, SavingsAccount,
    InvestmentAccount, BrokerageAccount, FourOhOneKAccount,
    RothAccount, TraditionalIRAAccount, SuperannuationAccount,
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

test('DIVIDEND_SCHEDULED: state.metrics.stockAccount is set after year-end dividend', () => {
  // dividendsEvent has startOffset(1), so first DIVIDEND_SCHEDULED fires Dec 31 2027
  const { sim } = buildScenario();
  sim.stepTo(new Date(Date.UTC(2027, 11, 31)));

  assert.ok(
    sim.state.metrics?.stockAccount != null,
    `state.metrics.stockAccount should be set after DIVIDEND_SCHEDULED; got ${JSON.stringify(sim.state.metrics)}`
  );
  assert.ok(
    typeof sim.state.metrics.stockAccount === 'number' && sim.state.metrics.stockAccount > 0,
    `state.metrics.stockAccount should be a positive number, got ${sim.state.metrics.stockAccount}`
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
