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
 * evt-bond-accretion.test.mjs — non-cash bond accretion (design 66 §G5 + §G6):
 *
 *   - G6 zero-coupon / OID: bought at a discount, the price accretes to par via the
 *     constant-yield method; the annual Original Issue Discount is imputed ordinary
 *     income despite no cash, and steps up basis so redemption at par realizes nothing.
 *   - G5 TIPS / inflation-linked: the principal indexes to CPI; the inflation
 *     accretion is imputed ("phantom") ordinary income and steps up basis; the cash
 *     coupon (separate stream) is paid on the grown principal; redemption has a
 *     deflation floor at par.
 *
 * Both flow through the shared BondAccretionHandler → BOND_ACCRETION_APPLY path,
 * reusing the design-59/66 BOND_COUPON_TAX classification for the federal/state
 * exemption split (a Treasury STRIPS is state-exempt; a muni zero federal-exempt).
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { computeHoldingsAccretion } from '../../src/finance/holdings/holdings-earnings.js';
import { BondAccretionApplyReducer } from '../../src/finance/reducers/bond-accretion-apply-reducer.js';
import { BondPriceAdjustReducer }    from '../../src/finance/economic-regimes/bond-price-adjust-reducer.js';
import { BondMaturityReducer }       from '../../src/finance/economic-regimes/bond-maturity-reducer.js';

import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { BaseScenario }           from '../../src/scenarios/base-scenario.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

// ── Unit: the accretion compute helper ───────────────────────────────────────

test('ACC-1: zero-coupon OID accretes basis toward par by the constant-yield method', () => {
  const asOf = Date.UTC(2026, 0, 1);
  const mat  = asOf + 5 * YEAR_MS;   // exactly 5 years to maturity
  const state = {
    acct: { holdings: [
      { id: 'z1', allocation: 'BOND', marketValue: 8000, costBasis: 8000, faceValue: 10000,
        maturityDate: new Date(mat), zeroCoupon: true, taxExemption: 'none' },
      { id: 'p1', allocation: 'BOND', marketValue: 5000, costBasis: 5000, couponRate: 0.04 }, // plain: no accretion
    ] },
  };

  const r = computeHoldingsAccretion({ state, stateKey: 'acct', currentDate: asOf });

  // y = (10000/8000)^(1/5) − 1 ≈ 0.045639 ; accretion = 8000·y ≈ 365.11
  const y = Math.pow(10000 / 8000, 1 / 5) - 1;
  const expected = +(8000 * y).toFixed(2);
  assert.strictEqual(r.amount, expected, 'OID is the constant-yield accretion off the adjusted basis');
  assert.ok(r.amount > 360 && r.amount < 370, `sanity: ~365, got ${r.amount}`);
  assert.strictEqual(r.holdingActions.length, 1, 'only the zero accretes; the plain bond is skipped');
  const a = r.holdingActions[0];
  assert.strictEqual(a.holdingId, 'z1');
  assert.strictEqual(a.marketValueDelta, expected, 'principal grows by the accretion');
  assert.strictEqual(a.costBasisDelta, expected, 'basis steps up by the accretion (no double-tax at maturity)');
});

test('ACC-1b: zero-coupon OID caps the final-year accretion at par (never overshoots faceValue)', () => {
  const asOf = Date.UTC(2026, 0, 1);
  const mat  = asOf + 0.25 * YEAR_MS;   // <1y left → raw constant-yield would overshoot
  const state = { acct: { holdings: [
    { id: 'z1', allocation: 'BOND', marketValue: 9800, costBasis: 9800, faceValue: 10000,
      maturityDate: new Date(mat), zeroCoupon: true },
  ] } };
  const r = computeHoldingsAccretion({ state, stateKey: 'acct', currentDate: asOf });
  assert.strictEqual(r.amount, 200, 'accretion is capped at faceValue − basis = 200');
});

test('ACC-2: TIPS indexes the principal by the period CPI rate and steps up basis', () => {
  const state = { acct: { holdings: [
    { id: 't1', allocation: 'BOND', marketValue: 10000, costBasis: 10000, faceValue: 10000,
      inflationLinked: true, couponRate: 0.01, taxExemption: 'none' },
  ] } };
  const r = computeHoldingsAccretion({ state, stateKey: 'acct', cpiRate: 0.03 });
  assert.strictEqual(r.amount, 300, 'accretion = basis × cpiRate = 10000 × 0.03');
  const a = r.holdingActions[0];
  assert.strictEqual(a.marketValueDelta, 300);
  assert.strictEqual(a.costBasisDelta, 300, 'inflation accretion steps up basis');
});

test('ACC-2b: TIPS deflation produces a negative accretion (symmetric)', () => {
  const state = { acct: { holdings: [
    { id: 't1', allocation: 'BOND', marketValue: 10000, costBasis: 10000, inflationLinked: true },
  ] } };
  const r = computeHoldingsAccretion({ state, stateKey: 'acct', cpiRate: -0.02 });
  assert.strictEqual(r.amount, -200, 'deflation shrinks the principal / income symmetrically');
});

test('ACC-3: the federal/state split reuses the coupon exemption rules', () => {
  // Resident of NE; an in-state (NE) muni zero is federal- AND state-exempt.
  const state = {
    people: { p1: { residencyState: 'NE' } },
    acct: { holdings: [
      // Treasury STRIPS: federally taxable, state-exempt (31 U.S.C. § 3124).
      { id: 'strip', allocation: 'BOND', marketValue: 8000, costBasis: 8000, faceValue: 10000,
        maturityDate: new Date(Date.UTC(2031, 0, 1)), zeroCoupon: true, taxExemption: 'state' },
      // In-state muni zero: federal- and state-exempt.
      { id: 'muni', allocation: 'BOND', marketValue: 8000, costBasis: 8000, faceValue: 10000,
        maturityDate: new Date(Date.UTC(2031, 0, 1)), zeroCoupon: true, taxExemption: 'federal', issuingState: 'NE' },
    ] },
  };
  const r = computeHoldingsAccretion({ state, stateKey: 'acct', currentDate: Date.UTC(2026, 0, 1) });
  assert.ok(r.amount > 0, 'both accrete');
  // Treasury OID is federally taxable; muni OID is federally exempt → fed slice = the strip's accretion only.
  const stripAccretion = r.holdingActions.find(a => a.holdingId === 'strip').marketValueDelta;
  assert.strictEqual(r.federalTaxableAmount, stripAccretion, 'muni OID excluded from the federal-taxable slice');
  assert.strictEqual(r.stateTaxableAmount, 0, 'Treasury + in-state muni are both state-exempt');
});

test('ACC-4: plain coupon bonds and bond funds do not accrete', () => {
  const state = { acct: { holdings: [
    { id: 'fund', allocation: 'BOND', marketValue: 10000, costBasis: 10000, couponRate: 0.04 }, // fund
    { id: 'ind',  allocation: 'BOND', marketValue: 10000, costBasis: 10000, faceValue: 10000,
      maturityDate: new Date(Date.UTC(2035, 0, 1)), couponRate: 0.04 },                          // plain individual
  ] } };
  const r = computeHoldingsAccretion({ state, stateKey: 'acct', cpiRate: 0.03, currentDate: Date.UTC(2026, 0, 1) });
  assert.strictEqual(r.amount, 0, 'no accretion without zeroCoupon / inflationLinked');
  assert.strictEqual(r.holdingActions.length, 0);
});

// ── Reducer postconditions: the three tax modes + deflation ──────────────────

const baseState = () => ({
  usOrdinaryIncomeYTD: 0, usNetInvestmentIncomeYTD: 0, auOrdinaryIncomeYTD: 0,
  usSourceOrdinaryUsdYTD: 0, usSourceOrdinaryAudYTD: 0,
  acct: { balance: 10000, holdings: [{ id: 'b1', allocation: 'BOND', marketValue: 10000 }] },
});

test('ACC-5: taxMode=deferred credits balance, no immediate tax', () => {
  const r = new BondAccretionApplyReducer({});
  const next = r.reduce(baseState(), { type: 'BOND_ACCRETION_APPLY', amount: 400, stateKey: 'acct', taxMode: 'deferred', residency: 'US' });
  assert.strictEqual(next.acct.balance, 10400);
  assert.strictEqual(next.usOrdinaryIncomeYTD, 0, 'deferred wrapper: taxed on withdrawal');
  assert.deepEqual(next.next, []);
});

test('ACC-6: taxMode=us routes accretion through BOND_COUPON_TAX with the fed/state split', () => {
  const r = new BondAccretionApplyReducer({});
  const next = r.reduce(baseState(), { type: 'BOND_ACCRETION_APPLY', amount: 365, federalTaxableAmount: 365, stateTaxableAmount: 0, stateKey: 'acct', taxMode: 'us', residency: 'US' });
  assert.strictEqual(next.acct.balance, 10365);
  const tax = next.next.find(a => a.type === 'BOND_COUPON_TAX');
  assert.ok(tax, 'OID is ordinary income via the shared bond-coupon tax path');
  assert.strictEqual(tax.federalTaxableAmount, 365);
  assert.strictEqual(tax.stateTaxableAmount, 0, 'a Treasury STRIPS OID is state-exempt');
});

test('ACC-7: taxMode=au chains AU_SAVINGS_EARNINGS_TAX', () => {
  const r = new BondAccretionApplyReducer({});
  const next = r.reduce(baseState(), { type: 'BOND_ACCRETION_APPLY', amount: 300, stateKey: 'acct', taxMode: 'au', residency: 'AU' });
  assert.strictEqual(next.acct.balance, 10300);
  const tax = next.next.find(a => a.type === 'AU_SAVINGS_EARNINGS_TAX');
  assert.ok(tax && tax.amount === 300, 'AU ordinary income on accrual');
});

test('ACC-8: a negative (deflation) accretion reduces balance and is not a no-op', () => {
  const r = new BondAccretionApplyReducer({});
  const next = r.reduce(baseState(), { type: 'BOND_ACCRETION_APPLY', amount: -150, federalTaxableAmount: -150, stateTaxableAmount: -150, stateKey: 'acct', taxMode: 'us', residency: 'US' });
  assert.strictEqual(next.acct.balance, 9850, 'deflation shrinks the principal');
  const tax = next.next.find(a => a.type === 'BOND_COUPON_TAX');
  assert.strictEqual(tax.federalTaxableAmount, -150, 'reduces ordinary income symmetrically');
});

// ── Price/maturity reducer interaction ───────────────────────────────────────

test('ACC-9: BondPriceAdjustReducer skips pull-to-par for accreting bonds (rate mark still applies)', () => {
  const asOf = Date.UTC(2030, 0, 1);
  const mat  = Date.UTC(2031, 0, 1);   // 1y to maturity
  const mkState = (extraFlags) => ({
    effectiveInterestRates: { FIXED_INCOME_US: 0.05 },
    priorMarkRates:         { FIXED_INCOME_US: 0.04 },   // +1% rate move → markdown
    priorMarkMs:            asOf - YEAR_MS,
    currentPeriods:         { US: { startMs: asOf } },
    acct: { balance: 8000, holdings: [
      { id: 'x', allocation: 'BOND', marketValue: 8000, costBasis: 8000, faceValue: 10000,
        duration: 3, rateKey: 'FIXED_INCOME_US', maturityDate: new Date(mat), ...extraFlags },
    ] },
  });

  const zero = new BondPriceAdjustReducer().reduce(mkState({ zeroCoupon: true }), { type: 'US_PERIOD_ADVANCE' });
  const plain = new BondPriceAdjustReducer().reduce(mkState({}), { type: 'US_PERIOD_ADVANCE' });

  const zMv = zero.acct.holdings[0].marketValue;
  const pMv = plain.acct.holdings[0].marketValue;
  // Both take the same rate-sensitivity markdown (effDuration = min(3, 1yr)=1, Δrate +0.01 → −80).
  assert.ok(zMv < 8000, 'the zero still takes the rate mark');
  // The plain individual bond ALSO pulls toward par (10000) → ends higher than the zero.
  assert.ok(pMv > zMv, `plain bond pulls to par; zero does not (zero=${zMv}, plain=${pMv})`);
});

test('ACC-10: BondMaturityReducer redeems a TIPS at max(adjustedPrincipal, faceValue) — deflation floor', () => {
  const asOf = Date.UTC(2035, 0, 2);
  const mkState = (mv) => ({
    currentPeriods: { US: { startMs: asOf } },
    effectiveInterestRates: {},
    acct: { balance: mv, holdings: [
      { id: 't', allocation: 'BOND', marketValue: mv, costBasis: mv, faceValue: 10000,
        maturityDate: new Date(Date.UTC(2035, 0, 1)), inflationLinked: true, rateKey: 'FIXED_INCOME_US' },
    ] },
  });

  // Inflation: adjusted principal 11000 > par → redeems at 11000.
  const infl = new BondMaturityReducer().reduce(mkState(11000), { type: 'US_PERIOD_ADVANCE' });
  const h1 = infl.acct.holdings[0];
  assert.strictEqual(h1.allocation, 'CASH', 'redeemed to cash');
  assert.strictEqual(h1.marketValue, 11000, 'redeems at the inflation-adjusted principal');
  assert.strictEqual(h1.inflationLinked, false, 'flag cleared on redemption');

  // Deflation: adjusted principal 9500 < par → deflation floor at par 10000.
  const defl = new BondMaturityReducer().reduce(mkState(9500), { type: 'US_PERIOD_ADVANCE' });
  assert.strictEqual(defl.acct.holdings[0].marketValue, 10000, 'deflation floor pays par');
});

// ── Integration: a brokerage zero grows + is taxed end-to-end ────────────────

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

test('ACC-11: a brokerage zero-coupon bond accretes to par over the sim (previously flat)', () => {
  const sim = run({ residencyState: 'NE', monthlyExpenses: 0, inflationAdjust: false },
    (cfg) => {
      const acct = (cfg.accounts ?? []).find(a => a.role === 'us-stock');
      assert.ok(acct, 'expected a us-stock brokerage account');
      acct.holdings = [
        { id: 'zero', allocation: 'BOND', marketValue: 80000, costBasis: 80000, faceValue: 100000,
          rateKey: 'FIXED_INCOME_US', duration: 8, zeroCoupon: true,
          maturityDate: new Date(Date.UTC(2034, 0, 1)), purchaseDate: new Date(Date.UTC(2026, 0, 1)) },
      ];
      acct.initialValue = 80000;
      acct.balance = 80000;
    });
  sim.stepTo(new Date(Date.UTC(2028, 0, 2)));   // past two year-ends

  const acct = sim.state.usStockAccount;
  const zero = acct.holdings.find(h => h.id === 'zero');
  assert.ok(zero, 'zero still present pre-maturity');
  assert.ok(zero.costBasis > 80000, `OID steps up the basis, got ${zero.costBasis}`);
  assert.ok(zero.marketValue > 80000, `principal accretes toward par, got ${zero.marketValue}`);
});
