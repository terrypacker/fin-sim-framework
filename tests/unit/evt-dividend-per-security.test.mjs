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
 * evt-dividend-per-security.test.mjs — design 106 §5, step 2a.
 *
 * A reinvested dividend buys more of the instrument that PAID it.
 *
 * Before 2a the whole payment was handed to `distributeHoldingsCredit` as one number and
 * split pro rata by MARKET VALUE across income buckets, and `securityId` was not in the
 * bucket key — so two securities in one account shared a bucket and a high-yield holding's
 * dividend partly bought the low-yield one. With equal yields that is invisible, which is
 * why it survived: it only shows once a security carries a yield of its own (design 94
 * §12 D11), and no golden reinvested such an account.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { computeHoldingsDividends } from '../../src/finance/holdings/holdings-earnings.js';
import { StockDividendApplyReducer } from '../../src/finance/account-rules/us/us-brokerage-classes.js';

const YEAR = 2030;
const DATE = Date.UTC(YEAR, 11, 31);

/** Two securities, same sleeve and rate key — the case that shared a bucket. */
const account = () => ({
  stateKey: 'usStockAccount', balance: 25_000,
  holdings: [
    { id: 'l-hi', securityId: 'sec-hi', allocation: 'EQUITY', marketValue: 15_000, costBasis: 15_000,
      rateKey: 'EQUITY_US', dividendYield: 0.05 },
    { id: 'l-lo', securityId: 'sec-lo', allocation: 'EQUITY', marketValue: 10_000, costBasis: 10_000,
      rateKey: 'EQUITY_US', dividendYield: 0.01 },
  ],
});

const stateWith = (acct) => ({
  usStockAccount: acct,
  currentPeriods: { US: { startMs: Date.UTC(YEAR, 0, 1) } },
  people: {},
});

const mvOf = (holdings, securityId) => holdings
  .filter(h => h.securityId === securityId)
  .reduce((t, h) => t + (h.marketValue ?? 0), 0);

test('DRIP-SEC-1: the payment is broken down by the security that paid it', () => {
  const { amount, bySecurity } = computeHoldingsDividends({
    state: stateWith(account()), stateKey: 'usStockAccount',
    fallbackYield: 0.02, fallbackRateKey: 'EQUITY_US',
  });
  assert.equal(amount, 850, '15k @ 5% + 10k @ 1%');
  assert.deepEqual(bySecurity, [
    { securityId: 'sec-hi', amount: 750 },
    { securityId: 'sec-lo', amount: 100 },
  ]);
});

test('DRIP-SEC-2: each slice is reinvested into the lots of ITS OWN security', () => {
  const acct = account();
  const { amount, bySecurity } = computeHoldingsDividends({
    state: stateWith(acct), stateKey: 'usStockAccount',
    fallbackYield: 0.02, fallbackRateKey: 'EQUITY_US',
  });

  const next = new StockDividendApplyReducer({}).reduce(stateWith(acct), {
    type: 'STOCK_DIVIDEND_APPLY', amount, residency: 'US',
    stateKey: 'usStockAccount', _bySecurity: bySecurity,
  });
  const hs = next.usStockAccount.holdings;

  assert.equal(+mvOf(hs, 'sec-hi').toFixed(2), 15_750, 'the 5% security keeps its own 750');
  assert.equal(+mvOf(hs, 'sec-lo').toFixed(2), 10_100, 'and the 1% security only its own 100');
  // Pro rata by market value — the pre-2a behaviour — would have been 510 / 340: the
  // low-yield security credited with 240 of a payment it did not make.
  assert.notEqual(+mvOf(hs, 'sec-lo').toFixed(2), 10_340);
});

test('DRIP-SEC-3: the reinvestment opens a VINTAGE lot per security, not a blend', () => {
  // design 93 §5.0a — a purchase is a new lot with its own holding period. This is why
  // step 2a keeps `distributeHoldingsCredit` rather than adding the money to the paying
  // lot: the paying lot was bought on a different day, and FIFO, HIFO, the Division 115
  // 12-month gate and the residency step-up all read that date.
  const acct = account();
  const state = stateWith(acct);
  const { amount, bySecurity } = computeHoldingsDividends({
    state, stateKey: 'usStockAccount', fallbackYield: 0.02, fallbackRateKey: 'EQUITY_US',
  });
  const hs = new StockDividendApplyReducer({}).reduce(state, {
    type: 'STOCK_DIVIDEND_APPLY', amount, residency: 'US',
    stateKey: 'usStockAccount', _bySecurity: bySecurity,
  }).usStockAccount.holdings;

  for (const id of ['l-hi', 'l-lo']) {
    assert.equal(hs.find(h => h.id === id).marketValue, id === 'l-hi' ? 15_000 : 10_000,
      'the paying lot is untouched — the money bought a new one');
  }
  const vintages = hs.filter(h => h.id.startsWith('reinvest-'));
  assert.equal(vintages.length, 2, 'one vintage lot per security');
  assert.deepEqual(vintages.map(h => h.securityId).sort(), ['sec-hi', 'sec-lo'],
    'and each names the instrument it bought');
  // A purchase carries basis equal to what was paid for it.
  assert.equal(vintages.find(h => h.securityId === 'sec-hi').costBasis, 750);
});

test('DRIP-SEC-4: Σ marketValue still rises by exactly the dividend (§4.4)', () => {
  const acct = account();
  const state = stateWith(acct);
  const before = acct.holdings.reduce((t, h) => t + h.marketValue, 0);
  const { amount, bySecurity } = computeHoldingsDividends({
    state, stateKey: 'usStockAccount', fallbackYield: 0.02, fallbackRateKey: 'EQUITY_US',
  });
  const next = new StockDividendApplyReducer({}).reduce(state, {
    type: 'STOCK_DIVIDEND_APPLY', amount, residency: 'US',
    stateKey: 'usStockAccount', _bySecurity: bySecurity,
  }).usStockAccount;
  const after = next.holdings.reduce((t, h) => t + h.marketValue, 0);
  assert.equal(+(after - before).toFixed(2), amount);
  assert.equal(+next.balance.toFixed(2), +after.toFixed(2), 'balance tracks the lots');
});

test('DRIP-SEC-5: an action with no slices falls back to the whole-account distribution', () => {
  // Replayed actions saved before 2a, and the no-lots case, must still work.
  const acct = account();
  const state = stateWith(acct);
  const next = new StockDividendApplyReducer({}).reduce(state, {
    type: 'STOCK_DIVIDEND_APPLY', amount: 850, residency: 'US', stateKey: 'usStockAccount',
  }).usStockAccount;
  const after = next.holdings.reduce((t, h) => t + h.marketValue, 0);
  assert.equal(+(after).toFixed(2), 25_850, 'the money still lands, pro rata as before');
});

// ── The election, end to end (step 2b) ──────────────────────────────────────

import { loadScenarioSim } from '../helpers/scenario-harness.js';
import { ACCOUNT_ROLES }   from '../../src/finance/state/account-roles.js';

/** One entry per ACTION (getActions yields one per reducer — de-dupe or double-count). */
function sumAmount(sim, type) {
  const seen = new Set();
  let total = 0;
  for (const e of (sim.journal?.getActions?.(type) ?? [])) {
    const id = e?.action?.instanceId;
    if (id != null && seen.has(id)) continue;
    if (id != null) seen.add(id);
    total += e?.action?.data?.amount ?? 0;
  }
  return +total.toFixed(2);
}

/** The reference plan with two securities in the taxable brokerage, and an election. */
const twoSecurityRun = ({ account, bySecurity }) => loadScenarioSim({
  simStart: '2026-01-01', simEnd: '2027-01-01', stepTo: '2027-01-01',
  params: { stockDividendReinvest: false },
  mutateCfg: (cfg) => {
    cfg.securities = [
      { id: 'sec-inc', symbol: 'INC', rateKey: 'EQUITY_US', dividendYield: 0.04 },
      { id: 'sec-gro', symbol: 'GRO', rateKey: 'EQUITY_US', dividendYield: 0.006 },
    ];
    const acct = cfg.accounts.find(a => a.role === ACCOUNT_ROLES.US_STOCK);
    const eq   = acct.holdings.filter(h => h.allocation === 'EQUITY');
    eq[0].securityId = 'sec-inc';
    (eq[1] ?? eq[0]).securityId = 'sec-gro';
    acct.reinvestDividends = account;
    if (bySecurity) acct.reinvestDividendsBySecurity = bySecurity;
  },
}).sim;

test('DRIP-SEC-6: one dividend event splits two ways when one security elects out', () => {
  const sim = twoSecurityRun({ account: true, bySecurity: { 'sec-inc': false } });
  const drip = sumAmount(sim, 'STOCK_DIVIDEND_APPLY');
  const cash = sumAmount(sim, 'STOCK_DIVIDEND_CASH_APPLY');
  assert.ok(drip > 0, 'the account default reinvested the securities it still covers');
  assert.ok(cash > 0, 'and the security that elected out was paid in cash');
});

test('DRIP-SEC-7: the election moves the MONEY without moving the TAX', () => {
  // The invariant design 106 §5 names: Σ STOCK_DIVIDEND_TAX == the dividend computed,
  // however the payment was split. A dividend is derived when it is paid.
  const all  = sumAmount(twoSecurityRun({ account: true }), 'STOCK_DIVIDEND_TAX');
  const none = sumAmount(twoSecurityRun({ account: false }), 'STOCK_DIVIDEND_TAX');
  const split = sumAmount(twoSecurityRun({ account: true, bySecurity: { 'sec-inc': false } }),
    'STOCK_DIVIDEND_TAX');
  assert.ok(all > 0);
  assert.equal(split, all,  'a split payment is assessed exactly as a reinvested one');
  assert.equal(split, none, '…and exactly as one taken wholly in cash');
});

test('DRIP-SEC-8: a per-security entry overrides the account default in BOTH directions', () => {
  // The map plus a default is an allow-list read one way and a deny-list read the other
  // (D4), so both readings have to work.
  const denyOne  = twoSecurityRun({ account: true,  bySecurity: { 'sec-inc': false } });
  const allowOne = twoSecurityRun({ account: false, bySecurity: { 'sec-inc': true } });

  assert.ok(sumAmount(denyOne, 'STOCK_DIVIDEND_CASH_APPLY') > 0
         && sumAmount(denyOne, 'STOCK_DIVIDEND_APPLY') > 0, 'deny-list reading');
  assert.ok(sumAmount(allowOne, 'STOCK_DIVIDEND_APPLY') > 0
         && sumAmount(allowOne, 'STOCK_DIVIDEND_CASH_APPLY') > 0, 'allow-list reading');

  // And they are mirror images: what one reinvests, the other pays out.
  assert.equal(sumAmount(denyOne,  'STOCK_DIVIDEND_APPLY'),
               sumAmount(allowOne, 'STOCK_DIVIDEND_CASH_APPLY'));
});

test('DRIP-SEC-9: a security the map does not name follows the account', () => {
  const sim = twoSecurityRun({ account: true, bySecurity: { 'sec-nonexistent': false } });
  assert.equal(sumAmount(sim, 'STOCK_DIVIDEND_CASH_APPLY'), 0,
    'an entry for an instrument the account does not hold changes nothing');
  assert.ok(sumAmount(sim, 'STOCK_DIVIDEND_APPLY') > 0);
});
