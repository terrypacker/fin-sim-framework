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
 * evt-bond-coupon.test.mjs — bond coupon interest as a distinct taxable stream,
 * with the direct-U.S.-Treasury state exemption (design 59).
 *
 * A BOND holding pays coupon interest (Σ marketValue × couponRate) that is
 * federally taxable ordinary income. A holding flagged `treasury: true` is a
 * direct U.S. Treasury obligation — its coupon is federally taxable but EXEMPT
 * from US state income tax (31 U.S.C. § 3124). The split is carried on
 * BOND_COUPON_TAX as `amount` (federal) vs `stateTaxableAmount` (state).
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { computeHoldingsCoupons } from '../../src/finance/holdings/holdings-earnings.js';

import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { BaseScenario }           from '../../src/scenarios/base-scenario.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';

// ── Unit: the coupon compute helper ──────────────────────────────────────────

test('EVT-BOND-COUPON-1: computeHoldingsCoupons sums BOND coupons and splits out the Treasury (state-exempt) slice', () => {
  const state = { acct: { holdings: [
    { id: 'b1', allocation: 'BOND',   marketValue: 10000, couponRate: 0.05, treasury: false }, // corporate → 500
    { id: 'b2', allocation: 'BOND',   marketValue: 10000, couponRate: 0.04, treasury: true  }, // treasury  → 400 (state-exempt)
    { id: 'e1', allocation: 'EQUITY', marketValue: 50000, dividendYield: 0.02 },               // ignored (not a bond)
    { id: 'c1', allocation: 'CASH',   marketValue: 30000 },                                    // ignored
  ] } };

  const r = computeHoldingsCoupons({ state, stateKey: 'acct', fallbackRate: 0.03 });

  assert.strictEqual(r.amount, 900, 'full coupon = 500 + 400');
  assert.strictEqual(r.stateTaxableAmount, 500, 'state-taxable excludes the Treasury coupon');
  assert.strictEqual(r.holdingActions.length, 2, 'one reinvest action per non-zero bond coupon');
});

test('EVT-BOND-COUPON-2: a BOND holding with no couponRate falls back to the account rate', () => {
  const state = { acct: { holdings: [
    { id: 'b1', allocation: 'BOND', marketValue: 20000, couponRate: null, treasury: false },
  ] } };

  const r = computeHoldingsCoupons({ state, stateKey: 'acct', fallbackRate: 0.03 });

  assert.strictEqual(r.amount, 600, '20000 × 0.03 fallback');
  assert.strictEqual(r.stateTaxableAmount, 600);
});

test('EVT-BOND-COUPON-3: an all-Treasury account produces coupon income that is fully state-exempt', () => {
  const state = { acct: { holdings: [
    { id: 'b1', allocation: 'BOND', marketValue: 10000, couponRate: 0.0426, treasury: true },
  ] } };

  const r = computeHoldingsCoupons({ state, stateKey: 'acct', fallbackRate: 0.04 });

  assert.strictEqual(r.amount, 426, 'federally taxable coupon');
  assert.strictEqual(r.stateTaxableAmount, 0, 'Treasury coupon is state-exempt');
});

// ── Integration: end-to-end through the prebuilt scenario ────────────────────

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

/**
 * The programmatic default scenario carries no bonds, so seed a us-stock account
 * with one corporate bond and one Treasury bond. `treasuryFlag` toggles whether
 * the Treasury holding is actually flagged (to compare exempt vs not).
 */
function seedBonds(treasuryFlag) {
  return (cfg) => {
    const acct = (cfg.accounts ?? []).find(a => a.role === 'us-stock');
    assert.ok(acct, 'expected a us-stock account in the default scenario');
    acct.holdings = [
      { id: 'corp-bond', allocation: 'BOND', marketValue: 100000, costBasis: 100000, couponRate: 0.05, rateKey: 'FIXED_INCOME_US', treasury: false },
      { id: 'treas-bond', allocation: 'BOND', marketValue: 100000, costBasis: 100000, couponRate: 0.04, rateKey: 'FIXED_INCOME_US', treasury: treasuryFlag },
    ];
    acct.initialValue = 200000;
    acct.balance = 200000;
  };
}

// The journal stores the graph-node form of an action; its payload lives under
// `.data` (reducers themselves receive the flattened top-level fields).
const couponTaxes = (sim) =>
  sim.journal.journal
    .filter(e => e.action?.type === 'BOND_COUPON_TAX')
    .map(e => {
      const a = e.action;
      return {
        amount:       a.amount       ?? a.data?.amount,
        stateTaxable: a.stateTaxableAmount ?? a.data?.stateTaxableAmount,
      };
    });

test('EVT-BOND-COUPON-4: BOND holdings emit BOND_COUPON_TAX carrying the Treasury-exempt split', () => {
  const sim = run({ residencyState: 'NE' }, seedBonds(true));
  sim.stepTo(new Date(Date.UTC(2028, 0, 2)));   // past the first year-end coupon

  const taxes = couponTaxes(sim);
  assert.ok(taxes.length > 0, 'bond coupons should have fired BOND_COUPON_TAX');

  // Two equal-value bonds: corporate coupon 5% (fully taxable) + Treasury coupon
  // 4% (state-exempt). The federal `amount` covers both; the state-taxable slice is
  // the corporate portion only, so stateTaxable/amount = 5/(5+4) regardless of how
  // much the sleeves have since appreciated.
  const first = taxes[0];
  assert.ok(first.amount > 0, 'coupon should be federally taxable');
  assert.ok(first.stateTaxable > 0 && first.stateTaxable < first.amount,
    'Treasury slice is state-exempt, so state-taxable < full coupon');
  assert.ok(Math.abs(first.stateTaxable / first.amount - 5 / 9) < 0.001,
    `state-taxable share should be the corporate 5/9, got ${(first.stateTaxable / first.amount).toFixed(4)}`);
});

test('EVT-BOND-COUPON-5: the Treasury flag lowers the state base but not the federal base', () => {
  // Same bonds, Treasury flag on vs off. Federal ordinary coupon is identical
  // (Treasuries are federally taxable); the state-taxable coupon is strictly lower
  // when the Treasury slice is flagged exempt. Zero spending so the two runs share
  // an identical brokerage trajectory (no state-tax-driven drawdown feedback).
  const params = { residencyState: 'NE', monthlyExpenses: 0, inflationAdjust: false };
  const runStepped = (flag) => {
    const sim = run(params, seedBonds(flag));
    sim.stepTo(new Date(Date.UTC(2028, 0, 2)));
    return couponTaxes(sim);
  };
  const withFlag    = runStepped(true);
  const withoutFlag = runStepped(false);

  const fedFlag    = withFlag.reduce((s, t) => s + t.amount, 0);
  const fedPlain   = withoutFlag.reduce((s, t) => s + t.amount, 0);
  const stateFlag  = withFlag.reduce((s, t) => s + t.stateTaxable, 0);
  const statePlain = withoutFlag.reduce((s, t) => s + t.stateTaxable, 0);

  assert.ok(fedFlag > 0 && Math.abs(fedFlag - fedPlain) < 0.01, 'federal coupon base is unchanged by the Treasury flag');
  assert.ok(stateFlag < statePlain - 0.01, 'flagging Treasury lowers the state-taxable coupon base');
});
