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
 * evt-offset.test.mjs — OffsetAccount (design 53 §3 / 54 P3).
 *
 * An offset account is cash-like and liquid; its balance suppresses the
 * interest-bearing principal of the loan linked to the same property
 * (`effectivePrincipal = max(0, loanBalance − offsetBalance)`) without paying the
 * loan down. It must:
 *   - reduce a loan's effective principal (same-currency, same-property offsets sum);
 *   - lower monthly interest and speed payoff on an owner-occupied loan, while the
 *     offset cash itself stays untouched (still liquid);
 *   - stay a valid drawdown/replenish source (unlike a loan);
 *   - round-trip through the serializer with offsetsPropertyKey intact;
 *   - (compile path) lower the rental deductible interest, raising taxable rental,
 *     by offsetBalance × rate / 12.
 *
 * Run with: node --test tests/unit/evt-offset.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert   from 'node:assert/strict';

import { EventBus }       from '../../src/simulation-framework/event-bus.js';
import { Graph }          from '../../src/graph/graph.js';
import { GraphQueryApi }  from '../../src/graph/graph-query-api.js';
import { AccountService } from '../../src/finance/services/account-service.js';
import { USD, AUD, CheckingAccount, SavingsAccount, LoanAccount, OffsetAccount } from '../../src/finance/assets/account.js';
import { ACCOUNT_ROLES }  from '../../src/finance/state/account-roles.js';
import {
  LoanPaymentHandler, LoanPaymentApplyReducer,
  offsetBalanceForLoan, effectivePrincipal,
} from '../../src/finance/account-rules/loan-classes.js';
import { ScenarioSerializer } from '../../src/scenarios/scenario-serializer.js';
import { ServiceRegistry }    from '../../src/services/service-registry.js';
import { ScenarioLoader }     from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }       from '../../src/index.js';

const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps;

function makeSvc() {
  const g = new Graph();
  return new AccountService(g, new GraphQueryApi(g), new EventBus());
}

/** A plain runtime loan state entry (as synthesized by the real-property toolset). */
function loanEntry(overrides = {}) {
  return {
    type: 'loan', kind: 'account', stateKey: 'hLoan', balance: 100_000,
    interestRate: 0.06, monthlyPayment: 1_000, linkedPropertyKey: 'h',
    country: 'US', currency: USD, minimumBalance: 0, drawdownPriority: null, holdings: [],
    ...overrides,
  };
}

/** A plain runtime offset state entry. */
function offsetEntry(overrides = {}) {
  return {
    type: 'offset', kind: 'account', stateKey: 'off', balance: 40_000,
    offsetsPropertyKey: 'h', country: 'US', currency: USD, drawdownPriority: null, holdings: [],
    ...overrides,
  };
}

// ── offsetBalanceForLoan ────────────────────────────────────────────────────

test('OFFSET: offsetBalanceForLoan sums same-property, same-currency offsets', () => {
  const loan = loanEntry();
  const state = {
    hLoan: loan,
    off1:  offsetEntry({ stateKey: 'off1', balance: 25_000 }),
    off2:  offsetEntry({ stateKey: 'off2', balance: 15_000 }),
  };
  assert.strictEqual(offsetBalanceForLoan(state, loan), 40_000);
});

test('OFFSET: offsetBalanceForLoan ignores offsets for other properties and other currencies', () => {
  const loan = loanEntry(); // property 'h', USD
  const state = {
    hLoan:      loan,
    matched:    offsetEntry({ stateKey: 'matched', balance: 30_000 }),
    otherProp:  offsetEntry({ stateKey: 'otherProp', balance: 50_000, offsetsPropertyKey: 'other' }),
    otherCcy:   offsetEntry({ stateKey: 'otherCcy',  balance: 50_000, currency: AUD }),
    notAnOffset: { type: 'savings', balance: 99_999, offsetsPropertyKey: 'h', currency: USD },
  };
  assert.strictEqual(offsetBalanceForLoan(state, loan), 30_000);
});

// ── effectivePrincipal ──────────────────────────────────────────────────────

test('OFFSET: effectivePrincipal subtracts the offset, clamped at 0', () => {
  const loan = loanEntry({ balance: 100_000 });
  assert.strictEqual(effectivePrincipal({ hLoan: loan, off: offsetEntry({ balance: 30_000 }) }, 'hLoan', loan), 70_000);
  // Over-offset: never negative.
  assert.strictEqual(effectivePrincipal({ hLoan: loan, off: offsetEntry({ balance: 130_000 }) }, 'hLoan', loan), 0);
  // No offset present → full balance (backward-compatible).
  assert.strictEqual(effectivePrincipal({ hLoan: loan }, 'hLoan', loan), 100_000);
});

// ── Owner-occupied: interest reduction + faster payoff ──────────────────────

test('OFFSET: an offset lowers monthly interest and speeds payoff (paying from savings leaves it untouched)', () => {
  const svc = makeSvc();
  const reducer = new LoanPaymentApplyReducer({ accountService: svc });
  const handler = new LoanPaymentHandler();

  const runMonth = (state) => {
    let next = state;
    for (const a of handler.call({ state })) {
      if (a.type === 'LOAN_PAYMENT_APPLY') next = reducer.reduce(next, a);
    }
    return next;
  };

  // Baseline: no offset. interest = 100000 × 0.06/12 = 500; principal 500 → 99500.
  const baseline = runMonth({
    usSavingsAccount: new SavingsAccount(50_000, { country: 'US', currency: USD }),
    hLoan: loanEntry(),
  });
  assert.ok(near(baseline.hLoan.balance, 99_500), `baseline ${baseline.hLoan.balance}`);

  // With a 40k offset but paying explicitly from savings (design 54 P4 lets an
  // explicit paymentSourceKey override the auto-prefer-offset default): effPrincipal
  // 60000; interest 300; principal 700 → 99300. This isolates the interest effect.
  const withOffset = runMonth({
    usSavingsAccount: new SavingsAccount(50_000, { country: 'US', currency: USD }),
    hLoan: loanEntry({ paymentSourceKey: 'usSavingsAccount' }),
    off:   offsetEntry({ balance: 40_000 }),
  });
  assert.ok(near(withOffset.hLoan.balance, 99_300), `offset ${withOffset.hLoan.balance}`);
  assert.ok(withOffset.hLoan.balance < baseline.hLoan.balance, 'offset speeds principal payoff');
  // Paying from savings leaves the offset cash fully liquid.
  assert.strictEqual(withOffset.off.balance, 40_000, 'offset untouched when the payment is sourced from savings');
});

// ── Payment source: auto-prefer the linked offset (design 54 P4) ─────────────

test('OFFSET: the monthly payment auto-debits the linked offset (no explicit source)', () => {
  const svc = makeSvc();
  const reducer = new LoanPaymentApplyReducer({ accountService: svc });
  const handler = new LoanPaymentHandler();

  let state = {
    usSavingsAccount: new SavingsAccount(50_000, { country: 'US', currency: USD }),
    hLoan: loanEntry(),                       // no paymentSourceKey → auto-prefer offset
    off:   offsetEntry({ balance: 40_000 }),
  };
  const actions = handler.call({ state });
  for (const a of actions) {
    if (a.type === 'LOAN_PAYMENT_APPLY') state = reducer.reduce(state, a);
  }
  // effPrincipal 60000 → interest 300, principal 700 → loan 99300.
  assert.ok(near(state.hLoan.balance, 99_300), `loan ${state.hLoan.balance}`);
  // The full P&I (1000) leaves the OFFSET, not savings.
  assert.strictEqual(state.off.balance, 39_000, 'offset debited by the payment');
  assert.strictEqual(state.usSavingsAccount.balance, 50_000, 'savings untouched');
  // The debited offset must emit its own RECORD_BALANCE (design 54 P4): the offset has
  // no other monthly event, so without this its charted metric would freeze while its
  // balance drops. Guards the "metric not updating" regression.
  assert.ok(
    actions.some(a => a.type === 'RECORD_BALANCE' && a.metricKey === 'off'),
    'a RECORD_BALANCE snapshot is emitted for the debited offset',
  );
});

// ── Liquidity: offset is a valid drawdown source (unlike a loan) ────────────

test('OFFSET: offset cash is drawdown-eligible (replenishes a savings shortfall)', () => {
  const svc = makeSvc();
  const state = {
    usSavingsAccount: new SavingsAccount(1_000, { country: 'US', currency: USD, role: ACCOUNT_ROLES.US_SAVINGS, drawdownPriority: 1 }),
    offset: new OffsetAccount(20_000, { country: 'US', currency: USD, role: ACCOUNT_ROLES.US_OFFSET, offsetsPropertyKey: 'h', drawdownPriority: 2 }),
  };
  // Draw 5000 into savings; savings alone can't cover it, so the offset is tapped.
  svc.replenishSavings(state, 'usSavingsAccount', 5_000, new Date(2026, 0, 1));
  assert.ok(state.offset.balance < 20_000, 'offset was drawn down as a liquid source');
  assert.ok(state.usSavingsAccount.balance >= 1_000, 'savings topped up from the offset');
});

// ── Serializer round-trip ───────────────────────────────────────────────────

test('OFFSET: round-trips through the serializer with offsetsPropertyKey intact', () => {
  const offset = new OffsetAccount(75_000, {
    id: 'O1', name: 'Home Offset', role: ACCOUNT_ROLES.AU_OFFSET,
    country: 'AU', currency: AUD, offsetsPropertyKey: 'auHouseProperty', drawdownPriority: 3,
  });
  const round = ScenarioSerializer._makeAccount(ScenarioSerializer._serializeAccount(offset));
  assert.ok(round instanceof OffsetAccount);
  assert.strictEqual(round.type, 'offset');
  assert.strictEqual(round.balance, 75_000);
  assert.strictEqual(round.offsetsPropertyKey, 'auHouseProperty');
  assert.strictEqual(round.currency.code, 'AUD');
  assert.strictEqual(round.drawdownPriority, 3);
});

// ── Compile-path integration: rental deductible interest ────────────────────

beforeEach(() => ServiceRegistry.resetAll());

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

const findDiff = (entry, field) => entry.stateDiff.find(d => d.field === field);
const FEB_2026 = new Date(Date.UTC(2026, 1, 15));

// AU rental property with a 500k @ 6% mortgage (monthlyMortgage 0 → interest only,
// for the deduction), optionally offset by `offsetBalance`. Mirrors EVT-RENT-2.
function auRentalConfig({ offsetBalance = null } = {}) {
  const accounts = [{
    __type: 'SavingsAccount', id: 'au-savings', name: 'AU Savings',
    type: 'savings', role: 'au-savings', stateKey: 'auSavingsAccount',
    initialValue: 50_000, ownershipType: 'sole', ownerId: 'primary',
    minimumBalance: 0, country: 'AU', currency: { code: 'AUD', symbol: 'A$' },
  }];
  if (offsetBalance != null) {
    accounts.push({
      __type: 'OffsetAccount', id: 'au-offset', name: 'AU Offset',
      type: 'offset', role: 'au-offset', stateKey: 'auOffsetAccount',
      initialValue: offsetBalance, ownershipType: 'sole', ownerId: 'primary',
      // drawdownPriority null so the offset is not drained during the run — keeps
      // the deduction stable for the assertion.
      drawdownPriority: null, country: 'AU', currency: { code: 'AUD', symbol: 'A$' },
      offsetsPropertyKey: 'auHouseProperty',
    });
  }
  return {
    toolsets: ['AU_RETIREMENT', 'AU_REAL_PROPERTY', 'US_TAX'],
    simStart: '2026-01-01', simEnd: '2041-01-01',
    parameters: {},
    persons: [{
      __type: 'Person', id: 'primary', name: 'Primary',
      birthDate: '1975-04-15', lifeExpectancy: 90, citizen: ['AU'], residency: 'AU',
      monthlyWage: 0, retirementDate: '2025-01-01', socialSecurityMonthly: 0,
    }],
    accounts,
    realProperties: [{
      __type: 'RealProperty', id: 're1', name: 'AU Rental', country: 'AU',
      appreciationRate: 0, costBasis: 800_000, value: 1_000_000,
      mortgageBalance: 500_000, monthlyMortgage: 0, mortgageInterestRate: 0.06,
      isPrimaryResidence: false, ownerId: 'primary', owners: [], ownershipType: 'sole',
      plannedSaleYear: null, saleDestinationAccount: 'auSavingsAccount',
      stateKey: 'auHouseProperty',
      rentalEnabled: true, monthlyRent: 3_000, occupancyRate: 0.9,
      rentalExpenseRatio: 0.25, landValueRatio: 0.2, annualDepreciationOverride: 12_000,
    }],
  };
}

test('OFFSET (compile path): an offset lowers rental deductible interest, raising taxable rental', () => {
  // taxable = effectiveRent(2700) − opex(675) − interest − depreciation(1000).
  // Baseline interest = 500000 × 0.06/12 = 2500 → taxable = −1475.
  const base = loadToolsetScenario(auRentalConfig());
  assert.doesNotThrow(() => base.sim.stepTo(FEB_2026));
  const baseApply = base.sim.journal.getActions('AU_RENTAL_INCOME_TAX')[0];
  const baseTaxable = findDiff(baseApply, 'auOrdinaryIncomeYTD').delta;

  ServiceRegistry.resetAll();

  // With a 100k offset: effPrincipal 400000; interest = 400000 × 0.06/12 = 2000 →
  // taxable = −975. So taxable rises by exactly offsetBalance × rate/12 = 500.
  const off = loadToolsetScenario(auRentalConfig({ offsetBalance: 100_000 }));
  assert.doesNotThrow(() => off.sim.stepTo(FEB_2026));
  const offApply = off.sim.journal.getActions('AU_RENTAL_INCOME_TAX')[0];
  const offTaxable = findDiff(offApply, 'auOrdinaryIncomeYTD').delta;

  assert.ok(near(baseTaxable, -1475), `baseline taxable ${baseTaxable}`);
  assert.ok(near(offTaxable,   -975), `offset taxable ${offTaxable}`);
  assert.ok(near(offTaxable - baseTaxable, 500), `offset raises taxable by 500; got ${offTaxable - baseTaxable}`);
});
