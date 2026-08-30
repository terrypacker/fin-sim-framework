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
 * scripts-cuts.test.mjs
 *
 * Guards `scripts/lib/cuts.mjs`, which exists because eleven study scripts had each
 * hand-rolled the same balance-sheet walk and three of them divided AUD by a
 * **hard-coded 1.55** instead of the run's own rate. That was not latent: a
 * stagflation column carries `fxAdjustment: { USD_AUD: -0.10 }` for ten years, so
 * the rate at the horizon was 1.45 and every AUD balance in that column was priced
 * 6.9% wrong — in a grid that completed and looked entirely reasonable.
 *
 * So the tests here are about the two things that failure had in common with every
 * other one in this family: **the rate came from the wrong place**, and **the scope
 * silently included or dropped an account**. Both are invisible in the output.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  sumHoldings, sumHoldingsWithBasis, netWorth, offsetDrawable, loanLiability,
  coverYears, yearsOfCover, allocationMix, locationSplit, assertRatesSeeded,
  scopedAccounts, isWrapper,
} from '../../scripts/lib/cuts.mjs';

/**
 * A state bag shaped like a real one: an AUD account, a wrapper, an offset carrying
 * a CASH holding of its own, a loan, and some non-account entries to walk past.
 */
const makeState = (rate = 1.55) => ({
  effectiveExchangeRates: { USD_AUD: rate },
  monthlyExpenses: 10_000,
  usStockAccount: {
    balance: 1000, type: 'brokerage', currency: { code: 'USD', symbol: '$' },
    holdings: [
      { allocation: 'EQUITY', marketValue: 600_000, costBasis: 400_000 },
      { allocation: 'BOND',   marketValue: 240_000, costBasis: 240_000 },
    ],
  },
  auSavingsAccount: {
    balance: 1000, type: 'savings', currency: { code: 'AUD', symbol: '$' },
    holdings: [{ allocation: 'CASH', marketValue: 155_000, costBasis: 155_000 }],
  },
  iraAccount: {
    balance: 1000, type: 'ira', currency: { code: 'USD' },
    holdings: [{ allocation: 'BOND', marketValue: 500_000, costBasis: 500_000 }],
  },
  auOffsetAccount: {
    balance: 155_000, type: 'offset', currency: { code: 'AUD' },
    holdings: [{ allocation: 'CASH', marketValue: 155_000, costBasis: 155_000 }],
  },
  auHouseLoan: { balance: 310_000, type: 'loan', currency: { code: 'AUD' } },
  // Non-accounts the walk must step over rather than trip on.
  people: { primary: { name: 'x' } },
  scenarioFailed: false,
  someList: [1, 2, 3],
});

describe('cuts — the rate comes from the run, not from a constant', () => {
  test('AUD is valued at the STATE rate, and follows it when it moves', () => {
    // A$155,000 at 1.55 is US$100,000. The hard-coded copies this module replaces
    // would return 100,000 for both states — which is the whole bug.
    assert.equal(sumHoldings(makeState(1.55), { classes: ['CASH'] }), 100_000);

    const shocked = sumHoldings(makeState(1.45), { classes: ['CASH'] });
    assert.ok(Math.abs(shocked - 106_896.55) < 0.01,
      `expected ~106,896.55 at a rate of 1.45, got ${shocked}`);
    assert.notEqual(shocked, 100_000, 'the rate moved and the valuation did not follow it');
  });

  test('USD holdings are untouched by the rate', () => {
    assert.equal(sumHoldings(makeState(1.45), { classes: ['EQUITY'] }), 600_000);
  });

  test('a {code} descriptor and a bare string are both understood', () => {
    // The design 82 §5.3 drift: a runtime account carries `{code, symbol}`, and a
    // comparison against a bare code never matched, so foreign money was valued at face.
    const bare = makeState();
    bare.auSavingsAccount.currency = 'AUD';
    assert.equal(sumHoldings(bare, { classes: ['CASH'] }), 100_000);
  });

  test('assertRatesSeeded refuses a state that would price AUD 1:1', () => {
    const noRate = makeState();
    noRate.effectiveExchangeRates = {};
    assert.throws(() => assertRatesSeeded(noRate), /USD_AUD/);
    assert.doesNotThrow(() => assertRatesSeeded(makeState()));
  });
});

describe('cuts — scope', () => {
  test('wrappers are excluded by default and reachable on request', () => {
    const s = makeState();
    // BOND: 240k taxable, 500k in the IRA.
    assert.equal(sumHoldings(s, { classes: ['BOND'] }), 240_000);
    assert.equal(sumHoldings(s, { classes: ['BOND'], wrappers: 'include' }), 740_000);
    assert.equal(sumHoldings(s, { classes: ['BOND'], wrappers: 'only' }), 500_000);
  });

  test('an offset\'s holdings are out of scope by default', () => {
    // The trap found while retrofitting cf-destination: the offset carries a real CASH
    // holding, so including or excluding it moves a reported cash share by 30x.
    const s = makeState();
    assert.equal(sumHoldings(s, { classes: ['CASH'] }), 100_000);
    assert.equal(sumHoldings(s, { classes: ['CASH'], offsets: 'include' }), 200_000);
  });

  test('loans are never an asset, in any scope', () => {
    const s = makeState();
    for (const scope of [{}, { wrappers: 'include' }, { offsets: 'include' }]) {
      const keys = [...scopedAccounts(s, scope)].map(([k]) => k);
      assert.ok(!keys.includes('auHouseLoan'), `loan leaked into scope ${JSON.stringify(scope)}`);
    }
    assert.equal(loanLiability(s), 200_000);   // A$310k / 1.55, POSITIVE
  });

  test('non-account entries are walked past', () => {
    const keys = [...scopedAccounts(makeState(), { wrappers: 'include', offsets: 'include' })]
      .map(([k]) => k).sort();
    assert.deepEqual(keys, ['auOffsetAccount', 'auSavingsAccount', 'iraAccount', 'usStockAccount']);
  });

  test('isWrapper reads either type or role', () => {
    assert.ok(isWrapper({ type: 'super' }));
    assert.ok(isWrapper({ role: 'roth' }));
    assert.ok(isWrapper({ type: 'brokerage', role: 'k401' }));
    assert.ok(!isWrapper({ type: 'brokerage' }));
  });
});

describe('cuts — the composed figures', () => {
  test('netWorth counts the offset ONCE, by balance, and subtracts the loan', () => {
    // 600k EQUITY + 240k BOND + 100k CASH + 500k IRA BOND = 1,440k of holdings
    // + 100k offset drawable − 200k loan = 1,340k. The offset's own CASH holding must
    // not be added on top of its balance.
    assert.equal(netWorth(makeState()), 1_340_000);
    assert.equal(offsetDrawable(makeState()), 100_000);
  });

  test('coverYears is taxable CASH+BOND over annual spend', () => {
    // (100k CASH + 240k BOND) / (10k × 12) = 2.833… years. The IRA's 500k of bonds is
    // age-gated and must not count as cover.
    const s = makeState();
    assert.ok(Math.abs(coverYears(s) - 340_000 / 120_000) < 1e-9);
    assert.equal(yearsOfCover(s, 120_000), 1);
  });

  test('yearsOfCover on a plan that spends nothing is Infinity, not a divide-by-zero', () => {
    const s = makeState();
    s.monthlyExpenses = 0;
    assert.equal(yearsOfCover(s, 1000), Infinity);
  });

  test('value and basis come from ONE walk, so they subtract', () => {
    const { value, costBasis } = sumHoldingsWithBasis(makeState(), { classes: ['EQUITY'] });
    assert.equal(value - costBasis, 200_000);
  });

  test('locationSplit separates reachable bonds from age-gated ones', () => {
    const { taxable, wrapped, total } = locationSplit(makeState(), 'BOND');
    assert.deepEqual({ taxable, wrapped, total }, { taxable: 240_000, wrapped: 500_000, total: 740_000 });
  });

  test('allocationMix shares are of the scoped total', () => {
    const { dollars, shares, total } = allocationMix(makeState(), { wrappers: 'include' });
    assert.equal(total, 1_440_000);
    assert.equal(dollars.BOND, 740_000);
    assert.ok(Math.abs(Object.values(shares).reduce((a, c) => a + c, 0) - 1) < 1e-12);
    assert.equal(shares.GOLD, 0);
  });
});
