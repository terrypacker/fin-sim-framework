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
 * evt-tips-expected-inflation.test.mjs — the inflation a TIPS rung expects (design 125).
 *
 * EXP-1  TENOR's closed form and limits: T ≤ 1 gives π₀, a long tenor tends to the anchor, no
 *        reversion gives π₀, π₀ = A gives exactly A; the share-weighted speed with w = 0 is
 *        the single country speed; TRAILING / CURRENT / no spec read as their names say
 * EXP-2  the latent forecast: k = 0 is today's deviation (GAUSSIAN and joint), and k years
 *        ahead matches the mean of many seeded InflationTickHandler steps, skew included
 * EXP-3  a hot global factor under an equal cool own factor reads near the anchor today but
 *        expects inflation above it; a regime residual on top decays at the fallback rate
 * EXP-4  tipsRealYield: no spec is design 121's trailing rule; a null tenor is the fund tenor
 *        on both halves
 * EXP-5  build and roll: the reducers lock nominal − expected inflation for the rung's tenor,
 *        the same figure for the same tenor; onset and after-spike move the right way
 * EXP-6  the toolset hands BondLadderReducer and BondMaturityReducer the same spec
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { expectedInflation, trailingInflation, tipsRealYield, resolveYield, tipsExpectationSpec }
  from '../../src/finance/economic-regimes/yield-curve.js';
import { InflationTickHandler, expectedInflationDeviation, combineInflationLatent, skewedInflationDeviation, inflationProcessConfig }
  from '../../src/finance/economic-regimes/inflation-tick-handler.js';
import { InflationStepReducer } from '../../src/finance/economic-regimes/inflation-step-reducer.js';
import { BondLadderReducer }    from '../../src/finance/behavioral/bond-ladder-reducer.js';
import { BondMaturityReducer }  from '../../src/finance/economic-regimes/bond-maturity-reducer.js';
import { ALLOCATION }           from '../../src/finance/holdings/allocation.js';
import { loadScenarioSim }      from '../helpers/scenario-harness.js';

const ms   = (y, m = 0, d = 1) => Date.UTC(y, m, d);
const near = (a, b, what, tol = 1e-12) => assert.ok(Math.abs(a - b) < tol, `${what}: expected ${b}, got ${a}`);

const SINGLE = (k = 0.33) => ({ mode: 'TENOR', process: { globalShare: 0, reversionSpeed: { US: k, AU: k } } });
const DEFAULT = tipsExpectationSpec({});
const flat = (now, anchor = 0.03) => ({ baseInflationRates: { US: anchor }, effectiveInflationRates: { US: now } });

// ── EXP-1 ────────────────────────────────────────────────────────────────────────

test('EXP-1: TENOR closed form and limits; the other modes read as named', () => {
  const s = flat(0.08);
  const a = Math.exp(-0.33);
  for (const n of [2, 3, 5, 10]) {
    const g = (1 - a ** n) / (n * (1 - a));
    near(expectedInflation(s, 'US', n, SINGLE()), 0.03 + 0.05 * g, `closed form n=${n}`);
  }
  near(expectedInflation(s, 'US', 1, SINGLE()), 0.08, 'a one-year rung expects π₀');
  near(expectedInflation(s, 'US', 0.25, SINGLE()), 0.08, 'so does a shorter one');
  near(expectedInflation(s, 'US', 0, SINGLE()), 0.08, 'T → 0 gives π₀');
  near(expectedInflation(s, 'US', 400, SINGLE()), 0.03, 'a long tenor tends to the anchor', 1e-3);
  near(expectedInflation(s, 'US', 7, { mode: 'TENOR', process: { globalShare: 0.4, globalReversionSpeed: 0, reversionSpeed: { US: 0 } } }),
    0.08, 'no reversion gives π₀');
  assert.equal(expectedInflation(flat(0.03), 'US', 5, DEFAULT), 0.03, 'π₀ = A gives exactly A');
  // A fractional tail year weighs its share: 2.5 years = years 0, 1 and half of 2.
  near(expectedInflation(s, 'US', 2.5, SINGLE()), 0.03 + 0.05 * (1 + a + 0.5 * a * a) / 2.5, 'fractional tenor');

  // Share-weighted fallback: w·g(κ_g) + (1 − w)·g(κ); w = 0 is the single speed.
  const ag = Math.exp(-0.1);
  const gOf = (x, n) => (1 - x ** n) / (n * (1 - x));
  near(expectedInflation(s, 'US', 5, DEFAULT), 0.03 + 0.05 * (0.4 * gOf(ag, 5) + 0.6 * gOf(a, 5)), 'share-weighted');
  near(expectedInflation(s, 'US', 5, { ...DEFAULT, process: { ...DEFAULT.process, globalShare: 0 } }),
    expectedInflation(s, 'US', 5, SINGLE()), 'w = 0 is the single speed');

  const hist = { ...s, currentPeriods: { US: { startMs: ms(2031) } }, bracketIndexAccumulatorByYear: { US: { 2030: 1, 2031: 1.03 } } };
  assert.equal(expectedInflation(hist, 'US', 5, null), trailingInflation(hist, 'US'), 'no spec is TRAILING');
  assert.equal(expectedInflation(hist, 'US', 5, { mode: 'TRAILING' }), trailingInflation(hist, 'US'));
  assert.equal(expectedInflation(hist, 'US', 5, { mode: 'CURRENT' }), 0.08);
  assert.equal(expectedInflation({ effectiveInflationRates: { US: 0.05 } }, 'US', 5, DEFAULT), 0.05,
    'no anchor in state ⇒ π₀');
});

// ── EXP-2 ────────────────────────────────────────────────────────────────────────

const mulberry = (seed) => () => {
  seed = (seed + 0x6D2B79F5) >>> 0; let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const ANCHORS = { baseInflationRates: { US: 0.03, AU: 0.025 } };

function procOpts(cfg, cc, joint = false) {
  return {
    anchor: ANCHORS.baseInflationRates[cc], bound: cfg.lowerBound[cc], vol: cfg.vol[cc],
    w: joint ? cfg.globalShareJoint : cfg.globalShare,
    ag: Math.exp(-cfg.globalReversionSpeed), a: Math.exp(-cfg.reversionSpeed[cc]), joint,
  };
}

test('EXP-2: the latent forecast is today\'s deviation at k = 0 and the simulated mean ahead', () => {
  const cfg    = inflationProcessConfig({});
  const latent = { g: 1.1, US: -0.4, AU: 0.7 };
  for (const joint of [false, true]) {
    for (const cc of ['US', 'AU']) {
      const o = procOpts(cfg, cc, joint);
      const today = skewedInflationDeviation(combineInflationLatent(latent.g, latent[cc], o), o);
      near(expectedInflationDeviation(latent, cc, 0, o), today, `k=0 ${cc} joint=${joint}`, 1e-15);
      near(expectedInflationDeviation(latent, cc, 300, o), 0, `k→∞ ${cc} joint=${joint}`, 1e-9);
    }
  }

  // Monte Carlo through the real tick + step reducer (GAUSSIAN).
  const h = new InflationTickHandler(cfg);
  const reducer = new InflationStepReducer();
  const N = 20000, K = 6;
  const sums = { US: new Array(K + 1).fill(0), AU: new Array(K + 1).fill(0) };
  const rng = mulberry(125);
  for (let i = 0; i < N; i++) {
    let state = { ...ANCHORS, inflationLatent: { ...latent } };
    for (let k = 1; k <= K; k++) {
      const a = h.call({ sim: { rng }, state })[0];
      state = reducer.reduce(state, a);
      for (const cc of ['US', 'AU']) sums[cc][k] += a.deviation[cc];
    }
  }
  for (const cc of ['US', 'AU']) {
    for (let k = 1; k <= K; k++) {
      // The deviation's sd is ~0.03, so 2e4 paths put the sampling error near 2e-4.
      near(sums[cc][k] / N, expectedInflationDeviation(latent, cc, k, procOpts(cfg, cc)), `${cc} k=${k}`, 8e-4);
    }
  }
});

// ── EXP-3 ────────────────────────────────────────────────────────────────────────

test('EXP-3: offsetting factors drift toward the slow one; a regime residual decays at the fallback', () => {
  const cfg = inflationProcessConfig({});
  const w   = cfg.globalShare;
  // y = 0 today: √w·g = −√(1−w)·x.
  const latent = { g: 1.5, US: -1.5 * Math.sqrt(w / (1 - w)), AU: 0 };
  const o   = procOpts(cfg, 'US');
  const dev = expectedInflationDeviation(latent, 'US', 0, o);
  const now = 0.03 + dev;
  const s = { ...ANCHORS, inflationLatent: latent, inflationDev: { US: dev }, effectiveInflationRates: { US: now } };
  // Same y, so the same rate today as a latent at rest (the skew's median, a little under A)…
  const rest = { ...s, inflationLatent: { g: 0, US: 0, AU: 0 } };
  near(expectedInflationDeviation(rest.inflationLatent, 'US', 0, o), dev, 'same reading today', 1e-15);
  // …but the slow global factor outlasts the own one, so it expects more inflation.
  assert.ok(expectedInflation(s, 'US', 10, DEFAULT) > expectedInflation(rest, 'US', 10, DEFAULT) + 0.002,
    'the slow global factor outlasts the own one');

  // A regime adds +4 pp on top of the path: the residual decays at the share-weighted rate.
  const r = 0.04;
  const withRegime = { ...s, effectiveInflationRates: { US: now + r } };
  const residualOnly = flat(0.03 + r);
  for (const T of [1, 3, 7]) {
    near(expectedInflation(withRegime, 'US', T, DEFAULT) - expectedInflation(s, 'US', T, DEFAULT),
      expectedInflation({ ...residualOnly, ...ANCHORS }, 'US', T, DEFAULT) - 0.03, `additive at T=${T}`);
  }
});

// ── EXP-4 / EXP-5 ────────────────────────────────────────────────────────────────

const CURVE = [{ tenor: 1, spread: -0.005 }, { tenor: 5, spread: 0 }, { tenor: 10, spread: 0.005 }];

function rateState({ fi = 0.07, infl = 0.08, levels = { 2030: 1.0, 2031: 1.03 }, anchor = 0.03 } = {}) {
  return {
    effectiveInterestRates:  { FIXED_INCOME_US: fi },
    yieldCurve:              { US: CURVE },
    effectiveInflationRates: { US: infl },
    baseInflationRates:      { US: anchor },
    currentPeriods:          { US: { startMs: ms(2031) } },
    bracketIndexAccumulatorByYear: { US: levels },
  };
}

test('EXP-4: tipsRealYield with no spec is trailing; a null tenor is the fund tenor on both halves', () => {
  const s = rateState();
  const nominal5 = resolveYield(s, { rateKey: 'FIXED_INCOME_US', tenorYears: 5 });
  near(tipsRealYield(s, { rateKey: 'FIXED_INCOME_US', tenorYears: 5 }), nominal5 - 0.03, 'no spec');
  near(tipsRealYield(s, { rateKey: 'FIXED_INCOME_US', expectation: DEFAULT }),
    nominal5 - expectedInflation(s, 'US', 5, DEFAULT), 'null tenor = 5y fund tenor');
});

function buildLadder(spec, state) {
  const s = { ...state, acct: { role: 'us-stock', country: 'US', balance: 50_000,
    holdings: [{ id: 'b', allocation: ALLOCATION.BOND, marketValue: 50_000, costBasis: 50_000 }] } };
  return new BondLadderReducer({ stateKey: 'acct', targetRungs: 5, inflationLinked: true, inflationExpectation: spec })
    .reduce(s, { type: 'US_PERIOD_ADVANCE' }).acct.holdings.filter(h => h.allocation === ALLOCATION.BOND);
}

function rollOne(spec, state) {
  const asOf = ms(2031, 0, 2);
  const s = { ...state, currentPeriods: { US: { startMs: asOf } }, acct: { balance: 10_000, holdings: [{
    id: 't', allocation: 'BOND', marketValue: 10_000, costBasis: 10_000, faceValue: 10_000,
    maturityDate: new Date(ms(2031)), purchaseDate: new Date(ms(2026)), rollAtMaturity: true,
    rollTermYears: 5, inflationLinked: true, couponRate: 0.015, rateKey: 'FIXED_INCOME_US', tipsCouponMode: 'MARKET',
  }] } };
  return new BondMaturityReducer({ inflationExpectation: spec }).reduce(s, { type: 'US_PERIOD_ADVANCE' }).acct.holdings[0];
}

test('EXP-5: build and roll lock nominal − expected inflation, and agree at the same tenor', () => {
  const s = rateState();
  const rungs = buildLadder(DEFAULT, s);
  rungs.forEach((h, k) => near(h.couponRate,
    resolveYield(s, { rateKey: 'FIXED_INCOME_US', tenorYears: k + 1 }) - expectedInflation(s, 'US', k + 1, DEFAULT), `rung ${k}`));
  near(rollOne(DEFAULT, s).couponRate, rungs[4].couponRate, 'the 5-year roll matches the 5-year build');
  near(rollOne(null, s).couponRate, resolveYield(s, { rateKey: 'FIXED_INCOME_US', tenorYears: 5 }) - 0.03,
    'a bare BondMaturityReducer rolls under TRAILING');

  // Onset: nominal and current inflation up, the history not yet: TENOR locks less than TRAILING.
  const onset = rateState({ infl: 0.08, levels: { 2030: 1.0, 2031: 1.03 } });
  assert.ok(rollOne(DEFAULT, onset).couponRate < rollOne(null, onset).couponRate, 'onset');
  // After a spike: nominal back down, current = trailing = 8%: TENOR locks more than either.
  const spike = rateState({ fi: 0.03, infl: 0.08, levels: { 2030: 1.0, 2031: 1.08 } });
  const tenor = rollOne(DEFAULT, spike).couponRate;
  assert.ok(tenor > rollOne(null, spike).couponRate, 'after a spike, vs TRAILING');
  assert.ok(tenor > rollOne({ mode: 'CURRENT' }, spike).couponRate, 'after a spike, vs CURRENT');
});

// ── EXP-6 ────────────────────────────────────────────────────────────────────────

test('EXP-6: the toolset hands both bond reducers the same spec, from the params', () => {
  const { sim } = loadScenarioSim({ telemetry: 'off', params: {
    behavioralStrategies: ['BOND_LADDER'], bondLadderInflationLinked: true,
    bondLadderTipsExpectedInflation: 'CURRENT', inflationReversionSpeedUs: 0.5,
  } });
  const specs = {};
  for (const list of sim.reducers.map.values()) {
    for (const r of [list].flat()) {
      const red = r?.reducer ?? r;
      const name = red?.constructor?.name;
      if (name === 'BondLadderReducer' || name === 'BondMaturityReducer') specs[name] = red.inflationExpectation;
    }
  }
  assert.ok(specs.BondLadderReducer && specs.BondMaturityReducer, 'both reducers present');
  assert.deepEqual(specs.BondLadderReducer, specs.BondMaturityReducer);
  assert.equal(specs.BondMaturityReducer.mode, 'CURRENT');
  assert.equal(specs.BondMaturityReducer.process.reversionSpeed.US, 0.5);
  assert.equal(tipsExpectationSpec({}).mode, 'TENOR', 'TENOR is the default');
});
