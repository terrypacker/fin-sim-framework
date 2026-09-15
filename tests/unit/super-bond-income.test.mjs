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
 * Design 105 §8 — bond income inside super.
 *
 * A coupon is the fund's ordinary income (s6-5), and so is accretion (a discount
 * accruing, TIPS indexation). Both are taxed in the fund at 15% in accumulation and 0% in
 * pension phase (s295-385/390), out of the fund's own assets. Before §8 both took the
 * `'deferred'` path and were never taxed.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { BondSleeveCouponApplyReducer } from '../../src/finance/reducers/bond-sleeve-coupon-apply-reducer.js';
import { BondAccretionApplyReducer }    from '../../src/finance/reducers/bond-accretion-apply-reducer.js';
import { superFundTaxRateOn }           from '../../src/finance/account-rules/au/au-super-classes.js';
import { BondMaturityReducer }          from '../../src/finance/economic-regimes/bond-maturity-reducer.js';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.005, `${msg}: got ${a}, want ${b}`);
const DATE = new Date(Date.UTC(2030, 5, 30));

function fund(birthDate) {
  return {
    people: { primary: { id: 'primary', birthDate: new Date(birthDate) } },
    superAccount: {
      balance: 100_000, contributionBasis: 100_000, earningsBasis: 0, ownerId: 'primary',
      holdings: [{ id: 'b1', allocation: 'BOND', rateKey: 'FIXED_INCOME_AU', marketValue: 100_000, costBasis: 100_000 }],
    },
  };
}

const coupon = (amount) => ({
  type: 'BOND_SLEEVE_COUPON_APPLY', amount, stateKey: 'superAccount', taxMode: 'super',
  _reinvestBuckets: [{ taxExemption: 'none', issuingState: null, rateKey: 'FIXED_INCOME_AU', amount }],
  _prevailingRate: 0.05, _reinvestYear: 2030, _reinvestPurchaseMs: DATE.getTime(),
});

const sumMv = acct => acct.holdings.reduce((s, h) => s + (h.marketValue ?? 0), 0);

test('superFundTaxRateOn: 15% in accumulation, 0% from 60', () => {
  assert.strictEqual(superFundTaxRateOn(fund('1990-01-01'), fund('1990-01-01').superAccount, DATE), 0.15);
  assert.strictEqual(superFundTaxRateOn(fund('1960-01-01'), fund('1960-01-01').superAccount, DATE), 0);
});

test('coupon, accumulation: the fund withholds 15% and reinvests the rest', () => {
  const next = new BondSleeveCouponApplyReducer().reduce(fund('1990-01-01'), coupon(5000), DATE);
  const sa   = next.superAccount;

  near(sa.balance, 104_250, '5,000 coupon less 750 of fund tax');
  near(sumMv(sa), sa.balance, '§4.4: holdings follow the balance');
  near(sa.earningsBasis, 4_250, 'only the net reaches the ledger');
  const tax = next.next.find(a => a.type === 'SUPER_EARNINGS_TAX');
  assert.ok(tax, 'the tax reaches fund tax');
  near(tax.amount * tax.taxRate, 750, 'SUPER_EARNINGS_TAX books 15% of the coupon');
});

test('coupon, pension phase: exempt, the whole coupon is reinvested', () => {
  const next = new BondSleeveCouponApplyReducer().reduce(fund('1960-01-01'), coupon(5000), DATE);
  near(next.superAccount.balance, 105_000, 'untaxed in pension phase');
  assert.ok(!(next.next ?? []).some(a => a.type === 'SUPER_EARNINGS_TAX'));
});

test('coupon, other wrappers: \'deferred\' still books no tax', () => {
  const state = fund('1990-01-01');
  const next  = new BondSleeveCouponApplyReducer().reduce(state, { ...coupon(5000), taxMode: 'deferred' }, DATE);
  near(next.superAccount.balance, 105_000, 'deferred is untouched');
  assert.ok(!(next.next ?? []).some(a => a.type === 'SUPER_EARNINGS_TAX'));
});

test('accretion, accumulation: 15% comes off the fund\'s holdings; the step-up follows', () => {
  const action = { type: 'BOND_ACCRETION_APPLY', amount: 2000, stateKey: 'superAccount', taxMode: 'super' };
  const next   = new BondAccretionApplyReducer().reduce(fund('1990-01-01'), action, DATE);
  const sa     = next.superAccount;

  // The handler's HoldingTransactActions add the 2,000 to the accreting lot afterwards,
  // so here the holdings carry only the withholding and the balance is already final.
  near(sa.balance, 101_700, '2,000 of accretion less 300 of fund tax');
  near(sumMv(sa), 99_700, 'the tax left the existing holdings');
  near(sa.earningsBasis, 1_700, 'only the net reaches the ledger');
  const tax = next.next.find(a => a.type === 'SUPER_EARNINGS_TAX');
  near(tax.amount * tax.taxRate, 300, 'SUPER_EARNINGS_TAX books 15% of the accretion');
});

// ─── maturity: a super bond's redemption is a revenue disposal (§8.6) ─────────

function maturingFund({ role = 'super', stateKey = 'superAccount', rollAtMaturity = false } = {}) {
  const at = Date.UTC(2030, 6, 1);
  return {
    currentPeriods: { AU: { startMs: at } },
    effectiveInterestRates: { FIXED_INCOME_AU: 0.04 },
    people: { primary: { id: 'primary', birthDate: new Date('1990-01-01') } },
    [stateKey]: {
      role, balance: 98_000, contributionBasis: 98_000, earningsBasis: 0, ownerId: 'primary',
      holdings: [{
        id: 'rung', allocation: 'BOND', rateKey: 'FIXED_INCOME_AU',
        marketValue: 98_000, costBasis: 95_000, faceValue: 100_000, couponRate: 0.03,
        purchaseDate: new Date(Date.UTC(2025, 6, 1)), maturityDate: new Date(Date.UTC(2030, 5, 30)),
        ...(rollAtMaturity ? { rollAtMaturity: true, rollTermYears: 5 } : {}),
      }],
    },
  };
}

test('maturity: a super bond redeemed at par realises its gain as revenue', () => {
  const next = new BondMaturityReducer().reduce(maturingFund(), { type: 'AU_PERIOD_ADVANCE' });
  const cgt  = (next.next ?? []).find(a => a.type === 'SUPER_CAPITAL_GAIN');
  assert.ok(cgt, 'the redemption is a disposal for the fund');
  near(cgt.revenueGain, 5_000, 'par 100,000 less cost 95,000, on revenue account');
  near(cgt.discountableGain, 0, 'no discount on a bond');
  assert.strictEqual(next.superAccount.holdings[0].allocation, 'CASH', 'redeemed to cash, as before');
});

test('maturity: a super roll realises the gain and re-bases the new bond at par', () => {
  const next = new BondMaturityReducer().reduce(maturingFund({ rollAtMaturity: true }), { type: 'AU_PERIOD_ADVANCE' });
  const cgt  = (next.next ?? []).find(a => a.type === 'SUPER_CAPITAL_GAIN');
  near(cgt.revenueGain, 5_000, 'the roll is a redemption and a fresh purchase');
  const rolled = next.superAccount.holdings[0];
  assert.strictEqual(rolled.allocation, 'BOND', 'still a bond');
  near(rolled.costBasis, 100_000, 'based at par, not the old 95,000 carried forward');
});

test('maturity: other wrappers keep the deferral — no SUPER_CAPITAL_GAIN from an IRA bond', () => {
  const next = new BondMaturityReducer().reduce(
    maturingFund({ role: 'ira', stateKey: 'iraAccount', rollAtMaturity: true }), { type: 'AU_PERIOD_ADVANCE' });
  assert.ok(!(next.next ?? []).some(a => a.type === 'SUPER_CAPITAL_GAIN'));
  near(next.iraAccount.holdings[0].costBasis, 95_000, 'the roll still carries its basis forward');
});

test('accretion, pension phase: exempt', () => {
  const action = { type: 'BOND_ACCRETION_APPLY', amount: 2000, stateKey: 'superAccount', taxMode: 'super' };
  const next   = new BondAccretionApplyReducer().reduce(fund('1960-01-01'), action, DATE);
  near(next.superAccount.balance, 102_000, 'untaxed');
  assert.ok(!(next.next ?? []).some(a => a.type === 'SUPER_EARNINGS_TAX'));
});
