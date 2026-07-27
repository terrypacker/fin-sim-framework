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
 * evt-target-allocation-taxable.test.mjs — design 61 Phase 2 (Lever C).
 *
 * Taxable-aware rebalancing + the buy / establish-new-sleeve primitive. Drives the
 * real RebalanceToTargetReducer → RebalanceToTargetApplyReducer pipeline. Covers:
 *   - taxable US_STOCK sell realizes STOCK_WITHDRAWAL_TAX with the correct gain, value
 *     conserved gross (balance unchanged), and the tax accrues separately;
 *   - AU_STOCK sell realizes AU_STOCK_WITHDRAWAL_TAX;
 *   - a tax-advantaged account rebalances for free (no tax);
 *   - establish a BOND sleeve from zero (rateKey / purchaseDate / basis / duration);
 *   - a GOLD sell routes through COLLECTIBLE_SALE_TAX (isGold); a gold buy never lands
 *     in a US IRA (the §OQ4a guard) but does in AU super / taxable;
 *   - split drift bands: the same drift triggers under the tight sheltered band but
 *     not under the wide taxable band (§OQ3).
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { RebalanceToTargetReducer, targetForRole, countryForRole, roleCanHoldGold }
  from '../../src/finance/behavioral/rebalance-to-target-reducer.js';
import { RebalanceToTargetApplyReducer }
  from '../../src/finance/behavioral/rebalance-to-target-apply-reducer.js';
import { ACCOUNT_ROLES } from '../../src/finance/state/account-roles.js';
import { ALLOCATION }    from '../../src/finance/holdings/allocation.js';
import { RATE_KEYS }     from '../../src/finance/economic-regimes/rate-keys.js';

const APPLY = new RebalanceToTargetApplyReducer();

function baseState(overrides = {}) {
  return {
    activeRegimes: [], regimeActions: {},
    people: { p1: { residency: 'US' } },
    currentPeriods: { US: { startMs: Date.UTC(2030, 0, 1) }, AU: { startMs: Date.UTC(2030, 0, 1) } },
    ...overrides,
  };
}

// Run the reducer→apply pipeline for one account; return { next, applied } where
// `applied` is the post-apply state and `taxes` the emitted tax actions.
function rebalance(state, account, target, bands = {}) {
  const reducer = new RebalanceToTargetReducer({
    accounts: [account], targetAllocation: target,
    driftBandTaxable: bands.taxable ?? 0.10, driftBandSheltered: bands.sheltered ?? 0.02,
  });
  const res     = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });
  const actions = res.next ?? [];
  let applied   = state;
  let taxes     = [];
  for (const a of actions) {
    const r = APPLY.reduce(applied, a);
    applied = r;
    taxes   = [...taxes, ...(r.next ?? [])];
  }
  return { actions, applied, taxes };
}

const mvOf   = (hs, cls) => hs.filter(h => h.allocation === cls).reduce((s, h) => s + h.marketValue, 0);
const totOf  = hs => hs.reduce((s, h) => s + h.marketValue, 0);

// ── Helpers ─────────────────────────────────────────────────────────────────────

test('RC-helper: countryForRole / roleCanHoldGold', () => {
  assert.strictEqual(countryForRole(ACCOUNT_ROLES.US_STOCK), 'US');
  assert.strictEqual(countryForRole(ACCOUNT_ROLES.IRA), 'US');
  assert.strictEqual(countryForRole(ACCOUNT_ROLES.AU_STOCK), 'AU');
  assert.strictEqual(countryForRole(ACCOUNT_ROLES.SUPER), 'AU');
  assert.strictEqual(roleCanHoldGold(ACCOUNT_ROLES.IRA), false);
  assert.strictEqual(roleCanHoldGold(ACCOUNT_ROLES.SUPER), true);   // AU super may hold bullion
  assert.strictEqual(roleCanHoldGold(ACCOUNT_ROLES.US_STOCK), true); // taxable is fine
});

test('RC-helper: targetForRole drops GOLD from a US tax-advantaged account and renormalizes', () => {
  const target = { EQUITY: 0.5, BOND: 0.2, CASH: 0.1, GOLD: 0.2 };
  const ira    = targetForRole(target, ACCOUNT_ROLES.IRA);
  assert.ok(!('GOLD' in ira), 'IRA target must have no GOLD');
  assert.ok(Math.abs(Object.values(ira).reduce((s, v) => s + v, 0) - 1) < 1e-6, 'renormalized to 1');
  // Super keeps gold (AU bullion allowed).
  assert.deepStrictEqual(targetForRole(target, ACCOUNT_ROLES.SUPER), target);
});

// ── Taxable sell realizes CGT; value conserved gross ─────────────────────────────

test('RC-1: taxable US_STOCK rebalance realizes STOCK_WITHDRAWAL_TAX; balance conserved gross', () => {
  const state = baseState({
    usStockAccount: { balance: 60000, holdings: [
      { allocation: ALLOCATION.EQUITY, marketValue: 60000, costBasis: 40000, purchaseDate: new Date(Date.UTC(2020, 0, 1)) },
    ] },
  });
  const { applied, taxes } = rebalance(state, { stateKey: 'usStockAccount', role: ACCOUNT_ROLES.US_STOCK },
    { EQUITY: 0.5, BOND: 0.5 });

  const hs = applied.usStockAccount.holdings;
  // Sold $30k equity (basis share 40k*0.5=20k → gain 10k), bought $30k bond.
  const tax = taxes.find(t => t.type === 'STOCK_WITHDRAWAL_TAX');
  assert.ok(tax, 'STOCK_WITHDRAWAL_TAX emitted');
  assert.strictEqual(tax.gain, 10000);
  assert.strictEqual(tax.proceeds, 30000);
  assert.strictEqual(tax.costBasis, 20000);
  assert.ok(Math.abs(mvOf(hs, ALLOCATION.EQUITY) - 30000) < 1, 'equity halved');
  assert.ok(Math.abs(mvOf(hs, ALLOCATION.BOND)   - 30000) < 1, 'bond established');
  assert.ok(Math.abs(totOf(hs) - 60000) < 1, 'gross value conserved');
  assert.ok(Math.abs(applied.usStockAccount.balance - 60000) < 1, 'balance re-synced, unchanged');
});

test('RC-2: sheltered IRA rebalance is free (no tax action)', () => {
  const state = baseState({
    iraAccount: { balance: 60000, holdings: [
      { allocation: ALLOCATION.EQUITY, marketValue: 60000, costBasis: 40000 },
    ] },
  });
  const { applied, taxes } = rebalance(state, { stateKey: 'iraAccount', role: ACCOUNT_ROLES.IRA },
    { EQUITY: 0.5, BOND: 0.5 });
  assert.strictEqual(taxes.length, 0, 'sheltered rebalance realizes no tax');
  const hs = applied.iraAccount.holdings;
  assert.ok(Math.abs(mvOf(hs, ALLOCATION.BOND) - 30000) < 1, 'bond established free');
  assert.ok(Math.abs(totOf(hs) - 60000) < 1, 'value conserved');
});

// ── Establish-new-sleeve primitive ───────────────────────────────────────────────

test('RC-3: establishes a BOND sleeve with correct rateKey / basis / purchaseDate / duration', () => {
  const state = baseState({
    iraAccount: { balance: 10000, holdings: [
      { allocation: ALLOCATION.EQUITY, marketValue: 10000, costBasis: 8000 },
    ] },
  });
  const { applied } = rebalance(state, { stateKey: 'iraAccount', role: ACCOUNT_ROLES.IRA },
    { EQUITY: 0.5, BOND: 0.5 });
  const bond = applied.iraAccount.holdings.find(h => h.allocation === ALLOCATION.BOND);
  assert.ok(bond, 'BOND sleeve established');
  assert.strictEqual(bond.costBasis, bond.marketValue, 'fresh basis = market');
  assert.strictEqual(bond.rateKey, RATE_KEYS.FIXED_INCOME_US, 'US bond rateKey');
  assert.ok(bond.purchaseDate instanceof Date, 'purchaseDate stamped');
  assert.ok(bond.duration > 0, 'BOND duration defaulted from RATE_KEY_META');
  assert.strictEqual(bond.taxExemption, 'none', 'an established sleeve is a generic taxable bond (design 66 §G2)');
  assert.strictEqual(bond.issuingState, null);
  // No effectiveInterestRates in this state ⇒ couponRate stays null (floats), the pre-G1 behavior.
  assert.strictEqual(bond.couponRate, null, 'no market rate available ⇒ coupon floats (null)');
});

test('RC-3-G1: an established BOND sleeve locks its coupon to the market yield at purchase (design 66 G1)', () => {
  // Per-account override wins over the shared key, mirroring the earnings-handler precedence.
  const state = baseState({
    effectiveInterestRates: { FIXED_INCOME_US: 0.045, 'FIXED_INCOME_US::iraAccount': 0.071 },
    iraAccount: { balance: 10000, holdings: [
      { allocation: ALLOCATION.EQUITY, marketValue: 10000, costBasis: 8000 },
    ] },
  });
  const { applied } = rebalance(state, { stateKey: 'iraAccount', role: ACCOUNT_ROLES.IRA },
    { EQUITY: 0.5, BOND: 0.5 });
  const bond = applied.iraAccount.holdings.find(h => h.allocation === ALLOCATION.BOND);
  assert.strictEqual(bond.couponRate, 0.071, 'coupon stamped from the per-account market yield at purchase');

  // With only the shared key present, the sleeve locks that.
  const shared = baseState({
    effectiveInterestRates: { FIXED_INCOME_US: 0.045 },
    iraAccount: { balance: 10000, holdings: [
      { allocation: ALLOCATION.EQUITY, marketValue: 10000, costBasis: 8000 },
    ] },
  });
  const bond2 = rebalance(shared, { stateKey: 'iraAccount', role: ACCOUNT_ROLES.IRA },
    { EQUITY: 0.5, BOND: 0.5 }).applied.iraAccount.holdings.find(h => h.allocation === ALLOCATION.BOND);
  assert.strictEqual(bond2.couponRate, 0.045, 'coupon stamped from the shared market yield');
});

// ── GOLD: jurisdiction-correct tax + the US-IRA guard ────────────────────────────

test('RC-4: selling a GOLD sleeve routes through COLLECTIBLE_SALE_TAX (isGold)', () => {
  const state = baseState({
    usStockAccount: { balance: 20000, holdings: [
      { allocation: ALLOCATION.GOLD,   marketValue: 12000, costBasis: 4000, purchaseDate: new Date(Date.UTC(2019, 0, 1)) },
      { allocation: ALLOCATION.EQUITY, marketValue: 8000,  costBasis: 8000 },
    ] },
  });
  // Target away from gold → sell gold.
  const { taxes } = rebalance(state, { stateKey: 'usStockAccount', role: ACCOUNT_ROLES.US_STOCK },
    { EQUITY: 0.5, GOLD: 0.1, BOND: 0.4 });
  const coll = taxes.find(t => t.type === 'COLLECTIBLE_SALE_TAX');
  assert.ok(coll, 'COLLECTIBLE_SALE_TAX emitted for the gold slice');
  assert.strictEqual(coll.isGold, true);
  assert.ok(coll.gain > 0, 'gold gain realized');
});

test('RC-5: gold guard — a GOLD target never establishes a sleeve in a US IRA', () => {
  const state = baseState({
    iraAccount: { balance: 10000, holdings: [
      { allocation: ALLOCATION.EQUITY, marketValue: 10000, costBasis: 8000 },
    ] },
  });
  const { actions, applied } = rebalance(state, { stateKey: 'iraAccount', role: ACCOUNT_ROLES.IRA },
    { EQUITY: 0.5, GOLD: 0.5 });
  // The leg reducer renormalized the IRA target to gold-free, so no gold leg exists…
  const goldLeg = (actions[0]?.legs ?? []).find(l => l.allocation === ALLOCATION.GOLD);
  assert.ok(!goldLeg, 'no GOLD leg generated for the guarded IRA');
  // …and no gold sleeve is ever established.
  assert.ok(!applied.iraAccount.holdings.some(h => h.allocation === ALLOCATION.GOLD),
    'no GOLD sleeve in the IRA');
});

test('RC-3b: every established sleeve gets a UNIQUE id (no HoldingTransact collision)', () => {
  // Regression: id:null on new sleeves collides in HoldingTransactReducer (matches by
  // h.id === holdingId), so a sibling sleeve's per-holding growth/interest lands on the
  // wrong holding and corrupts the account. Establishing BOND+CASH+GOLD from a single
  // EQUITY sleeve must yield four distinct, non-null ids.
  const state = baseState({
    superAccount: { balance: 100000, role: ACCOUNT_ROLES.SUPER, holdings: [
      { id: 'e0', allocation: ALLOCATION.EQUITY, marketValue: 100000, costBasis: 60000 },
    ] },
  });
  const { applied } = rebalance(state, { stateKey: 'superAccount', role: ACCOUNT_ROLES.SUPER },
    { EQUITY: 0.4, BOND: 0.3, CASH: 0.1, GOLD: 0.2 });
  const hs  = applied.superAccount.holdings;
  const ids = hs.map(h => h.id);
  assert.ok(ids.every(Boolean), `every holding must have a non-null id: ${JSON.stringify(ids)}`);
  assert.strictEqual(new Set(ids).size, ids.length, `ids must be unique: ${JSON.stringify(ids)}`);
  assert.strictEqual(hs.length, 4, 'four sleeves established');
});

test('RC-6: AU_STOCK taxable sell realizes AU_STOCK_WITHDRAWAL_TAX', () => {
  const state = baseState({
    people: { p1: { residency: 'AU' } },
    auStockAccount: { balance: 50000, holdings: [
      { allocation: ALLOCATION.EQUITY, marketValue: 50000, costBasis: 30000, purchaseDate: new Date(Date.UTC(2019, 0, 1)) },
    ] },
  });
  const { taxes } = rebalance(state, { stateKey: 'auStockAccount', role: ACCOUNT_ROLES.AU_STOCK },
    { EQUITY: 0.6, BOND: 0.4 });
  const tax = taxes.find(t => t.type === 'AU_STOCK_WITHDRAWAL_TAX');
  assert.ok(tax, 'AU_STOCK_WITHDRAWAL_TAX emitted');
  assert.ok('auDiscountableGain' in tax, 'carries the AU discountable-gain slice');
  assert.ok(tax.gain > 0);
});

// ── Split drift bands ────────────────────────────────────────────────────────────

test('RC-7: the same drift triggers under the tight sheltered band but not the wide taxable band', () => {
  // 55/45 equity/bond vs a 50/50 target → 5pp drift.
  const holdings = [
    { allocation: ALLOCATION.EQUITY, marketValue: 55000, costBasis: 40000 },
    { allocation: ALLOCATION.BOND,   marketValue: 45000, costBasis: 45000 },
  ];
  const target = { EQUITY: 0.5, BOND: 0.5 };

  // Taxable, wide band 0.10 → 5pp drift does NOT trigger.
  const taxableRes = rebalance(baseState({ usStockAccount: { balance: 100000, holdings } }),
    { stateKey: 'usStockAccount', role: ACCOUNT_ROLES.US_STOCK }, target);
  assert.strictEqual(taxableRes.actions.length, 0, 'wide taxable band suppresses the 5pp drift');

  // Sheltered, tight band 0.02 → 5pp drift DOES trigger.
  const shelteredRes = rebalance(baseState({ iraAccount: { balance: 100000, holdings } }),
    { stateKey: 'iraAccount', role: ACCOUNT_ROLES.IRA }, target);
  assert.strictEqual(shelteredRes.actions.length, 1, 'tight sheltered band triggers on the 5pp drift');
});
