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
 * Design 129 step 0 — the base stock–bond correlation (§8 tests 1–7).
 *
 *   z_yield = −ρ·z_eq + √(1 − ρ²)·ε
 *
 * The handler tests drive YieldCurveTickHandler directly; the e2e tests check the compile
 * (stamp, event order, handler wiring) and that a plan not in play is untouched.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { YieldCurveTickHandler }  from '../../src/finance/economic-regimes/yield-curve-tick-handler.js';
import { BondPriceAdjustReducer } from '../../src/finance/economic-regimes/bond-price-adjust-reducer.js';
import { gaussianFrom }           from '../../src/finance/fx/fx-process-models.js';
import { RATE_KEYS }              from '../../src/finance/economic-regimes/rate-keys.js';
import {
  stockBondCorrelationOf, stockBondCorrelationActive, stockBondCorrelationWarnings,
} from '../../src/finance/economic-regimes/stock-bond-correlation.js';
import { loadScenarioSim }        from '../helpers/scenario-harness.js';

// Final state and the queue only — no journal or history reads (see yield-curve-dynamics).
const loadSim = (opts = {}) => loadScenarioSim({ telemetry: 'off', ...opts });

const YEAR = 2030;
const sim0 = (rng) => ({ rng, currentDate: new Date(Date.UTC(YEAR, 11, 31)) });
const lcg  = (seed) => { let s = seed; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return (s + 0.5) / 0x80000000; }; };
const shockFor = (z, year = YEAR + 1) => ({ equityMarketShock: { year, z } });
const K = 0.3, VOL = 0.01;

const corr = (xs, ys) => {
  const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxy / Math.sqrt(sxx * syy);
};

describe('stock-bond correlation — params', () => {
  test('ρ is clipped to [−1, 1] and a missing value is 0', () => {
    assert.equal(stockBondCorrelationOf({}), 0);
    assert.equal(stockBondCorrelationOf({ stockBondCorrelation: 1.7 }), 1);
    assert.equal(stockBondCorrelationOf({ stockBondCorrelation: -3 }), -1);
    assert.equal(stockBondCorrelationOf({ stockBondCorrelation: 'x' }), 0);
  });

  test('in play needs both flags, no joint mode, and ρ ≠ 0', () => {
    const on = { yieldCurveStochastic: true, equityReturnStochastic: true, stockBondCorrelation: 0.4 };
    assert.equal(stockBondCorrelationActive(on), true);
    assert.equal(stockBondCorrelationActive({ ...on, stockBondCorrelation: 0 }), false);
    assert.equal(stockBondCorrelationActive({ ...on, yieldCurveStochastic: false }), false);
    assert.equal(stockBondCorrelationActive({ ...on, equityReturnStochastic: false }), false);
    const joint = { ...on, inflationStochastic: true, inflationModel: 'HISTORICAL_JOINT', equityReturnModel: 'HISTORICAL_BOOTSTRAP' };
    assert.equal(stockBondCorrelationActive(joint), false);
  });

  // §8 test 7.
  test('warnings: inert when a flag is off, ignored in joint mode, silent otherwise', () => {
    assert.deepEqual(stockBondCorrelationWarnings({ stockBondCorrelation: 0 }), []);
    assert.deepEqual(stockBondCorrelationWarnings({ yieldCurveStochastic: true, equityReturnStochastic: true, stockBondCorrelation: 0.4 }), []);
    const [inert] = stockBondCorrelationWarnings({ yieldCurveStochastic: true, stockBondCorrelation: 0.4 });
    assert.match(inert, /Stochastic Equity Returns is off/);
    const [both] = stockBondCorrelationWarnings({ stockBondCorrelation: 0.4 });
    assert.match(both, /Stochastic Yield Curve and Stochastic Equity Returns are off/);
    const [joint] = stockBondCorrelationWarnings({
      yieldCurveStochastic: true, equityReturnStochastic: true, stockBondCorrelation: 0.4,
      inflationStochastic: true, inflationModel: 'HISTORICAL_JOINT', equityReturnModel: 'HISTORICAL_BOOTSTRAP',
    });
    assert.match(joint, /HISTORICAL_JOINT/);
  });
});

describe('YieldCurveTickHandler — correlated draw', () => {
  const step = (rho, state, rng) =>
    new YieldCurveTickHandler({ vol: VOL, reversionSpeed: K, equityCorrelation: rho }).call({ sim: sim0(rng), state });

  // §8 test 2.
  test('same ε with ρ on and off; only z_yield differs, by exactly the formula', () => {
    const prev  = { US: 0.004, AU: -0.002 };
    const zEq   = -1.3;
    const state = { yieldCurveLevelDev: prev, ...shockFor(zEq) };
    const off = step(0,   state, lcg(11));
    const on  = step(0.5, state, lcg(11));
    const eps = lcg(11);
    for (const [i, cc] of ['US', 'AU'].entries()) {
      const e = gaussianFrom(eps);
      const mean = prev[cc] * Math.exp(-K);
      assert.ok(Math.abs(off[i].deviation - (mean + VOL * e)) < 1e-15, `${cc}: ρ = 0 uses ε as is`);
      const want = mean + VOL * (-0.5 * zEq + Math.sqrt(1 - 0.25) * e);
      assert.ok(Math.abs(on[i].deviation - want) < 1e-15, `${cc}: −ρ·z_eq + √(1 − ρ²)·ε`);
    }
  });

  test('draw count is unchanged: the rng is left at the same cursor', () => {
    const a = lcg(5), b = lcg(5);
    step(0,   { ...shockFor(1) }, a);
    step(0.9, { ...shockFor(1) }, b);
    assert.equal(a(), b());
  });

  // §8 test 3.
  test('sign: a bad equity year marks bonds down at ρ = +0.9 and up at ρ = −0.9', () => {
    const mark = (rho) => {
      const [us] = step(rho, { yieldCurveLevelDev: { US: 0, AU: 0 }, ...shockFor(-2.5) }, () => 0.5);   // ε = 0
      const base = 0.04;
      const state = {
        effectiveInterestRates: { [RATE_KEYS.FIXED_INCOME_US]: base + us.deviation },
        priorMarkRates:         { [RATE_KEYS.FIXED_INCOME_US]: base },
        acct: { balance: 10_000, holdings: [
          { id: 'b', allocation: 'BOND', marketValue: 10_000, costBasis: 10_000, rateKey: RATE_KEYS.FIXED_INCOME_US },
        ] },
      };
      return new BondPriceAdjustReducer().reduce(state, { type: 'US_PERIOD_ADVANCE' }).acct.holdings[0].marketValue - 10_000;
    };
    assert.ok(mark(0.9) < 0, `ρ = +0.9 ⇒ bonds fall with stocks (got ${mark(0.9)})`);
    assert.ok(mark(-0.9) > 0, `ρ = −0.9 ⇒ bonds hedge (got ${mark(-0.9)})`);
  });

  // §8 test 4 — Gaussian and a skewed, bootstrap-like z (standardized, not normal).
  for (const [name, draw] of [
    ['Gaussian',  (r) => gaussianFrom(r)],
    ['skewed',    (r) => { const g = gaussianFrom(r); return (Math.exp(0.6 * g) - Math.exp(0.18)) / Math.sqrt((Math.exp(0.36) - 1) * Math.exp(0.36)); }],
  ]) {
    test(`realised correlation: innovations −ρ, Δy ≈ −0.93ρ (${name} z_eq)`, () => {
      const rho = 0.4, N = 20_000;
      const h = new YieldCurveTickHandler({ vol: VOL, reversionSpeed: K, equityCorrelation: rho });
      const eqRng = lcg(101), yRng = lcg(202);
      let prev = 0;
      const zs = [], innov = [], dy = [];
      for (let i = 0; i < N; i++) {
        const z = draw(eqRng);
        const [us] = h.call({ sim: sim0(yRng), state: { yieldCurveLevelDev: { US: prev, AU: 0 }, ...shockFor(z) } });
        zs.push(z);
        innov.push(us.deviation - prev * Math.exp(-K));
        dy.push(us.deviation - prev);
        prev = us.deviation;
      }
      const ci = corr(zs, innov), cd = corr(zs, dy);
      assert.ok(Math.abs(ci + rho) < 0.03, `innovation correlation ${ci.toFixed(3)} ≈ −${rho}`);
      const steady = rho / Math.sqrt(1 + (1 - Math.exp(-K)) ** 2 / (1 - Math.exp(-2 * K)));
      assert.ok(Math.abs(cd + steady) < 0.03, `Δy correlation ${cd.toFixed(3)} ≈ −${steady.toFixed(3)} (design 129 §3.1)`);
    });
  }

  // §8 test 6.
  test('no stamp, or a stamp for the wrong year ⇒ the uncorrelated draw', () => {
    const base = step(0, { yieldCurveLevelDev: { US: 0.001, AU: 0 } }, lcg(9));
    assert.deepEqual(step(0.6, { yieldCurveLevelDev: { US: 0.001, AU: 0 } }, lcg(9)), base);
    assert.deepEqual(step(0.6, { yieldCurveLevelDev: { US: 0.001, AU: 0 }, ...shockFor(-2, YEAR) }, lcg(9)), base);
  });

  test('toJSON carries equityCorrelation only when set, and round-trips', () => {
    assert.equal('equityCorrelation' in new YieldCurveTickHandler().toJSON(), false);
    const h = YieldCurveTickHandler.fromJSON(new YieldCurveTickHandler({ equityCorrelation: 0.4 }).toJSON());
    assert.equal(h.equityCorrelation, 0.4);
  });
});

describe('stock-bond correlation — compile (e2e)', () => {
  const END  = Date.UTC(2040, 0, 1);
  const BASE = { yieldCurveStochastic: true, equityReturnStochastic: true, randomSeed: 7, rngStreams: true };
  const tick = (sim, type) => sim.queue.data.find(e => e.type === type);

  // §8 tests 1 and 5.
  test('not in play ⇒ yield tick keeps order 0, no stamp, and ρ = 0 equals no ρ byte for byte', () => {
    const a = loadSim({ params: BASE, simEnd: END, stepTo: END }).sim;
    const b = loadSim({ params: { ...BASE, stockBondCorrelation: 0 }, simEnd: END, stepTo: END }).sim;
    assert.equal(tick(a, 'YIELD_CURVE_TICK').order ?? 0, 0);
    assert.equal(a.state.equityMarketShock, undefined, 'no stamp without a reader');
    assert.equal(JSON.stringify(a.state), JSON.stringify(b.state));
  });

  test('in play ⇒ yield tick ordered after equity, the stamp exists, the handler carries ρ', () => {
    const { sim } = loadSim({ params: { ...BASE, stockBondCorrelation: 0.4 }, simEnd: END, stepTo: END });
    const y = tick(sim, 'YIELD_CURVE_TICK'), e = tick(sim, 'EQUITY_RETURN_TICK');
    assert.ok((y.order ?? 0) > (e.order ?? 0), 'yield tick sorts after the equity tick');
    assert.ok(Number.isInteger(sim.state.equityMarketShock?.year), 'the stamp is labelled with a year');
    assert.ok(Number.isFinite(sim.state.equityMarketShock?.z), 'the equity tick stamps its shock');
    const h = (sim.handlers.get('YIELD_CURVE_TICK') ?? []).find(x => x instanceof YieldCurveTickHandler);
    assert.equal(h.equityCorrelation, 0.4);
  });

  test('a flag off ⇒ the handler gets ρ = 0 and nothing is reordered', () => {
    const { sim } = loadSim({ params: { ...BASE, equityReturnStochastic: false, stockBondCorrelation: 0.4 }, simEnd: END });
    assert.equal(tick(sim, 'YIELD_CURVE_TICK').order ?? 0, 0);
    assert.equal((sim.handlers.get('YIELD_CURVE_TICK') ?? []).find(x => x instanceof YieldCurveTickHandler).equityCorrelation, 0);
  });

  test('under rngStreams the equity path is identical across ρ arms and the yield path is not', () => {
    const run = (rho) => loadSim({ params: { ...BASE, stockBondCorrelation: rho }, simEnd: END, stepTo: END }).sim.state;
    const lo = run(-0.5), hi = run(0.5);
    assert.deepEqual(lo.equityReturnMarketDev, hi.equityReturnMarketDev, 'equity draws unchanged');
    assert.notDeepEqual(lo.yieldCurveLevelDev, hi.yieldCurveLevelDev, 'yield path moves with ρ');
  });

  test('the loader warns once when ρ is inert', () => {
    const seen = [];
    const orig = console.warn;
    console.warn = (m) => { seen.push(String(m)); };
    try {
      loadSim({ params: { stockBondCorrelation: 0.37 }, simEnd: END });
      loadSim({ params: { stockBondCorrelation: 0.37 }, simEnd: END });
    } finally { console.warn = orig; }
    assert.equal(seen.filter(m => m.includes('Stock–Bond Correlation is 0.37')).length, 1);
  });
});
