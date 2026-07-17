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
 * with the exemption splits of designs 59 (Treasury) and 66 §G2 (municipal).
 *
 * A BOND holding pays coupon interest (Σ marketValue × couponRate) that is
 * federally taxable ordinary income. The `taxExemption` enum (design 66,
 * generalizing the design-59 `treasury` boolean) classifies each holding:
 *   - 'none'    — corporate/other: fully taxable federal + state;
 *   - 'state'   — a direct U.S. Treasury obligation: federally taxable but EXEMPT
 *                 from US state income tax (31 U.S.C. § 3124);
 *   - 'federal' — a municipal bond: federally EXEMPT; state-exempt only when its
 *                 `issuingState` matches the resident's state (in-state muni).
 * The splits are carried on BOND_COUPON_TAX as `amount` (full coupon),
 * `federalTaxableAmount` (excludes munis) and `stateTaxableAmount` (excludes
 * Treasuries and in-state munis).
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { computeHoldingsCoupons } from '../../src/finance/holdings/holdings-earnings.js';
import { Holding }                 from '../../src/finance/holdings/holding.js';

import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { BaseScenario }           from '../../src/scenarios/base-scenario.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';

// ── Unit: the coupon compute helper ──────────────────────────────────────────

test('EVT-BOND-COUPON-1: computeHoldingsCoupons sums BOND coupons and splits out the Treasury (state-exempt) slice', () => {
  const state = { acct: { holdings: [
    { id: 'b1', allocation: 'BOND',   marketValue: 10000, couponRate: 0.05, taxExemption: 'none'  }, // corporate → 500
    { id: 'b2', allocation: 'BOND',   marketValue: 10000, couponRate: 0.04, taxExemption: 'state' }, // treasury  → 400 (state-exempt)
    { id: 'e1', allocation: 'EQUITY', marketValue: 50000, dividendYield: 0.02 },                     // ignored (not a bond)
    { id: 'c1', allocation: 'CASH',   marketValue: 30000 },                                          // ignored
  ] } };

  const r = computeHoldingsCoupons({ state, stateKey: 'acct', fallbackRate: 0.03 });

  assert.strictEqual(r.amount, 900, 'full coupon = 500 + 400');
  assert.strictEqual(r.federalTaxableAmount, 900, 'both coupons are federally taxable (Treasury exemption is state-only)');
  assert.strictEqual(r.stateTaxableAmount, 500, 'state-taxable excludes the Treasury coupon');
  assert.strictEqual(r.holdingActions.length, 2, 'one reinvest action per non-zero bond coupon');
});

test('EVT-BOND-COUPON-2: a BOND holding with no couponRate falls back to the account rate', () => {
  const state = { acct: { holdings: [
    { id: 'b1', allocation: 'BOND', marketValue: 20000, couponRate: null, taxExemption: 'none' },
  ] } };

  const r = computeHoldingsCoupons({ state, stateKey: 'acct', fallbackRate: 0.03 });

  assert.strictEqual(r.amount, 600, '20000 × 0.03 fallback');
  assert.strictEqual(r.federalTaxableAmount, 600);
  assert.strictEqual(r.stateTaxableAmount, 600);
});

test('EVT-BOND-COUPON-3: an all-Treasury account produces coupon income that is fully state-exempt', () => {
  const state = { acct: { holdings: [
    { id: 'b1', allocation: 'BOND', marketValue: 10000, couponRate: 0.0426, taxExemption: 'state' },
  ] } };

  const r = computeHoldingsCoupons({ state, stateKey: 'acct', fallbackRate: 0.04 });

  assert.strictEqual(r.amount, 426, 'federally taxable coupon');
  assert.strictEqual(r.federalTaxableAmount, 426, 'Treasury coupon is federally taxable');
  assert.strictEqual(r.stateTaxableAmount, 0, 'Treasury coupon is state-exempt');
});

test('EVT-BOND-COUPON-3b: back-compat — a legacy `treasury: true` holding is still state-exempt', () => {
  // A holding object persisted before design 66 carries the old boolean. Holding.fromJSON
  // maps it to taxExemption:'state'; the raw compute helper does NOT (it reads the enum),
  // so this guards the field name the rest of the pipeline now uses.
  const legacy = { id: 'b1', allocation: 'BOND', marketValue: 10000, couponRate: 0.04, treasury: true };
  const migrated = Holding.fromJSON(legacy);
  assert.strictEqual(migrated.taxExemption, 'state', 'treasury:true → taxExemption state');

  const r = computeHoldingsCoupons({ state: { acct: { holdings: [migrated] } }, stateKey: 'acct', fallbackRate: 0.04 });
  assert.strictEqual(r.stateTaxableAmount, 0, 'migrated Treasury coupon is state-exempt');
  assert.strictEqual(r.federalTaxableAmount, 400, 'and federally taxable');
});

test('EVT-BOND-COUPON-3c: a municipal bond is federally exempt; state-exempt only in-state (design 66 §G2)', () => {
  const muni = { id: 'm1', allocation: 'BOND', marketValue: 10000, couponRate: 0.03, taxExemption: 'federal', issuingState: 'CA' };
  const others = [
    { id: 'b1', allocation: 'BOND', marketValue: 10000, couponRate: 0.05, taxExemption: 'none' }, // corporate → 500
  ];
  const mk = (residencyState) => ({
    acct:   { holdings: [muni, ...others] },
    people: { p1: { residencyState } },
  });

  // CA resident: the CA muni is exempt federal AND state; corporate is fully taxable.
  const inState = computeHoldingsCoupons({ state: mk('CA'), stateKey: 'acct', fallbackRate: 0 });
  assert.strictEqual(inState.amount, 800, 'full coupon = 300 muni + 500 corp');
  assert.strictEqual(inState.federalTaxableAmount, 500, 'muni is federally exempt');
  assert.strictEqual(inState.stateTaxableAmount, 500, 'in-state muni is also state-exempt');

  // NY resident: the CA muni is out-of-state — still federally exempt, but state-TAXABLE.
  const outState = computeHoldingsCoupons({ state: mk('NY'), stateKey: 'acct', fallbackRate: 0 });
  assert.strictEqual(outState.federalTaxableAmount, 500, 'muni is federally exempt regardless of residence');
  assert.strictEqual(outState.stateTaxableAmount, 800, 'out-of-state muni coupon is state-taxable');

  // 'both' — an unconditionally state-exempt muni ignores residence.
  const both = computeHoldingsCoupons({
    state: { acct: { holdings: [{ ...muni, taxExemption: 'both' }] }, people: { p1: { residencyState: 'NY' } } },
    stateKey: 'acct', fallbackRate: 0,
  });
  assert.strictEqual(both.federalTaxableAmount, 0, 'both ⇒ federally exempt');
  assert.strictEqual(both.stateTaxableAmount, 0, 'both ⇒ state-exempt regardless of residence');
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
 * the Treasury holding is flagged state-exempt (to compare exempt vs not).
 */
function seedBonds(treasuryFlag) {
  return (cfg) => {
    const acct = (cfg.accounts ?? []).find(a => a.role === 'us-stock');
    assert.ok(acct, 'expected a us-stock account in the default scenario');
    acct.holdings = [
      { id: 'corp-bond', allocation: 'BOND', marketValue: 100000, costBasis: 100000, couponRate: 0.05, rateKey: 'FIXED_INCOME_US', taxExemption: 'none' },
      { id: 'treas-bond', allocation: 'BOND', marketValue: 100000, costBasis: 100000, couponRate: 0.04, rateKey: 'FIXED_INCOME_US', taxExemption: treasuryFlag ? 'state' : 'none' },
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
        amount:         a.amount       ?? a.data?.amount,
        federalTaxable: a.federalTaxableAmount ?? a.data?.federalTaxableAmount,
        stateTaxable:   a.stateTaxableAmount   ?? a.data?.stateTaxableAmount,
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
