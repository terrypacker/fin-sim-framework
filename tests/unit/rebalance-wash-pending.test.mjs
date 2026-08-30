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
 * rebalance-wash-pending.test.mjs — design 94 §8.1n.
 *
 * `state.washPendingLosses` used to have exactly ONE writer, `StockHarvestApplyReducer`.
 * §8.1j's reasoning for that treated the harvester as the only SELLER — but the design-61
 * LOCATED planner relocates a class by selling it in the taxable book and rebuying it inside a
 * wrapper, and in a down year that sale realizes a loss. If the wrapper is an IRA or Roth,
 * Rev. Rul. 2008-5 DESTROYS that loss; before this the loss reached the return in full, because
 * `characterizeCapitalGain` reads the signed term fields off any disposal action while
 * `resolveWashSales` only ever saw the harvester's entries.
 *
 * These pin the sell leg's new entries. The last test is the end-to-end one: it drives the
 * SHIPPED `resolveWashSales` over the state the reducer produced, so the assertion is about what
 * the taxpayer's return actually loses rather than about the shape of a ledger row.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { RebalanceToTargetApplyReducer } from '../../src/finance/behavioral/rebalance-to-target-apply-reducer.js';
import { resolveWashSales } from '../../src/finance/tax/us/wash-sale.js';
import { ACCOUNT_ROLES }    from '../../src/finance/state/account-roles.js';
import { ALLOCATION }       from '../../src/finance/holdings/allocation.js';
import { RATE_KEYS }        from '../../src/finance/economic-regimes/rate-keys.js';

const APPLY  = new RebalanceToTargetApplyReducer();
const SALE   = new Date(Date.UTC(2033, 0, 1));
const US_SEC = 'sec-auto-EQUITY_US';
const AU_SEC = 'sec-auto-EQUITY_AU';

/**
 * A lot. `securityId: null` models an un-securitised holding, which makes no identity claim.
 *
 * `pricePerUnit` is not decoration: `consumeHoldings` rescales `units` on a PARTIAL sale only
 * when the lot carries one (design 93 §5b). A fixture without it keeps its full unit count
 * after a partial sale, which is not what a real unitised lot does — and it silently changes
 * what this suite measures.
 */
const lot = (id, allocation, mv, basis, units, securityId = US_SEC, purchase = '2029-01-01') => ({
  id, allocation, marketValue: mv, costBasis: basis, units, securityId,
  pricePerUnit: units > 0 ? +(mv / units).toFixed(8) : null,
  rateKey: allocation === ALLOCATION.EQUITY ? RATE_KEYS.EQUITY_US : RATE_KEYS.CASH,
  costBaseByCountry: null, purchaseDate: new Date(purchase), acquisitionDateByCountry: null,
});

const acct = (stateKey, role, holdings, country = 'US') => ({
  stateKey, role, type: 'brokerage', country, currency: { code: 'USD' },
  balance: +holdings.reduce((s, h) => s + h.marketValue, 0).toFixed(2), holdings,
});

const baseState = (accounts, extra = {}) => ({
  activeRegimes: [], regimeActions: {}, people: { p1: { residency: 'US' } },
  currentPeriods: { US: { startMs: SALE.getTime() }, AU: { startMs: SALE.getTime() } },
  securities: null, washPendingLosses: [],
  ...Object.fromEntries(accounts.map(a => [a.stateKey, a])), ...extra,
});

/**
 * Apply one sell leg directly. The reducer is driven with a hand-built
 * `REBALANCE_TO_TARGET_APPLY` rather than through `RebalanceToTargetReducer`, so each test
 * states the leg it is about and nothing else can move.
 */
const sell = (state, stateKey, allocation, amount, { country = 'US', role = ACCOUNT_ROLES.US_STOCK,
                                                     taxable = true } = {}) =>
  APPLY.reduce(state, {
    type: 'REBALANCE_TO_TARGET_APPLY', stateKey, role, taxable, country,
    legs: [{ allocation, delta: -amount }, { allocation: ALLOCATION.CASH, delta: amount }],
  }, SALE);

const pending = (s) => s.washPendingLosses ?? [];

test('a taxable EQUITY sell at a LOSS writes a pending entry naming the group, units and character', () => {
  const state = baseState([acct('brokerage', ACCOUNT_ROLES.US_STOCK, [
    lot('eq', ALLOCATION.EQUITY, 120000, 200000, 1200),
  ])]);
  const out = sell(state, 'brokerage', ALLOCATION.EQUITY, 120000);

  assert.equal(pending(out).length, 1);
  const e = pending(out)[0];
  assert.equal(e.group, US_SEC);
  assert.equal(e.stateKey, 'brokerage');
  assert.equal(e.units, 1200);
  assert.equal(e.ms, SALE.getTime());
  // The lot is >12 months old at the sale, so the whole loss is long-term. Signed: the
  // action's own `gain` field is clamped at zero and would report no loss at all.
  assert.equal(e.shortLoss + e.longLoss, 80000);
  assert.equal(e.shortLoss, 0);
});

test('a taxable EQUITY sell at a GAIN writes nothing — §1091 is a rule about losses', () => {
  const state = baseState([acct('brokerage', ACCOUNT_ROLES.US_STOCK, [
    lot('eq', ALLOCATION.EQUITY, 200000, 120000, 1200),
  ])]);
  assert.equal(pending(sell(state, 'brokerage', ALLOCATION.EQUITY, 100000)).length, 0);
});

test('an un-securitised lot writes nothing — it makes no identity claim (§8.1c)', () => {
  const state = baseState([acct('brokerage', ACCOUNT_ROLES.US_STOCK, [
    lot('eq', ALLOCATION.EQUITY, 120000, 200000, 1200, null),
  ])]);
  assert.equal(pending(sell(state, 'brokerage', ALLOCATION.EQUITY, 120000)).length, 0);
});

test('a SHELTERED sell writes nothing — no loss is realized to disallow', () => {
  const state = baseState([acct('ira', ACCOUNT_ROLES.IRA, [
    lot('eq', ALLOCATION.EQUITY, 120000, 200000, 1200),
  ])]);
  const out = sell(state, 'ira', ALLOCATION.EQUITY, 120000,
    { role: ACCOUNT_ROLES.IRA, taxable: false });
  assert.equal(pending(out).length, 0);
});

test('an AU-domiciled leg writes nothing — §1091 is resolved against the US return', () => {
  const a = acct('auBrokerage', ACCOUNT_ROLES.AU_STOCK, [
    lot('eq', ALLOCATION.EQUITY, 120000, 200000, 1200, AU_SEC),
  ], 'AU');
  const out = sell(baseState([a]), 'auBrokerage', ALLOCATION.EQUITY, 120000,
    { country: 'AU', role: ACCOUNT_ROLES.AU_STOCK });
  assert.equal(pending(out).length, 0);
});

test('a BOND leg writes nothing — the resolver matches EQUITY replacements only', () => {
  const state = baseState([acct('brokerage', ACCOUNT_ROLES.US_STOCK, [
    lot('bd', ALLOCATION.BOND, 120000, 200000, 1200),
  ])]);
  assert.equal(pending(sell(state, 'brokerage', ALLOCATION.BOND, 120000)).length, 0);
});

test('two identity groups in one account produce two entries; units and loss split, total conserved', () => {
  // The case a single undifferentiated entry gets wrong: it would attribute the whole loss to
  // whichever group sorted first and match it against that group's replacements only.
  const state = baseState([acct('brokerage', ACCOUNT_ROLES.US_STOCK, [
    lot('us', ALLOCATION.EQUITY, 60000, 100000, 600, US_SEC),
    lot('au', ALLOCATION.EQUITY, 60000, 100000, 600, AU_SEC),
  ])]);
  const out = sell(state, 'brokerage', ALLOCATION.EQUITY, 120000);

  const entries = pending(out);
  assert.equal(entries.length, 2);
  assert.deepEqual(new Set(entries.map(e => e.group)), new Set([US_SEC, AU_SEC]));
  // Both lots are identical in size and loss, so the split is even and the totals tie back
  // to the leg. The TOTAL is the invariant; the per-group share is the thing being tested.
  assert.equal(entries.reduce((s, e) => s + e.units, 0), 1200);
  assert.equal(+entries.reduce((s, e) => s + e.shortLoss + e.longLoss, 0).toFixed(2), 80000);
  for (const e of entries) assert.equal(e.units, 600);
});

test('a partial sell reports only the units that actually left', () => {
  const state = baseState([acct('brokerage', ACCOUNT_ROLES.US_STOCK, [
    lot('eq', ALLOCATION.EQUITY, 120000, 200000, 1200),
  ])]);
  const out = sell(state, 'brokerage', ALLOCATION.EQUITY, 30000);
  const e = pending(out)[0];
  // A quarter of the position's market value, so a quarter of the units and of the loss.
  assert.equal(e.units, 300);
  assert.equal(+(e.shortLoss + e.longLoss).toFixed(2), 20000);
});

test('entries APPEND — the harvester writes to this ledger on 31 Dec and this runs on 1 Jan', () => {
  const prior = { ms: Date.UTC(2032, 11, 31), group: US_SEC, units: 10,
                  shortLoss: 0, longLoss: 500, stateKey: 'other' };
  const state = baseState([acct('brokerage', ACCOUNT_ROLES.US_STOCK, [
    lot('eq', ALLOCATION.EQUITY, 120000, 200000, 1200),
  ])], { washPendingLosses: [prior] });
  const out = pending(sell(state, 'brokerage', ALLOCATION.EQUITY, 120000));
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], prior);
});

test('END TO END — the relocation loss is destroyed when the wrapper is an IRA, and stands when it is not', () => {
  // The §8.1n fact pattern: taxable equity sold at a loss, the same identity group bought
  // inside a covered wrapper the same day. The assertion runs the SHIPPED resolver, so this
  // is about what the return loses, not about the ledger's shape.
  const withIra = baseState([
    acct('brokerage', ACCOUNT_ROLES.US_STOCK, [lot('eq', ALLOCATION.EQUITY, 120000, 200000, 1200)]),
    acct('ira', ACCOUNT_ROLES.IRA, [
      lot('ira-eq', ALLOCATION.EQUITY, 200000, 200000, 2000, US_SEC, '2033-01-01')]),
  ]);
  const afterIra = sell(withIra, 'brokerage', ALLOCATION.EQUITY, 120000);
  const resIra = resolveWashSales(afterIra, Date.UTC(2033, 0, 1), Date.UTC(2033, 11, 31));
  assert.equal(resIra.disallowedShort + resIra.disallowedLong, 80000);
  assert.equal(resIra.ledger[0].matchedFraction, 1);

  // Same sale, but the replacement is an AU super fund holding a DIFFERENT market's security —
  // which is why the reference plan measures zero exposure. Neither fact is a property of the
  // rule, and changing either brings the disallowance back.
  const withSuper = baseState([
    acct('brokerage', ACCOUNT_ROLES.US_STOCK, [lot('eq', ALLOCATION.EQUITY, 120000, 200000, 1200)]),
    acct('super', ACCOUNT_ROLES.SUPER, [
      lot('su-eq', ALLOCATION.EQUITY, 200000, 200000, 2000, AU_SEC, '2033-01-01')], 'AU'),
  ]);
  const afterSuper = sell(withSuper, 'brokerage', ALLOCATION.EQUITY, 120000);
  // The entry is still written — the sale happened — but nothing matches it.
  assert.equal(pending(afterSuper).length, 1);
  const resSuper = resolveWashSales(afterSuper, Date.UTC(2033, 0, 1), Date.UTC(2033, 11, 31));
  assert.equal(resSuper.disallowedShort + resSuper.disallowedLong, 0);
});

test('a replacement OUTSIDE the ±30-day window does not wash the loss', () => {
  const state = baseState([
    acct('brokerage', ACCOUNT_ROLES.US_STOCK, [lot('eq', ALLOCATION.EQUITY, 120000, 200000, 1200)]),
    acct('ira', ACCOUNT_ROLES.IRA, [
      lot('ira-eq', ALLOCATION.EQUITY, 200000, 200000, 2000, US_SEC, '2033-06-01')]),
  ]);
  const after = sell(state, 'brokerage', ALLOCATION.EQUITY, 120000);
  const res = resolveWashSales(after, Date.UTC(2033, 0, 1), Date.UTC(2033, 11, 31));
  assert.equal(res.disallowedShort + res.disallowedLong, 0);
});
