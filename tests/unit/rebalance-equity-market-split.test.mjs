/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

// A rebalance BUY into an EQUITY sleeve that does not agree on a market used to buy the
// account's DOMESTIC market alone, so a split account drifted home one rebalance at a
// time — a super on APRA's 39.7/60.3 mix (design 99 P5c) back to 100% AU. The buy now
// splits by market: pro rata on the sleeve's current value per market, or the account's
// resolved mix when the sleeve is empty.

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { RebalanceToTargetApplyReducer } from '../../src/finance/behavioral/rebalance-to-target-apply-reducer.js';
import { ACCOUNT_ROLES } from '../../src/finance/state/account-roles.js';
import { ALLOCATION }    from '../../src/finance/holdings/allocation.js';
import { RATE_KEYS }     from '../../src/finance/economic-regimes/rate-keys.js';

const APPLY = new RebalanceToTargetApplyReducer();
const AT    = new Date(Date.UTC(2030, 0, 1));

const lot = (id, allocation, rateKey, marketValue) => ({
  id, allocation, rateKey, marketValue, costBasis: marketValue,
  purchaseDate: new Date(Date.UTC(2020, 0, 1)),
});

/** One sheltered buy leg of `amount` EQUITY; returns the account's new rebalance lots. */
function buyEquity({ role, country, holdings, amount }) {
  const acct = { stateKey: 'acct', role, country, currency: { code: country === 'AU' ? 'AUD' : 'USD' },
    balance: holdings.reduce((s, h) => s + h.marketValue, 0), holdings };
  const state = { people: { p1: { residency: country } }, acct };
  const out = APPLY.reduce(state, {
    type: 'REBALANCE_TO_TARGET_APPLY', stateKey: 'acct', role, taxable: false, country,
    legs: [{ allocation: ALLOCATION.EQUITY, delta: amount }],
  }, AT);
  return out.acct.holdings.filter(h => h.id.startsWith('reb-'));
}
const byKey = lots => Object.fromEntries(lots.map(h => [h.rateKey, h.marketValue]));

test('RMS-1: an emptied super sleeve buys back on its APRA mix, not 100% AU', () => {
  const bought = buyEquity({ role: ACCOUNT_ROLES.SUPER, country: 'AU', amount: 100_000,
    holdings: [lot('h-b', ALLOCATION.BOND, RATE_KEYS.FIXED_INCOME_AU, 250_000)] });
  assert.deepEqual(byKey(bought), { [RATE_KEYS.EQUITY_AU]: 39_700, [RATE_KEYS.EQUITY_INTL_EX_AU]: 60_300 });
});

test('RMS-2: a mixed sleeve buys pro rata on its current value per market', () => {
  const bought = buyEquity({ role: ACCOUNT_ROLES.US_STOCK, country: 'US', amount: 10_000, holdings: [
    lot('h-us', ALLOCATION.EQUITY, RATE_KEYS.EQUITY_US, 75_000),
    lot('h-ex', ALLOCATION.EQUITY, RATE_KEYS.EQUITY_INTL_EX_US, 25_000),
  ] });
  assert.deepEqual(byKey(bought), { [RATE_KEYS.EQUITY_US]: 7_500, [RATE_KEYS.EQUITY_INTL_EX_US]: 2_500 });
  // Design 94 D10: each leg is the generic market position for ITS market.
  for (const h of bought) assert.equal(h.securityId, `sec-auto-${h.rateKey}`);
});

test('RMS-3: a sleeve that agrees on one market still buys one lot of it', () => {
  const bought = buyEquity({ role: ACCOUNT_ROLES.SUPER, country: 'AU', amount: 10_000,
    holdings: [lot('h-au', ALLOCATION.EQUITY, RATE_KEYS.EQUITY_AU, 50_000)] });
  assert.deepEqual(byKey(bought), { [RATE_KEYS.EQUITY_AU]: 10_000 });
});

test('RMS-4: an empty single-market account buys its domestic market, as before', () => {
  const bought = buyEquity({ role: ACCOUNT_ROLES.ROTH, country: 'US', amount: 10_000,
    holdings: [lot('h-b', ALLOCATION.BOND, RATE_KEYS.FIXED_INCOME_US, 50_000)] });
  assert.equal(bought.length, 1);
  assert.equal(bought[0].rateKey, RATE_KEYS.EQUITY_US);
});

test('RMS-5: the split is value-exact on awkward amounts', () => {
  // Not sub-dollar: a leg ≤ 1 cent is folded into the largest lot by `_sweepDust` (value-
  // neutral for the account, but it leaves the `reb-` lots).
  for (const amount of [33_333.33, 1.01, 12_345.67]) {
    const bought = buyEquity({ role: ACCOUNT_ROLES.SUPER, country: 'AU', amount,
      holdings: [lot('h-b', ALLOCATION.BOND, RATE_KEYS.FIXED_INCOME_AU, 250_000)] });
    assert.equal(+bought.reduce((s, h) => s + h.marketValue, 0).toFixed(2), amount);
  }
});
