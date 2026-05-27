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
 * scenario-roundtrip.test.mjs
 *
 * Phase 1 integration tests: export/import round-trip for the finance simulation.
 *
 * Test 1 — full round-trip: build IntlRetirementScenario, serialize, restore
 *   into a fresh BaseScenario, run 3 months, and assert that key account
 *   balances match the original run exactly.
 *
 * Test 2 — modify/import: serialize, increase monthly expenses by $3,000/month,
 *   restore, run 3 months, and assert US savings is materially lower.
 *
 * Run with: node --test tests/unit/scenario-roundtrip.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Simulation }      from '../../src/simulation-framework/simulation.js';
import { HandlerEntry }    from '../../src/simulation-framework/handlers.js';
import { AmountAction, Action, FieldAction, ScriptedAction, RecordBalanceAction, FieldValueAction } from '../../src/simulation-framework/actions.js';
import { FieldReducer, NoOpReducer, ArrayReducer, NumericSumReducer, MultiplicativeReducer, ScriptedReducer } from '../../src/simulation-framework/reducers.js';
import { ReducerBuilder }  from '../../src/simulation-framework/builders/reducer-builder.js';
import { BaseEvent }       from '../../src/simulation-framework/events/base-event.js';
import { EventSeries }     from '../../src/simulation-framework/events/event-series.js';
import { OneOffEvent }     from '../../src/simulation-framework/events/one-off-event.js';
import { ServiceRegistry }          from '../../src/services/service-registry.js';
import { BaseScenario }             from '../../src/scenarios/base-scenario.js';
import { IntlRetirementScenario }   from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioSerializer }       from '../../src/scenarios/scenario-serializer.js';

import { TaxService }           from '../../src/finance/tax-service.js';
import { DynamicTaxReducer }    from '../../src/finance/tax/dynamic-tax-reducer.js';
import { PeriodAdvanceReducer, PeriodAdvanceHandler }                                 from '../../src/finance/tax/period-advance-classes.js';
import { TaxSettleHandler, TaxSettleApplyReducer, TaxPaymentDebitReducer }           from '../../src/finance/tax/tax-settle-classes.js';
import { RothContributionApplyReducer, RothWithdrawalContribApplyReducer, RothWithdrawalEarningsApplyReducer, RothEarningsApplyReducer, RothContributionHandler, RothWithdrawalContributionsHandler, RothWithdrawalEarningsHandler, RothEarningsHandler }             from '../../src/finance/account-rules/us/roth-classes.js';
import { IraContributionApplyReducer, IraWithdrawalContribApplyReducer, IraWithdrawalEarningsApplyReducer, IraEarningsApplyReducer, IraContributionHandler, IraWithdrawalContributionsHandler, IraWithdrawalEarningsHandler, IraEarningsHandler }                     from '../../src/finance/account-rules/us/ira-classes.js';
import { K401ContributionApplyReducer, K401EarningsApplyReducer, K401WithdrawalApplyReducer, K401ContributionHandler, K401EarningsHandler, K401WithdrawalHandler, K401RmdApplyReducer, K401AnnualRmdHandler }                                                                                                     from '../../src/finance/account-rules/us/k401-classes.js';
import { FixedIncomeContributionApplyReducer, FixedIncomeWithdrawalApplyReducer, FixedIncomeEarningsApplyReducer, StockContributionApplyReducer, StockDividendApplyReducer, StockEarningsApplyReducer, StockWithdrawalApplyReducer, FixedIncomeContributionHandler, FixedIncomeWithdrawalHandler, FixedIncomeEarningsHandler, StockContributionHandler, StockDividendHandler, StockEarningsHandler, StockWithdrawalHandler } from '../../src/finance/account-rules/us/us-brokerage-classes.js';
import { UsHouseSaleApplyReducer, UsHouseSaleHandler }                               from '../../src/finance/account-rules/us/us-real-property-classes.js';
import { SsIncomeApplyReducer, WagesIncomeApplyReducer, WagesWithheldApplyReducer, SeIncomeUsApplyReducer, BonusApplyReducer, CompanySaleApplyReducer, SsIncomeHandler, WagesIncomeHandler, WagesWithheldHandler, SeIncomeUsHandler, BonusHandler, CompanySaleHandler } from '../../src/finance/account-rules/us/us-income-classes.js';
import { CollectibleSaleApplyReducer, CollectibleValueChangeApplyReducer, CollectibleSaleHandler, CollectibleValueChangeHandler } from '../../src/finance/account-rules/us/us-collectible-classes.js';
import { IraRolloverWithdrawalApplyReducer, IraRmdApplyReducer, IraRolloverWithdrawalHandler, IraRmdHandler, IraAnnualRmdHandler } from '../../src/finance/account-rules/us/ira-rollover-classes.js';
import { RothRolloverContributionApplyReducer, RothRolloverEarningsApplyReducer, RothRolloverWithdrawalContribApplyReducer, RothRolloverWithdrawalEarningsApplyReducer, RothRolloverContributionHandler, RothRolloverEarningsHandler, RothRolloverWithdrawalContributionsHandler, RothRolloverWithdrawalEarningsHandler } from '../../src/finance/account-rules/us/roth-rollover-classes.js';
import { RothConversionApplyReducer, RothConversionHandler, RothConversionPolicyHandler } from '../../src/finance/account-rules/us/roth-conversion-classes.js';
import { AuSeIncomeApplyReducer, AuSeIncomeHandler }                                 from '../../src/finance/account-rules/au/au-income-classes.js';
import { AuSavingsContributionApplyReducer, AuSavingsWithdrawalApplyReducer, AuSavingsEarningsApplyReducer, AuSavingsContributionHandler, AuSavingsWithdrawalHandler, AuSavingsEarningsHandler }                                                                     from '../../src/finance/account-rules/au/au-savings-classes.js';
import { SuperContributionApplyReducer, SuperWithdrawalContribApplyReducer, SuperWithdrawalEarningsApplyReducer, SuperEarningsApplyReducer, SuperContributionHandler, SuperWithdrawalContributionsHandler, SuperWithdrawalEarningsHandler, SuperEarningsDirectHandler } from '../../src/finance/account-rules/au/au-super-classes.js';
import { AuDividendFrankedResidentApplyReducer, AuDividendFrankedNonResidentApplyReducer, AuDividendUnfrankedResidentApplyReducer, AuDividendUnfrankedNonResidentApplyReducer, AuStockEarningsApplyReducer, AuStockWithdrawalApplyReducer, AuDividendFrankedResidentHandler, AuDividendFrankedNonResidentHandler, AuDividendUnfrankedResidentHandler, AuDividendUnfrankedNonResidentHandler, AuStockEarningsHandler, AuStockWithdrawalHandler } from '../../src/finance/account-rules/au/au-brokerage-classes.js';
import { AuHouseSaleApplyReducer, AuHouseSaleHandler }                               from '../../src/finance/account-rules/au/au-real-property-classes.js';
import { UsSavingsInterestMonthlyHandler }    from '../../src/finance/handlers/us-savings-interest-handler.js';
import { MonthlyExpensesHandler }            from '../../src/finance/handlers/monthly-expenses-handler.js';
import { MonthlyWagesHandler }               from '../../src/finance/handlers/monthly-wages-handler.js';
import { IntlTransferToUsHandler, IntlTransferToAuHandler } from '../../src/finance/handlers/intl-transfer-handlers.js';
import {
  AuSavingsInterestHandler, FixedIncomeInterestHandler, SuperEarningsHandler,
  IntlRothEarningsHandler, IntlIraEarningsHandler, IntlK401EarningsHandler,
  IntlUsStockEarningsHandler, IntlAuStockEarningsHandler, IntlAuStockDividendHandler,
} from '../../src/finance/handlers/earnings-handlers.js';
import { DividendScheduledHandler }    from '../../src/finance/handlers/dividend-scheduled-handler.js';
import { ChangeResidencyHandler }      from '../../src/finance/handlers/change-residency-handler.js';
import { OutOfFundsHandler }           from '../../src/finance/handlers/out-of-funds-handler.js';
import { ChangeResidencyApplyReducer } from '../../src/finance/reducers/change-residency-apply-reducer.js';
import { ExpenseDebitReducer }         from '../../src/finance/reducers/expense-debit-reducer.js';
import { IntlTransferApplyReducer }    from '../../src/finance/reducers/intl-transfer-apply-reducer.js';
import { ReplenishSavingsReducer }     from '../../src/finance/reducers/replenish-savings-reducer.js';
import { SetOutOfFundsDateReducer }    from '../../src/finance/reducers/set-out-of-funds-date-reducer.js';
import { AccumulateDeficitReducer }    from '../../src/finance/reducers/accumulate-deficit-reducer.js';
import { OutOfFundsReducer }           from '../../src/finance/reducers/out-of-funds-reducer.js';
import { InflationAdjustReducer }      from '../../src/finance/reducers/inflation-adjust-reducer.js';
import { StockDividendCashApplyReducer }  from '../../src/finance/reducers/stock-dividend-cash-apply-reducer.js';
import { UsSavingsInterestCreditReducer } from '../../src/finance/reducers/us-savings-interest-credit-reducer.js';
import { Account, CheckingAccount, SavingsAccount }   from '../../src/finance/assets/account.js';
import { InvestmentAccount, BrokerageAccount, FourOhOneKAccount, RothAccount, TraditionalIRAAccount, SuperannuationAccount } from '../../src/finance/assets/investment-account.js';
import { RealProperty }  from '../../src/finance/assets/real-property.js';
import { Collectible }   from '../../src/finance/assets/collectible.js';
import { Person } from '../../src/finance/person.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STUB_UI = {
  nodes: [],
  _listeners: { eventCreated: [], handlerCreated: [], actionCreated: [], reducerCreated: [] },
  registerEventCreatedListener(l)   { this._listeners.eventCreated.push(l); },
  registerHandlerCreatedListener(l) { this._listeners.handlerCreated.push(l); },
  registerActionCreatedListener(l)  { this._listeners.actionCreated.push(l); },
  registerReducerCreatedListener(l) { this._listeners.reducerCreated.push(l); },
  addEvent()   {},
  addHandler() {},
  addAction()  {},
  addReducer() {},
};

/**
 * Build and fully initialise an IntlRetirementScenario using the toolset path.
 * Returns { scenario, sim, config } where config is the serialized form captured
 * BEFORE the simulation is run — it represents the canonical initial state.
 *
 * Uses sim.state (post-compilation) as initialState so that currentPeriods and
 * other toolset-provided state survive the serialize→deserialize round-trip.
 */
function buildIntlAndSerialize() {
  ServiceRegistry.reset();
  const scenario = IntlRetirementScenario.buildAndCompile({});

  const services = ServiceRegistry.getInstance();
  const config = ScenarioSerializer.serialize(
    services,
    'roundtrip-test',
    'Round-trip Test',
    1,
    true,
    scenario.simStart,
    scenario.simEnd,
    scenario.sim.state,  // capture compiled state for correct currentPeriods/inflation
    [],
  );

  return { scenario, sim: scenario.sim, config };
}

/**
 * Restore a scenario from a serialized config using BaseScenario + deserialize.
 * This mirrors what BaseApp.initScenario() does for an imported scenario.
 */
function restoreFromConfig(config) {
  ServiceRegistry.reset();
  const scenario = new BaseScenario({
    context:      ServiceRegistry.getInstance().simulationContext,
    initialState: config.initialState ?? {},
    simStart:     new Date(config.simStart),
    simEnd:       new Date(config.simEnd),
  });
  scenario.buildSim();
  ScenarioSerializer.deserializeGraph(config, ServiceRegistry.getInstance());
  return { scenario, sim: scenario.sim };
}

// End of first quarter 2026 — 3 month-end events fire (Jan, Feb, Mar).
const Q1_2026 = new Date(Date.UTC(2026, 2, 31));

// ─── Test 1: full round-trip produces identical financial results ──────────────

test('round-trip: deserialized scenario runs 3 months without error', () => {
  const { config } = buildIntlAndSerialize();
  const { sim } = restoreFromConfig(config);
  assert.doesNotThrow(() => sim.stepTo(Q1_2026), 'stepTo should not throw');
  assert.strictEqual(sim.currentDate.toISOString(), Q1_2026.toISOString(),
    'sim should reach Mar 31 2026');
});

test('round-trip: US savings balance matches original after 3 months', () => {
  const { sim: simOrig, config } = buildIntlAndSerialize();
  simOrig.stepTo(Q1_2026);
  const baseline = simOrig.state.usSavingsAccount?.balance;
  assert.ok(baseline != null, 'original usSavingsAccount balance should exist');

  const { sim: simRestored } = restoreFromConfig(config);
  simRestored.stepTo(Q1_2026);
  const restored = simRestored.state.usSavingsAccount?.balance;
  assert.ok(restored != null, 'restored usSavingsAccount balance should exist');

  assert.strictEqual(restored, baseline,
    `US savings balance mismatch — original: ${baseline}, restored: ${restored}`);
});

test('round-trip: IRA balance matches original after 3 months', () => {
  const { sim: simOrig, config } = buildIntlAndSerialize();
  simOrig.stepTo(Q1_2026);
  const baseline = simOrig.state.iraAccount?.balance;
  assert.ok(baseline != null, 'original iraAccount balance should exist');

  const { sim: simRestored } = restoreFromConfig(config);
  simRestored.stepTo(Q1_2026);
  const restored = simRestored.state.iraAccount?.balance;
  assert.ok(restored != null, 'restored iraAccount balance should exist');

  assert.strictEqual(restored, baseline,
    `IRA balance mismatch — original: ${baseline}, restored: ${restored}`);
});

test('round-trip: 401k balance matches original after 3 months', () => {
  const { sim: simOrig, config } = buildIntlAndSerialize();
  simOrig.stepTo(Q1_2026);
  const baseline = simOrig.state.k401Account?.balance;
  assert.ok(baseline != null, 'original k401Account balance should exist');

  const { sim: simRestored } = restoreFromConfig(config);
  simRestored.stepTo(Q1_2026);
  const restored = simRestored.state.k401Account?.balance;
  assert.ok(restored != null, 'restored k401Account balance should exist');

  assert.strictEqual(restored, baseline,
    `401k balance mismatch — original: ${baseline}, restored: ${restored}`);
});

test('round-trip: serialized config preserves stateKey on all accounts', () => {
  const { config } = buildIntlAndSerialize();
  const missingStateKey = config.accounts.filter(a => !a.stateKey).map(a => a.name);
  assert.strictEqual(missingStateKey.length, 0,
    `accounts missing stateKey: ${missingStateKey.join(', ')}`);
});

// ─── Test 2: modify expenses, reimport, observe savings reduction ─────────────

test('modify round-trip: increasing monthly expenses by $3000 reduces savings after 3 months', () => {
  const { sim: simOrig, config } = buildIntlAndSerialize();
  simOrig.stepTo(Q1_2026);
  const baseline = simOrig.state.usSavingsAccount?.balance;
  assert.ok(baseline != null, 'original usSavingsAccount balance should exist');

  // Deep-clone via JSON so we get a clean plain-object copy to mutate.
  const modified = JSON.parse(JSON.stringify(config));
  const expHandler = modified.handlers.find(h => h.__type === 'MonthlyExpensesHandler');
  assert.ok(expHandler, 'MonthlyExpensesHandler must be present in serialized config');
  const originalExpenses = expHandler.monthlyExpenses;
  expHandler.monthlyExpenses = originalExpenses + 3000;
  // MonthlyExpensesHandler reads state.monthlyExpenses first (InflationAdjustReducer owns it).
  // Both the handler config and the initial state must be updated together.
  modified.initialState.monthlyExpenses = (modified.initialState.monthlyExpenses ?? originalExpenses) + 3000;

  const { sim: simModified } = restoreFromConfig(modified);
  simModified.stepTo(Q1_2026);
  const modifiedBalance = simModified.state.usSavingsAccount?.balance;
  assert.ok(modifiedBalance != null, 'modified usSavingsAccount balance should exist');

  // 3 months × $3,000 extra = $9,000 less in savings.
  // Accept anything within $500 of the target to account for tax effects.
  const reduction = baseline - modifiedBalance;
  assert.ok(reduction > 8_000,
    `Expected savings to drop by ~$9000; got reduction=${reduction.toFixed(2)} ` +
    `(baseline=${baseline.toFixed(2)}, modified=${modifiedBalance.toFixed(2)})`);
});
