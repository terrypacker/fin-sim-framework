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
 * yield-curve-dynamics.test.mjs — design 67 §6 (Phase 3: curve dynamics).
 *
 * Three deterministic sources compose onto the base shape and one optional stochastic
 * one, all through the YieldCurveReducer:
 *   - composeYieldCurve / shapeDelta — the twist algebra (base + Σ factor·twist).
 *   - YieldCurveReducer — no-op when nothing is active (byte-identical to Phase 2),
 *     composes active-regime twists (scaled by recovery factor), and folds the
 *     stochastic level deviation onto the effective fixed-income level.
 *   - EconomicShockHandler — carries a named curve shock's yieldCurveTwist to the regime.
 *   - YieldCurveTickHandler — the seeded-RNG OU level walk (reproducible).
 *   - e2e — stochastic OFF is byte-identical; ON is reproducible with the same seed.
 */

import { test, describe, beforeEach } from 'node:test';
import assert                         from 'node:assert/strict';

import {
  composeYieldCurve, shapeDelta, interpolateSpread,
} from '../../src/finance/economic-regimes/yield-curve.js';
import { YieldCurveReducer }      from '../../src/finance/economic-regimes/yield-curve-reducer.js';
import { YieldCurveTickHandler }  from '../../src/finance/economic-regimes/yield-curve-tick-handler.js';
import { EconomicShockHandler }   from '../../src/finance/economic-regimes/economic-shock-handler.js';
import { SHOCK_LIBRARY }          from '../../src/finance/economic-shocks/shock-library.js';
import { RATE_KEYS }              from '../../src/finance/economic-regimes/rate-keys.js';
import { loadScenarioSim }        from '../helpers/scenario-harness.js';


/**
 * These tests assert on FINAL STATE only — none of them reads `sim.journal`,
 * `sim.history`, a snapshot, the bus, or `sim.samples`. Telemetry is therefore pure
 * overhead here, and it is not a small one: the journal and snapshot machinery, not
 * the simulation maths, is what a full run spends its time on (design 78 §4.4 — sim
 * maths measured at ~285ms of a 9.5s run). Turning it off makes this file ~5x faster.
 *
 * This matters beyond the file: `node --test` runs 300+ files 8-way parallel, so once
 * the fast files drain, the whole suite sits on a handful of slow ones printing
 * nothing, which reads as a hang. Shortening that tail is what keeps `npm run test`
 * looking alive.
 *
 * If you add an assertion here that reads the journal or history, drop the wrapper and
 * call `loadScenarioSim` directly — the default is full telemetry for a reason.
 */
const loadSim = (opts = {}) => loadScenarioSim({ telemetry: 'off', ...opts });

const US = RATE_KEYS.FIXED_INCOME_US;
const BASE = [
  { tenor: 1, spread: -0.010 }, { tenor: 5, spread: 0 },
  { tenor: 10, spread: 0.006 }, { tenor: 30, spread: 0.012 },
];

// ─── composeYieldCurve / shapeDelta ─────────────────────────────────────────────

describe('composeYieldCurve', () => {
  test('no twists ⇒ returns the base shape by reference (Phase-2 identity)', () => {
    assert.equal(composeYieldCurve(BASE, []), BASE);
    assert.equal(composeYieldCurve(BASE, null), BASE);
    assert.equal(composeYieldCurve(BASE, [{ points: [], factor: 1 }]), BASE);   // empty twist
    assert.equal(composeYieldCurve(BASE, [{ points: BASE, factor: 0 }]), BASE); // zero factor
  });

  test('a twist adds its spread scaled by the recovery factor', () => {
    const twist = [{ tenor: 1, spread: 0.02 }, { tenor: 30, spread: 0 }];
    const out = composeYieldCurve(BASE, [{ points: twist, factor: 0.5 }]);
    const at1 = out.find(p => p.tenor === 1);
    // base(-0.010) + 0.5 × twist(0.02) = 0.
    assert.ok(Math.abs(at1.spread - 0) < 1e-9);
    // 30y: base 0.012 + 0.5×0 = 0.012 unchanged.
    assert.ok(Math.abs(out.find(p => p.tenor === 30).spread - 0.012) < 1e-9);
  });

  test('union grid: a twist tenor not in the base enriches the curve', () => {
    const twist = [{ tenor: 2, spread: 0.05 }];
    const out = composeYieldCurve(BASE, [{ points: twist, factor: 1 }]);
    assert.ok(out.some(p => p.tenor === 2), 'the 2y point is added to the grid');
  });

  test('multiple twists sum', () => {
    const t1 = [{ tenor: 5, spread: 0.01 }];
    const t2 = [{ tenor: 5, spread: 0.02 }];
    const out = composeYieldCurve(BASE, [{ points: t1, factor: 1 }, { points: t2, factor: 1 }]);
    // base(0 at 5y) + 0.01 + 0.02 = 0.03.
    assert.ok(Math.abs(out.find(p => p.tenor === 5).spread - 0.03) < 1e-9);
  });
});

describe('shapeDelta', () => {
  test('base + shapeDelta(abs, base) reproduces abs at every grid tenor', () => {
    const abs = [{ tenor: 1, spread: 0.005 }, { tenor: 10, spread: -0.002 }, { tenor: 30, spread: 0.03 }];
    const delta = shapeDelta(abs, BASE);
    const composed = composeYieldCurve(BASE, [{ points: delta, factor: 1 }]);
    for (const p of abs) {
      assert.ok(Math.abs(interpolateSpread(composed, p.tenor) - p.spread) < 1e-6,
        `abs at ${p.tenor}y not reproduced`);
    }
  });
});

// ─── YieldCurveReducer ──────────────────────────────────────────────────────────

describe('YieldCurveReducer', () => {
  let reducer;
  beforeEach(() => { reducer = new YieldCurveReducer(); });

  const baseState = () => ({
    baseYieldCurve: { US: BASE, AU: [] },
    yieldCurve:     { US: BASE, AU: [] },
    effectiveInterestRates: { [US]: 0.04, [RATE_KEYS.FIXED_INCOME_AU]: 0.03 },
    yieldCurveLevelDev: { US: 0, AU: 0 },
    activeRegimes: [],
  });

  test('no active twist + zero level deviation ⇒ no-op (yieldCurve & level unchanged)', () => {
    const st = baseState();
    const next = reducer.reduce(st, { type: 'US_PERIOD_ADVANCE' });
    assert.equal(next.yieldCurve.US, BASE);                      // same reference
    assert.equal(next.effectiveInterestRates[US], 0.04);
  });

  test('an active twist regime composes onto baseYieldCurve (scaled by currentFactor)', () => {
    const st = baseState();
    st.activeRegimes = [{
      yieldCurveTwist: { US: [{ tenor: 1, spread: 0.02 }, { tenor: 30, spread: 0 }] },
      currentFactor: 0.5,
    }];
    const next = reducer.reduce(st, { type: 'US_PERIOD_ADVANCE' });
    // 1y: base(-0.010) + 0.5×0.02 = 0.
    assert.ok(Math.abs(interpolateSpread(next.yieldCurve.US, 1) - 0) < 1e-9);
    assert.notEqual(next.yieldCurve.US, BASE);                   // recomposed
  });

  test('a stochastic level deviation folds onto the effective fixed-income level', () => {
    const st = baseState();
    st.yieldCurveLevelDev = { US: 0.007, AU: 0 };
    st.effectiveInterestRates[`${US}::acctA`] = 0.045;           // a per-account variant
    const next = reducer.reduce(st, { type: 'US_PERIOD_ADVANCE' });
    assert.ok(Math.abs(next.effectiveInterestRates[US] - 0.047) < 1e-9);
    assert.ok(Math.abs(next.effectiveInterestRates[`${US}::acctA`] - 0.052) < 1e-9);
    assert.equal(next.effectiveInterestRates[RATE_KEYS.FIXED_INCOME_AU], 0.03); // AU untouched
  });
});

// ─── EconomicShockHandler carries the twist ─────────────────────────────────────

describe('named curve shocks', () => {
  test('the shock library defines the three curve shocks with a yieldCurveTwist', () => {
    for (const id of ['CURVE_BEAR_FLATTENER', 'CURVE_BULL_STEEPENER', 'CURVE_INVERSION']) {
      assert.ok(SHOCK_LIBRARY[id]?.regime?.yieldCurveTwist?.US?.length > 0, `${id} missing twist`);
    }
  });

  test('EconomicShockHandler carries yieldCurveTwist onto the emitted regime', () => {
    const shock = { ...SHOCK_LIBRARY.CURVE_INVERSION, startDate: new Date(Date.UTC(2030, 0, 1)) };
    const actions = new EconomicShockHandler().call({ data: { shock } });
    const add = actions.find(a => a.type === 'ADD_REGIME_APPLY');
    assert.ok(add?.regime?.yieldCurveTwist?.US?.length > 0, 'twist dropped by the handler whitelist');
  });
});

// ─── YieldCurveTickHandler (stochastic OU) ──────────────────────────────────────

describe('YieldCurveTickHandler', () => {
  test('draws from sim.rng and emits a mean-reverting step per country', () => {
    // A fake rng returning a fixed uniform ⇒ deterministic gaussian ⇒ deterministic step.
    const rng = () => 0.5;
    const sim = { rng };
    const state = { yieldCurveLevelDev: { US: 0, AU: 0 }, effectiveFxVol: {} };
    const h = new YieldCurveTickHandler({ vol: 0.01, reversionSpeed: 0.3, dt: 1 });
    const out = h.call({ sim, state });
    assert.equal(out.length, 2);
    assert.deepEqual(out.map(a => a.country), ['US', 'AU']);
    for (const a of out) {
      assert.equal(a.type, 'YIELD_CURVE_STEP_APPLY');
      assert.ok(Number.isFinite(a.deviation));
    }
  });

  test('same rng sequence ⇒ identical steps (reproducible)', () => {
    const mk = () => { let s = 42; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; };
    const state = { yieldCurveLevelDev: { US: 0, AU: 0 } };
    const a = new YieldCurveTickHandler().call({ sim: { rng: mk() }, state });
    const b = new YieldCurveTickHandler().call({ sim: { rng: mk() }, state });
    assert.deepEqual(a, b);
  });
});

// ─── e2e: determinism of the stochastic path ────────────────────────────────────

describe('stochastic curve — e2e determinism', () => {
  const END = Date.UTC(2040, 0, 1);
  const nw = (sim) => Math.round(sim.state.metrics?.netWorth ?? 0);

  test('stochastic OFF ⇒ two default runs are byte-identical (and match no-param)', () => {
    const a = loadSim({ simEnd: END, stepTo: END }).sim;
    const b = loadSim({ params: { yieldCurveStochastic: false }, simEnd: END, stepTo: END }).sim;
    assert.equal(nw(a), nw(b));
  });

  test('stochastic ON ⇒ reproducible across identical runs, and moves the number', () => {
    const on1 = loadSim({ params: { yieldCurveStochastic: true, yieldCurveVol: 0.02 }, simEnd: END, stepTo: END }).sim;
    const on2 = loadSim({ params: { yieldCurveStochastic: true, yieldCurveVol: 0.02 }, simEnd: END, stepTo: END }).sim;
    const off = loadSim({ simEnd: END, stepTo: END }).sim;
    assert.equal(nw(on1), nw(on2), 'same seed ⇒ same result (reproducible)');
    assert.notEqual(nw(on1), nw(off), 'the stochastic level walk should perturb bond pricing');
  });
});
