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
 * loan-account-authoring.test.mjs
 *
 * A UI-authored loan has to survive four hops before it does anything: the controller
 * (role + stateKey), the serializer (save/reload), the state projection (the payment
 * handler reads runtime STATE, not the record) and the schedule gate (no event, no
 * payment). Each hop dropped loans before design 86's UI phase, and each failure is
 * silent — the loan sits in net worth as a debt that is never serviced, which reads as
 * a modelling choice rather than a bug.
 *
 * Run with: node --test tests/unit/loan-account-authoring.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadScenarioSim } from '../helpers/scenario-harness.js';
import { AccountsController } from '../../src/visualization/accounts/accounts-controller.js';
import { ScenarioSerializer } from '../../src/scenarios/scenario-serializer.js';
import { LoanAccount, AUD } from '../../src/finance/assets/account.js';
import { propertyNeedsLoanPayment, accountNeedsLoanPayment } from '../../src/finance/account-rules/loan-classes.js';
import { US_REAL_PROPERTY } from '../../src/scenarios/toolsets/us-real-property-toolset.js';
import { AU_REAL_PROPERTY } from '../../src/scenarios/toolsets/au-real-property-toolset.js';
import { US_RETIREMENT }    from '../../src/scenarios/toolsets/us-retirement-toolset.js';

/** Minimal AccountService stub: records registrations, no graph/bus. */
function makeService() {
  const accounts = [];
  return {
    accounts,
    getAll: () => accounts,
    createAccount: (a) => { a.id = `ac${accounts.length + 1}`; accounts.push(a); return a; },
  };
}

const LOAN_FORM = {
  type: 'loan', name: 'AU Mortgage', balance: 500_000, country: 'AU',
  currency: 'AUD', ownerId: 'primary', drawdownPriority: '',
  interestRate: 0, primeSpread: 0.02, monthlyPayment: 0,
  interestOnly: true, interestOnlyUntilYear: 2031, maturityYear: 2051,
  deductibleFraction: 0.6, bookingFxRate: 1.42,
  linkedPropertyKey: 'auHouseProperty', paymentSourceKey: 'auOffsetAccount',
};

describe('AccountsController — loan (liability) creation', () => {
  test('a created loan gets the country loan role and a stateKey', () => {
    const ctl = new AccountsController({ accountService: makeService() });
    const au = ctl.create({ ...LOAN_FORM });
    assert.equal(au.role, 'au-loan');
    assert.equal(au.stateKey, 'auLoanAccount');
    const us = ctl.create({ ...LOAN_FORM, country: 'US', currency: 'USD' });
    assert.equal(us.role, 'us-loan');
  });

  test('every design-86 term reaches the record', () => {
    const ctl = new AccountsController({ accountService: makeService() });
    const a = ctl.create({ ...LOAN_FORM });
    assert.equal(a.type, 'loan');
    assert.equal(a.balance, 500_000);
    assert.equal(a.currency.code, 'AUD');
    assert.equal(a.primeSpread, 0.02);
    assert.equal(a.interestOnly, true);
    assert.equal(a.interestOnlyUntilYear, 2031);
    assert.equal(a.maturityYear, 2051);
    assert.equal(a.deductibleFraction, 0.6);
    assert.equal(a.bookingFxRate, 1.42);
    assert.equal(a.linkedPropertyKey, 'auHouseProperty');
    assert.equal(a.paymentSourceKey, 'auOffsetAccount');
    // A liability is never a source of drawdown cash (design 54 §8).
    assert.equal(a.drawdownPriority, null);
  });

  test('an omitted term is null, not 0 — 0 is a real maturity year and a real 0% fraction', () => {
    const ctl = new AccountsController({ accountService: makeService() });
    const a = ctl.create({ type: 'loan', name: 'Bare', balance: 1_000, country: 'US', ownerId: 'primary' });
    assert.equal(a.interestOnlyUntilYear, null);
    assert.equal(a.maturityYear, null);
    assert.equal(a.deductibleFraction, null);
    assert.equal(a.bookingFxRate, null);
    assert.equal(a.interestOnly, false);
    assert.equal(a.monthlyPayment, 0);
  });

  test('update: a cleared term becomes null, and a cleared cash rate is still nullable', () => {
    const svc = makeService();
    const acct = { id: 'ac1', stateKey: 'auLoanAccount', maturityYear: 2051, deductibleFraction: 0.6 };
    svc.accounts.push(acct);
    svc.updateAccount = (id, changes) => { Object.assign(acct, changes); return acct; };
    const ctl = new AccountsController({ accountService: svc });

    const out = ctl.update('ac1', { maturityYear: '', deductibleFraction: '', monthlyPayment: '3400', interestOnly: 'on' });
    assert.equal(out.maturityYear, null);
    assert.equal(out.deductibleFraction, null);
    assert.equal(out.monthlyPayment, 3400);
    assert.equal(out.interestOnly, true);

    // The loan coercion must not reach `interestRate`: a cash account clearing its
    // rate sends null, and turning that into 0 pins it at a real 0% rate.
    const cash = ctl.update('ac1', { interestRate: null });
    assert.equal(cash.interestRate, null);
  });
});

describe('ScenarioSerializer — LoanAccount round-trip', () => {
  test('every design-86 field survives serialize → deserialize', () => {
    const loan = new LoanAccount(500_000, {
      id: 'ac1', name: 'AU Mortgage', country: 'AU', currency: AUD,
      interestRate: 0.06, monthlyPayment: 3_400,
      linkedPropertyKey: 'auHouseProperty', paymentSourceKey: 'auOffsetAccount',
      interestOnly: true, deductibleFraction: 0.6,
      interestOnlyUntilYear: 2031, maturityYear: 2051, bookingFxRate: 1.42,
    });
    loan.stateKey = 'auLoanAccount';

    const json  = ScenarioSerializer._serializeAccount(loan);
    const round = ScenarioSerializer._makeAccount(json);

    for (const f of ['interestRate', 'monthlyPayment', 'linkedPropertyKey', 'paymentSourceKey',
                     'interestOnly', 'deductibleFraction', 'interestOnlyUntilYear',
                     'maturityYear', 'bookingFxRate']) {
      assert.deepEqual(round[f], loan[f], `${f} did not round-trip`);
    }
  });

  test('a legacy save with no term fields reloads as the pre-86 loan', () => {
    const round = ScenarioSerializer._makeAccount({
      __type: 'LoanAccount', id: 'ac1', name: 'Old Loan', balance: 100_000,
      interestRate: 0.05, monthlyPayment: 800,
    });
    assert.equal(round.interestOnly, false);
    assert.equal(round.interestOnlyUntilYear, null);
    assert.equal(round.maturityYear, null);
    assert.equal(round.deductibleFraction, null);
    assert.equal(round.bookingFxRate, null);
  });
});

describe('state projection — a loan record reaches runtime state with its terms', () => {
  test('_accountToStatePlain carries the loan fields the payment handler reads', () => {
    const loan = new LoanAccount(500_000, {
      id: 'ac1', name: 'AU Mortgage', country: 'AU', currency: AUD, role: 'au-loan',
      interestRate: 0, primeSpread: 0.02, monthlyPayment: 0,
      linkedPropertyKey: 'auHouseProperty', paymentSourceKey: 'auOffsetAccount',
      interestOnly: true, deductibleFraction: 0.6,
      interestOnlyUntilYear: 2031, maturityYear: 2051, bookingFxRate: 1.42,
    });
    loan.stateKey = 'auLoanAccount';

    const patches = US_RETIREMENT.state({
      accounts: [loan], people: [], realProperties: [], collectibles: [], companyEquities: [],
      parameters: {}, paramSchema: [], startDate: new Date('2026-01-01'),
    });
    const entry = patches.auLoanAccount;
    assert.ok(entry, 'the loan is missing from state entirely');
    assert.equal(entry.type, 'loan');
    assert.equal(entry.primeSpread, 0.02);
    assert.equal(entry.interestOnly, true);
    assert.equal(entry.interestOnlyUntilYear, 2031);
    assert.equal(entry.maturityYear, 2051);
    assert.equal(entry.deductibleFraction, 0.6);
    assert.equal(entry.bookingFxRate, 1.42);
    assert.equal(entry.linkedPropertyKey, 'auHouseProperty');
    assert.equal(entry.paymentSourceKey, 'auOffsetAccount');
  });
});

describe('LOAN_PAYMENT scheduling gate (design 86 G6)', () => {
  test('propertyNeedsLoanPayment: an IO or term-bearing mortgage counts, despite a 0 payment', () => {
    assert.equal(propertyNeedsLoanPayment({ mortgageBalance: 500_000, monthlyMortgage: 2_000 }), true);
    assert.equal(propertyNeedsLoanPayment({ mortgageBalance: 500_000, monthlyMortgage: 0 }), false);
    assert.equal(propertyNeedsLoanPayment({ mortgageBalance: 500_000, monthlyMortgage: 0, mortgageInterestOnly: true }), true);
    assert.equal(propertyNeedsLoanPayment({ mortgageBalance: 500_000, monthlyMortgage: 0, mortgageMaturityYear: 2051 }), true);
    // No debt ⇒ nothing to pay, whatever the terms say.
    assert.equal(propertyNeedsLoanPayment({ mortgageBalance: 0, mortgageInterestOnly: true }), false);
  });

  test('accountNeedsLoanPayment: country-filtered, and only for a real liability', () => {
    const loan = { type: 'loan', country: 'AU', balance: 500_000, interestOnly: true };
    assert.equal(accountNeedsLoanPayment(loan, 'AU'), true);
    assert.equal(accountNeedsLoanPayment(loan, 'US'), false);
    assert.equal(accountNeedsLoanPayment({ ...loan, type: 'savings' }, 'AU'), false);
    assert.equal(accountNeedsLoanPayment({ ...loan, balance: 0 }, 'AU'), false);
    assert.equal(accountNeedsLoanPayment({ type: 'loan', country: 'AU', balance: 1 }, 'AU'), false);
  });

  for (const [label, TOOLSET, country, evtType] of [
    ['US', US_REAL_PROPERTY, 'US', 'US_LOAN_PAYMENT'],
    ['AU', AU_REAL_PROPERTY, 'AU', 'AU_LOAN_PAYMENT'],
  ]) {
    test(`${label}: an interest-only mortgage with a 0 payment still schedules ${evtType}`, () => {
      const ctx = {
        accounts: [],
        realProperties: [{
          stateKey: 'houseProperty', name: 'House', country,
          mortgageBalance: 500_000, monthlyMortgage: 0, mortgageInterestOnly: true,
        }],
        stateRegistry: null, schedulesById: {},
      };
      const types = TOOLSET.schedules(ctx).map(s => s.type);
      assert.ok(types.includes(evtType), `no ${evtType} scheduled: ${types.join(', ')}`);
      assert.ok(TOOLSET.handlers(ctx).some(h => h.constructor.eventType === evtType));
    });

    test(`${label}: a standalone loan account schedules ${evtType} with no property at all`, () => {
      const ctx = {
        accounts: [{ type: 'loan', country, balance: 250_000, monthlyPayment: 1_800, stateKey: 'loanAccount' }],
        realProperties: [], stateRegistry: null, schedulesById: {},
      };
      const types = TOOLSET.schedules(ctx).map(s => s.type);
      assert.ok(types.includes(evtType), `no ${evtType} scheduled: ${types.join(', ')}`);
      assert.ok(TOOLSET.handlers(ctx).some(h => h.constructor.eventType === evtType));
    });

    test(`${label}: no loan and no property schedules nothing`, () => {
      const ctx = { accounts: [], realProperties: [], stateRegistry: null, schedulesById: {} };
      assert.deepEqual(TOOLSET.schedules(ctx), []);
      assert.deepEqual(TOOLSET.handlers(ctx), []);
    });
  }
});

describe('end to end — a standalone loan is actually serviced', () => {
  test('an authored LoanAccount amortizes over a real run', () => {
    const { sim } = loadScenarioSim({
      simStart: '2026-01-01',
      simEnd:   '2029-01-01',
      mutateCfg: (cfg) => {
        cfg.accounts.push({
          __type: 'LoanAccount', id: 'acLoan', name: 'Car Loan',
          stateKey: 'usLoanAccount', role: 'us-loan',
          country: 'US', currency: { code: 'USD', symbol: '$' },
          balance: 60_000, interestRate: 0.07, monthlyPayment: 1_200,
        });
      },
      stepTo: '2027-01-01',
      telemetry: 'off',
    });

    const loan = sim.state.usLoanAccount;
    assert.ok(loan, 'the loan never reached runtime state');
    // 12 × $1,200 against 7% on a falling balance ⇒ ~$10.5k of principal repaid.
    // The precise figure matters less than the fact that it MOVED: before the UI
    // phase the terms never reached state, so the balance sat at 60,000 forever
    // while the debt showed up in net worth — a liability nobody was paying.
    assert.ok(loan.balance < 50_000 && loan.balance > 49_000,
      `expected ~49.5k after a year of payments, got ${loan.balance}`);
  });
});
