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
 * inflation-path.test.mjs — design 103 (stochastic inflation path + joint history, §10
 * revision: skewed, level-scaled swings and a shared global factor).
 *
 *   - the bundled macro series is in sync with the CSVs it is generated from;
 *   - the skew map keeps the mean at the anchor, never crosses the bound, and has sd σ;
 *   - GAUSSIAN over a long run: sd σ, rarely below 0, and US–AU levels correlated as the
 *     lognormal map of the latent correlation w + (1−w)·ρ predicts; 6 uniforms a year
 *     (4 when the global share is 0);
 *   - HISTORICAL_JOINT: the cursor year's standardized residuals drive both factors, with
 *     no RNG draw; no cursor falls back to GAUSSIAN;
 *   - the step reducer, the fold (with its floor) and the equity pass-through;
 *   - the yield curve's historical shock and the equity bootstrap's POSTWAR window;
 *   - e2e: off is inert, on is seed-reproducible, and joint mode wires all three together.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';
import { readFileSync }   from 'node:fs';

import { InflationTickHandler, HISTORICAL_JOINT_WINDOW, jointWindowIndex, skewedInflationDeviation } from '../../src/finance/economic-regimes/inflation-tick-handler.js';
import { InflationStepReducer }  from '../../src/finance/economic-regimes/inflation-step-reducer.js';
import { InflationPathReducer }  from '../../src/finance/economic-regimes/inflation-path-reducer.js';
import { EquityReturnReducer }   from '../../src/finance/economic-regimes/equity-return-reducer.js';
import { YieldCurveTickHandler } from '../../src/finance/economic-regimes/yield-curve-tick-handler.js';
import { EquityReturnTickHandler, HISTORICAL_BOOTSTRAP_WINDOWS } from '../../src/finance/economic-regimes/equity-return-tick-handler.js';
import { EquityReturnStepReducer } from '../../src/finance/economic-regimes/equity-return-step-reducer.js';
import { HISTORICAL_MACRO }      from '../../src/finance/economic-regimes/historical-macro.js';
import { RATE_KEYS, EQUITY_SLEEVES } from '../../src/finance/economic-regimes/rate-keys.js';
import { gaussianFrom }          from '../../src/finance/fx/fx-process-models.js';
import { loadScenarioSim }       from '../helpers/scenario-harness.js';

const W = HISTORICAL_JOINT_WINDOW;
const mkRng = (seed = 42) => {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
};
const countingRng = (inner = mkRng()) => { const r = () => { r.calls++; return inner(); }; r.calls = 0; return r; };
const noRng = () => { throw new Error('joint mode must not draw'); };
const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length;
const sd   = (x) => { const m = mean(x); return Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1)); };
// A loop, not Math.min(...x): spreading 10⁵ arguments overflows the call stack.
const min  = (x) => x.reduce((m, v) => (v < m ? v : m), Infinity);
const corr = (a, b) => { const ma = mean(a), mb = mean(b); let s = 0, sa = 0, sb = 0; a.forEach((v, i) => { s += (v - ma) * (b[i] - mb); sa += (v - ma) ** 2; sb += (b[i] - mb) ** 2; }); return s / Math.sqrt(sa * sb); };
const ANCHORS = { inflationRates: { US: 0.03, AU: 0.03 } };

/** The skew's s for a σ at a given distance above the bound. */
const sOf = (vol, span) => Math.sqrt(Math.log(1 + (vol / span) ** 2));
/** Pearson correlation of two lognormals whose underlying normals correlate at r. */
const lognormalCorr = (r, s1, s2) => (Math.exp(r * s1 * s2) - 1) / Math.sqrt((Math.exp(s1 * s1) - 1) * (Math.exp(s2 * s2) - 1));

/** Step the inflation handler `years` times through the real step reducer. */
function walk(h, rng, years, state = { ...ANCHORS }) {
  const reducer = new InflationStepReducer();
  const out = [];
  for (let t = 0; t < years; t++) {
    const a = h.call({ sim: { rng }, state })[0];
    out.push(a);
    state = reducer.reduce(state, a);
  }
  return { actions: out, state };
}

// ─── the bundled macro series ────────────────────────────────────────────────────

describe('historical macro series', () => {
  test('matches the CSVs it is generated from (re-run the build script if not)', () => {
    const read = (f) => {
      const [hdr, ...lines] = readFileSync(new URL(`../../docs/economic-shocks/data/${f}`, import.meta.url), 'utf8').trim().split(/\r?\n/);
      const cols = hdr.split(',');
      return lines.map(l => { const c = l.split(','); return Object.fromEntries(cols.map((k, i) => [k, c[i]])); });
    };
    const jan = new Map(read('Shiller-SP500-monthly.csv').filter(r => r.observation_date.slice(5, 7) === '01').map(r => [Number(r.observation_date.slice(0, 4)), r]));
    const au  = new Map(read('FRED-CPALTT01AUQ659N.csv').filter(r => r.observation_date.slice(5, 7) === '10').map(r => [Number(r.observation_date.slice(0, 4)), Number(r.CPALTT01AUQ659N) / 100]));
    assert.equal(HISTORICAL_MACRO.firstYear, 1950);
    HISTORICAL_MACRO.usInflation.forEach((v, i) => {
      const y = 1950 + i, a = jan.get(y), b = jan.get(y + 1);
      assert.ok(Math.abs(v - (Number(b.CPI) / Number(a.CPI) - 1)) < 1e-6, `US ${y}`);
      assert.ok(Math.abs(HISTORICAL_MACRO.gs10Change[i] - (Number(b.GS10) - Number(a.GS10)) / 100) < 1e-6, `GS10 ${y}`);
      assert.ok(Math.abs(HISTORICAL_MACRO.auInflation[i] - au.get(y)) < 1e-6, `AU ${y}`);
    });
  });

  test('the joint window is 1951–2023, with mean-0 residuals and post-war persistence', () => {
    assert.equal(W.firstYear, 1951);
    assert.equal(W.firstYear + W.length - 1, 2023);
    for (const cc of ['US', 'AU']) {
      assert.ok(Math.abs(mean(W[cc].residuals)) < 1e-12, `${cc} residual mean`);
      assert.ok(W[cc].phi > 0.5 && W[cc].phi < 0.9, `${cc} φ ${W[cc].phi}`);
    }
    assert.ok(W.residualCorr > 0.1 && W.residualCorr < 0.5, `residual corr ${W.residualCorr}`);
    assert.ok(Math.abs(mean(W.gs10.shocks)) < 1e-12);
    assert.equal(jointWindowIndex(1950), -1);
    assert.equal(jointWindowIndex(1951), 0);
    assert.equal(jointWindowIndex(2024), -1);
  });
});

// ─── the skew map (§10.1) ────────────────────────────────────────────────────────

describe('skewedInflationDeviation', () => {
  test('keeps the mean at the anchor, never crosses the bound, and has sd σ', () => {
    // mulberry32, not mkRng: mkRng's multiply runs past 2⁵³ and loses its low bits, which
    // is fine for "same stream twice" tests but biases a 200k-draw sd by ~4%.
    let a = 3 >>> 0;
    const rng = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const opts = { anchor: 0.03, bound: -0.01, vol: 0.028 };
    const infl = Array.from({ length: 200000 }, () => 0.03 + skewedInflationDeviation(gaussianFrom(rng), opts));
    assert.ok(Math.abs(mean(infl) - 0.03) < 0.0005, `mean ${mean(infl)}`);
    assert.ok(min(infl) > -0.01, 'never below the bound');
    assert.ok(Math.abs(sd(infl) / 0.028 - 1) < 0.03, `sd ${sd(infl)}`);
    // Skewed: the upside tail is longer than the downside one.
    const sorted = [...infl].sort((a, b) => a - b);
    assert.ok(sorted[Math.floor(0.99 * sorted.length)] - 0.03 > 0.03 - sorted[Math.floor(0.01 * sorted.length)]);
  });

  test('an anchor at or below the bound leaves no room to move', () => {
    assert.equal(skewedInflationDeviation(2, { anchor: -0.01, bound: -0.01, vol: 0.03 }), 0);
    assert.equal(skewedInflationDeviation(2, { anchor: -0.02, bound: -0.01, vol: 0.03 }), 0);
  });
});

// ─── GAUSSIAN ────────────────────────────────────────────────────────────────────

describe('InflationTickHandler — GAUSSIAN', () => {
  const sUS = sOf(0.028, 0.04), sAU = sOf(0.03, 0.04);

  test('over a long run: sd σ, rarely below 0, and US–AU levels correlated as the latent predicts', () => {
    const h = new InflationTickHandler({ vol: { US: 0.028, AU: 0.03 }, globalShare: 0.4, correlation: 0.35 });
    const { actions } = walk(h, mkRng(7), 60000);
    const us = actions.map(a => 0.03 + a.deviation.US), au = actions.map(a => 0.03 + a.deviation.AU);
    assert.ok(Math.abs(sd(us) / 0.028 - 1) < 0.06, `US sd ${sd(us)}`);
    assert.ok(Math.abs(sd(au) / 0.03 - 1) < 0.06, `AU sd ${sd(au)}`);
    assert.ok(Math.abs(mean(us) - 0.03) < 0.002, `US mean ${mean(us)}`);
    for (const [cc, x] of [['US', us], ['AU', au]]) {
      // At a 3% anchor about 3% of years dip below 0, as in the low-inflation eras (US
      // 1983–2023 and AU since 1993 both averaged under 3% and had 2–3% of years below 0);
      // it was 14–16% before design 103 §10.1.
      const below = x.filter(v => v < 0).length / x.length;
      assert.ok(below < 0.05, `${cc} years below 0: ${below}`);
      assert.ok(min(x) > -0.01, `${cc} never below the bound`);
    }
    const expected = lognormalCorr(0.4 + 0.6 * 0.35, sUS, sAU);
    assert.ok(Math.abs(corr(us, au) - expected) < 0.06, `level corr ${corr(us, au)} vs ${expected}`);
  });

  test('a global share of 0 lets the countries correlate only through ρ, so much less', () => {
    const { actions } = walk(new InflationTickHandler({ globalShare: 0, correlation: 0.35 }), mkRng(8), 40000);
    const c = corr(actions.map(a => a.deviation.US), actions.map(a => a.deviation.AU));
    const expected = lognormalCorr(0.35, sUS, sAU);
    assert.ok(Math.abs(c - expected) < 0.06, `level corr ${c} vs ${expected}`);
    assert.ok(c < lognormalCorr(0.61, sUS, sAU) - 0.15, 'the global factor is what lifts the co-movement');
  });

  test('six uniforms a year with a global factor, four without, whatever ρ is', () => {
    for (const correlation of [0, 0.35, 1]) {
      const r6 = countingRng(); walk(new InflationTickHandler({ correlation }), r6, 5);
      assert.equal(r6.calls, 30, `ρ=${correlation}`);
      const r4 = countingRng(); walk(new InflationTickHandler({ correlation, globalShare: 0 }), r4, 5);
      assert.equal(r4.calls, 20, `ρ=${correlation}, no global factor`);
    }
  });

  test('the latent factors are stored and walked', () => {
    const { actions, state } = walk(new InflationTickHandler(), mkRng(9), 3);
    assert.deepEqual(Object.keys(state.inflationLatent).sort(), ['AU', 'US', 'g']);
    assert.deepEqual(state.inflationLatent, actions[2].latent);
  });
});

// ─── HISTORICAL_JOINT ────────────────────────────────────────────────────────────

describe('InflationTickHandler — HISTORICAL_JOINT', () => {
  const joint = (opts = {}) => new InflationTickHandler({ model: 'HISTORICAL_JOINT', ...opts });

  test('the normal scores are standard normal and keep the residuals\' order', () => {
    for (const cc of ['US', 'AU']) {
      const ns = W[cc].normalScores;
      assert.ok(Math.abs(mean(ns)) < 1e-9 && Math.abs(sd(ns) - 1) < 1e-9, cc);
      // Same ranking as the residuals, but thin-tailed: history's 4.6σ AU year becomes ~2.5σ.
      const byRes = W[cc].residuals.map((_, i) => i).sort((i, j) => W[cc].residuals[i] - W[cc].residuals[j]);
      byRes.slice(1).forEach((i, k) => assert.ok(ns[i] > ns[byRes[k]], `${cc} order`));
      assert.ok(Math.max(...ns) < 2.6, `${cc} max ${Math.max(...ns)}`);
    }
    assert.ok(W.normalScoreCorr > 0.1 && W.normalScoreCorr < 0.5);
  });

  test('the cursor year\'s normal-scored residuals drive both factors, with no RNG draw', () => {
    const h = joint({ globalShareJoint: 0.2, globalReversionSpeed: 0.1, reversionSpeed: { US: 0.33, AU: 0.5 } });
    const a = h.call({ sim: { rng: noRng }, state: { ...ANCHORS, equityReturnBootstrap: { year: 1974 } } })[0];
    const i = 1974 - 1951;
    const eUS = W.US.normalScores[i], eAU = W.AU.normalScores[i];
    const eg  = (eUS + eAU) / Math.sqrt(2 + 2 * W.normalScoreCorr);
    const step = (k, e) => Math.sqrt(1 - Math.exp(-2 * k)) * e;
    assert.ok(Math.abs(a.latent.g  - step(0.1, eg))   < 1e-15);
    assert.ok(Math.abs(a.latent.US - step(0.33, eUS)) < 1e-15);
    assert.ok(Math.abs(a.latent.AU - step(0.5, eAU))  < 1e-15);
    assert.equal(a.historicalYear, 1974);
    // 1974 was a US inflation surprise to the upside.
    assert.ok(a.deviation.US > 0);
  });

  test('the same year and state always give the same step', () => {
    const st = { ...ANCHORS, equityReturnBootstrap: { year: 1990 }, inflationLatent: { g: 0.3, US: -0.2, AU: 0.1 } };
    assert.deepEqual(joint().call({ sim: { rng: noRng }, state: st }), joint().call({ sim: { rng: noRng }, state: st }));
  });

  test('no cursor (or a year outside 1951–) falls back to GAUSSIAN and draws', () => {
    for (const state of [{ ...ANCHORS }, { ...ANCHORS, equityReturnBootstrap: { year: 1929 } }]) {
      const rng = countingRng();
      const a = joint().call({ sim: { rng }, state })[0];
      assert.equal(rng.calls, 6);
      assert.ok(!('historicalYear' in a));
    }
  });
});

// ─── reducers ────────────────────────────────────────────────────────────────────

describe('inflation reducers', () => {
  test('the step reducer stores the deviation, latent and floor, and the pass-through only when asked', () => {
    const r = new InflationStepReducer();
    const plain = r.reduce({}, { type: 'INFLATION_STEP_APPLY', deviation: { US: 0.01, AU: -0.02 }, latent: { g: 0.1, US: 0.2, AU: -0.3 }, floor: -0.05 });
    assert.deepEqual(plain.inflationDev, { US: 0.01, AU: -0.02 });
    assert.deepEqual(plain.inflationLatent, { g: 0.1, US: 0.2, AU: -0.3 });
    assert.equal(plain.inflationFloor, -0.05);
    assert.ok(!('equityInflationPassThrough' in plain));

    const pass = r.reduce({}, { type: 'INFLATION_STEP_APPLY', deviation: { US: 0.01, AU: -0.02 }, floor: -0.05, passThrough: true });
    // Each market takes the inflation of the country it is priced in.
    assert.equal(pass.equityInflationPassThrough[RATE_KEYS.EQUITY_US], 0.01);
    assert.equal(pass.equityInflationPassThrough[RATE_KEYS.EQUITY_INTL_EX_US], 0.01);
    assert.equal(pass.equityInflationPassThrough[RATE_KEYS.EQUITY_AU], -0.02);
    assert.equal(pass.equityInflationPassThrough[RATE_KEYS.EQUITY_INTL_EX_AU], -0.02);
  });

  test('the fold adds the deviation to the effective rate and clamps at the floor', () => {
    const f = new InflationPathReducer();
    const st = { effectiveInflationRates: { US: 0.025, AU: 0.03 }, inflationDev: { US: 0.02, AU: -0.12 }, inflationFloor: -0.05 };
    const next = f.reduce(st, { type: 'US_PERIOD_ADVANCE' });
    assert.ok(Math.abs(next.effectiveInflationRates.US - 0.045) < 1e-12);
    assert.equal(next.effectiveInflationRates.AU, -0.05);
  });

  test('the fold is a no-op without a stored deviation', () => {
    const st = { effectiveInflationRates: { US: 0.025 } };
    assert.equal(new InflationPathReducer().reduce(st, { type: 'US_PERIOD_ADVANCE' }).effectiveInflationRates, st.effectiveInflationRates);
  });

  test('the equity fold adds the nominal pass-through to each market', () => {
    const st = {
      effectiveGrowthRates:       { [RATE_KEYS.EQUITY_US]: 0.07, [RATE_KEYS.EQUITY_AU]: 0.07 },
      equityReturnDev:            { [RATE_KEYS.EQUITY_US]: -0.10, [RATE_KEYS.EQUITY_AU]: -0.05 },
      equityReturnDriftComp:      {},
      equityInflationPassThrough: { [RATE_KEYS.EQUITY_US]: 0.03, [RATE_KEYS.EQUITY_AU]: 0.01 },
    };
    const next = new EquityReturnReducer().reduce(st, { type: 'US_PERIOD_ADVANCE' });
    assert.ok(Math.abs(next.effectiveGrowthRates[RATE_KEYS.EQUITY_US] - 0.00) < 1e-12);
    assert.ok(Math.abs(next.effectiveGrowthRates[RATE_KEYS.EQUITY_AU] - 0.03) < 1e-12);
  });
});

// ─── the yield curve and the equity window ───────────────────────────────────────

describe('joint mode — yields and the POSTWAR equity window', () => {
  test('the historical yield shock is that year\'s 10-year change, rescaled, for both countries', () => {
    const h = new YieldCurveTickHandler({ vol: 0.01, reversionSpeed: 0.3, historical: true });
    const prev = { US: 0.004, AU: -0.002 };
    const out = h.call({ sim: { rng: noRng }, state: { yieldCurveLevelDev: prev, equityReturnBootstrap: { year: 1979 } } });
    const shock = W.gs10.shocks[1979 - 1951] * (0.01 / W.gs10.sd);
    for (const a of out) {
      assert.ok(Math.abs(a.deviation - (prev[a.country] * Math.exp(-0.3) + shock)) < 1e-15, a.country);
    }
  });

  test('without the historical flag the yield tick is unchanged (two Gaussian draws)', () => {
    const rng = countingRng();
    new YieldCurveTickHandler({ historical: false }).call({ sim: { rng }, state: { equityReturnBootstrap: { year: 1979 } } });
    assert.equal(rng.calls, 4);
  });

  test('POSTWAR draws only 1951–2023, wraps inside the window, and is re-centred on its own mean', () => {
    const w = HISTORICAL_BOOTSTRAP_WINDOWS.POSTWAR;
    assert.equal(w.firstYear + w.start, 1951);
    assert.ok(Math.abs(mean(w.deviations)) < 1e-12);
    const h = new EquityReturnTickHandler({ model: 'HISTORICAL_BOOTSTRAP', window: 'POSTWAR', blockLength: 3, idioVol: Object.fromEntries(EQUITY_SLEEVES.map(k => [k, 0])) });
    const reducer = new EquityReturnStepReducer();
    let state = {};
    const years = [];
    for (let t = 0; t < 3; t++) {
      const a = h.call({ sim: { rng: () => 0.9999999 }, state })[0];
      years.push(a.bootstrap.year);
      state = reducer.reduce(state, a);
    }
    assert.deepEqual(years, [2023, 1951, 1952]);
  });
});

// ─── e2e ─────────────────────────────────────────────────────────────────────────

describe('inflation path — e2e', () => {
  const END = Date.UTC(2040, 0, 1);
  const run = (params) => loadScenarioSim({ telemetry: 'off', simEnd: END, stepTo: END, params: { randomSeed: 7, ...params } }).sim.state;

  test('off: no deviation in state, and the accumulator is the deterministic one', () => {
    const off = run({});
    assert.ok(!('inflationDev' in off));
    assert.deepEqual(run({ inflationStochastic: false }).inflationAccumulator, off.inflationAccumulator);
  });

  test('Gaussian on: the price level moves off the deterministic path, reproducibly', () => {
    const off = run({}).inflationAccumulator;
    const on  = run({ inflationStochastic: true });
    assert.ok(on.inflationDev && on.inflationLatent);
    assert.notEqual(on.inflationAccumulator.US, off.US);
    assert.deepEqual(run({ inflationStochastic: true }).inflationAccumulator, on.inflationAccumulator);
    assert.notDeepEqual(run({ inflationStochastic: true, randomSeed: 8 }).inflationAccumulator, on.inflationAccumulator);
  });

  test('the global share reaches the handler', () => {
    const a = run({ inflationStochastic: true, inflationGlobalShare: 0 }).inflationAccumulator;
    const b = run({ inflationStochastic: true, inflationGlobalShare: 0.8 }).inflationAccumulator;
    assert.notDeepEqual(a, b);
  });

  test('joint: equity replays post-war years, and inflation and nominal equity follow them', () => {
    const st = run({
      equityReturnStochastic: true, equityReturnModel: 'HISTORICAL_BOOTSTRAP',
      inflationStochastic: true, inflationModel: 'HISTORICAL_JOINT', yieldCurveStochastic: true,
    });
    assert.ok(st.equityReturnBootstrap.year >= 1951 && st.equityReturnBootstrap.year <= 2023);
    assert.ok(st.inflationDev && st.equityInflationPassThrough);
    assert.equal(st.equityInflationPassThrough[RATE_KEYS.EQUITY_US], st.inflationDev.US);
  });

  test('joint without the equity bootstrap runs as Gaussian (no pass-through)', () => {
    const st = run({ equityReturnStochastic: true, equityReturnModel: 'WHITE_NOISE', inflationStochastic: true, inflationModel: 'HISTORICAL_JOINT' });
    assert.ok(st.inflationDev);
    assert.ok(!('equityInflationPassThrough' in st));
  });
});
