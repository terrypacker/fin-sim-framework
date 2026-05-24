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
 * serializer-finance-roundtrip.test.mjs  — Level 3 of the serialization test pyramid
 *
 * Uses real finance handlers and reducers (MonthlyExpensesHandler,
 * ExpenseDebitReducer, ChangeResidencyHandler, etc.) but builds scenarios
 * directly rather than through IntlRetirementScenario so each test covers
 * a single concern in isolation.
 *
 * These tests are designed to catch the class of bug where serialization
 * produces structurally correct configs but incorrect runtime behaviour.
 *
 * Regression:
 *   - isAuResident must stay false when ChangeResidency OneOffEvent is dated
 *     in the future (the 'OneOff' vs 'OneOffEvent' serializer bug would cause
 *     ChangeResidencyHandler to fire every month-end, setting isAuResident=true).
 *   - MonthlyExpensesHandler must debit usSavingsAccount when isAuResident=false.
 *   - Modifying monthlyExpenses in the serialized config+state changes behaviour.
 *
 * Run with: node --test tests/unit/serializer-finance-roundtrip.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Simulation }      from '../../src/simulation-framework/simulation.js';
import { HandlerEntry }    from '../../src/simulation-framework/handlers.js';
import {
  AmountAction, Action, FieldAction, FieldValueAction, ScriptedAction,
  RecordBalanceAction, ActionDefinition,
} from '../../src/simulation-framework/actions.js';
import {
  FieldReducer, NumericSumReducer, ArrayReducer, MultiplicativeReducer,
  NoOpReducer, ScriptedReducer,
} from '../../src/simulation-framework/reducers.js';
import { ReducerBuilder }  from '../../src/simulation-framework/builders/reducer-builder.js';
import { EventSeries }     from '../../src/simulation-framework/events/event-series.js';
import { OneOffEvent }     from '../../src/simulation-framework/events/one-off-event.js';

import { ServiceRegistry }    from '../../src/services/service-registry.js';
import { BaseScenario }       from '../../src/scenarios/base-scenario.js';
import { ScenarioSerializer } from '../../src/scenarios/scenario-serializer.js';

import { Person }             from '../../src/finance/person.js';
import { Account, SavingsAccount } from '../../src/finance/assets/account.js';
import {
  RothAccount, TraditionalIRAAccount, FourOhOneKAccount, BrokerageAccount,
  SuperannuationAccount,
} from '../../src/finance/assets/investment-account.js';
import { ACCOUNT_ROLES } from '../../src/finance/state/account-roles.js';

import { MonthlyExpensesHandler }     from '../../src/finance/handlers/monthly-expenses-handler.js';
import { ChangeResidencyHandler }     from '../../src/finance/handlers/change-residency-handler.js';
import { UsSavingsInterestMonthlyHandler } from '../../src/finance/handlers/us-savings-interest-handler.js';
import { ExpenseDebitReducer }        from '../../src/finance/reducers/expense-debit-reducer.js';
import { ReplenishSavingsReducer }    from '../../src/finance/reducers/replenish-savings-reducer.js';
import { ChangeResidencyApplyReducer } from '../../src/finance/reducers/change-residency-apply-reducer.js';
import { UsSavingsInterestCreditReducer } from '../../src/finance/reducers/us-savings-interest-credit-reducer.js';
import { TaxService }                from '../../src/finance/tax-service.js';
import { DynamicTaxReducer }         from '../../src/finance/tax/dynamic-tax-reducer.js';
import {
  PeriodAdvanceReducer, PeriodAdvanceHandler,
} from '../../src/finance/tax/period-advance-classes.js';
import {
  TaxSettleHandler, TaxSettleApplyReducer, TaxPaymentDebitReducer,
} from '../../src/finance/tax/tax-settle-classes.js';
// Account-module classes needed by serializer dispatch maps
import {
  RothContributionApplyReducer, RothEarningsApplyReducer,
  RothContributionHandler,
} from '../../src/finance/account-rules/us/roth-classes.js';
import {
  IraContributionApplyReducer, IraEarningsApplyReducer,
  IraContributionHandler,
} from '../../src/finance/account-rules/us/ira-classes.js';

// ─── Shared helpers ───────────────────────────────────────────────────────────

const SIM_START = new Date(Date.UTC(2026, 0, 1));
const SIM_END   = new Date(Date.UTC(2041, 0, 1));

const STUB_UI = {
  _listeners: { eventCreated: [], handlerCreated: [], actionCreated: [], reducerCreated: [] },
  registerEventCreatedListener(l)   { this._listeners.eventCreated.push(l); },
  registerHandlerCreatedListener(l) { this._listeners.handlerCreated.push(l); },
  registerActionCreatedListener(l)  { this._listeners.actionCreated.push(l); },
  registerReducerCreatedListener(l) { this._listeners.reducerCreated.push(l); },
};

function makeContext() {
  return ServiceRegistry.getInstance().simulationContext;
}

function buildAndSerialize(initialState, buildFn) {
  ServiceRegistry.reset();
  const scenario = new BaseScenario({
    eventSchedulerUI: STUB_UI,
    context: makeContext(),
    initialState,
    simStart: SIM_START,
    simEnd:   SIM_END,
  });
  scenario.buildSim();
  buildFn(ServiceRegistry.getInstance());
  const sr = ServiceRegistry.getInstance();
  const config = ScenarioSerializer.serialize(
    sr, 'test', 'Finance Test', 1, true,
    scenario.simStart, scenario.simEnd,
    scenario.initialState, [],
  );
  return { sim: scenario.sim, config };
}

function restoreFromConfig(config) {
  ServiceRegistry.reset();
  const scenario = new BaseScenario({
    eventSchedulerUI: STUB_UI,
    context:  makeContext(),
    initialState: config.initialState ?? {},
    simStart: new Date(config.simStart),
    simEnd:   new Date(config.simEnd),
  });
  scenario.buildSim();
  ScenarioSerializer.deserializeGraph(config, ServiceRegistry.getInstance());
  return { scenario, sim: scenario.sim };
}

const Q1_2026 = new Date(Date.UTC(2026, 2, 31));   // Mar 31 2026

// ═════════════════════════════════════════════════════════════════════════════
// Test 1: Account stateKey preserved through round-trip
// ═════════════════════════════════════════════════════════════════════════════

test('finance round-trip: account stateKey is preserved through serialize/deserialize', () => {
  const { config } = buildAndSerialize({}, (sr) => {
    const acc = new SavingsAccount(30000, {
      name: 'US Savings', role: ACCOUNT_ROLES.US_SAVINGS, minimumBalance: 3000,
    });
    acc.stateKey = 'usSavingsAccount';
    sr.accountService.register(acc);
  });

  const usSavings = config.accounts.find(a => a.name === 'US Savings');
  assert.ok(usSavings, 'US savings must appear in serialized config');
  assert.strictEqual(usSavings.stateKey, 'usSavingsAccount',
    'serialized stateKey must be "usSavingsAccount"');

  const { scenario } = restoreFromConfig(config);
  const sr2 = ServiceRegistry.getInstance();
  const restoredAccounts = sr2.accountService.getAll();
  const restoredUs = restoredAccounts.find(a => a.name === 'US Savings');
  assert.ok(restoredUs, 'account must exist after restore');
  assert.strictEqual(restoredUs.stateKey, 'usSavingsAccount',
    'restored stateKey must match original');
});

// ═════════════════════════════════════════════════════════════════════════════
// Test 2: isAuResident stays false when ChangeResidency event is in the future
// ═════════════════════════════════════════════════════════════════════════════

test('finance round-trip: isAuResident stays false when ChangeResidency is in the future', () => {
  // The ChangeResidency OneOffEvent is dated 2031-07-01 — well after our 3-month run.
  // If the event is accidentally serialized as EventSeries (the 'OneOff' bug),
  // ChangeResidencyHandler fires every month-end and isAuResident becomes true
  // on the very first tick.
  const moveDate = new Date(Date.UTC(2031, 6, 1));

  const { sim: simOrig, config } = buildAndSerialize(
    { isAuResident: false },
    (sr) => {
      // OneOffEvent for change of residency — far in the future
      const changeResidency = sr.eventService.createOneOffEvent({
        name: 'Move to AU', type: 'CHANGE_RESIDENCY', date: moveDate, enabled: true,
      });
      const handler = new ChangeResidencyHandler();
      handler.handledEvents.push(changeResidency);
      sr.handlerService.register(handler);

      const reducer = new ChangeResidencyApplyReducer({
        accountService: sr.accountService,
        stateRegistry:  sr.stateRegistry,
      });
      sr.reducerService.register(reducer);
    }
  );

  // Original: isAuResident must still be false after 3 months
  simOrig.stepTo(Q1_2026);
  assert.strictEqual(simOrig.state.isAuResident, false,
    'original: isAuResident should remain false before the move date');

  // Restored: same guarantee
  const { sim: simRestored } = restoreFromConfig(config);
  simRestored.stepTo(Q1_2026);
  assert.strictEqual(simRestored.state.isAuResident, false,
    'restored: isAuResident must remain false — ChangeResidency OneOffEvent must not ' +
    'fire as a monthly EventSeries after round-trip');
});

// ═════════════════════════════════════════════════════════════════════════════
// Test 3: MonthlyExpensesHandler debits usSavingsAccount when not AU resident
// ═════════════════════════════════════════════════════════════════════════════

test('finance round-trip: MonthlyExpensesHandler debits usSavingsAccount when isAuResident=false', () => {
  const PRIMARY_ID = 'primary';

  // Account plain objects must be in initialState so the simulation state
  // has them from the start (sim.state = structuredClone(initialState)).
  // Accounts are also registered with accountService for stateRegistry lookups
  // and transaction calls; both paths must be consistent.
  const initialState = {
    isAuResident: false,
    monthlyExpenses: 6000,
    people: { primary: { name: 'Primary' } },
    usSavingsAccount: { balance: 30000, minimumBalance: 3000 },
    auSavingsAccount: { balance: 50000, minimumBalance: 3000 },
  };

  const { sim: simOrig, config } = buildAndSerialize(initialState, (sr) => {
    const primary = new Person('primary', new Date(Date.UTC(1978, 3, 15)),
      { name: 'Primary', citizen: ['US'] });
    sr.personService.register(primary);

    // US savings — must also be in accountService so stateRegistry.getStateKey() resolves
    const usSavings = new SavingsAccount(30000, {
      name: 'US Savings', role: ACCOUNT_ROLES.US_SAVINGS, ownerId: PRIMARY_ID, minimumBalance: 3000,
    });
    usSavings.stateKey = 'usSavingsAccount';
    sr.accountService.register(usSavings);

    const auSavings = new SavingsAccount(50000, {
      name: 'AU Savings', role: ACCOUNT_ROLES.AU_SAVINGS, ownerId: PRIMARY_ID, minimumBalance: 3000,
    });
    auSavings.stateKey = 'auSavingsAccount';
    sr.accountService.register(auSavings);

    const monthEnd = sr.eventService.createEventSeries({
      name: 'Month End', type: 'MONTHLY_EXPENSES', interval: 'month-end', enabled: true,
    });

    const expHandler = new MonthlyExpensesHandler({
      stateRegistry: sr.stateRegistry, monthlyExpenses: 6000,
      usRole: ACCOUNT_ROLES.US_SAVINGS, usOwnerId: PRIMARY_ID,
      auRole: ACCOUNT_ROLES.AU_SAVINGS, auOwnerId: PRIMARY_ID,
    });
    expHandler.handledEvents.push(monthEnd);
    sr.handlerService.register(expHandler);

    const replenishReducer = new ReplenishSavingsReducer({ accountService: sr.accountService });
    sr.reducerService.register(replenishReducer);

    const expenseReducer = new ExpenseDebitReducer({
      accountService: sr.accountService, usAccountKey: 'usSavingsAccount', auAccountKey: 'auSavingsAccount',
    });
    sr.reducerService.register(expenseReducer);
  });

  // Original: after 3 months × $6k = $18k drawn from US savings
  simOrig.stepTo(Q1_2026);
  const origUsBalance = simOrig.state.usSavingsAccount?.balance;
  const origAuBalance = simOrig.state.auSavingsAccount?.balance;
  assert.ok(origUsBalance != null, 'usSavingsAccount balance must exist');
  assert.ok(origUsBalance < 30000, `US savings must have been debited: ${origUsBalance}`);
  assert.strictEqual(origAuBalance, 50000, 'AU savings must remain untouched');

  // Restored: same result
  const { sim: simRestored } = restoreFromConfig(config);
  simRestored.stepTo(Q1_2026);
  const restUsBalance = simRestored.state.usSavingsAccount?.balance;
  const restAuBalance = simRestored.state.auSavingsAccount?.balance;

  assert.strictEqual(restUsBalance, origUsBalance,
    `US savings mismatch — original: ${origUsBalance}, restored: ${restUsBalance}`);
  assert.strictEqual(restAuBalance, origAuBalance,
    `AU savings mismatch — original: ${origAuBalance}, restored: ${restAuBalance}`);
});

// ═════════════════════════════════════════════════════════════════════════════
// Test 4: Modifying monthlyExpenses in both handler config AND initialState changes result
// ═════════════════════════════════════════════════════════════════════════════

test('finance round-trip: increasing monthlyExpenses in config+state reduces US savings', () => {
  // This test documents the correct pattern for editing monthly expenses in a
  // serialized config: both the handler's monthlyExpenses AND initialState.monthlyExpenses
  // must be updated, because MonthlyExpensesHandler reads state.monthlyExpenses first
  // (InflationAdjustReducer owns it as the live value).
  const PRIMARY_ID = 'primary';
  const initialState = {
    isAuResident: false,
    monthlyExpenses: 6000,
    people: { primary: { name: 'Primary' } },
    usSavingsAccount: { balance: 60000, minimumBalance: 3000 },
    auSavingsAccount: { balance: 50000, minimumBalance: 3000 },
  };

  const { config } = buildAndSerialize(initialState, (sr) => {
    const primary = new Person('primary', new Date(Date.UTC(1978, 3, 15)),
      { name: 'Primary', citizen: ['US'] });
    sr.personService.register(primary);

    const usSavings = new SavingsAccount(60000, {
      name: 'US Savings', role: ACCOUNT_ROLES.US_SAVINGS, ownerId: PRIMARY_ID, minimumBalance: 3000,
    });
    usSavings.stateKey = 'usSavingsAccount';
    sr.accountService.register(usSavings);

    const auSavings = new SavingsAccount(50000, {
      name: 'AU Savings', role: ACCOUNT_ROLES.AU_SAVINGS, ownerId: PRIMARY_ID, minimumBalance: 3000,
    });
    auSavings.stateKey = 'auSavingsAccount';
    sr.accountService.register(auSavings);

    const monthEnd = sr.eventService.createEventSeries({
      name: 'Month End', type: 'MONTHLY_EXPENSES', interval: 'month-end', enabled: true,
    });
    const expHandler = new MonthlyExpensesHandler({
      stateRegistry: sr.stateRegistry, monthlyExpenses: 6000,
      usRole: ACCOUNT_ROLES.US_SAVINGS, usOwnerId: PRIMARY_ID,
      auRole: ACCOUNT_ROLES.AU_SAVINGS, auOwnerId: PRIMARY_ID,
    });
    expHandler.handledEvents.push(monthEnd);
    sr.handlerService.register(expHandler);

    const replenishReducer = new ReplenishSavingsReducer({ accountService: sr.accountService });
    sr.reducerService.register(replenishReducer);

    const expenseReducer = new ExpenseDebitReducer({
      accountService: sr.accountService, usAccountKey: 'usSavingsAccount', auAccountKey: 'auSavingsAccount',
    });
    sr.reducerService.register(expenseReducer);
  });

  // Baseline: run with original config
  const { sim: simBase } = restoreFromConfig(config);
  simBase.stepTo(Q1_2026);
  const baseBalance = simBase.state.usSavingsAccount?.balance;
  assert.ok(baseBalance != null, 'baseline usSavingsAccount balance must exist');

  // Modified: increase monthly expenses by $3000 in BOTH handler config AND initialState
  const modified = JSON.parse(JSON.stringify(config));
  const expHandler = modified.handlers.find(h => h.__type === 'MonthlyExpensesHandler');
  assert.ok(expHandler, 'MonthlyExpensesHandler must be in serialized config');
  expHandler.monthlyExpenses = expHandler.monthlyExpenses + 3000;
  modified.initialState.monthlyExpenses = (modified.initialState.monthlyExpenses ?? 6000) + 3000;

  const { sim: simModified } = restoreFromConfig(modified);
  simModified.stepTo(Q1_2026);
  const modBalance = simModified.state.usSavingsAccount?.balance;
  assert.ok(modBalance != null, 'modified usSavingsAccount balance must exist');

  // 3 months × $3000 extra = ~$9000 less
  const reduction = baseBalance - modBalance;
  assert.ok(reduction > 8000,
    `expected reduction ~$9000; got ${reduction.toFixed(2)} ` +
    `(base=${baseBalance.toFixed(2)}, modified=${modBalance.toFixed(2)})`);
});
