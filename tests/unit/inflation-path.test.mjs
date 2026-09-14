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
 * inflation-path.test.mjs — design 103 (stochastic inflation path + joint history).
 *
 *   - the bundled macro series is in sync with the CSVs it is generated from;
 *   - GAUSSIAN: σ is the stationary sd, persistence is e^(−k), US–AU correlate at ρ, and
 *     every tick takes exactly four uniforms;
 *   - HISTORICAL_JOINT: the innovation is the equity cursor's year's residual, with no
 *     RNG draw, reproducing the historical path; no cursor falls back to GAUSSIAN;
 *   - the step reducer, the fold (with its floor) and the equity pass-through;
 *   - the yield curve's historical shock and the equity bootstrap's POSTWAR window;
 *   - e2e: off is inert, on is seed-reproducible, and joint mode wires all three together.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';
import { readFileSync }   from 'node:fs';

import { InflationTickHandler, HISTORICAL_JOINT_WINDOW, jointWindowIndex } from '../../src/finance/economic-regimes/inflation-tick-handler.js';
import { InflationStepReducer }  from '../../src/finance/economic-regimes/inflation-step-reducer.js';
import { InflationPathReducer }  from '../../src/finance/economic-regimes/inflation-path-reducer.js';
import { EquityReturnReducer }   from '../../src/finance/economic-regimes/equity-return-reducer.js';
import { YieldCurveTickHandler } from '../../src/finance/economic-regimes/yield-curve-tick-handler.js';
import { EquityReturnTickHandler, HISTORICAL_BOOTSTRAP_WINDOWS } from '../../src/finance/economic-regimes/equity-return-tick-handler.js';
import { EquityReturnStepReducer } from '../../src/finance/economic-regimes/equity-return-step-reducer.js';
import { HISTORICAL_MACRO }      from '../../src/finance/economic-regimes/historical-macro.js';
import { RATE_KEYS, EQUITY_SLEEVES } from '../../src/finance/economic-regimes/rate-keys.js';
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
const corr = (a, b) => { const ma = mean(a), mb = mean(b); let s = 0, sa = 0, sb = 0; a.forEach((v, i) => { s += (v - ma) * (b[i] - mb); sa += (v - ma) ** 2; sb += (b[i] - mb) ** 2; }); return s / Math.sqrt(sa * sb); };

/** Step the inflation handler `years` times through the real step reducer. */
function walk(h, rng, years, state = {}) {
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
    assert.ok(Math.abs(mean(W.gs10.shocks)) < 1e-12);
    assert.equal(jointWindowIndex(1950), -1);
    assert.equal(jointWindowIndex(1951), 0);
    assert.equal(jointWindowIndex(2024), -1);
  });
});

// ─── GAUSSIAN ────────────────────────────────────────────────────────────────────

describe('InflationTickHandler — GAUSSIAN', () => {
  test('σ is the stationary sd, persistence is e^(−k), and US–AU correlate at ρ', () => {
    const h = new InflationTickHandler({ vol: { US: 0.028, AU: 0.03 }, reversionSpeed: { US: 0.33, AU: 0.5 }, correlation: 0.35 });
    const { actions } = walk(h, mkRng(7), 40000);
    const us = actions.map(a => a.deviation.US), au = actions.map(a => a.deviation.AU);
    assert.ok(Math.abs(sd(us) / 0.028 - 1) < 0.05, `US sd ${sd(us)}`);
    assert.ok(Math.abs(sd(au) / 0.03 - 1) < 0.05, `AU sd ${sd(au)}`);
    assert.ok(Math.abs(corr(us.slice(1), us.slice(0, -1)) - Math.exp(-0.33)) < 0.02, 'US persistence');
    assert.ok(Math.abs(corr(au.slice(1), au.slice(0, -1)) - Math.exp(-0.5)) < 0.02, 'AU persistence');
    // The innovations (not the levels) carry ρ.
    const innov = (x, k) => x.slice(1).map((v, i) => v - Math.exp(-k) * x[i]);
    assert.ok(Math.abs(corr(innov(us, 0.33), innov(au, 0.5)) - 0.35) < 0.03, 'innovation correlation');
  });

  test('every tick takes exactly four uniforms, whatever ρ is', () => {
    for (const correlation of [0, 0.35, 1]) {
      const rng = countingRng();
      walk(new InflationTickHandler({ correlation }), rng, 5);
      assert.equal(rng.calls, 20, `ρ=${correlation}`);
    }
  });
});

// ─── HISTORICAL_JOINT ────────────────────────────────────────────────────────────

describe('InflationTickHandler — HISTORICAL_JOINT', () => {
  const joint = (opts = {}) => new InflationTickHandler({ model: 'HISTORICAL_JOINT', ...opts });

  test('the innovation is the cursor year\'s residual, rescaled, with no RNG draw', () => {
    const h = joint();
    const a = h.call({ sim: { rng: noRng }, state: { equityReturnBootstrap: { year: 1974 } } })[0];
    const i = 1974 - 1951;
    for (const cc of ['US', 'AU']) {
      const expected = W[cc].residuals[i] * (h.innovationSd(cc) / W[cc].sd);
      assert.ok(Math.abs(a.deviation[cc] - expected) < 1e-15, cc);
    }
    assert.equal(a.historicalYear, 1974);
  });

  test('at the fitted k and σ, replaying the window reproduces history\'s inflation path', () => {
    // σ chosen so the rescale is 1, and k = −ln φ, so the step is exactly the AR(1) fit.
    const vol = {}, reversionSpeed = {};
    for (const cc of ['US', 'AU']) {
      reversionSpeed[cc] = -Math.log(W[cc].phi);
      vol[cc] = W[cc].sd / Math.sqrt(1 - W[cc].phi ** 2);
    }
    const h = joint({ vol, reversionSpeed });
    const series = { US: HISTORICAL_MACRO.usInflation, AU: HISTORICAL_MACRO.auInflation };
    let state = { inflationDev: { US: series.US[0] - W.US.mean, AU: series.AU[0] - W.AU.mean } };
    const reducer = new InflationStepReducer();
    for (let y = 1951; y <= 2023; y++) {
      const a = h.call({ sim: { rng: noRng }, state: { ...state, equityReturnBootstrap: { year: y } } })[0];
      state = reducer.reduce(state, a);
      for (const cc of ['US', 'AU']) {
        // Off only by the residuals' re-centring, which accumulates at most m/(1−φ).
        assert.ok(Math.abs(state.inflationDev[cc] - (series[cc][y - 1950] - W[cc].mean)) < 0.005, `${cc} ${y}`);
      }
    }
  });

  test('no cursor (or a year outside 1951–) falls back to GAUSSIAN and draws', () => {
    for (const state of [{}, { equityReturnBootstrap: { year: 1929 } }]) {
      const rng = countingRng();
      const a = joint().call({ sim: { rng }, state })[0];
      assert.equal(rng.calls, 4);
      assert.ok(!('historicalYear' in a));
    }
  });
});

// ─── reducers ────────────────────────────────────────────────────────────────────

describe('inflation reducers', () => {
  test('the step reducer stores the deviation and floor, and the pass-through only when asked', () => {
    const r = new InflationStepReducer();
    const plain = r.reduce({}, { type: 'INFLATION_STEP_APPLY', deviation: { US: 0.01, AU: -0.02 }, floor: -0.05 });
    assert.deepEqual(plain.inflationDev, { US: 0.01, AU: -0.02 });
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
    assert.ok(on.inflationDev);
    assert.notEqual(on.inflationAccumulator.US, off.US);
    assert.deepEqual(run({ inflationStochastic: true }).inflationAccumulator, on.inflationAccumulator);
    assert.notDeepEqual(run({ inflationStochastic: true, randomSeed: 8 }).inflationAccumulator, on.inflationAccumulator);
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
