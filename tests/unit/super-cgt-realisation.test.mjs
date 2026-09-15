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
 * Design 105 — a super fund's capital gains, taxed on realisation.
 *
 *   s295-85      CGT is the primary code for a complying fund's gains
 *   s102-5(1)    Step 1 losses → Step 2 carried net capital losses → Step 5 discount
 *   s102-10      a year's net capital loss (losses over gains) carries forward
 *   s115-25      the discount needs the asset held at least 12 months
 *   s115-100(b)  a complying fund's discount is one third (15% → 10%)
 *   s118-320     a gain or loss on a segregated current pension asset is disregarded
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import {
  SuperCapitalGainApplyReducer, superNetCapitalGain, SUPER_CGT_DISCOUNT,
} from '../../src/finance/account-rules/au/au-super-classes.js';
import { RebalanceToTargetReducer }      from '../../src/finance/behavioral/rebalance-to-target-reducer.js';
import { RebalanceToTargetApplyReducer } from '../../src/finance/behavioral/rebalance-to-target-apply-reducer.js';
import { ACCOUNT_ROLES } from '../../src/finance/state/account-roles.js';
import { ALLOCATION }    from '../../src/finance/holdings/allocation.js';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.005, `${msg}: got ${a}, want ${b}`);

// ─── the netting ──────────────────────────────────────────────────────────────

test('s115-100(b): a complying fund discounts a discount gain by one third', () => {
  assert.strictEqual(SUPER_CGT_DISCOUNT, 1 / 3);
  near(superNetCapitalGain({ discountableGain: 3000 }), 2000, '3,000 discountable');
  near(superNetCapitalGain({ otherGain: 3000 }), 3000, '3,000 held under 12 months');
});

test('s102-5: losses reduce gains BEFORE the discount, non-discount gains first', () => {
  // 500 non-discount + 1,000 discountable, less a 700 loss: the loss clears the 500 first,
  // then 200 of the discountable gain, leaving 800 to discount → 533.33.
  near(superNetCapitalGain({ otherGain: 500, discountableGain: 1000, capitalLoss: 700 }), 533.33, 'netted');
  // A carried-forward loss reduces the same way (Step 2), after this year's losses.
  near(superNetCapitalGain({ otherGain: 500, discountableGain: 1000, carriedLoss: 700 }), 533.33, 'carried');
  assert.strictEqual(superNetCapitalGain({ otherGain: 500, capitalLoss: 900 }), 0, 'never negative');
});

// ─── the reducer ──────────────────────────────────────────────────────────────

function fund({ birthDate = '1990-01-01', capitalGainsYTD } = {}) {
  return {
    people: { primary: { id: 'primary', birthDate: new Date(birthDate) } },
    superAccount: {
      balance: 100_000, contributionBasis: 80_000, earningsBasis: 20_000, ownerId: 'primary',
      holdings: [{ id: 'h1', allocation: 'EQUITY', rateKey: 'EQUITY_AU', marketValue: 100_000, costBasis: 80_000 }],
      ...(capitalGainsYTD ? { capitalGainsYTD } : {}),
    },
  };
}

const reducer = new SuperCapitalGainApplyReducer();
const apply = (state, gain, date) =>
  reducer.reduce(state, { type: 'SUPER_CAPITAL_GAIN', stateKey: 'superAccount', ...gain }, new Date(date));

test('accumulation: a discount gain is taxed at 10%, from fund assets', () => {
  const next = apply(fund(), { discountableGain: 3000 }, '2030-03-01');
  const sa   = next.superAccount;

  near(sa.balance, 99_700, 'balance: 15% × ⅔ × 3,000 = 300 withheld');
  near(sa.holdings.reduce((s, h) => s + h.marketValue, 0), sa.balance, '§4.4: holdings follow the balance');
  near(sa.earningsBasis, 19_700, 'the tax comes off earnings first');
  assert.strictEqual(sa.capitalGainsYTD.fy, 2029, 'AU income year 2029-30');
  near(sa.capitalGainsYTD.netGain, 2000, 'net capital gain');

  const tax = next.next.find(a => a.type === 'SUPER_EARNINGS_TAX');
  assert.ok(tax, 'the tax reaches the fund-tax bucket');
  near(tax.amount * tax.taxRate, 300, 'SUPER_EARNINGS_TAX books the 300');
});

test('a gain held under 12 months is taxed at the full 15%', () => {
  const next = apply(fund(), { otherGain: 3000 }, '2030-03-01');
  near(next.superAccount.balance, 99_550, '15% × 3,000 = 450');
});

test('a later loss in the same income year gives back tax an earlier gain drew', () => {
  const first  = apply(fund(), { discountableGain: 3000 }, '2029-09-01');
  const second = apply(first, { capitalLoss: 1500 }, '2030-03-01');

  // Net gain for the year falls 2,000 → 1,000: 150 of the 300 comes back to the fund.
  near(second.superAccount.balance, 99_850, 'refunded into the fund');
  near(second.superAccount.capitalGainsYTD.netGain, 1000, 'net capital gain after the loss');
  const tax = second.next.find(a => a.type === 'SUPER_EARNINGS_TAX');
  near(tax.amount * tax.taxRate, -150, 'a negative change in the year\'s fund tax');
});

test('s102-10: a year\'s net capital loss carries into the next year, and is used there', () => {
  // FY2029: a 5,000 loss and nothing to use it on.
  const y1 = apply(fund(), { capitalLoss: 5000 }, '2030-03-01');
  near(y1.superAccount.balance, 100_000, 'a net loss draws no tax');

  // FY2030: a 3,000 gain is wholly absorbed; 2,000 of the loss is left.
  const y2 = apply(y1, { otherGain: 3000 }, '2030-09-01');
  near(y2.superAccount.balance, 100_000, 'the carried loss absorbs the gain');
  assert.strictEqual(y2.superAccount.capitalGainsYTD.carriedLoss, 5000, 'carried in');

  // FY2031: 2,000 of loss carries in, so a 3,000 short-term gain nets to 1,000.
  const y3 = apply(y2, { otherGain: 3000 }, '2031-09-01');
  assert.strictEqual(y3.superAccount.capitalGainsYTD.carriedLoss, 2000, 'what FY2030 did not use');
  near(y3.superAccount.balance, 99_850, '15% × 1,000');
});

test('s118-320: in pension phase the gain and the loss are both disregarded', () => {
  const state = fund({ birthDate: '1960-01-01' });   // 70 in 2030
  const next  = apply(state, { discountableGain: 3000, capitalLoss: 500 }, '2030-03-01');

  assert.strictEqual(next.superAccount, state.superAccount, 'nothing recorded, nothing withheld');
  assert.strictEqual((next.next ?? []).length, 0);
});

// ─── the rebalancer: where a super lot is sold ────────────────────────────────

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const AT_MS   = Date.UTC(2030, 0, 1);

/** Run one rebalance of `acct` to `target` and return the actions the apply step chains. */
function rebalanceActions(acct, target) {
  const state = {
    activeRegimes: [], regimeActions: {},
    people: { p1: { residency: 'AU' } },
    currentPeriods: { US: { startMs: AT_MS }, AU: { startMs: AT_MS } },
    [acct.stateKey]: acct,
  };
  const legs = new RebalanceToTargetReducer({
    accounts: [{ stateKey: acct.stateKey, role: acct.role }],
    targetAllocation: target, driftBandTaxable: 0.10, driftBandSheltered: 0.02,
  }).reduce(state, { type: 'US_PERIOD_ADVANCE' }).next ?? [];
  assert.ok(legs.length > 0, 'the rebalance should fire');
  const apply = new RebalanceToTargetApplyReducer();
  return legs.flatMap(a => apply.reduce(state, a).next ?? []);
}

const account = (role, stateKey) => ({
  stateKey, role, type: 'super', country: 'AU', currency: { code: 'AUD' },
  balance: 120_000,
  holdings: [
    // Two years old, 40% gain.
    { id: 'old', allocation: ALLOCATION.EQUITY, rateKey: 'EQUITY_AU', marketValue: 100_000, costBasis: 60_000,
      purchaseDate: new Date(AT_MS - 2 * YEAR_MS) },
    // Three months old, bought above today's value.
    { id: 'young', allocation: ALLOCATION.EQUITY, rateKey: 'EQUITY_AU', marketValue: 20_000, costBasis: 25_000,
      purchaseDate: new Date(AT_MS - YEAR_MS / 4) },
  ],
});

test('s295-85: a rebalance sale of super lots emits the fund\'s gain, per lot, losses kept', () => {
  const out = rebalanceActions(account(ACCOUNT_ROLES.SUPER, 'superAccount'),
    { [ALLOCATION.EQUITY]: 0.5, [ALLOCATION.CASH]: 0.5 });
  const cgt = out.find(a => a.type === 'SUPER_CAPITAL_GAIN');
  assert.ok(cgt, 'a super sell is a CGT event for the fund');

  // 60,000 of equity sold pro rata: 50,000 of the old lot (gain 20,000, held 2 years →
  // discountable) and 10,000 of the young lot (loss 2,500, which s102-5 nets).
  near(cgt.discountableGain, 20_000, 'old lot, held ≥ 12 months');
  near(cgt.otherGain, 0, 'no short-term gain');
  near(cgt.capitalLoss, 2_500, 'young lot\'s loss is kept, not floored');
});

// ─── bonds: revenue account, not capital (design 105 §8) ─────────────────────

test('s295-85(3)(b)(i): a bond gain is taxed at the full 15%, no discount', () => {
  const next = apply(fund(), { revenueGain: 2000 }, '2030-03-01');
  near(next.superAccount.balance, 99_700, '15% × 2,000');
});

test('a bond loss is refunded at 15% straight away (s8-1, against the fund\'s other income)', () => {
  const next = apply(fund(), { revenueGain: -2000 }, '2030-03-01');
  near(next.superAccount.balance, 100_300, '15% × 2,000 back to the fund');
  const tax = next.next.find(a => a.type === 'SUPER_EARNINGS_TAX');
  near(tax.amount * tax.taxRate, -300, 'a negative fund tax');
});

test('a capital loss cannot shelter a bond gain; a bond loss does reduce a capital gain', () => {
  // Capital losses offset capital gains only: the bond gain is taxed in full.
  near(apply(fund(), { revenueGain: 2000, capitalLoss: 5000 }, '2030-03-01').superAccount.balance,
    99_700, 'capital loss vs bond gain');
  // A revenue loss is a deduction against assessable income, net capital gain included:
  // 3,000 discountable → 2,000 net capital gain, less the 1,000 bond loss → 1,000 at 15%.
  near(apply(fund(), { discountableGain: 3000, revenueGain: -1000 }, '2030-03-01').superAccount.balance,
    99_850, 'bond loss vs capital gain');
});

test('a rebalance sale of a super BOND lot reports revenue, not capital', () => {
  const acct = {
    stateKey: 'superAccount', role: ACCOUNT_ROLES.SUPER, type: 'super', country: 'AU',
    currency: { code: 'AUD' }, balance: 120_000,
    holdings: [
      { id: 'bond', allocation: ALLOCATION.BOND, rateKey: 'FIXED_INCOME_AU', marketValue: 100_000, costBasis: 90_000,
        purchaseDate: new Date(AT_MS - 2 * YEAR_MS) },
      { id: 'eq', allocation: ALLOCATION.EQUITY, rateKey: 'EQUITY_AU', marketValue: 20_000, costBasis: 20_000,
        purchaseDate: new Date(AT_MS - 2 * YEAR_MS) },
    ],
  };
  const out = rebalanceActions(acct, { [ALLOCATION.BOND]: 0.5, [ALLOCATION.CASH]: 0.5 });
  const cgt = out.find(a => a.type === 'SUPER_CAPITAL_GAIN');
  assert.ok(cgt, 'the bond sale is reported');
  // 40,000 of the bond sold: a 10% gain, held two years, and still NOT discountable.
  near(cgt.revenueGain, 4_000, 'bond gain on revenue account');
  near(cgt.discountableGain, 0, 'nothing discounted');
});

test('other sheltered wrappers still rebalance free: no SUPER_CAPITAL_GAIN from an IRA', () => {
  const out = rebalanceActions(account(ACCOUNT_ROLES.IRA, 'iraAccount'),
    { [ALLOCATION.EQUITY]: 0.5, [ALLOCATION.CASH]: 0.5 });
  assert.ok(!out.some(a => a.type === 'SUPER_CAPITAL_GAIN'));
});
