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
import { UsPeriodAdvanceReducer, AuPeriodAdvanceReducer, UsPeriodAdvanceHandler, AuPeriodAdvanceHandler } from '../../src/finance/tax/period-advance-classes.js';
import { UsTaxSettleHandler, AuTaxSettleHandler, UsTaxSettleApplyReducer, AuTaxSettleApplyReducer, UsTaxPaymentDebitReducer, AuTaxPaymentDebitReducer } from '../../src/finance/tax/tax-settle-classes.js';
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
  ServiceRegistry.resetAll();
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

  const snapshot = ScenarioSerializer.serializeScenario({
    ...ScenarioSerializer.snapshotServices(origServices),
    id: 'snap', name: 'Snap', order: 1, active: true,
    simStart: new Date(cfg.simStart), simEnd: new Date(cfg.simEnd),
    initialState: origServices.simulationRegistry.getPrimary().state,
    params: [],
  });

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
  const snapshot = ScenarioSerializer.serializeScenario({
    ...ScenarioSerializer.snapshotServices(svc1),
    id: 'snap', name: 'Snap', order: 1, active: true,
    simStart: new Date(cfg.simStart), simEnd: new Date(cfg.simEnd),
    initialState: cfg.initialState ?? {},   // pre-run initial state for round-trip
    params: [],
  });
  // Capture the post-compile / pre-run state so the reload starts from the
  // same point (currentPeriods, inflationAccumulator, etc.).
  ServiceRegistry.resetAll();
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
  ServiceRegistry.resetAll();
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
  ServiceRegistry.resetAll();
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

// ─── Regression: toolset paramSchemas are merged into cfg.params ──────────────
//
// ScenarioCompiler returns a merged toolset paramSchema, but ScenarioLoader used
// to drop it and only populate cfg.params from cfg.scenarioClass.getParamSchema().
// Toolset-only params (e.g. k401ToIraConversionEnabled from US_RETIREMENT) were
// therefore invisible in the scenario UI panel. These tests pin the merge so the
// regression can't reappear.

test('toolset params: cfg.params includes toolset-only keys missing from scenario schema', () => {
  // Use IntlRetirement WITHOUT stamping cfg.scenarioClass so toolset params land
  // straight into cfg.params from the compiler result.
  const cfg = freshDeclarativeConfig();
  const { services } = loadIntoFreshServices(cfg);

  const names = new Set(cfg.params.map(p => p.name));

  // From US_RETIREMENT — not in INTL_RETIREMENT_PARAM_SCHEMA.
  assert.ok(names.has('k401ToIraConversionEnabled'),
    'cfg.params should expose toolset-only key k401ToIraConversionEnabled');
  assert.ok(names.has('k401ToIraConversionMonth'),
    'cfg.params should expose toolset-only key k401ToIraConversionMonth');
  assert.ok(names.has('k401ToIraConversionDay'),
    'cfg.params should expose toolset-only key k401ToIraConversionDay');
  assert.ok(names.has('k401ToIraConversionYear'),
    'cfg.params should expose toolset-only key k401ToIraConversionYear');

  // sanity — services still load.
  assert.ok(services.handlerService.getAll().length > 0);
});

test('toolset params: scenario-class entries win on key collision with toolset entry', () => {
  // The real IntlRetirementScenario intentionally doesn't redeclare any toolset
  // params (drift hazard), so we use a synthetic class that DOES redeclare one
  // to pin the precedence rule for future scenarios.
  class CollidingScenario extends BaseScenario {
    static getParamSchema() {
      return [{
        key: 'usSavingsInterestRate', label: 'My Custom Label',
        type: 'Number', group: 'Custom Group', mc: false, opt: false,
        defaultValue: 0.99,
      }];
    }
  }

  const cfg = freshDeclarativeConfig();
  cfg.scenarioClass = CollidingScenario;
  cfg.params = []; // start clean so the schema merge populates from scratch
  loadIntoFreshServices(cfg);

  const usSavings = cfg.params.filter(p => p.name === 'usSavingsInterestRate');
  assert.strictEqual(usSavings.length, 1,
    'usSavingsInterestRate should appear exactly once even though two schemas declare it');
  assert.strictEqual(usSavings[0].group, 'Custom Group',
    'scenario-class group must win over toolset group on key collision');
  assert.strictEqual(usSavings[0].label, 'My Custom Label',
    'scenario-class label must win over toolset label on key collision');
});

test('toolset params: defaults come from toolset paramSchema when scenario schema omits the key', () => {
  // k401ToIraConversionEnabled is only in US_RETIREMENT.paramSchema() with defaultValue=true.
  const cfg = freshDeclarativeConfig();
  loadIntoFreshServices(cfg);

  const entry = cfg.params.find(p => p.name === 'k401ToIraConversionEnabled');
  assert.ok(entry, 'cfg.params must contain the toolset-only param');
  assert.strictEqual(entry.type,  'Boolean');
  assert.strictEqual(entry.group, 'US Retirement');
  assert.strictEqual(entry.value, true,
    'toolset paramSchema defaultValue must seed cfg.params[].value');
});

test('toolset params: edited user value round-trips through cfg.params → cfg.parameters on next load', () => {
  // First load — toolset params get populated with defaults.
  const cfg = freshDeclarativeConfig();
  loadIntoFreshServices(cfg);

  // User flips a toolset-only param via the UI.
  const idx = cfg.params.findIndex(p => p.name === 'k401ToIraConversionEnabled');
  assert.notStrictEqual(idx, -1);
  cfg.params[idx].value = false;

  // Wipe the compile-derived graph snapshot so the loader takes the compile branch
  // again (mirrors what happens after a user toggles a param and clicks Rebuild).
  cfg.events = []; cfg.handlers = []; cfg.actions = []; cfg.reducers = [];

  // Second load — the sync at the top of ScenarioLoader.load() must propagate
  // cfg.params[].value into cfg.parameters before compile runs.
  loadIntoFreshServices(cfg);

  assert.strictEqual(cfg.parameters.k401ToIraConversionEnabled, false,
    'user-edited toolset param must propagate to cfg.parameters on subsequent load');
});

test('toolset params: cfg.params[].description is propagated from schema for UI tooltips', () => {
  // The UI uses param.description as a hover tooltip on labels/inputs, so the
  // loader must thread description through from both scenario and toolset schemas.
  const cfg = freshDeclarativeConfig();
  cfg.scenarioClass = IntlRetirementScenario; // enable scenario-level schema merge
  loadIntoFreshServices(cfg);

  // Toolset-owned key (US_RETIREMENT) — description must come from the toolset schema.
  const k401 = cfg.params.find(p => p.name === 'k401ToIraConversionEnabled');
  assert.ok(k401, 'k401ToIraConversionEnabled must exist in cfg.params');
  assert.ok(k401.description && k401.description.length > 0,
    'k401ToIraConversionEnabled.description must be populated from US_RETIREMENT.paramSchema');

  // Scenario-owned key (node-bound) — description must come from the scenario schema.
  // (Per-record balance/wage/min-balance params are now generated from records and
  // carry no description; companySaleYear is a retained static node-bound param.)
  const saleYear = cfg.params.find(p => p.name === 'companySaleYear');
  assert.ok(saleYear);
  assert.ok(saleYear.description && saleYear.description.length > 0,
    'companySaleYear.description must be populated from the scenario schema');
});

test('toolset params: drift guard backfills missing description on pre-existing cfg.params entries', () => {
  // Simulate a scenario saved BEFORE description was added to cfg.params entries:
  // cfg.params has the right keys/labels but no description field. The loader must
  // backfill description from the schema so the UI tooltip works on next load.
  const cfg = freshDeclarativeConfig();
  cfg.scenarioClass = IntlRetirementScenario;
  cfg.params = [
    { name: 'companySaleYear', label: 'Company Sale Year',
      type: 'Number', group: 'Company Equity', value: 2035,
      node: { type: 'companyEquity', stateKey: 'companyEquityAccount', field: 'plannedSaleYear' } },
    // saved value the user edited — must not be reset by backfill
    { name: 'monthlyExpenses', label: 'Monthly Expenses (USD)',
      type: 'Number', group: 'US Retirement', value: 7500 },
  ];

  loadIntoFreshServices(cfg);

  const saleYear = cfg.params.find(p => p.name === 'companySaleYear');
  assert.ok(saleYear?.description?.length > 0,
    'scenario-schema description should be backfilled onto pre-existing entries');

  const expenses = cfg.params.find(p => p.name === 'monthlyExpenses');
  assert.ok(expenses?.description?.length > 0,
    'toolset-schema description should be backfilled onto pre-existing entries');
  assert.strictEqual(expenses.value, 7500,
    'backfill must preserve the existing user value');
});

test('toolset params: cfg.params has no duplicates when multiple toolsets declare the same key', () => {
  // US_RETIREMENT and AU_RETIREMENT both declare `monthlyExpenses` (and `inflationAdjust`).
  // The merge must dedup, otherwise the cfg.params → cfg.parameters sync loop overwrites
  // user-edited values with the second toolset's default.
  const cfg = freshDeclarativeConfig();
  loadIntoFreshServices(cfg);

  const names = cfg.params.map(p => p.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepStrictEqual(dupes, [],
    `cfg.params should not contain duplicate keys; saw: ${dupes.join(', ')}`);

  // Spot-check: monthlyExpenses appears exactly once.
  const monthly = cfg.params.filter(p => p.name === 'monthlyExpenses');
  assert.strictEqual(monthly.length, 1,
    'monthlyExpenses should be deduplicated across US_RETIREMENT and AU_RETIREMENT');
});

test('toolset params: cfg.params[].value seeds from cfg.parameters when set by buildDefaultConfig', () => {
  // buildDefaultConfig populates cfg.parameters.moveYear = 2031, but the toolset
  // paramSchema's defaultValue is undefined. The merged cfg.params entry must use
  // 2031 (the value the compiler actually consumed), not undefined — otherwise
  // saving + reloading the scenario would lose the move year.
  const cfg = freshDeclarativeConfig();
  assert.strictEqual(cfg.parameters.moveYear, 2031,
    'precondition: buildDefaultConfig should set moveYear');

  loadIntoFreshServices(cfg);

  const moveYear = cfg.params.find(p => p.name === 'moveYear');
  assert.ok(moveYear, 'moveYear should appear in cfg.params (from US_AU_CROSS_BORDER paramSchema)');
  assert.strictEqual(moveYear.value, 2031,
    'cfg.params[].value must mirror cfg.parameters when buildDefaultConfig sets it');
});

test('toolset params: schema-drift adds newly-introduced toolset keys to existing cfg.params', () => {
  // Simulate a saved cfg from an older release that predates k401ToIraConversion* params:
  // cfg.params is non-empty but missing those keys. Loader must append them with defaults.
  const cfg = freshDeclarativeConfig();
  cfg.params = [
    // single entry, simulating a sparse older save
    { name: 'monthlyExpenses', label: 'Monthly Expenses', type: 'Number',
      group: 'Transfer & Expenses', value: 6000 },
  ];

  loadIntoFreshServices(cfg);

  const names = new Set(cfg.params.map(p => p.name));
  assert.ok(names.has('k401ToIraConversionEnabled'),
    'schema-drift guard should append toolset-only params missing from saved cfg.params');
  assert.ok(names.has('superGrowthRate'),
    'schema-drift guard should append AU_RETIREMENT params missing from saved cfg.params');
});

test('toolset params: schema-drift re-syncs option lists onto saved enum params (design/33 AGE_BANDED)', () => {
  // Simulate a scenario saved BEFORE AGE_BANDED existed: spendingStrategy carries
  // the old option list and a user-edited selection. On load the loader must
  // refresh the option list (so AGE_BANDED becomes selectable) WITHOUT touching
  // the user's saved selection.
  const cfg = freshDeclarativeConfig();
  cfg.params = [
    { name: 'spendingStrategy', label: 'Spending Strategy', type: 'EnumMulti',
      group: 'Spending',
      options: ['FIXED', 'REGIME_AWARE', 'GUARDRAIL', 'HEALTHCARE'], // stale (pre-AGE_BANDED)
      value:   ['FIXED', 'GUARDRAIL'] },                              // user selection
  ];

  loadIntoFreshServices(cfg);

  const strat = cfg.params.find(p => p.name === 'spendingStrategy');
  assert.ok(strat.options.includes('AGE_BANDED'),
    'stale option list must be refreshed to include the newly-added AGE_BANDED choice');
  assert.deepStrictEqual(strat.value, ['FIXED', 'GUARDRAIL'],
    'option-list re-sync must preserve the user\'s saved selection');
});

test('toolset params: visibleWhen is synced onto schema params (conditional visibility, design/33)', () => {
  // A fresh load should stamp visibleWhen onto strategy config knobs from the schema.
  const cfg = freshDeclarativeConfig();
  loadIntoFreshServices(cfg);

  const bands = cfg.params.find(p => p.name === 'spendingAgeBands');
  assert.ok(bands, 'spendingAgeBands should be present');
  assert.deepStrictEqual(bands.visibleWhen, { param: 'spendingStrategy', includes: 'AGE_BANDED' },
    'spendingAgeBands must carry its visibleWhen condition');
});

test('toolset params: visibleWhen drift — saved param missing the condition gains it on load', () => {
  const cfg = freshDeclarativeConfig();
  // Simulate a scenario saved before visibleWhen existed: the key is present but
  // carries no visibleWhen. The merge must stamp it from the schema.
  cfg.params = [
    { name: 'regimeAwareCutPct', label: 'Regime-Aware Spending Cut', type: 'Number',
      group: 'Spending', value: 0.25 }, // user-edited value, no visibleWhen
  ];
  loadIntoFreshServices(cfg);

  const cut = cfg.params.find(p => p.name === 'regimeAwareCutPct');
  assert.deepStrictEqual(cut.visibleWhen, { param: 'spendingStrategy', includes: 'REGIME_AWARE' },
    'visibleWhen should be stamped onto pre-existing entries that lack it');
  assert.strictEqual(cut.value, 0.25, 'drift-sync must preserve the user value');
});

// ── Custom drawdown strategies (user-authored by-role orderings) ───────────────
//
// customDrawdownStrategies is a DrawdownStrategyList param: [{ name, roles }].
// A selected custom name must resolve through the same accountPriority cascade as
// the built-ins, be authoritative (unranked eligible roles drop to null), and
// surface as an Optimize sweep value.

test('custom drawdown strategy: cascade applies by-role ranks with owner banding', () => {
  const cfg = IntlRetirementScenario.buildDefaultConfig({}, undefined, undefined);
  cfg.scenarioClass = IntlRetirementScenario;
  cfg.parameters.customDrawdownStrategies = [{ name: 'ROTH_ONLY', roles: { 'roth-ira': 1, 'ira': 2 } }];
  cfg.parameters.drawdownStrategy = 'ROTH_ONLY';

  new ScenarioLoader()._normalizeParams(cfg);

  const byKey = Object.fromEntries(cfg.accounts.map(a => [a.stateKey, a]));
  assert.strictEqual(byKey.rothAccount.drawdownPriority, 1, 'primary roth ranked 1');
  assert.strictEqual(byKey.iraAccount.drawdownPriority, 2, 'primary ira ranked 2');
  // Owner banding (ownerStride 100) keeps the spouse's same-role buckets distinct.
  assert.strictEqual(byKey.spouseRothAccount.drawdownPriority, 101, 'spouse roth banded +100');
  assert.strictEqual(byKey.spouseIraAccount.drawdownPriority, 102, 'spouse ira banded +100');
});

test('custom drawdown strategy: unranked eligible roles are excluded (null), not left as authored', () => {
  const cfg = IntlRetirementScenario.buildDefaultConfig({}, undefined, undefined);
  cfg.scenarioClass = IntlRetirementScenario;
  // ROTH_ONLY omits us-stock / fixed-income; a custom strategy is authoritative,
  // so those drop out of drawdown rather than retaining their authored defaults.
  cfg.parameters.customDrawdownStrategies = [{ name: 'ROTH_ONLY', roles: { 'roth-ira': 1, 'ira': 2 } }];
  cfg.parameters.drawdownStrategy = 'ROTH_ONLY';

  new ScenarioLoader()._normalizeParams(cfg);

  const byKey = Object.fromEntries(cfg.accounts.map(a => [a.stateKey, a]));
  assert.strictEqual(byKey.usStockAccount.drawdownPriority, null, 'unranked us-stock excluded');
  assert.strictEqual(byKey.fixedIncomeAccount.drawdownPriority, null, 'unranked fixed-income excluded');
});

test('custom drawdown strategy: built-in strategies still cascade unchanged', () => {
  const cfg = IntlRetirementScenario.buildDefaultConfig({}, undefined, undefined);
  cfg.scenarioClass = IntlRetirementScenario;
  cfg.parameters.drawdownStrategy = 'TAXABLE_FIRST';

  new ScenarioLoader()._normalizeParams(cfg);

  const byKey = Object.fromEntries(cfg.accounts.map(a => [a.stateKey, a]));
  assert.strictEqual(byKey.fixedIncomeAccount.drawdownPriority, 1, 'TAXABLE_FIRST drains fixed-income first');
  assert.strictEqual(byKey.rothAccount.drawdownPriority, 5, 'TAXABLE_FIRST drains roth last');
});

test('custom drawdown strategy: dynamicOptionsFrom is carried onto cfg.params', () => {
  const cfg = freshDeclarativeConfig();
  cfg.scenarioClass = IntlRetirementScenario; // so the scenario schema (owns drawdownStrategy) merges
  loadIntoFreshServices(cfg);
  const dd = cfg.params.find(p => p.name === 'drawdownStrategy');
  assert.strictEqual(dd.dynamicOptionsFrom, 'customDrawdownStrategies',
    'drawdownStrategy must name its custom-strategy source for the UI dropdown');
});

test('custom drawdown strategy: stale persisted node (pre-customStrategiesKey) still cascades — schema node is authoritative', () => {
  // Regression: a scenario saved BEFORE the accountPriority node gained
  // `customStrategiesKey` froze the old node shape on its typed params entry.
  // A persisted node must not shadow the live schema node; otherwise the custom
  // strategies are never merged in, the selected custom name resolves to nothing,
  // and the cascade silently leaves accounts on their authored defaults.
  const cfg = IntlRetirementScenario.buildDefaultConfig({}, undefined, undefined);
  cfg.scenarioClass = IntlRetirementScenario;
  cfg.parameters.customDrawdownStrategies = [{ name: 'ROTH_ONLY', roles: { 'roth-ira': 1, 'ira': 2 } }];
  cfg.parameters.drawdownStrategy = 'ROTH_ONLY';
  cfg.params = [
    { name: 'drawdownStrategy', label: 'Drawdown Strategy', type: 'Enum', group: 'Spending',
      value: 'ROTH_ONLY',
      // STALE node — the shape saved before customStrategiesKey existed.
      node: { type: 'accountPriority', strategies: { TAXABLE_FIRST: { 'roth-ira': 5 } },
              ownerOrder: ['primary', 'spouse'], ownerStride: 100 } },
  ];

  new ScenarioLoader()._normalizeParams(cfg);

  const byKey = Object.fromEntries(cfg.accounts.map(a => [a.stateKey, a]));
  assert.strictEqual(byKey.rothAccount.drawdownPriority, 1,
    'custom ROTH_ONLY must apply despite a stale persisted node missing customStrategiesKey');
  assert.strictEqual(byKey.iraAccount.drawdownPriority, 2, 'custom ira rank applies');
});

// ── Per-owner drawdown banding (design 35) ─────────────────────────────────────
//
// drawdownOwnerOrdering controls how same-role accounts owned by different people
// are ordered within a drawdown strategy. The accountPriority cascade resolves the
// mode → ownerOrder/ownerStride and applies `base + ownerRank * ownerStride`.

test('owner ordering: PRIMARY_FIRST bands the spouse after the primary (+ownerStride)', () => {
  const cfg = IntlRetirementScenario.buildDefaultConfig({}, undefined, undefined);
  cfg.scenarioClass = IntlRetirementScenario;
  cfg.parameters.drawdownStrategy = 'TAXABLE_FIRST';
  cfg.parameters.drawdownOwnerOrdering = 'PRIMARY_FIRST';

  new ScenarioLoader()._normalizeParams(cfg);

  const byKey = Object.fromEntries(cfg.accounts.map(a => [a.stateKey, a]));
  assert.strictEqual(byKey.rothAccount.drawdownPriority, 5, 'primary roth at its base rank');
  assert.strictEqual(byKey.spouseRothAccount.drawdownPriority, 105, 'spouse roth banded +100');
});

test('owner ordering: POOLED gives same-role accounts across owners an equal priority', () => {
  const cfg = IntlRetirementScenario.buildDefaultConfig({}, undefined, undefined);
  cfg.scenarioClass = IntlRetirementScenario;
  cfg.parameters.drawdownStrategy = 'TAXABLE_FIRST';
  cfg.parameters.drawdownOwnerOrdering = 'POOLED';

  new ScenarioLoader()._normalizeParams(cfg);

  const byKey = Object.fromEntries(cfg.accounts.map(a => [a.stateKey, a]));
  assert.strictEqual(byKey.rothAccount.drawdownPriority, 5, 'primary roth at base rank');
  assert.strictEqual(byKey.spouseRothAccount.drawdownPriority, 5,
    'POOLED: spouse roth shares the primary roth tier (no +100 band)');
  assert.strictEqual(byKey.iraAccount.drawdownPriority, byKey.spouseIraAccount.drawdownPriority,
    'POOLED: both IRAs share a tier too');
});

test('owner ordering: SPOUSE_FIRST bands the primary after the spouse', () => {
  const cfg = IntlRetirementScenario.buildDefaultConfig({}, undefined, undefined);
  cfg.scenarioClass = IntlRetirementScenario;
  cfg.parameters.drawdownStrategy = 'TAXABLE_FIRST';
  cfg.parameters.drawdownOwnerOrdering = 'SPOUSE_FIRST';

  new ScenarioLoader()._normalizeParams(cfg);

  const byKey = Object.fromEntries(cfg.accounts.map(a => [a.stateKey, a]));
  assert.strictEqual(byKey.spouseRothAccount.drawdownPriority, 5, 'spouse roth at base rank (drawn first)');
  assert.strictEqual(byKey.rothAccount.drawdownPriority, 105, 'primary roth banded +100');
});

test('owner ordering: default is PRIMARY_FIRST when the param is absent (back-compat)', () => {
  const cfg = IntlRetirementScenario.buildDefaultConfig({}, undefined, undefined);
  cfg.scenarioClass = IntlRetirementScenario;
  cfg.parameters.drawdownStrategy = 'TAXABLE_FIRST';
  delete cfg.parameters.drawdownOwnerOrdering; // simulate a scenario saved before design 35

  new ScenarioLoader()._normalizeParams(cfg);

  const byKey = Object.fromEntries(cfg.accounts.map(a => [a.stateKey, a]));
  assert.strictEqual(byKey.spouseRothAccount.drawdownPriority, 105,
    'missing mode falls back to the node default banding (+100), preserving legacy behavior');
});

test('owner ordering: drawdownOwnerOrdering param is appended to saved cfg.params with its default', () => {
  const cfg = freshDeclarativeConfig();
  cfg.scenarioClass = IntlRetirementScenario;
  cfg.params = [
    { name: 'drawdownStrategy', label: 'Drawdown Strategy', type: 'Enum', group: 'Spending',
      value: 'TAXABLE_FIRST' }, // a sparse older save with no drawdownOwnerOrdering entry
  ];

  loadIntoFreshServices(cfg);

  const owner = cfg.params.find(p => p.name === 'drawdownOwnerOrdering');
  assert.ok(owner, 'schema-drift guard must append the new drawdownOwnerOrdering param');
  assert.strictEqual(owner.value, 'PRIMARY_FIRST', 'appended with the legacy-preserving default');
  assert.deepStrictEqual(owner.options, ['PRIMARY_FIRST', 'SPOUSE_FIRST', 'POOLED']);
});

test('custom drawdown strategy: schema-drift re-syncs the accountPriority node onto saved params (gains customStrategiesKey)', () => {
  // The persisted node is schema-owned metadata; a stale copy must be refreshed
  // on load so a subsequent re-save no longer carries the broken shape.
  const cfg = freshDeclarativeConfig();
  cfg.scenarioClass = IntlRetirementScenario;
  cfg.params = [
    { name: 'drawdownStrategy', label: 'Drawdown Strategy', type: 'Enum', group: 'Spending',
      value: 'TAXABLE_FIRST',
      node: { type: 'accountPriority', strategies: {}, ownerOrder: ['primary', 'spouse'], ownerStride: 100 } },
  ];

  loadIntoFreshServices(cfg);

  const dd = cfg.params.find(p => p.name === 'drawdownStrategy');
  assert.strictEqual(dd.node.customStrategiesKey, 'customDrawdownStrategies',
    'stale node must be re-synced from the schema so custom strategies resolve');
});

// ─── deleted-default tombstones (drift-merge suppression) ──────────────────────

test('drift-merge: a deleted default WITHOUT a tombstone is re-added (forward-fill)', () => {
  // Baseline: this is the pre-tombstone behavior that surprised the user — a
  // deliberately-deleted default account reappears on Rebuild.
  const cfg = IntlRetirementScenario.buildDefaultConfig({}, undefined, undefined);
  cfg.scenarioClass = IntlRetirementScenario;
  cfg.accounts = cfg.accounts.filter(a => a.stateKey !== 'usSavingsAccount');

  new ScenarioLoader()._driftMergeDomainRecords(cfg);

  assert.ok(cfg.accounts.some(a => a.stateKey === 'usSavingsAccount'),
    'an untombstoned missing default is filled back in');
});

test('drift-merge: a tombstoned default account is NOT re-added', () => {
  const cfg = IntlRetirementScenario.buildDefaultConfig({}, undefined, undefined);
  cfg.scenarioClass = IntlRetirementScenario;
  cfg.accounts = cfg.accounts.filter(a => a.stateKey !== 'usSavingsAccount');
  cfg.deletedDefaults = { accounts: ['usSavingsAccount'] };

  new ScenarioLoader()._driftMergeDomainRecords(cfg);

  assert.ok(!cfg.accounts.some(a => a.stateKey === 'usSavingsAccount'),
    'a tombstoned default must stay deleted across drift-merge');
});

test('drift-merge: a genuinely-new default is still filled in despite other tombstones', () => {
  // Tombstoning one account must not suppress a different, untombstoned default.
  const cfg = IntlRetirementScenario.buildDefaultConfig({}, undefined, undefined);
  cfg.scenarioClass = IntlRetirementScenario;
  cfg.accounts = cfg.accounts.filter(
    a => a.stateKey !== 'usSavingsAccount' && a.stateKey !== 'auStockAccount');
  cfg.deletedDefaults = { accounts: ['usSavingsAccount'] };

  new ScenarioLoader()._driftMergeDomainRecords(cfg);

  assert.ok(!cfg.accounts.some(a => a.stateKey === 'usSavingsAccount'),
    'tombstoned default stays deleted');
  assert.ok(cfg.accounts.some(a => a.stateKey === 'auStockAccount'),
    'untombstoned missing default is still filled in');
});

test('recordDeletedDefaults: records default accounts absent from cfg', () => {
  const cfg = IntlRetirementScenario.buildDefaultConfig({}, undefined, undefined);
  cfg.scenarioClass = IntlRetirementScenario;
  cfg.accounts = cfg.accounts.filter(
    a => a.stateKey !== 'usSavingsAccount' && a.stateKey !== 'auStockAccount');

  ScenarioLoader.recordDeletedDefaults(cfg);

  assert.deepStrictEqual([...cfg.deletedDefaults.accounts].sort(),
    ['auStockAccount', 'usSavingsAccount'],
    'both deleted defaults are tombstoned');
});

test('recordDeletedDefaults: is self-correcting — a present default is pruned from the tombstone', () => {
  const cfg = IntlRetirementScenario.buildDefaultConfig({}, undefined, undefined);
  cfg.scenarioClass = IntlRetirementScenario;
  // usSavingsAccount is present in the default cfg; a stale tombstone must clear.
  cfg.deletedDefaults = { accounts: ['usSavingsAccount'] };

  ScenarioLoader.recordDeletedDefaults(cfg);

  assert.ok(!cfg.deletedDefaults.accounts.includes('usSavingsAccount'),
    're-adding a default drops it from the tombstone');
});

test('recordDeletedDefaults: resolves the class from scenarioId when scenarioClass is absent', () => {
  const cfg = IntlRetirementScenario.buildDefaultConfig({}, undefined, undefined);
  cfg.scenarioId = 'p:intl-retirement';        // prefixed prebuilt id, no scenarioClass
  cfg.accounts = cfg.accounts.filter(a => a.stateKey !== 'usSavingsAccount');

  ScenarioLoader.recordDeletedDefaults(cfg);

  assert.ok(cfg.deletedDefaults.accounts.includes('usSavingsAccount'),
    'class resolves from the p:-prefixed scenarioId');
});

test('load (compile branch): a tombstoned default account never reaches the services', () => {
  const cfg = freshDeclarativeConfig();
  cfg.scenarioId = 'p:intl-retirement';
  cfg.accounts = cfg.accounts.filter(a => a.stateKey !== 'usSavingsAccount');
  cfg.deletedDefaults = { accounts: ['usSavingsAccount'] };

  const { services } = loadIntoFreshServices(cfg);

  const keys = services.accountService.getAll().map(a => a.stateKey);
  assert.ok(!keys.includes('usSavingsAccount'),
    'the tombstoned default is absent from the compiled services');
});
