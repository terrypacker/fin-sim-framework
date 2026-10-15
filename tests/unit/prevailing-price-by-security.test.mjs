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
 * prevailing-price-by-security.test.mjs — a lot born beside others is priced by lots of
 * its OWN security only.
 *
 * A price is per share of one instrument. Before this, every birth site priced a new lot
 * by every lot of the same allocation (or market) in the account, so a harvest rebuy of
 * the US market fund beside an alternate index joined at a blend of the two. The
 * `wash-sale-two-books` golden measured what that cost: the replacement claimed about 2.5×
 * the shares it bought, and §1091, which matches SHARES, over-matched the loss. With real
 * imported share counts (SWTSX at 18.68 beside VOO at 550) the blend would be worse.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { prevailingPrice, projectHoldingsToState } from '../../src/finance/holdings/holding-utils.js';
import { syntheticSecurityId }                     from '../../src/finance/holdings/security.js';

const lot = (id, securityId, units, pricePerUnit, extra = {}) => ({
  id, allocation: 'EQUITY', rateKey: 'EQUITY_US', securityId,
  units, pricePerUnit, marketValue: +(units * pricePerUnit).toFixed(2), costBasis: 0, ...extra,
});

const book = [lot('a', 'swtsx', 1000, 18.68), lot('b', 'voo', 10, 550)];

test('without a security the price is the value-weighted blend, as before', () => {
  assert.equal(+prevailingPrice(book).toFixed(4), +((18680 + 5500) / 1010).toFixed(4));
});

test('with a security only that security\'s lots price the birth', () => {
  assert.equal(prevailingPrice(book, 'swtsx'), 18.68);
  assert.equal(prevailingPrice(book, 'voo'), 550);
});

test('a security the account does not hold yet joins at the convention', () => {
  assert.equal(prevailingPrice(book, 'vti'), 100);
});

test('a lot with no securityId counts as its market\'s synthetic security', () => {
  const lots = [lot('m', undefined, 50, 140), lot('a', 'swtsx', 1000, 18.68)];
  assert.equal(prevailingPrice(lots, syntheticSecurityId('EQUITY_US')), 140);
});

test('at boot an unpriced lot joins its security\'s authored price, not 100', () => {
  const [, joined, other] = projectHoldingsToState([
    lot('a', 'swtsx', 1000, 18.68),
    { id: 'b', allocation: 'EQUITY', rateKey: 'EQUITY_US', securityId: 'swtsx', marketValue: 934, costBasis: 900 },
    { id: 'c', allocation: 'EQUITY', rateKey: 'EQUITY_US', securityId: 'voo', marketValue: 5500, costBasis: 5000 },
  ]);
  assert.equal(joined.pricePerUnit, 18.68);
  assert.equal(joined.units, 50);
  assert.equal(other.pricePerUnit, 100, 'no authored VOO count, so VOO keeps the convention');
});

test('at boot an authored share count is kept exactly', () => {
  const [a] = projectHoldingsToState([lot('a', 'swtsx', 12.13, 18.68)]);
  assert.equal(a.units, 12.13);
  assert.equal(a.pricePerUnit, 18.68);
  assert.equal(a.marketValue, 226.59);
});
