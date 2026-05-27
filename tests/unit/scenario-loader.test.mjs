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
 * scenario-loader.test.mjs
 *
 * Tests for ScenarioLoader — the single dispatch point that restores a
 * scenario configuration into the services. Verifies the two branches:
 *
 *   - Compile branch: cfg has `toolsets: [...]` but no graph snapshot →
 *     toolset compilation populates eventService / handlerService / reducerService.
 *   - Deserialize branch: cfg has events/handlers/actions/reducers populated
 *     (from a prior save) → graph is restored verbatim without recompilation.
 *   - Round-trip: compile → snapshot graph from services → reload from snapshot →
 *     simulation state matches across both runs.
 *
 * Run with: node --test tests/unit/scenario-loader.test.mjs
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
import { ServiceRegistry } from '../../src/services/service-registry.js';
import { BaseScenario }    from '../../src/scenarios/base-scenario.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioSerializer }     from '../../src/scenarios/scenario-serializer.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';

import { TaxService }           from '../../src/finance/tax-service.js';
import { DynamicTaxReducer }    from '../../src/finance/tax/dynamic-tax-reducer.js';
import { PeriodAdvanceReducer, PeriodAdvanceHandler }                       from '../../src/finance/tax/period-advance-classes.js';
import { TaxSettleHandler, TaxSettleApplyReducer, TaxPaymentDebitReducer } from '../../src/finance/tax/tax-settle-classes.js';
import { RothContributionApplyReducer, RothWithdrawalContribApplyReducer, RothWithdrawalEarningsApplyReducer, RothEarningsApplyReducer, RothContributionHandler, RothWithdrawalContributionsHandler, RothWithdrawalEarningsHandler, RothEarningsHandler }             from '../../src/finance/account-rules/us/roth-classes.js';
import { IraContributionApplyReducer, IraWithdrawalContribApplyReducer, IraWithdrawalEarningsApplyReducer, IraEarningsApplyReducer, IraContributionHandler, IraWithdrawalContributionsHandler, IraWithdrawalEarningsHandler, IraEarningsHandler }                     from '../../src/finance/account-rules/us/ira-classes.js';
import { K401ContributionApplyReducer, K401EarningsApplyReducer, K401WithdrawalApplyReducer, K401ContributionHandler, K401EarningsHandler, K401WithdrawalHandler, K401RmdApplyReducer, K401AnnualRmdHandler }                                                                                                     from '../../src/finance/account-rules/us/k401-classes.js';
import { FixedIncomeContributionApplyReducer, FixedIncomeWithdrawalApplyReducer, FixedIncomeEarningsApplyReducer, StockContributionApplyReducer, StockDividendApplyReducer, StockEarningsApplyReducer, StockWithdrawalApplyReducer, FixedIncomeContributionHandler, FixedIncomeWithdrawalHandler, FixedIncomeEarningsHandler, StockContributionHandler, StockDividendHandler, StockEarningsHandler, StockWithdrawalHandler } from '../../src/finance/account-rules/us/us-brokerage-classes.js';
import { UsHouseSaleApplyReducer, UsHouseSaleHandler }                       from '../../src/finance/account-rules/us/us-real-property-classes.js';
import { SsIncomeApplyReducer, WagesIncomeApplyReducer, WagesWithheldApplyReducer, SeIncomeUsApplyReducer, BonusApplyReducer, CompanySaleApplyReducer, SsIncomeHandler, WagesIncomeHandler, WagesWithheldHandler, SeIncomeUsHandler, BonusHandler, CompanySaleHandler } from '../../src/finance/account-rules/us/us-income-classes.js';
import { CollectibleSaleApplyReducer, CollectibleValueChangeApplyReducer, CollectibleSaleHandler, CollectibleValueChangeHandler } from '../../src/finance/account-rules/us/us-collectible-classes.js';
import { IraRolloverWithdrawalApplyReducer, IraRmdApplyReducer, IraRolloverWithdrawalHandler, IraRmdHandler, IraAnnualRmdHandler } from '../../src/finance/account-rules/us/ira-rollover-classes.js';
import { RothRolloverContributionApplyReducer, RothRolloverEarningsApplyReducer, RothRolloverWithdrawalContribApplyReducer, RothRolloverWithdrawalEarningsApplyReducer, RothRolloverContributionHandler, RothRolloverEarningsHandler, RothRolloverWithdrawalContributionsHandler, RothRolloverWithdrawalEarningsHandler } from '../../src/finance/account-rules/us/roth-rollover-classes.js';
import { RothConversionApplyReducer, RothConversionHandler, RothConversionPolicyHandler } from '../../src/finance/account-rules/us/roth-conversion-classes.js';
import { AuSeIncomeApplyReducer, AuSeIncomeHandler }                         from '../../src/finance/account-rules/au/au-income-classes.js';
import { AuSavingsContributionApplyReducer, AuSavingsWithdrawalApplyReducer, AuSavingsEarningsApplyReducer, AuSavingsContributionHandler, AuSavingsWithdrawalHandler, AuSavingsEarningsHandler }                                                                     from '../../src/finance/account-rules/au/au-savings-classes.js';
import { SuperContributionApplyReducer, SuperWithdrawalContribApplyReducer, SuperWithdrawalEarningsApplyReducer, SuperEarningsApplyReducer, SuperContributionHandler, SuperWithdrawalContributionsHandler, SuperWithdrawalEarningsHandler, SuperEarningsDirectHandler } from '../../src/finance/account-rules/au/au-super-classes.js';
import { AuDividendFrankedResidentApplyReducer, AuDividendFrankedNonResidentApplyReducer, AuDividendUnfrankedResidentApplyReducer, AuDividendUnfrankedNonResidentApplyReducer, AuStockEarningsApplyReducer, AuStockWithdrawalApplyReducer, AuDividendFrankedResidentHandler, AuDividendFrankedNonResidentHandler, AuDividendUnfrankedResidentHandler, AuDividendUnfrankedNonResidentHandler, AuStockEarningsHandler, AuStockWithdrawalHandler } from '../../src/finance/account-rules/au/au-brokerage-classes.js';
import { AuHouseSaleApplyReducer, AuHouseSaleHandler }                       from '../../src/finance/account-rules/au/au-real-property-classes.js';
import { UsSavingsInterestMonthlyHandler }   from '../../src/finance/handlers/us-savings-interest-handler.js';
import { MonthlyExpensesHandler }           from '../../src/finance/handlers/monthly-expenses-handler.js';
import { MonthlyWagesHandler }              from '../../src/finance/handlers/monthly-wages-handler.js';
import { MonthlySocialSecurityHandler }     from '../../src/finance/handlers/monthly-social-security-handler.js';
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

const Q1_2026 = new Date(Date.UTC(2026, 2, 31));

/**
 * Build a fresh IntlRetirementScenario, run its Simulation, and produce a
 * declarative config (toolsets + persons + accounts + parameters) — the kind
 * of cfg ScenarioLoader.load() sees for a fresh prebuilt that has never been
 * saved with a graph snapshot.
 */
function freshDeclarativeConfig() {
  const cfg = IntlRetirementScenario.buildDefaultConfig({}, undefined, undefined);
  cfg.initialState = {};
  cfg.params = [];
  return cfg;
}

/**
 * Build a scenario into the services from a declarative cfg via ScenarioLoader,
 * returning the ServiceRegistry and Simulation.
 */
function loadIntoFreshServices(cfg) {
  ServiceRegistry.reset();
  const services = ServiceRegistry.getInstance();

  const scenario = new BaseScenario({
    context:      services.simulationContext,
    initialState: cfg.initialState ?? {},
    simStart:     new Date(cfg.simStart),
    simEnd:       new Date(cfg.simEnd),
  });
  scenario.buildSim();

  new ScenarioLoader().load(cfg, services);
  return { services, scenario, sim: scenario.sim };
}

// ─── hasSerializedGraph ───────────────────────────────────────────────────────

test('hasSerializedGraph: returns false for declarative cfg with toolsets only', () => {
  const cfg = freshDeclarativeConfig();
  assert.strictEqual(ScenarioSerializer.hasSerializedGraph(cfg), false);
});

test('hasSerializedGraph: returns true when events array is populated', () => {
  assert.strictEqual(ScenarioSerializer.hasSerializedGraph({ events: [{ id: 'e1' }] }), true);
});

test('hasSerializedGraph: returns true when handlers array is populated', () => {
  assert.strictEqual(ScenarioSerializer.hasSerializedGraph({ handlers: [{ id: 'h1' }] }), true);
});

test('hasSerializedGraph: returns false for null or empty config', () => {
  assert.strictEqual(ScenarioSerializer.hasSerializedGraph(null), false);
  assert.strictEqual(ScenarioSerializer.hasSerializedGraph({}), false);
  assert.strictEqual(ScenarioSerializer.hasSerializedGraph({ events: [], handlers: [] }), false);
});

// ─── Compile branch: cfg has toolsets, no graph ───────────────────────────────

test('compile branch: loads declarative IntlRetirement cfg into services', () => {
  const cfg = freshDeclarativeConfig();
  const { services } = loadIntoFreshServices(cfg);

  // Persons / accounts loaded
  assert.ok(services.personService.getAll().length > 0, 'persons should be registered');
  assert.ok(services.accountService.getAll().length > 0, 'accounts should be registered');

  // Compiler produced events / handlers / reducers
  assert.ok(services.eventService.getAll().length > 0, 'events should be registered');
  assert.ok(services.handlerService.getAll().length > 0, 'handlers should be registered');
  assert.ok(services.reducerService.getAll().length > 0, 'reducers should be registered');
});

test('compile branch: produced simulation can run 3 months without error', () => {
  const cfg = freshDeclarativeConfig();
  const { sim } = loadIntoFreshServices(cfg);
  assert.doesNotThrow(() => sim.stepTo(Q1_2026));
  assert.strictEqual(sim.currentDate.toISOString(), Q1_2026.toISOString());
});

test('compile branch: usSavingsAccount state is populated', () => {
  const cfg = freshDeclarativeConfig();
  const { sim } = loadIntoFreshServices(cfg);
  assert.ok(sim.state.usSavingsAccount != null);
  assert.strictEqual(typeof sim.state.usSavingsAccount.balance, 'number');
});

// ─── Deserialize branch: cfg has a saved graph snapshot ───────────────────────

test('deserialize branch: loads saved graph without invoking compiler', () => {
  // 1) Build via compile, then capture full snapshot from services.
  const cfg = freshDeclarativeConfig();
  const { services: origServices } = loadIntoFreshServices(cfg);

  const snapshot = ScenarioSerializer.serialize(
    origServices,
    'snap', 'Snap', 1, true,
    new Date(cfg.simStart), new Date(cfg.simEnd),
    origServices.simulationRegistry.getPrimary().state,
    [],
  );

  assert.ok(ScenarioSerializer.hasSerializedGraph(snapshot),
    'snapshot must carry a serialized graph');

  // 2) Reload from the snapshot via ScenarioLoader — should take the deserialize branch.
  const { services: restored } = loadIntoFreshServices(snapshot);

  assert.strictEqual(restored.eventService.getAll().length, origServices.eventService.getAll().length,
    'event count should match snapshot');
  assert.strictEqual(restored.handlerService.getAll().length, origServices.handlerService.getAll().length,
    'handler count should match snapshot');
  assert.strictEqual(restored.reducerService.getAll().length, origServices.reducerService.getAll().length,
    'reducer count should match snapshot');
});

// ─── Empty cfg: no toolsets, no graph ─────────────────────────────────────────

test('empty cfg: loader is a no-op when cfg has no toolsets and no graph', () => {
  const cfg = {
    simStart: '2026-01-01', simEnd: '2041-01-01',
    persons: [], accounts: [], realProperties: [], collectibles: [],
    toolsets: [],
  };
  const { services } = loadIntoFreshServices(cfg);
  assert.strictEqual(services.eventService.getAll().length,   0);
  assert.strictEqual(services.handlerService.getAll().length, 0);
  assert.strictEqual(services.actionService.getAll().length,  0);
  assert.strictEqual(services.reducerService.getAll().length, 0);
});

// ─── Round-trip: compile → snapshot → reload preserves financial state ────────

test('round-trip via ScenarioLoader: US savings balance matches after 3 months', () => {
  const cfg = freshDeclarativeConfig();

  // First run via compile branch
  const { services: svc1, sim: sim1 } = loadIntoFreshServices(cfg);
  sim1.stepTo(Q1_2026);
  const baseline = sim1.state.usSavingsAccount?.balance;
  assert.ok(baseline != null);

  // Snapshot the compiled scenario
  const snapshot = ScenarioSerializer.serialize(
    svc1,
    'snap', 'Snap', 1, true,
    new Date(cfg.simStart), new Date(cfg.simEnd),
    cfg.initialState ?? {},   // use the pre-run initial state for the round-trip
    [],
  );
  // Capture the post-compile / pre-run state so the reload starts from the
  // same point (currentPeriods, inflationAccumulator, etc.).
  ServiceRegistry.reset();
  const services2 = ServiceRegistry.getInstance();
  const tmpScenario = new BaseScenario({
    context: services2.simulationContext,
    initialState: {},
    simStart: new Date(cfg.simStart),
    simEnd:   new Date(cfg.simEnd),
  });
  tmpScenario.buildSim();
  new ScenarioLoader().load(cfg, services2);
  const compiledState = { ...services2.simulationRegistry.getPrimary().state };
  snapshot.initialState = compiledState;

  // Reload from the snapshot (deserialize branch) and re-run
  const { sim: sim2 } = loadIntoFreshServices(snapshot);
  sim2.stepTo(Q1_2026);
  const restored = sim2.state.usSavingsAccount?.balance;

  assert.strictEqual(restored, baseline,
    `US savings mismatch after round-trip — baseline: ${baseline}, restored: ${restored}`);
});

// ─── Regression: copy an IntlRetirement prebuilt and save it ──────────────────
//
// Mirrors the UI flow:
//   1. Open IntlRetirement (prebuilt) — initScenario merges buildDefaultConfig
//      and ScenarioLoader compiles the toolsets, populating services.
//   2. Click "New Scenario" — creates a user scenario whose graph fields are
//      empty arrays.
//   3. Click "Save" — onSave snapshots the live services into _activeScenario.
//   4. ScenarioStorage persists the user scenario via serializeScenario, which
//      iterates _activeScenario.{persons,accounts,events,handlers,actions,reducers}
//      and runs each item through the matching _serialize* helper.
//
// This previously threw "Unsupported action type [object Object]" because the
// onSave step pre-serialized actions into plain {__type,…} objects, and then
// serializeScenario called _serializeAction on them again — and that helper
// (alone among the _serialize* methods) is not idempotent: instanceof checks
// against the live Action classes failed on the already-serialized plain
// objects.

test('regression: copying IntlRetirement and saving (onSave + serializeScenario) does not throw', () => {
  // Step 1 — compile IntlRetirement into services
  const cfg = freshDeclarativeConfig();
  const { services } = loadIntoFreshServices(cfg);

  // Step 2 — emulate "New Scenario" produced by ScenarioService.newScenario():
  // a user scenario object with empty graph arrays.
  const userScenario = {
    id:           'u:0',
    name:         'New Scenario',
    order:        100,
    prebuilt:     false,
    scenarioId:   'p:intl-retirement',
    simStart:     new Date(cfg.simStart),
    simEnd:       new Date(cfg.simEnd),
    persons:        [],
    accounts:       [],
    realProperties: [],
    collectibles:   [],
    events:         [],
    handlers:       [],
    actions:        [],
    reducers:       [],
    initialState: {},
    params:       [],
    toolsets:     cfg.toolsets,
  };

  // Step 3 — onSave: snapshot live services into the user scenario
  // (matches ScenarioTabPresenter.onSave exactly).
  userScenario.persons        = services.personService.getAll().map(p => ScenarioSerializer._serializePerson(p));
  userScenario.accounts       = services.accountService.getAll().map(a => ScenarioSerializer._serializeAccount(a));
  userScenario.realProperties = services.realPropertyService.getAll().map(p => ScenarioSerializer._serializeRealProperty(p));
  userScenario.collectibles   = services.collectibleService.getAll().map(c => ScenarioSerializer._serializeCollectible(c));
  userScenario.events   = services.eventService.getAll().map(n => ScenarioSerializer._serializeEvent(n));
  userScenario.handlers = services.handlerService.getAll().map(n => ScenarioSerializer._serializeHandler(n));
  userScenario.actions  = services.actionService.getAll().map(n => ScenarioSerializer._serializeAction(n));
  userScenario.reducers = services.reducerService.getAll().map(n => ScenarioSerializer._serializeReducer(n));

  // Step 4 — ScenarioStorage.save round: serializeScenario must not throw on
  // arrays that already hold serialized {__type,…} plain objects.
  let serialized;
  assert.doesNotThrow(
    () => { serialized = ScenarioSerializer.serializeScenario(userScenario); },
    'serializeScenario should not throw on a user scenario whose graph arrays already hold serialized records',
  );

  // Sanity — the resulting JSON should be JSON.stringify-clean.
  assert.doesNotThrow(() => JSON.stringify(serialized),
    'serialized scenario should round-trip through JSON.stringify');

  // The graph survived the round-trip.
  assert.ok(serialized.actions.length  > 0,  'actions should be present in serialized output');
  assert.ok(serialized.handlers.length > 0, 'handlers should be present in serialized output');
  assert.ok(serialized.events.length   > 0,   'events should be present in serialized output');
});

// ─── Regression: _makeAction('Action') used to fall through into 'FieldAction' ─
//
// Previously the 'Action' case in _makeAction's switch was missing both its
// semicolon and a break, so it silently overwrote the freshly built Action
// with a FieldAction whose fieldName was undefined. Deserialized records of
// type 'Action' therefore round-tripped to the wrong concrete class.

test('regression: _makeAction returns an Action (not FieldAction) for __type=Action', () => {
  const action = ScenarioSerializer._makeAction({
    __type: 'Action', id: 'a99', type: 'CUSTOM', name: 'Custom',
  });
  assert.strictEqual(action.constructor.name, 'Action',
    "__type='Action' should deserialize to an Action, not a FieldAction");
  assert.strictEqual(action.id, 'a99');
  assert.strictEqual(action.type, 'CUSTOM');
  assert.strictEqual(action.name, 'Custom');
});

// ─── Regression: copy IntlRetirement, save+JSON round-trip, run sim ───────────
//
// User flow:
//   1. Open IntlRetirement — initScenario merges buildDefaultConfig and the
//      loader compiles the toolsets. ScenarioLoader writes the resulting
//      sim.state back into cfg.initialState so it survives serialization.
//   2. Create New Scenario — empty user scenario derived from the prebuilt.
//   3. Click Save — onSave snapshots services + sim into the user scenario.
//   4. Click Rebuild (or reload) — ScenarioLoader takes the deserialize branch
//      and rehydrates sim.state from cfg.initialState.
//
// Previously the deserialize branch left sim.state empty, so every handler
// looked up state.usSavingsAccount → undefined and silently no-op'd. The
// dashboard showed 920 events but 0 handler/action/reducer executions.

test('regression: copy IntlRetirement, save, reload, and run — handlers fire and state updates', () => {
  // Step 1 — compile (mirrors first initScenario after merging buildDefaultConfig).
  const cfg = freshDeclarativeConfig();
  ServiceRegistry.reset();
  const s1 = ServiceRegistry.getInstance();
  const sc1 = new BaseScenario({
    context:      s1.simulationContext,
    initialState: cfg.initialState ?? {},
    simStart:     new Date(cfg.simStart),
    simEnd:       new Date(cfg.simEnd),
  });
  sc1.buildSim();
  new ScenarioLoader().load(cfg, s1);

  // ScenarioLoader.load must capture sim.state into cfg.initialState during compile.
  assert.ok(cfg.initialState && Object.keys(cfg.initialState).length > 0,
    'compile branch must populate cfg.initialState');
  assert.ok(cfg.initialState.usSavingsAccount,
    'cfg.initialState should carry the usSavingsAccount snapshot');

  // Step 2-3 — emulate onSave (snapshot services + write to a u:0 scenario).
  const userScenario = {
    id: 'u:0', name: 'Copy', order: 100, prebuilt: false,
    scenarioId: 'p:intl-retirement',
    simStart: cfg.simStart, simEnd: cfg.simEnd,
    toolsets: cfg.toolsets, parameters: cfg.parameters,
    persons:        s1.personService.getAll().map(p => ScenarioSerializer._serializePerson(p)),
    accounts:       s1.accountService.getAll().map(a => ScenarioSerializer._serializeAccount(a)),
    realProperties: s1.realPropertyService.getAll().map(p => ScenarioSerializer._serializeRealProperty(p)),
    collectibles:   s1.collectibleService.getAll().map(c => ScenarioSerializer._serializeCollectible(c)),
    events:   s1.eventService.getAll().map(n => ScenarioSerializer._serializeEvent(n)),
    handlers: s1.handlerService.getAll().map(n => ScenarioSerializer._serializeHandler(n)),
    actions:  s1.actionService.getAll().map(n => ScenarioSerializer._serializeAction(n)),
    reducers: s1.reducerService.getAll().map(n => ScenarioSerializer._serializeReducer(n)),
    // initialState carries the post-compile sim.state via cfg, which is the
    // same in-memory object the loader mutated above.
    initialState: cfg.initialState,
    params: [],
  };

  // Serialize for storage and round-trip through JSON (what localStorage does).
  const serialized = ScenarioSerializer.serializeScenario(userScenario);
  const stored     = JSON.parse(JSON.stringify(serialized));

  // Step 4 — reload via ScenarioLoader (deserialize branch).
  ServiceRegistry.reset();
  const s2 = ServiceRegistry.getInstance();
  const sc2 = new BaseScenario({
    context:      s2.simulationContext,
    initialState: stored.initialState ?? {},
    simStart:     new Date(stored.simStart),
    simEnd:       new Date(stored.simEnd),
  });
  sc2.buildSim();
  new ScenarioLoader().load(stored, s2);

  // sim.state must be re-hydrated from stored.initialState.
  const state = s2.simulationRegistry.getPrimary().state;
  assert.ok(state.usSavingsAccount, 'sim.state.usSavingsAccount must exist after deserialize');
  const initialBalance = state.usSavingsAccount.balance;
  assert.strictEqual(typeof initialBalance, 'number',
    'usSavingsAccount.balance should be restored as a number');

  // Step 5 — run 3 months and observe that handlers actually fired.
  const Q1 = new Date(Date.UTC(2026, 2, 31));
  sc2.sim.stepTo(Q1);
  assert.ok(sc2.sim.handlerExecutions > 0,
    `handlerExecutions should be > 0 after running 3 months (got ${sc2.sim.handlerExecutions})`);
  assert.ok(sc2.sim.reducerExecutions > 0,
    `reducerExecutions should be > 0 after running 3 months (got ${sc2.sim.reducerExecutions})`);

  // The balance should have moved — wages/expenses ran on the savings account.
  const finalBalance = state.usSavingsAccount.balance;
  assert.notStrictEqual(finalBalance, initialBalance,
    'usSavingsAccount.balance should have moved after 3 months of wage/expense events');
});
