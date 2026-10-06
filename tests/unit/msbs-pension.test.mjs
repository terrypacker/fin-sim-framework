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
 * msbs-pension.test.mjs — design 119 phase 5: the MSBS election, the pension and its tax.
 *
 *   MSP-1: Sch 5 — 10 at 65, plus 0.2 a year under it, pro rata by days
 *   MSP-2: the election converts the funded part first (r 65A); below \$5,000 it is all lump sum
 *   MSP-3: pension share — the loader rejects one the Rules forbid; a swept one snaps to the nearest
 *   MSP-4: r 61B / r 56 / r 58 — part-year and yearly increases
 *   MSP-5: a payment's tax facts by age band (s301-25, s301-110, s301-10, s301-100)
 *   MSP-6: the defined benefit income cap (s303-2, s303-3)
 *   MSP-7: the settle assesses the stream, and the offset is non-refundable
 *   MSP-8: the lump sum — to cash less 15% once released, else rolled into a fund that pays it
 *   MSP-9: a pension in payment counts P × PF toward total super balance (Table 4A)
 *   MSP-10: the pensioner dies — the spouse gets three full months, then 67%; with none it ends
 *
 * Run with: node --test tests/unit/msbs-pension.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { msbsConversionFactor, msbsElection, normalizePensionShare, validateMsbsAccounts,
  partYearIncrease, msbsPensionIncrease, pensionPaymentTax, superIncomeStreamTax,
  msbsTotalSuperBalance, msbsPensionFactor } from '../../src/finance/account-rules/au/msbs.js';
import { MsbsPensionHandler, MsbsElectionApplyReducer, MsbsPensionApplyReducer,
  MsbsPensionRevertReducer } from '../../src/finance/account-rules/au/msbs-classes.js';
import { AuTaxRates2026 } from '../../src/finance/tax/au/au-tax-rates-2026.js';

const D = (y, m, d) => Date.UTC(y, m - 1, d);
const near = (a, b, msg, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${msg}: got ${a}, want ${b}`);
const BORN = '1981-07-01';

test('MSP-1 Sch 5: 10 at 65, plus 0.2 a year under it, pro rata by days', () => {
  assert.equal(msbsConversionFactor(BORN, D(2046, 7, 1)), 10);
  assert.equal(msbsConversionFactor(BORN, D(2041, 7, 1)), 11);
  assert.equal(msbsConversionFactor(BORN, D(2036, 7, 1)), 12, '55 divides by 12');
  near(msbsConversionFactor(BORN, D(2042, 1, 1)), 11 - 0.2 * 184 / 365, 'half a year past 60');
});

test('MSP-2 the election converts the funded part first; below $5,000 it is all lump sum', () => {
  const r = msbsElection({ funded: 40_000, unfunded: 160_000, pensionShare: 0.5, birthDate: BORN, electionMs: D(2041, 7, 1) });
  assert.equal(r.converted, 100_000);
  near(r.taxedShare, 0.4, 'the funded 40,000 is in the converted 100,000 (r 65A)');
  assert.deepEqual([r.lumpTaxed, r.lumpUntaxed], [0, 100_000]);
  near(r.annual, 100_000 / 11, 'Sch 5, to the cent', 0.005);
  const small = msbsElection({ funded: 1_000, unfunded: 3_999, birthDate: BORN, electionMs: D(2041, 7, 1) });
  assert.deepEqual([small.annual, small.lumpTaxed, small.lumpUntaxed], [0, 1_000, 3_999], 'r 52(2), r 65B');
});

test('MSP-3 pension share: the loader rejects a forbidden one; a swept one snaps to the nearest', () => {
  const acct = o => ({ __type: 'MsbsAccount', stateKey: 'm', fundedEmployerBenefit: 10_000, unfundedEmployerBenefit: 0, ...o });
  assert.deepEqual(validateMsbsAccounts([acct({ pensionShare: 1 }), acct({ pensionShare: 0 })]), []);
  assert.match(validateMsbsAccounts([acct({ pensionShare: 0.3 })]).join(), /r 52\(1\)\(c\)/);
  assert.match(validateMsbsAccounts([acct({ fundedEmployerBenefit: 4_000 })]).join(), /r 65B/);
  assert.deepEqual([0, 0.2, 0.3, 0.8, 1.4].map(normalizePensionShare), [0, 0, 0.5, 0.8, 1]);
});

test('MSP-4 part-year and yearly increases (r 61B, r 56, r 58)', () => {
  assert.equal(partYearIncrease(100_000, 0.03, 6), 101_500, 'half a year of 3%');
  assert.equal(partYearIncrease(100_000, 0.03, 0), 100_000, 'elected on 1 July: none');
  assert.deepEqual(msbsPensionIncrease(10_000, 1.03, 1), { annual: 10_300, cpiPeak: 1.03 });
  assert.deepEqual(msbsPensionIncrease(10_000, 0.99, 1), { annual: 10_000, cpiPeak: 1 }, 'never falls');
  assert.equal(msbsPensionIncrease(10_000, 1.03, 1, 6).annual, 10_150, 'r 58(3): six months paid');
  assert.equal(msbsPensionIncrease(10_000, 1.03, 1, 0).annual, 10_000, 'r 58(2): started in the last fortnight');
});

test('MSP-5 a payment\'s tax facts by age band', () => {
  const pay = age => pensionPaymentTax({ amount: 1000, taxedShare: 0.2, age, preservationAge: 58 });
  assert.deepEqual(pay(57), { assessable: 1000, offset: 0, offset60: 0, taxed60: 0, total60: 0 }, 'under preservation age');
  const p59 = pay(59);
  assert.equal(p59.assessable, 1000);
  near(p59.offset, 30, 's301-25: 15% of the 200 taxed');
  const p61 = pay(61);
  near(p61.assessable, 800, 's301-10: the taxed element is not assessable');
  near(p61.offset60, 80, 's301-100: 10% of the 800 untaxed');
  assert.deepEqual([p61.taxed60, p61.total60], [200, 1000]);
});

test('MSP-6 the defined benefit income cap (s303-2, s303-3)', () => {
  const under = superIncomeStreamTax({ assessable: 80_000, offset60: 8_000, taxed60: 20_000, total60: 100_000 }, 125_000);
  assert.deepEqual(under, { assessable: 80_000, offset: 8_000 });
  const over = superIncomeStreamTax({ assessable: 80_000, offset60: 8_000, taxed60: 140_000, total60: 220_000 }, 125_000);
  assert.equal(over.assessable, 80_000 + 0.5 * 15_000, 'half the taxed element over the cap');
  assert.equal(over.offset, 0, 'the 8,000 offset falls by 10% of the 95,000 excess, not below 0');
  const some = superIncomeStreamTax({ offset60: 8_000, taxed60: 0, total60: 135_000 }, 125_000);
  assert.equal(some.offset, 7_000, 'and by exactly 10% of a smaller excess');
  assert.equal(superIncomeStreamTax(null, 1).assessable, 0);
});

test('MSP-7 the settle assesses the stream, and the offset is non-refundable', () => {
  const rates = new AuTaxRates2026();
  const base  = rates._assessResidentPreFito({ auOrdinaryIncomeYTD: 50_000 });
  const with_ = rates._assessResidentPreFito({ auOrdinaryIncomeYTD: 50_000,
    auSuperIncomeStream: { assessable: 20_000, offset: 2_000 } });
  assert.equal(with_.superIncomeStreamAssessable, 20_000);
  assert.equal(with_.superIncomeStreamOffset, 2_000);
  assert.ok(with_.netLiabilityPreFito > base.netLiabilityPreFito);
  const tiny = rates._assessResidentPreFito({ auOrdinaryIncomeYTD: 0,
    auSuperIncomeStream: { assessable: 1_000, offset: 5_000 } });
  assert.ok(tiny.netLiabilityPreFito >= 0, 'an unused non-refundable offset is lost, never refunded');
});

/** A minimal account service: transaction() moves the balance. */
const svc = { transaction(acct, amount) { acct.balance = +(acct.balance + amount).toFixed(2); } };
const registry = cashKey => ({ getStateKey: (role) => (role === 'super' ? 'superAccount' : null),
  resolveTransactionAccountKey: () => cashKey });

function pensionState(o = {}) {
  return {
    people: { primary: { id: 'primary', birthDate: BORN } },
    cpiAccumulator: { AU: 1.2 },
    auSavingsAccount: { role: 'au-savings', isTransactionAccount: true, country: 'AU', balance: 0 },
    superAccount: { role: 'super', ownerId: 'primary', balance: 0 },
    msbsAccount: { scheme: 'MSBS', role: 'super', ownerId: 'primary', balance: 0,
      serviceEndDate: '2014-06-30', drawStartDate: '2041-07-01', pensionShare: 1,
      employerBenefit: { funded: 0, unfunded: 0, cpiPeak: 1, electedMs: D(2041, 7, 1) } },
    ...o,
  };
}

test('MSP-8 the lump sum: to cash less 15% once released, else rolled into a fund that pays it', () => {
  const apply = new MsbsElectionApplyReducer({ accountService: svc, stateRegistry: registry('auSavingsAccount') });
  const fresh = () => pensionState({ msbsAccount: { ...pensionState().msbsAccount,
    employerBenefit: { funded: 10_000, unfunded: 90_000, cpiPeak: 1 } } });
  const act = to => ({ type: 'MSBS_ELECTION_APPLY', stateKey: 'msbsAccount', personKey: 'primary',
    electionMs: D(2041, 7, 1), annual: 0, lumpTaxed: 10_000, lumpUntaxed: 90_000, lumpTo: to, cpiLevel: 1.2 });

  const s1 = fresh();
  const cash = apply.reduce(s1, act('cash'));
  assert.equal(s1.auSavingsAccount.balance, 100_000 - 13_500, 's301-95: 15% of the untaxed 90,000');
  assert.equal(cash.auSuperLumpSumTaxYTD, 13_500);
  assert.equal(cash.msbsAccount.employerBenefit.unfunded, 0);
  assert.equal(cash.msbsAccount.pension, undefined, 'all lump sum: no pension');

  const s2 = fresh();
  const rolled = apply.reduce(s2, act('super'));
  assert.equal(s2.superAccount.balance, 100_000 - 13_500, 'r 84: rolled over; the fund pays 15%');
  assert.equal(s2.auSavingsAccount.balance, 0);
  assert.ok(rolled, 'returns');
});

test('MSP-9 a pension in payment counts P × PF toward total super balance (Table 4A)', () => {
  const entry = { balance: 50_000, pension: { annual: 20_000 } };
  // 30 Jun 2042: 60 completed years and 11 months.
  const pf = (14.3115 * 1 + 13.9413 * 11) / 12;   // Table 4A, ages 60 and 61
  near(msbsPensionFactor(60, 11), pf, 'interpolated by month', 1e-9);
  near(msbsTotalSuperBalance(entry, BORN, D(2042, 6, 30)), 50_000 + 20_000 * pf, 'P × PF + member');
});

test('MSP-10 the pensioner dies: the spouse gets three full months, then 67%; with none it ends', () => {
  const pension = { annual: 12_000, taxedShare: 0.25, startMs: D(2041, 7, 1), cpiPeak: 1.2,
    recipientKey: 'primary', survivor: false, fullRatePaymentsLeft: 0, reversionAnnual: null };
  const base = pensionState();
  const withSpouse = { ...base, people: { spouse: { id: 'spouse', birthDate: '1983-01-01' } },
    msbsAccount: { ...base.msbsAccount, pension } };
  const h = new MsbsPensionHandler({ stateKey: 'msbsAccount' });
  const acts = h.call({ state: withSpouse, date: new Date(D(2050, 1, 31)) });
  assert.deepEqual(acts.map(a => a.type), ['MSBS_PENSION_REVERT', 'MSBS_PENSION_APPLY']);
  assert.equal(acts[1].personKey, 'spouse');
  assert.equal(acts[1].amount, 1000, 'r 42(2): the full rate first');

  const revert = new MsbsPensionRevertReducer();
  const pay = new MsbsPensionApplyReducer({ accountService: svc, stateRegistry: registry('auSavingsAccount') });
  let s = revert.reduce(withSpouse, acts[0]);
  assert.equal(s.msbsAccount.pension.reversionAnnual, 8_040, '67%');
  for (let i = 0; i < 3; i++) s = pay.reduce(s, { ...acts[1] });
  assert.equal(s.msbsAccount.pension.annual, 8_040, 'after three full-rate months');
  assert.ok(s.auPersonSuperStreamYTD.spouse.assessable > 0, 'taxed as the spouse\'s');

  const alone = { ...base, people: {}, msbsAccount: { ...base.msbsAccount, pension } };
  const end = h.call({ state: alone, date: new Date(D(2050, 1, 31)) });
  assert.deepEqual(end.map(a => a.type), ['MSBS_PENSION_REVERT']);
  assert.equal(revert.reduce(alone, end[0]).msbsAccount.pension.annual, 0, 'no spouse: it ends (r 43 not modelled)');
});
