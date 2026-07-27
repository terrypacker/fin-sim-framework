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
 * evt-bond-sleeve-coupon.test.mjs — coupon interest on the BOND sleeve of an
 * equity-served account (IRA / 401k / Roth / super / au-stock).
 *
 * Sibling of evt-cash-sleeve-interest (design 60), which closed the same gap for
 * CASH sleeves. These accounts run off the equity-growth earnings handler, which
 * applies NO return to BOND holdings (a bond's return is its coupon). US_STOCK
 * brokerage bonds have their own INTL_BOND_COUPON stream; every OTHER equity-served
 * account had none, so a BOND sleeve there (routinely established by the design-61
 * allocation lever, with a null couponRate) earned nothing. This annual stream pays
 * those sleeves their coupon, always reinvesting it, taxed per the account's wrapper:
 * tax-deferred (401k/IRA/Roth/super) or AU ordinary income (au-stock).
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { computeHoldingsCoupons } from '../../src/finance/holdings/holdings-earnings.js';
import { BondSleeveCouponApplyReducer } from '../../src/finance/reducers/bond-sleeve-coupon-apply-reducer.js';

import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { BaseScenario }           from '../../src/scenarios/base-scenario.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';

// ── Unit: the coupon compute helper falls back per-account when couponRate is null ──

test('EVT-BOND-SLV-1: computeHoldingsCoupons pays only BOND sleeves; null couponRate uses the fallback', () => {
  const state = {
    acct: { holdings: [
      { id: 'b1', allocation: 'BOND',   marketValue: 20000, couponRate: 0.05 },     // explicit → 1000
      { id: 'b2', allocation: 'BOND',   marketValue: 10000, couponRate: null },     // null → fallback 0.04 → 400
      { id: 'e1', allocation: 'EQUITY', marketValue: 50000, rateKey: 'EQUITY_US' }, // ignored
      { id: 'c1', allocation: 'CASH',   marketValue: 10000, rateKey: 'SAVINGS_US' },   // ignored
      { id: 'g1', allocation: 'GOLD',   marketValue: 10000, rateKey: 'GOLD' },       // ignored
    ] },
  };

  const r = computeHoldingsCoupons({ state, stateKey: 'acct', fallbackRate: 0.04 });

  assert.strictEqual(r.amount, 1400, 'only BOND sleeves earn; null couponRate falls back to 0.04');
  assert.strictEqual(r.holdingActions.length, 2, 'two reinvest actions, one per BOND sleeve');
  const b2 = r.holdingActions.find(a => a.holdingId === 'b2');
  assert.strictEqual(b2.marketValueDelta, 400, 'the null-couponRate sleeve earns the fallback');
  assert.strictEqual(b2.costBasisDelta, 0, 'reinvested coupon does not raise basis');
});

// ── Reducer postconditions: the three tax modes ──────────────────────────────

const baseState = () => ({
  usOrdinaryIncomeYTD: 0, auOrdinaryIncomeYTD: 0,
  usSourceOrdinaryUsdYTD: 0, usSourceOrdinaryAudYTD: 0,
  acct: { balance: 10000, holdings: [{ id: 'b1', allocation: 'BOND', marketValue: 10000 }] },
});

test('EVT-BOND-SLV-2: taxMode=deferred credits balance with no immediate tax', () => {
  const r = new BondSleeveCouponApplyReducer({});
  const next = r.reduce(baseState(), { type: 'BOND_SLEEVE_COUPON_APPLY', amount: 500, stateKey: 'acct', taxMode: 'deferred', residency: 'US' });

  assert.strictEqual(next.acct.balance, 10500, 'coupon grows the tax-deferred wrapper');
  assert.strictEqual(next.usOrdinaryIncomeYTD, 0, 'no immediate tax — taxed (or not, for Roth) on withdrawal');
  assert.deepEqual(next.next, [], 'no chained tax action on the deferred path');
});

test('EVT-BOND-SLV-3: taxMode=au credits balance and chains AU_SAVINGS_EARNINGS_TAX', () => {
  const r = new BondSleeveCouponApplyReducer({});
  const next = r.reduce(baseState(), { type: 'BOND_SLEEVE_COUPON_APPLY', amount: 300, stateKey: 'acct', taxMode: 'au', residency: 'AU' });

  assert.strictEqual(next.acct.balance, 10300);
  assert.strictEqual(next.usOrdinaryIncomeYTD, 0, 'US buckets untouched on the AU path');
  const tax = next.next.find(a => a.type === 'AU_SAVINGS_EARNINGS_TAX');
  assert.ok(tax, 'chains the AU ordinary-income tax action');
  assert.strictEqual(tax.amount, 300);
});

test('EVT-BOND-SLV-4: taxMode=us chains BOND_COUPON_TAX with the Treasury-exempt split', () => {
  const r = new BondSleeveCouponApplyReducer({});
  const next = r.reduce(baseState(), { type: 'BOND_SLEEVE_COUPON_APPLY', amount: 400, stateTaxableAmount: 250, stateKey: 'acct', taxMode: 'us', residency: 'AU' });

  assert.strictEqual(next.acct.balance, 10400, 'coupon credited to balance');
  const tax = next.next.find(a => a.type === 'BOND_COUPON_TAX');
  assert.ok(tax, 'routes through the design-59 bond-coupon tax classification');
  assert.strictEqual(tax.amount, 400, 'full coupon = federal ordinary income');
  assert.strictEqual(tax.stateTaxableAmount, 250, 'state-taxable portion excludes Treasury holdings');
  assert.strictEqual(tax.residency, 'AU', 'residency threaded for FITO relief');
});

test('EVT-BOND-SLV-5: zero/absent coupon is a no-op on the balance', () => {
  const r = new BondSleeveCouponApplyReducer({});
  const next = r.reduce(baseState(), { type: 'BOND_SLEEVE_COUPON_APPLY', amount: 0, stateKey: 'acct', taxMode: 'deferred' });
  assert.strictEqual(next.acct.balance, 10000, 'no coupon → balance unchanged');
});

// ── Integration: a BOND sleeve in a deferred wrapper grows end-to-end ─────────

function run(params, mutateCfg) {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  const cfg = IntlRetirementScenario.buildDefaultConfig(params, undefined, undefined);
  if (mutateCfg) mutateCfg(cfg);
  const scenario = new BaseScenario({
    context: services.simulationContext, initialState: cfg.initialState ?? {},
    simStart: new Date(cfg.simStart), simEnd: new Date(cfg.simEnd),
  });
  scenario.buildSim();
  new ScenarioLoader().load(cfg, services);
  return scenario.sim;
}

function seedBondSleeve(role, cfg) {
  const acct = (cfg.accounts ?? []).find(a => a.role === role);
  assert.ok(acct, `expected a ${role} account in the default scenario`);
  acct.holdings = [
    { id: 'bond-sleeve', allocation: 'BOND', marketValue: 100000, costBasis: 100000, rateKey: 'FIXED_INCOME_US', couponRate: 0.05 },
  ];
  acct.initialValue = 100000;
  acct.balance = 100000;
  return acct;
}

test('EVT-BOND-SLV-6: an IRA BOND sleeve reinvests its coupon into a new-vintage lot (§G10b)', () => {
  const sim = run({ residencyState: 'NE', monthlyExpenses: 0, inflationAdjust: false, fixedIncomeInterestRate: 0.05 },
    (cfg) => seedBondSleeve('ira', cfg));
  sim.stepTo(new Date(Date.UTC(2027, 0, 2)));   // past the first year-end

  const acct = sim.state.iraAccount;
  // §G10b: the coupon no longer grows the SOURCE bond; it buys a new-vintage BOND lot
  // at the prevailing yield. The source stays at par; the account total grows.
  const source = acct.holdings.find(h => h.id === 'bond-sleeve');
  assert.ok(Math.abs(source.marketValue - 100000) < 0.01, 'the source sleeve is not grown by the coupon (par preserved)');
  const reinvestLots = acct.holdings.filter(h => typeof h.id === 'string' && h.id.startsWith('reinvest-'));
  assert.ok(reinvestLots.length > 0, 'a new-vintage reinvest lot was created for the coupon');
  assert.ok(reinvestLots.every(h => h.allocation === 'BOND' && h.couponRate > 0), 'reinvest lots are BOND with a stamped prevailing coupon');
  assert.ok(acct.balance > 100000, `account total grew from the reinvested coupon, got ${acct.balance}`);
  const sumMv = acct.holdings.reduce((s, h) => s + (h.marketValue ?? 0), 0);
  assert.ok(Math.abs(acct.balance - sumMv) < 0.01, '§4.4: balance stays synced to Σ holdings');
});

test('EVT-BOND-SLV-7: a super BOND sleeve reinvests its coupon (deferred, no immediate AU tax booked) (§G10b)', () => {
  const sim = run({ residencyState: 'NE', monthlyExpenses: 0, inflationAdjust: false, auFixedIncomeInterestRate: 0.05 },
    (cfg) => seedBondSleeve('super', cfg));
  sim.stepTo(new Date(Date.UTC(2027, 0, 2)));

  const acct = sim.state.superAccount;
  const reinvestLots = acct.holdings.filter(h => typeof h.id === 'string' && h.id.startsWith('reinvest-'));
  assert.ok(reinvestLots.length > 0, 'a new-vintage reinvest lot was created for the super coupon');
  assert.ok(acct.balance > 100000, `super account total grew from the reinvested coupon, got ${acct.balance}`);
});
