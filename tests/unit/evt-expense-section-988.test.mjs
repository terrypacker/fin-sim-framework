/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * evt-expense-section-988.test.mjs — design 87 §14.4 item 2.
 *
 * Spending foreign currency on goods and services is a disposition, priced by
 * `§1.988-2(a)(2)(ii)(B)` as a sale of the units for USD at spot followed by a purchase
 * for those dollars. It is the highest-volume emitter by far, and the one where
 * §988(e)(3)'s "to the extent" fraction stops being a per-account constant: a household
 * pool pays for groceries (personal) and a rental's rates (§212) out of the same balance
 * on the same day.
 *
 * Four handlers emit `EXPENSE_DEBIT` and each declares its own character:
 *
 *   EXP988-1..2   MonthlyExpensesHandler — living expenses are personal, and what that means.
 *   EXP988-3..5   the property handlers — §212 on a rental, personal on a home, blended
 *                 across both, plus §4's live flip when a rental stops renting.
 *   EXP988-6      ExpenseEventHandler — a property-linked event inherits the property.
 *   EXP988-7      the reducer names the pool, including via the residency fallback.
 *
 * Run with: node --test tests/unit/evt-expense-section-988.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { MonthlyExpensesHandler }       from '../../src/finance/handlers/monthly-expenses-handler.js';
import { HouseRunningCostHandler }      from '../../src/finance/handlers/house-running-cost-handler.js';
import { RealPropertyRepairTickHandler } from '../../src/finance/handlers/real-property-repair-tick-handler.js';
import { ExpenseEventHandler }          from '../../src/finance/spending/strategies/expense-event-handler.js';
import { ExpenseDebitReducer }          from '../../src/finance/reducers/expense-debit-reducer.js';
import { createCurrencyLotObserver }    from '../../src/finance/account-rules/currency-lot-observer.js';
import { propertyExpenseBusinessFraction, blendExpenseBusinessFraction }
  from '../../src/finance/account-rules/currency-basis.js';
import { AccountService } from '../../src/finance/services/account-service.js';
import { ALLOCATION }     from '../../src/finance/holdings/allocation.js';
import { ACCOUNT_ROLES }  from '../../src/finance/state/account-roles.js';

const STRONG = 1.30;   // AUD per USD — a LOWER number is a stronger AUD
const WEAK   = 1.55;
const DATE   = new Date('2030-06-30');

function deposit({ stateKey, balance, currency = 'AUD', country = 'AU', role, ...rest }) {
  return {
    id: stateKey, stateKey, country, role,
    currency: { code: currency, symbol: '$' },
    balance, minimumBalance: 0, ownerId: 'primary',
    holdings: [{ id: `${stateKey}-cash`, allocation: ALLOCATION.CASH,
                 marketValue: balance, costBasis: balance }],
    ...rest,
  };
}

/** A real-property state entry, only the fields the two cost handlers read. */
function property({ stateKey, value = 800000, rentalEnabled = false, annualRunningCost = 12000, ...rest }) {
  return { stateKey, value, country: 'AU', currency: { code: 'AUD' },
           annualRunningCost, runningCostValuePct: 0, runningCostGrowth: 0,
           rentalEnabled, ...rest };
}

function baseState({ rate = WEAK, extra = {} } = {}) {
  return {
    effectiveExchangeRates: { USD_AUD: rate },
    inflationAccumulator: { AU: 1, US: 1 },
    people: { primary: { id: 'primary', residency: 'AU', birthDate: new Date('1966-01-01') } },
    auSavingsAccount: deposit({ stateKey: 'auSavingsAccount', balance: 200000,
                                role: ACCOUNT_ROLES.AU_SAVINGS, fxBasisRate: STRONG }),
    ...extra,
  };
}

const registry = {
  getStateKey: () => 'auSavingsAccount',
  resolveTransactionAccountKey: () => 'auSavingsAccount',
  getFlaggedStateKey: () => null,
};

/** The EXPENSE_DEBIT a handler emitted (there is at most one per target). */
const debitsOf = (actions) => actions.filter(a => a.type === 'EXPENSE_DEBIT');

/** Run an EXPENSE_DEBIT through the real reducer inside an observer bracket. */
function spend(state, action, observer = createCurrencyLotObserver()) {
  const reducer = new ExpenseDebitReducer({ accountService: new AccountService() });
  const token   = observer.before(state);
  reducer.reduce(state, action, DATE);
  return observer.after(state, token, action, DATE);
}

// ─── EXP988-1..2 · living expenses ────────────────────────────────────────────────────

test('EXP988-1 monthly living expenses declare a PERSONAL disposition', () => {
  const h = new MonthlyExpensesHandler({
    stateRegistry: registry, expensesCurrency: 'AUD', monthlyExpenses: 8000,
    usRole: ACCOUNT_ROLES.US_SAVINGS, auRole: ACCOUNT_ROLES.AU_SAVINGS,
  });
  const state = baseState();
  const [debit] = debitsOf(h.call({ data: { amount: 8000 }, state, date: DATE }));

  assert.equal(debit.section988.kind, 'DISPOSE');
  assert.equal(debit.section988.businessFraction, 0,
    '§1.988-1(a)(9) Example 2 — a household outlay is not a §988 transaction at all');
});

test('EXP988-2 a personal expense disposition is CAPITAL, never ordinary §988', () => {
  // AUD strengthens 1.55 → 1.30, so the units bought more dollars than their basis: a
  // gain. Large enough to clear the §988(e)(2) \$200 floor, which is what makes the
  // ordinary-vs-capital distinction observable at all.
  const state = baseState({ rate: STRONG });
  state.auSavingsAccount.fxBasisRate = WEAK;
  // Authored fully income-producing, so the ACCOUNT scalar would say ordinary. The
  // per-disposition declaration must win.
  state.auSavingsAccount.deductibleFraction = 1;

  const emitted = spend(state, { type: 'EXPENSE_DEBIT', amount: 50000, targetKey: 'auSavingsAccount',
                                 section988: { kind: 'DISPOSE', businessFraction: 0 } });

  assert.equal(emitted.length, 1);
  assert.ok(emitted[0].gross > 200, 'a gain clear of the $200 floor');
  assert.equal(emitted[0].amount, 0, 'nothing ordinary');
  assert.ok(emitted[0].capitalGain > 0, 'the personal share is capital — G10');
  assert.equal(emitted[0].accountKey, 'auSavingsAccount', 'the reducer named the pool');
});

// ─── EXP988-3..5 · property expenses ──────────────────────────────────────────────────

test('EXP988-3 running costs are §212 on a RENTAL and personal on a HOME', () => {
  // The load-bearing pair: byte-identical properties, identical debits, and the only
  // difference is whether the property produces income. Without the home arm the rental
  // assertion would pass equally well against a handler that declared 1 unconditionally.
  const mk = (rentalEnabled) => {
    const h = new HouseRunningCostHandler({
      stateRegistry: registry, propertyKeys: ['auHouse'],
      usRole: ACCOUNT_ROLES.US_SAVINGS, auRole: ACCOUNT_ROLES.AU_SAVINGS,
      startDate: DATE,
    });
    const state = baseState({ extra: { auHouse: property({ stateKey: 'auHouse', rentalEnabled }) } });
    return debitsOf(h.call({ state, date: DATE }))[0];
  };

  const rental = mk(true);
  const home   = mk(false);
  assert.equal(rental.section988.businessFraction, 1, 'a rental clears §212');
  assert.equal(home.section988.businessFraction, 0, 'a residence does not');
  assert.equal(rental.amount, home.amount, 'CONTROL: the same money either way — only character differs');
});

test('EXP988-4 a home and a rental in ONE debit blend by weight, not winner-takes-all', () => {
  // Both handlers sum every property into a single EXPENSE_DEBIT, so the fraction has to
  // be debit-weighted. §988(e)(3) is already a "to the extent" fraction, so a tick that is
  // 25% rental by cost is 25% ordinary — not all-or-nothing on whichever property is first.
  const h = new HouseRunningCostHandler({
    stateRegistry: registry, propertyKeys: ['home', 'rental'],
    usRole: ACCOUNT_ROLES.US_SAVINGS, auRole: ACCOUNT_ROLES.AU_SAVINGS, startDate: DATE,
  });
  const state = baseState({ extra: {
    home:   property({ stateKey: 'home',   rentalEnabled: false, annualRunningCost: 36000 }),
    rental: property({ stateKey: 'rental', rentalEnabled: true,  annualRunningCost: 12000 }),
  } });

  const [debit] = debitsOf(h.call({ state, date: DATE }));
  assert.ok(Math.abs(debit.section988.businessFraction - 0.25) < 1e-9,
    `12000 of 48000 is §212 ⇒ 0.25, got ${debit.section988.businessFraction}`);

  // And the split reaches the return: a gain divides between ordinary and capital in
  // that ratio rather than landing wholly in one.
  const live = baseState({ rate: STRONG });
  live.auSavingsAccount.fxBasisRate = WEAK;
  const emitted = spend(live, { type: 'EXPENSE_DEBIT', amount: 50000, targetKey: 'auSavingsAccount',
                                section988: { kind: 'DISPOSE', businessFraction: 0.25 } });
  assert.equal(emitted.length, 1);
  const g = emitted[0];
  assert.ok(Math.abs(g.amount - g.gross * 0.25) < 0.01, 'a quarter is ordinary §988');
  assert.ok(Math.abs(g.capitalGain - g.gross * 0.75) < 0.01, 'three quarters is capital');
});

test('EXP988-5 a rental that stops renting flips SUBSEQUENT debits to personal', () => {
  // Design 87 §4's trap, and the reason the fraction is read per tick rather than
  // authored once: `rentalEnabled` is live state. The asymmetry is dormant in a rental
  // scenario, not absent — the same currency loss is deductible before the flip and
  // disallowed after it, with nothing re-authored in between.
  const h = new HouseRunningCostHandler({
    stateRegistry: registry, propertyKeys: ['auHouse'],
    usRole: ACCOUNT_ROLES.US_SAVINGS, auRole: ACCOUNT_ROLES.AU_SAVINGS, startDate: DATE,
  });
  const state = baseState({ extra: { auHouse: property({ stateKey: 'auHouse', rentalEnabled: true }) } });

  assert.equal(debitsOf(h.call({ state, date: DATE }))[0].section988.businessFraction, 1);
  state.auHouse.rentalEnabled = false;
  assert.equal(debitsOf(h.call({ state, date: DATE }))[0].section988.businessFraction, 0,
    'no re-authoring — the same handler reads the new state');
});

test('EXP988-5b repair ticks carry the same rule as running costs', () => {
  // The repair handler is the second property emitter and drifting apart from the first
  // would split one pool's character on which handler happened to fire.
  const h = new RealPropertyRepairTickHandler({
    stateRegistry: registry, propertyKeys: ['rental'],
    usRole: ACCOUNT_ROLES.US_SAVINGS, auRole: ACCOUNT_ROLES.AU_SAVINGS,
  });
  const state = baseState({ extra: {
    rental: property({ stateKey: 'rental', rentalEnabled: true, annualRunningCost: 0,
                       repairModel: 'CONTINUOUS', repairMedian: 5000, repairSigma: 0 }),
  } });
  // A deterministic "RNG": CONTINUOUS draws one lognormal severity per year.
  const sim = { rng: () => 0.5 };

  const debits = debitsOf(h.call({ sim, state }));
  assert.equal(debits.length, 1, 'the repair drew a cost');
  assert.equal(debits[0].section988.kind, 'DISPOSE');
  assert.equal(debits[0].section988.businessFraction, 1, 'repairs on a rental are §212');

  state.rental.rentalEnabled = false;
  assert.equal(debitsOf(h.call({ sim, state }))[0].section988.businessFraction, 0);
});

// ─── EXP988-6 · one-off expense events ────────────────────────────────────────────────

test('EXP988-6 a property-linked event inherits the property; both legs agree', () => {
  // An event part-funded from a nominated account and part from savings is ONE
  // transaction under §988(e)(2)'s per-transaction floor, so the two debits must not
  // disagree about what the money bought.
  const h = new ExpenseEventHandler({
    stateRegistry: registry, expensesCurrency: 'AUD',
    usRole: ACCOUNT_ROLES.US_SAVINGS, auRole: ACCOUNT_ROLES.AU_SAVINGS,
  });
  const state = baseState({ extra: {
    rental:    property({ stateKey: 'rental', rentalEnabled: true }),
    auOffset:  deposit({ stateKey: 'auOffset', balance: 5000, role: ACCOUNT_ROLES.AU_SAVINGS }),
  } });

  const debits = debitsOf(h.call({ state, data: {
    amount: 20000, currency: 'AUD', propertyKey: 'rental', fundFrom: 'auOffset',
  } }));

  assert.equal(debits.length, 2, 'part-funded: the offset then the savings account');
  for (const d of debits) {
    assert.equal(d.section988.kind, 'DISPOSE');
    assert.equal(d.section988.businessFraction, 1, 'both legs inherit the rental');
  }
  // Separate objects, not one shared reference: `ExpenseDebitReducer` stamps `accountKey`
  // onto the declaration it is handed, so a shared object would have the second leg
  // rewrite the first leg's pool.
  assert.notEqual(debits[0].section988, debits[1].section988);

  const personal = debitsOf(h.call({ state, data: { amount: 20000, currency: 'AUD' } }));
  assert.equal(personal[0].section988.businessFraction, 0,
    'CONTROL: an event with no property is personal');
});

// ─── EXP988-7 · the reducer names the pool ────────────────────────────────────────────

test('EXP988-7 the reducer names the pool it actually debited, fallback included', () => {
  // `targetKey` is optional: a bare EXPENSE_DEBIT falls back to the residence-appropriate
  // account, and only the reducer knows which that is. If the declaration did not pick up
  // the resolved key the disposal would still work (an unnamed DISPOSE applies to every
  // debit), but a multi-pool bracket would misattribute it.
  const state = baseState({ rate: STRONG });
  state.auSavingsAccount.fxBasisRate = WEAK;
  const reducer = new ExpenseDebitReducer({
    accountService: new AccountService(), auAccountKey: 'auSavingsAccount',
  });
  const action = { type: 'EXPENSE_DEBIT', amount: 50000,       // no targetKey
                   section988: { kind: 'DISPOSE', businessFraction: 0 } };
  reducer.reduce(state, action, DATE);

  assert.equal(action.section988.accountKey, 'auSavingsAccount',
    'resolved through the AU-residency fallback');
});

// ─── the two helpers, directly ────────────────────────────────────────────────────────

test('EXP988-8 propertyExpenseBusinessFraction matches the debt leg s rule', () => {
  // It must stay identical to `section988BusinessFraction`'s property branch in
  // loan-classes.js: the mortgage and the running costs of one property dispose out of
  // the same pool, and disagreeing rules would split its character on nothing but which
  // handler fired. Explicit `deductibleFraction` first, then `rentalEnabled`.
  assert.equal(propertyExpenseBusinessFraction({ rentalEnabled: true }), 1);
  assert.equal(propertyExpenseBusinessFraction({ rentalEnabled: false }), 0);
  assert.equal(propertyExpenseBusinessFraction(null), 0);
  assert.equal(propertyExpenseBusinessFraction({ rentalEnabled: true, deductibleFraction: 0.4 }), 0.4,
    'an authored fraction overrides the rental flag');
  assert.equal(propertyExpenseBusinessFraction({ deductibleFraction: 5 }), 1, 'clamped');

  assert.equal(blendExpenseBusinessFraction(300, 1200), 0.25);
  assert.equal(blendExpenseBusinessFraction(0, 0), 0, 'a zero debit is not a division by zero');
  assert.equal(blendExpenseBusinessFraction(5, 1), 1, 'clamped');
});
