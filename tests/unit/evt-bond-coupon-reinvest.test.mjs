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
 * evt-bond-coupon-reinvest.test.mjs — design 66 §G10b (reinvestment risk).
 *
 * Reinvested bond coupons buy a NEW-VINTAGE lot priced at the then-prevailing market
 * yield (`state.effectiveInterestRates[rateKey]`), not the maturing bond's own coupon.
 * The sleeve becomes a real blend of coupon vintages. Lots consolidate to one per
 * (tax-character bucket × year); both semi-annual firings of a year merge into that
 * year's lot with a market-value-weighted coupon rate.
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import {
  mergeCouponReinvestLots,
  resolvePrevailingCouponRate,
  computeHoldingsCoupons,
} from '../../src/finance/holdings/holdings-earnings.js';

import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { BaseScenario }           from '../../src/scenarios/base-scenario.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';

// ── resolvePrevailingCouponRate ──────────────────────────────────────────────

test('G10b-1: resolvePrevailingCouponRate prefers the per-account rate, then the shared key, else null', () => {
  const state = { effectiveInterestRates: {
    FIXED_INCOME_US: 0.045,
    'FIXED_INCOME_US::iraAccount': 0.052,
  } };
  assert.equal(resolvePrevailingCouponRate(state, 'iraAccount', 'FIXED_INCOME_US'), 0.052, 'per-account override wins');
  assert.equal(resolvePrevailingCouponRate(state, 'otherAccount', 'FIXED_INCOME_US'), 0.045, 'falls back to the shared key');
  assert.equal(resolvePrevailingCouponRate(state, 'iraAccount', 'MISSING_KEY'), null, 'absent ⇒ null');
  assert.equal(resolvePrevailingCouponRate({}, 'iraAccount', 'FIXED_INCOME_US'), null, 'no rates ⇒ null');
});

// ── mergeCouponReinvestLots ──────────────────────────────────────────────────

const bucket = (over = {}) => ({ taxExemption: 'none', issuingState: null, rateKey: 'FIXED_INCOME_US', amount: 500, ...over });

test('G10b-2: a coupon creates a new-vintage BOND lot at the PREVAILING yield (not the source coupon)', () => {
  const holdings = [{ id: 'src', allocation: 'BOND', marketValue: 10000, costBasis: 10000, couponRate: 0.02 }];
  const next = mergeCouponReinvestLots(holdings, {
    stateKey: 'acct', buckets: [bucket({ amount: 500 })], prevailingRate: 0.06, year: 2030, purchaseMs: Date.UTC(2030, 11, 31),
  });

  assert.equal(next.length, 2, 'source untouched + one new lot');
  const src = next.find(h => h.id === 'src');
  assert.equal(src.marketValue, 10000, 'source bond is not grown by the coupon');
  const lot = next.find(h => h.id !== 'src');
  assert.equal(lot.allocation, 'BOND');
  assert.equal(lot.marketValue, 500, 'new lot holds the reinvested coupon');
  assert.equal(lot.costBasis, 500, 'a bond lot basis = its market value');
  assert.equal(lot.couponRate, 0.06, 'new lot is priced at the prevailing yield, NOT the 0.02 source coupon');
  assert.equal(lot.couponFrequency, 2, 'new lot is semi-annual (§G10a default)');
  assert.equal(lot.taxExemption, 'none', 'inherits the source bucket tax character');
});

test('G10b-3: two firings in the same year merge into ONE vintage lot with an mv-weighted blended rate', () => {
  // Jun firing @ prevailing 0.06 for 500, then Dec firing @ prevailing 0.04 for 500.
  const jun = mergeCouponReinvestLots(
    [{ id: 'src', allocation: 'BOND', marketValue: 10000, costBasis: 10000, couponRate: 0.05 }],
    { stateKey: 'acct', buckets: [bucket({ amount: 500 })], prevailingRate: 0.06, year: 2030, purchaseMs: 0 },
  );
  const dec = mergeCouponReinvestLots(jun, {
    stateKey: 'acct', buckets: [bucket({ amount: 500 })], prevailingRate: 0.04, year: 2030, purchaseMs: 0,
  });

  const lots = dec.filter(h => h.id !== 'src');
  assert.equal(lots.length, 1, 'both firings consolidate into the single 2030 vintage lot');
  assert.equal(lots[0].marketValue, 1000, 'lot accumulates both coupons');
  // Blended rate = (500·0.06 + 500·0.04) / 1000 = 0.05.
  assert.ok(Math.abs(lots[0].couponRate - 0.05) < 1e-9, `mv-weighted blended coupon rate, got ${lots[0].couponRate}`);
});

test('G10b-4: different years produce DISTINCT vintage lots (the blend of vintages)', () => {
  let h = [{ id: 'src', allocation: 'BOND', marketValue: 10000, costBasis: 10000, couponRate: 0.05 }];
  h = mergeCouponReinvestLots(h, { stateKey: 'acct', buckets: [bucket({ amount: 400 })], prevailingRate: 0.06, year: 2030, purchaseMs: 0 });
  h = mergeCouponReinvestLots(h, { stateKey: 'acct', buckets: [bucket({ amount: 400 })], prevailingRate: 0.03, year: 2031, purchaseMs: 0 });

  const lots = h.filter(x => x.id !== 'src');
  assert.equal(lots.length, 2, 'one lot per year');
  assert.deepEqual(lots.map(l => l.couponRate).sort(), [0.03, 0.06], 'each vintage keeps its own year-of-issue yield');
});

test('G10b-5: distinct tax buckets do not merge (a Treasury coupon reinvests into a new Treasury)', () => {
  const buckets = [
    bucket({ taxExemption: 'none',  amount: 300 }),
    bucket({ taxExemption: 'state', amount: 200 }),   // Treasury slice
  ];
  const next = mergeCouponReinvestLots([], { stateKey: 'acct', buckets, prevailingRate: 0.05, year: 2030, purchaseMs: 0 });
  assert.equal(next.length, 2, 'one lot per tax bucket');
  const treasury = next.find(l => l.taxExemption === 'state');
  assert.equal(treasury.marketValue, 200, 'the Treasury coupon buys a new Treasury lot');
});

test('G10b-6: empty buckets or empty holdings are safe no-ops', () => {
  const h = [{ id: 'src', allocation: 'BOND', marketValue: 100 }];
  assert.equal(mergeCouponReinvestLots(h, { stateKey: 'a', buckets: [], prevailingRate: 0.05, year: 2030 }), h, 'no buckets ⇒ same array');
  assert.deepEqual(mergeCouponReinvestLots([], { stateKey: 'a', buckets: [bucket()], prevailingRate: 0.05, year: 2030 }).length, 1, 'empty holdings still gains the lot');
});

// ── End-to-end: the lever bites when prevailing ≠ source coupon ───────────────

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

test('G10b-7 (e2e): a low-coupon sleeve reinvests at the higher prevailing rate into a new lot', () => {
  // Source bond pays a 2% coupon, but the prevailing fixed-income yield is 6%. The
  // reinvested coupon should buy a new lot at ~6%, not perpetuate the 2% source.
  const sim = run(
    { residencyState: 'NE', monthlyExpenses: 0, inflationAdjust: false, fixedIncomeInterestRate: 0.06 },
    (cfg) => {
      const acct = (cfg.accounts ?? []).find(a => a.role === 'ira');
      assert.ok(acct, 'expected an ira account');
      acct.holdings = [{ id: 'low-coupon', allocation: 'BOND', marketValue: 100000, costBasis: 100000, rateKey: 'FIXED_INCOME_US', couponRate: 0.02 }];
      acct.initialValue = 100000; acct.balance = 100000;
    },
  );
  sim.stepTo(new Date(Date.UTC(2027, 0, 2)));

  const acct = sim.state.iraAccount;
  const source = acct.holdings.find(h => h.id === 'low-coupon');
  assert.ok(Math.abs(source.marketValue - 100000) < 0.01, 'the 2% source bond stays at par (coupon not reinvested into it)');
  const lot = acct.holdings.find(h => typeof h.id === 'string' && h.id.startsWith('reinvest-'));
  assert.ok(lot, 'a new-vintage reinvest lot exists');
  assert.ok(lot.couponRate > 0.05, `reinvest lot carries the ~6% prevailing yield, not 2%, got ${lot.couponRate}`);
});
