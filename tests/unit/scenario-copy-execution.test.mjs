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
 * scenario-copy-execution.test.mjs
 *
 * Integration tests that verify ScenarioService.newScenario() produces a
 * simulation whose financial state matches the original after stepping to the
 * same target date (serialisation round-trip is lossless), and that modifying
 * a param in the copy causes the state to diverge.
 *
 * Run with: node --test tests/unit/scenario-copy-execution.test.mjs
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
import { IntlRetirementScenario }     from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioLoader }             from '../../src/scenarios/scenario-loader.js';

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
import { computeNetLiquidity } from '../../src/finance/derived-metrics/net-liquidity.js';
import { computeNetWorth }     from '../../src/finance/derived-metrics/net-worth.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const TARGET  = new Date(Date.UTC(2028, 0, 1));
const SIM_END = new Date(Date.UTC(2041, 0, 1));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePrebuiltArray() {
  return [
    {
      cls:      IntlRetirementScenario,
      order:    1,
      active:   true,
      simStart: new Date(Date.UTC(2026, 0, 1)),
      simEnd:   new Date(Date.UTC(2041, 0, 1)),
    },
  ];
}

/**
 * Build and compile the IntlRetirement prebuilt via the PREBUILT_SCENARIOS path:
 *   createActiveScenario() → buildSim() → ScenarioLoader.load() (compile branch).
 *
 * After this call:
 *   - services.simulationRegistry.getPrimary() is the live sim (not yet stepped).
 *   - activeConfig has been mutated to carry events/handlers/reducers/initialState.
 */
function buildAndCompilePrebuilt() {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  services.scenarioRegistry.loadPrebuilt(makePrebuiltArray());

  const activeScenario = services.scenarioService.createActiveScenario();
  activeScenario.buildSim();

  const activeConfig = services.scenarioService.getActive();
  const ScenarioCls  = activeScenario.constructor;
  const declaredToolsets = ScenarioCls.getToolsets?.() ?? [];
  if (declaredToolsets.length > 0 && !activeConfig?.toolsets?.length) {
    const defaultCfg = ScenarioCls.buildDefaultConfig(
      activeScenario.params, activeScenario.simStart, activeScenario.simEnd
    );
    if (defaultCfg && activeConfig) Object.assign(activeConfig, defaultCfg);
  }
  new ScenarioLoader().load(activeConfig, services);

  return { services, activeScenario };
}

/**
 * Load a compiled config into a fresh ServiceRegistry and return the sim.
 * Takes the deserialize branch (cfg.events is non-empty after compile).
 */
function loadCopyIntoFreshServices(cfg) {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  const scenario = new BaseScenario({
    context:  services.simulationContext,
    simStart: new Date(cfg.simStart),
    simEnd:   new Date(cfg.simEnd),
  });
  scenario.buildSim();
  new ScenarioLoader().load(cfg, services);
  return services.simulationRegistry.getPrimary();
}

// ═════════════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════════════

test('copy via newScenario() produces identical financial state at 2028-01-01', () => {
  // Step A: build + compile original; run to TARGET
  const { services, activeScenario } = buildAndCompilePrebuilt();
  const sim1 = activeScenario.sim;
  sim1.stepTo(TARGET);

  const orig = {
    usSavings: sim1.state.usSavingsAccount?.balance,
    roth:      sim1.state.rothAccount?.balance,
    ira:       sim1.state.iraAccount?.balance,
    k401:      sim1.state.k401Account?.balance,
    super_:    sim1.state.superAccount?.balance,
    auSavings: sim1.state.auSavingsAccount?.balance,
    expenses:  sim1.state.monthlyExpenses,
  };

  // Step B: create copy via newScenario() — deep-clones compiled graph + pre-run initialState
  const active  = services.scenarioService.getActive();
  const created = services.scenarioService.newScenario(active);

  // created.events is non-empty → ScenarioLoader takes the deserialize branch
  assert.ok(created.events.length > 0,   'copy should have compiled events');
  assert.ok(created.handlers.length > 0, 'copy should have compiled handlers');
  assert.ok(created.reducers.length > 0, 'copy should have compiled reducers');

  const sim2 = loadCopyIntoFreshServices(created);
  sim2.stepTo(TARGET);

  // Step C: key account balances must be identical (round-trip is lossless)
  assert.strictEqual(sim2.state.usSavingsAccount?.balance, orig.usSavings,  'usSavingsAccount balance');
  assert.strictEqual(sim2.state.rothAccount?.balance,      orig.roth,       'rothAccount balance');
  assert.strictEqual(sim2.state.iraAccount?.balance,       orig.ira,        'iraAccount balance');
  assert.strictEqual(sim2.state.k401Account?.balance,      orig.k401,       'k401Account balance');
  assert.strictEqual(sim2.state.superAccount?.balance,     orig.super_,     'superAccount balance');
  assert.strictEqual(sim2.state.auSavingsAccount?.balance, orig.auSavings,  'auSavingsAccount balance');
  assert.strictEqual(sim2.state.monthlyExpenses,           orig.expenses,   'monthlyExpenses');
});

test('copy with modified monthlyExpenses diverges from original at 2028-01-01', () => {
  // Build original and run to TARGET
  const { services, activeScenario } = buildAndCompilePrebuilt();
  activeScenario.sim.stepTo(TARGET);
  const origSavings = activeScenario.sim.state.usSavingsAccount?.balance;
  assert.ok(origSavings != null, 'original US savings should be defined');

  // Create copy and reduce monthly expenses (default is 6000, halved to 3000)
  const active  = services.scenarioService.getActive();
  const created = services.scenarioService.newScenario(active);

  const expParam = created.params?.find(p => p.name === 'monthlyExpenses');
  if (expParam) expParam.value = 3000;
  if (created.initialState) created.initialState.monthlyExpenses = 3000;

  const sim2 = loadCopyIntoFreshServices(created);
  sim2.stepTo(TARGET);
  const copySavings = sim2.state.usSavingsAccount?.balance;

  // Lower expenses → US savings should be higher over 2 years
  assert.ok(copySavings > origSavings,
    `copy with lower expenses (3000) should have higher US savings — original: ${origSavings}, copy: ${copySavings}`);
});

// ─── Initialization-flow change-propagation tests ────────────────────────────
//
// These tests verify that changes made to a scenario config (params, person
// fields, account values, event dates) are picked up by the simulation
// initialization flow WITHOUT manually patching initialState.
//
// Root cause: ScenarioLoader.load() takes the deserialize branch whenever
// cfg.events is non-empty, which restores the frozen cfg.initialState snapshot
// and overwrites anything that changed.  Tests that exercise params→state,
// person→state, and account→state currently FAIL.  The moveYear→event-date
// test also FAILS because the compiled event date is frozen in cfg.events even
// when the param that produced it is changed.  Only tests that mutate cfg.events
// directly currently pass (test 3 above).  These tests document the full scope
// of the problem before the architectural fix is applied.

test('changing primaryRetirementDate param is reflected in state.people via initialization flow', () => {
  // Build and compile the prebuilt (default primaryRetirementDate = 2040-01-01)
  const { services } = buildAndCompilePrebuilt();
  const active  = services.scenarioService.getActive();
  const created = services.scenarioService.newScenario(active);

  // Mutate the param — the initialization flow must propagate this into state.people
  const retParam = created.params?.find(p => p.name === 'person.primary.retirementDate');
  assert.ok(retParam, 'person.primary.retirementDate param must exist in the copy');
  retParam.value = '2027-01-01';

  const sim = loadCopyIntoFreshServices(created);

  const primaryPerson = sim.state.people?.primary;
  assert.ok(primaryPerson, 'primary person must exist in state.people after load');

  const retDate = primaryPerson.retirementDate instanceof Date
    ? primaryPerson.retirementDate
    : new Date(primaryPerson.retirementDate);

  assert.strictEqual(
    retDate.toISOString().slice(0, 10),
    '2027-01-01',
    `state.people.primary.retirementDate should be 2027-01-01 after param change, got ${retDate?.toISOString?.() ?? retDate}`,
  );
});

test('changing a non-param person field is reflected in state.people via initialization flow', () => {
  // socialSecurityMonthly has no corresponding param and no paramToPersonSync entry,
  // so a direct edit to cfg.persons must survive the recompile unchanged.
  const { services } = buildAndCompilePrebuilt();
  const active  = services.scenarioService.getActive();
  const created = services.scenarioService.newScenario(active);

  const primaryRec = created.persons?.find(p => p.id === 'primary');
  assert.ok(primaryRec, 'primary person must exist in scenario persons array');
  primaryRec.socialSecurityMonthly = 2_500;

  const sim = loadCopyIntoFreshServices(created);

  const statePerson = sim.state.people?.primary;
  assert.ok(statePerson, 'primary person must exist in state.people after load');
  assert.strictEqual(
    statePerson.socialSecurityMonthly,
    2_500,
    `state.people.primary.socialSecurityMonthly should be 2500 after direct field change, got ${statePerson.socialSecurityMonthly}`,
  );
});

test('direct event date edits in cfg.events are overridden by param-driven recompile for toolset scenarios', () => {
  // For toolset scenarios, the event schedule is always derived from params.  Editing
  // cfg.events[i].date directly (as the graph UI would do) is overridden on the next
  // load because the compile branch regenerates the schedule from the current params.
  // To change an event date, change the controlling param (e.g. moveYear) instead.
  const { services } = buildAndCompilePrebuilt();
  const active  = services.scenarioService.getActive();
  const created = services.scenarioService.newScenario(active);

  // Directly edit the CHANGE_RESIDENCY event date in cfg.events (moveYear param still 2031)
  const changeResEvent = created.events?.find(e => e.type === 'CHANGE_RESIDENCY');
  assert.ok(changeResEvent, 'CHANGE_RESIDENCY event must exist in the compiled events');
  changeResEvent.date = new Date(Date.UTC(2027, 6, 1)).toISOString();

  const sim = loadCopyIntoFreshServices(created);
  sim.stepTo(TARGET);

  // moveYear param = 2031 (after TARGET) → event recompiled to 2031-07-01 → direct edit ignored
  const primaryResidency = Object.values(sim.state.people ?? {})[0]?.residency;
  assert.notStrictEqual(
    primaryResidency,
    'AU',
    `Direct event date edit is overridden by recompile; moveYear=2031 so residency should not be AU at TARGET, got ${primaryResidency}`,
  );
});

test('changing moveYear param updates the CHANGE_RESIDENCY event date via initialization flow', () => {
  // Default moveYear = 2031 → CHANGE_RESIDENCY compiled to 2031-07-01 (after TARGET).
  // Changing the param to 2027 should make the event fire on 2027-07-01 (before TARGET),
  // so isAuResident must be true at TARGET.  Currently FAILS because the param change
  // is not cascaded to the frozen event date in cfg.events.
  const { services } = buildAndCompilePrebuilt();
  const active  = services.scenarioService.getActive();
  const created = services.scenarioService.newScenario(active);

  const moveParam = created.params?.find(p => p.name === 'moveYear');
  assert.ok(moveParam, 'moveYear param must exist in the copy');
  moveParam.value = 2027;

  const sim = loadCopyIntoFreshServices(created);
  sim.stepTo(TARGET);

  const primaryResidency = Object.values(sim.state.people ?? {})[0]?.residency;
  assert.strictEqual(
    primaryResidency,
    'AU',
    `residency should be AU at TARGET after moveYear param changed to 2027, got ${primaryResidency}`,
  );
});

test('changing monthlyExpenses param is reflected in state.monthlyExpenses via initialization flow', () => {
  // Default monthlyExpenses = 6000.  Changing the param to a distinctive value
  // must be visible in state.monthlyExpenses after load, without touching initialState.
  // Currently FAILS because cfg.initialState.monthlyExpenses is the frozen compile-time value.
  const { services } = buildAndCompilePrebuilt();
  const active  = services.scenarioService.getActive();
  const created = services.scenarioService.newScenario(active);

  const expParam = created.params?.find(p => p.name === 'monthlyExpenses');
  assert.ok(expParam, 'monthlyExpenses param must exist in the copy');
  expParam.value = 9_999;

  const sim = loadCopyIntoFreshServices(created);

  assert.strictEqual(
    sim.state.monthlyExpenses,
    9_999,
    `state.monthlyExpenses should be 9999 after param change, got ${sim.state.monthlyExpenses}`,
  );
});

test('changing a non-param account field (drawdownPriority) is reflected in state via initialization flow', () => {
  // Fields on account records that have no corresponding param (e.g. drawdownPriority)
  // are authoritative from cfg.accounts and survive the compile/load cycle unchanged.
  // Fields that DO have a param mapping (e.g. initialValue, minimumBalance) are controlled
  // by the param; direct edits to those fields on cfg.accounts are overridden by the
  // param node sync.  drawdownPriority is now driven by the `drawdownStrategy` param,
  // so this test selects the CUSTOM strategy (a no-op cascade) under which per-account
  // drawdownPriority remains authoritative — validating the non-param field path.
  const { services } = buildAndCompilePrebuilt();
  const active  = services.scenarioService.getActive();
  const created = services.scenarioService.newScenario(active);

  // CUSTOM strategy → cascade leaves per-account drawdownPriority untouched.
  const stratParam = created.params?.find(p => p.name === 'drawdownStrategy');
  if (stratParam) stratParam.value = 'CUSTOM';

  const iraRec = created.accounts?.find(a => a.stateKey === 'iraAccount');
  assert.ok(iraRec, 'iraAccount must exist in scenario accounts array');
  const originalPriority = iraRec.drawdownPriority;
  const newPriority = (originalPriority ?? 3) + 10;
  iraRec.drawdownPriority = newPriority;

  const sim = loadCopyIntoFreshServices(created);

  assert.strictEqual(
    sim.state.iraAccount?.drawdownPriority,
    newPriority,
    `state.iraAccount.drawdownPriority should be ${newPriority} after direct field change, got ${sim.state.iraAccount?.drawdownPriority}`,
  );
});

// ─── Generic schema-node cascade tests ───────────────────────────────────────
//
// These tests verify the generic param→node mechanism: changing a param value
// cascades automatically to cfg.persons or cfg.accounts (via schema node
// declarations) before compilation, without any manual patching.

test('changing primaryMonthlyWage param cascades to person via schema node', () => {
  const { services } = buildAndCompilePrebuilt();
  const active  = services.scenarioService.getActive();
  const created = services.scenarioService.newScenario(active);

  const wageParam = created.params?.find(p => p.name === 'person.primary.monthlyWage');
  assert.ok(wageParam, 'person.primary.monthlyWage param must exist in the copy');
  wageParam.value = 12_345;

  const sim = loadCopyIntoFreshServices(created);

  const primary = sim.state.people?.primary;
  assert.ok(primary, 'primary person must exist in state.people after load');
  assert.strictEqual(
    primary.monthlyWage,
    12_345,
    `state.people.primary.monthlyWage should be 12345 after param change, got ${primary.monthlyWage}`,
  );
});

test('changing spouseMonthlyWage param cascades to person via schema node', () => {
  const { services } = buildAndCompilePrebuilt();
  const active  = services.scenarioService.getActive();
  const created = services.scenarioService.newScenario(active);

  const wageParam = created.params?.find(p => p.name === 'person.spouse.monthlyWage');
  assert.ok(wageParam, 'person.spouse.monthlyWage param must exist in the copy');
  wageParam.value = 6_789;

  const sim = loadCopyIntoFreshServices(created);

  const spouse = sim.state.people?.spouse;
  assert.ok(spouse, 'spouse person must exist in state.people after load');
  assert.strictEqual(
    spouse.monthlyWage,
    6_789,
    `state.people.spouse.monthlyWage should be 6789 after param change, got ${spouse.monthlyWage}`,
  );
});

test('a holdings-bearing account exposes no balance param; its balance round-trips through a copy', () => {
  // design 55 §13: a holdings-bearing account's balance is DERIVED from Σ holdings, so
  // no balance param is generated (the value is controlled by editing holdings, not a
  // param). The starting balance still round-trips faithfully through a copy.
  const { services } = buildAndCompilePrebuilt();
  const active  = services.scenarioService.getActive();
  const created = services.scenarioService.newScenario(active);

  assert.strictEqual(
    created.params?.find(p => p.name === 'acct.usSavingsAccount.balance'), undefined,
    'holdings-bearing account has no balance param (balance derives from holdings)');

  const sim = loadCopyIntoFreshServices(created);

  assert.strictEqual(
    sim.state.usSavingsAccount?.balance, 30_000,
    `account starting balance round-trips through the copy, got ${sim.state.usSavingsAccount?.balance}`,
  );
});

test('changing rothAccount contributionBasis param cascades to state via schema node', () => {
  const { services } = buildAndCompilePrebuilt();
  const active  = services.scenarioService.getActive();
  const created = services.scenarioService.newScenario(active);

  // contributionBasis is the generated retirement scalar param (balance is now
  // holdings-derived and no longer a param); it cascades onto the record + state.
  const param = created.params?.find(p => p.name === 'acct.rothAccount.contributionBasis');
  assert.ok(param, 'acct.rothAccount.contributionBasis param must exist in the copy');
  param.value = 55_555;

  const sim = loadCopyIntoFreshServices(created);

  assert.strictEqual(
    sim.state.rothAccount?.contributionBasis,
    55_555,
    `state.rothAccount.contributionBasis should be 55555 after param change, got ${sim.state.rothAccount?.contributionBasis}`,
  );
});

test('changing per-account savings minimumBalance param cascades to account minimumBalance via schema node', () => {
  const { services } = buildAndCompilePrebuilt();
  const active  = services.scenarioService.getActive();
  const created = services.scenarioService.newScenario(active);

  // Design 55 §7/§13: the floor is generated per-account (acct.<stateKey>.minimumBalance),
  // replacing the old global usSavingsMinBalance param (retired behind an alias).
  const param = created.params?.find(p => p.name === 'acct.usSavingsAccount.minimumBalance');
  assert.ok(param, 'acct.usSavingsAccount.minimumBalance param must exist in the copy');
  param.value = 8_888;

  const sim = loadCopyIntoFreshServices(created);

  assert.strictEqual(
    sim.state.usSavingsAccount?.minimumBalance,
    8_888,
    `state.usSavingsAccount.minimumBalance should be 8888 after usSavingsMinBalance param change, got ${sim.state.usSavingsAccount?.minimumBalance}`,
  );
});

test('changing spouseRothAccount contributionBasis param cascades to state via schema node', () => {
  const { services } = buildAndCompilePrebuilt();
  const active  = services.scenarioService.getActive();
  const created = services.scenarioService.newScenario(active);

  const param = created.params?.find(p => p.name === 'acct.spouseRothAccount.contributionBasis');
  assert.ok(param, 'acct.spouseRothAccount.contributionBasis param must exist in the copy');
  param.value = 33_333;

  const sim = loadCopyIntoFreshServices(created);

  assert.strictEqual(
    sim.state.spouseRothAccount?.contributionBasis,
    33_333,
    `state.spouseRothAccount.contributionBasis should be 33333 after param change, got ${sim.state.spouseRothAccount?.contributionBasis}`,
  );
});

// ─── Copy fidelity when the ORIGINAL carries user edits ──────────────────────
//
// The tests above copy an untouched reference scenario, where every collection
// the copy might drop happens to be re-supplied by the loader's drift-merge with
// its DEFAULT value — so an incomplete copy still scores identically and the
// defect hides. These run the same copy → rebuild → run cycle on an original
// whose records have been EDITED, which is the only place the loss shows up.
//
// Historical failures (before newScenario() copied the record generically):
//   companyEquities dropped  → drift-merge restored the DEFAULT equity  (−32% net liquidity)
//   bequests dropped         → the inheritance vanished; nothing re-adds it (−15%)
//   deletedDefaults dropped  → a deliberately deleted default came back  (+1.9% net worth)

/** Run a cfg to SIM_END in a fresh registry and return its terminal metrics. */
function runToEnd(cfg) {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  services.scenarioRegistry.loadPrebuilt(makePrebuiltArray());
  services.scenarioRegistry.save(cfg, true);

  const scenario = services.scenarioService.createActiveScenario();
  scenario.buildSim();
  new ScenarioLoader().load(cfg, services);

  const sim = services.simulationRegistry.getPrimary();
  sim.stepTo(SIM_END);
  return {
    services,
    netLiquidity: computeNetLiquidity(sim.state, SIM_END),
    netWorth:     computeNetWorth(sim.state),
  };
}

/**
 * Apply `editOriginal` to a freshly compiled prebuilt, run it, copy it, run the
 * copy, and assert both terminal metrics match to the cent.
 */
function assertCopyMatchesEditedOriginal(label, editOriginal) {
  const { services } = buildAndCompilePrebuilt();
  const original = services.scenarioService.getActive();
  editOriginal(original);

  const before = runToEnd(original);
  const copy   = before.services.scenarioService.newScenario(original);
  const after  = runToEnd(copy);

  assert.strictEqual(after.netLiquidity, before.netLiquidity,
    `${label}: copy net liquidity should equal the original's — original ${before.netLiquidity}, copy ${after.netLiquidity}`);
  assert.strictEqual(after.netWorth, before.netWorth,
    `${label}: copy net worth should equal the original's — original ${before.netWorth}, copy ${after.netWorth}`);
}

test('copy of an original with an EDITED company equity runs identically', () => {
  assertCopyMatchesEditedOriginal('companyEquities', (cfg) => {
    assert.ok(cfg.companyEquities?.length, 'reference scenario must carry a company equity');
    cfg.companyEquities[0].value           = 2_000_000;
    cfg.companyEquities[0].plannedSaleYear = 2032;
  });
});

test('copy of an original with an ARMED bequest runs identically', () => {
  assertCopyMatchesEditedOriginal('bequests', (cfg) => {
    assert.ok(cfg.bequests?.length, 'reference scenario must carry a bequest');
    cfg.bequests[0].inheritanceYear = 2030;
  });
});

test('copy of an original with a DELETED default record runs identically', () => {
  assertCopyMatchesEditedOriginal('deletedDefaults', (cfg) => {
    cfg.accounts     = (cfg.accounts     ?? []).filter(a => a.stateKey !== 'collectibleAccount');
    cfg.collectibles = (cfg.collectibles ?? []).filter(c => c.stateKey !== 'collectibleAccount');
    // The Save/Rebuild harvest is what records the tombstone in the real app.
    ScenarioLoader.recordDeletedDefaults(cfg);
    assert.ok(cfg.deletedDefaults.collectibles.includes('collectibleAccount'),
      'the deletion must be tombstoned for the test to mean anything');
  });
});

test('copy carries every config field of the source, and shares no state with it', () => {
  // Guards against the enumeration drift that caused the failures above: any
  // collection added to the scenario record must reach the copy for free.
  const { services } = buildAndCompilePrebuilt();
  const original = services.scenarioService.getActive();
  const copy     = services.scenarioService.newScenario(original);

  const IDENTITY = new Set(['id', 'name', 'order', 'active', 'prebuilt', 'layer']);
  const missing  = Object.keys(original).filter(k => !IDENTITY.has(k) && !(k in copy));
  assert.deepStrictEqual(missing, [],
    `every non-identity field must be copied; missing: ${missing.join(', ')}`);

  // Deep-copied, not aliased: editing the copy must never reach the original.
  for (const key of Object.keys(copy)) {
    if (key === 'scenarioClass') continue;          // a class ref, shared on purpose
    const value = copy[key];
    if (value !== null && typeof value === 'object') {
      assert.notStrictEqual(value, original[key], `${key} must not be shared by reference`);
    }
  }
  copy.accounts[0].balance = -12_345;
  copy.parameters.monthlyExpenses = -1;
  assert.notStrictEqual(original.accounts[0].balance, -12_345, 'editing the copy must not touch the original');
  assert.notStrictEqual(original.parameters.monthlyExpenses, -1, 'editing the copy must not touch the original');
});
