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
 * equity-return-paths.test.mjs — design 74 (Phase 1: stochastic equity return paths).
 *
 * The unit under test is the third seeded-RNG consumer (after FX design 47 and the
 * yield curve design 67):
 *   - EquityReturnTickHandler — one shared market draw, loaded per sleeve via beta +
 *     an optional idiosyncratic term; deterministic and RNG-cursor-stable.
 *   - EquityReturnStepReducer — stores the per-sleeve deviation + market factor.
 *   - EquityReturnReducer — no-op when nothing is stored (byte-identical to before),
 *     folds the per-sleeve deviation onto effectiveGrowthRates (+ per-account variants).
 *   - e2e — stochastic OFF is byte-identical; ON is reproducible with the same seed.
 *
 * Maps directly to the §6 testing plan (inertness, determinism, snapshot safety via the
 * e2e reproducibility, calibration, correlation, drift, RNG-cursor ordering).
 */

import { test, describe, beforeEach } from 'node:test';
import assert                         from 'node:assert/strict';

import { EquityReturnTickHandler } from '../../src/finance/economic-regimes/equity-return-tick-handler.js';
import { EquityReturnStepReducer } from '../../src/finance/economic-regimes/equity-return-step-reducer.js';
import { EquityReturnReducer }     from '../../src/finance/economic-regimes/equity-return-reducer.js';
import { RATE_KEYS, EQUITY_SLEEVES, DEFAULT_EQUITY_BETA } from '../../src/finance/economic-regimes/rate-keys.js';
import { gaussianFrom }            from '../../src/finance/fx/fx-process-models.js';
import { loadScenarioSim }         from '../helpers/scenario-harness.js';


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

// A small linear-congruential uniform generator so tests can build fresh, identical
// RNG streams on demand (mirrors the yield-curve dynamics test).
const mkRng = (seed = 42) => {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
};

// Design 90 §7.2 — named by MARKET now. The old aliases (US_MKT/AU_MKT) named account
// wrappers, which are no longer sleeves.
const US_MKT = RATE_KEYS.EQUITY_US;
const AU_MKT = RATE_KEYS.EQUITY_AU;

// ─── EquityReturnTickHandler ─────────────────────────────────────────────────────

describe('EquityReturnTickHandler', () => {
  test('emits ONE EQUITY_RETURN_STEP_APPLY carrying a deviation per sleeve', () => {
    const h = new EquityReturnTickHandler({ vol: 0.18 });
    const out = h.call({ sim: { rng: () => 0.5 }, state: {} });
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'EQUITY_RETURN_STEP_APPLY');
    assert.ok(Number.isFinite(out[0].marketDev));
    for (const sleeve of EQUITY_SLEEVES) {
      assert.ok(Number.isFinite(out[0].deviation[sleeve]), `${sleeve} missing`);
    }
  });

  test('one market factor drives every sleeve — each is beta × marketDev (idio 0)', () => {
    const h = new EquityReturnTickHandler({ vol: 0.18 });
    const { marketDev, deviation } = h.call({ sim: { rng: () => 0.5 }, state: {} })[0];
    for (const sleeve of EQUITY_SLEEVES) {
      const expected = DEFAULT_EQUITY_BETA[sleeve] * marketDev;
      assert.ok(Math.abs(deviation[sleeve] - expected) < 1e-12, `${sleeve} not beta×market`);
    }
    // Design 90 §7.2 — the market factor IS the US market's, so EQUITY_US rides it 1:1
    // by construction; the AU market loads below it. Spot-checked by name as well as by
    // the loop above, so a table edited to all-1.0 betas cannot pass vacuously.
    assert.ok(Math.abs(deviation[RATE_KEYS.EQUITY_US] - marketDev) < 1e-12);
    assert.ok(Math.abs(deviation[RATE_KEYS.EQUITY_AU] - 0.8 * marketDev) < 1e-12);
  });

  test('same rng sequence ⇒ identical output (reproducible)', () => {
    const a = new EquityReturnTickHandler().call({ sim: { rng: mkRng() }, state: {} });
    const b = new EquityReturnTickHandler().call({ sim: { rng: mkRng() }, state: {} });
    assert.deepEqual(a, b);
  });

  test('WHITE_NOISE is memoryless — ignores the prior market deviation', () => {
    const h = new EquityReturnTickHandler({ vol: 0.18, model: 'WHITE_NOISE' });
    const fresh = h.call({ sim: { rng: mkRng() }, state: {} })[0];
    const primed = h.call({ sim: { rng: mkRng() }, state: { equityReturnMarketDev: 0.5 } })[0];
    assert.ok(Math.abs(fresh.marketDev - primed.marketDev) < 1e-12, 'prior dev leaked into WHITE_NOISE');
  });

  test('MEAN_REVERTING carries the prior market deviation (pulled toward 0)', () => {
    const h = new EquityReturnTickHandler({ vol: 0.18, model: 'MEAN_REVERTING', reversionSpeed: 0.3 });
    const primed = h.call({ sim: { rng: mkRng() }, state: { equityReturnMarketDev: 0.5 } })[0];
    const fresh  = h.call({ sim: { rng: mkRng() }, state: {} })[0];
    assert.notEqual(primed.marketDev, fresh.marketDev);
    // The kick z is identical; the difference is exactly the retained prior 0.5·e^{-k}.
    assert.ok(Math.abs((primed.marketDev - fresh.marketDev) - 0.5 * Math.exp(-0.3)) < 1e-12);
  });

  // ── §6 test 7: RNG-cursor ordering ──
  test('idio 0 does NOT consume a uniform — market-only path is bit-identical', () => {
    // Two runs share a stream: run A (all idio 0) and run B (idio 0) must agree,
    // AND the stream must be left at the same cursor (next draw identical).
    const rngA = mkRng(7);
    const rngB = mkRng(7);
    const a = new EquityReturnTickHandler({ idioVol: {} }).call({ sim: { rng: rngA }, state: {} })[0];
    const b = new EquityReturnTickHandler({ idioVol: { [US_MKT]: 0 } }).call({ sim: { rng: rngB }, state: {} })[0];
    assert.deepEqual(a, b);
    assert.equal(rngA(), rngB(), 'a zero-vol sleeve must not advance the RNG cursor');
  });

  test('enabling idio for ONE sleeve leaves every OTHER sleeve’s market component intact', () => {
    // Idio is drawn AFTER the single market draw and only for sleeves with vol>0.
    // Turning it on for the last-iterated sleeve (by sorted key) must not disturb the
    // market draw shared by all, so every other sleeve is unchanged.
    const market = new EquityReturnTickHandler({ idioVol: {} }).call({ sim: { rng: mkRng(11) }, state: {} })[0];
    const withIdio = new EquityReturnTickHandler({ idioVol: { [AU_MKT]: 0.1 } })
      .call({ sim: { rng: mkRng(11) }, state: {} })[0];
    assert.ok(Math.abs(withIdio.marketDev - market.marketDev) < 1e-12, 'market factor shifted');
    for (const sleeve of EQUITY_SLEEVES) {
      if (sleeve === AU_MKT) continue;
      assert.ok(Math.abs(withIdio.deviation[sleeve] - market.deviation[sleeve]) < 1e-12,
        `${sleeve} disturbed by another sleeve’s idio draw`);
    }
    assert.notEqual(withIdio.deviation[AU_MKT], market.deviation[AU_MKT], 'the idio sleeve should move');
  });

  test('per-sleeve beta override replaces the default loading', () => {
    const h = new EquityReturnTickHandler({ beta: { [AU_MKT]: 1.5 } });
    const { marketDev, deviation } = h.call({ sim: { rng: () => 0.5 }, state: {} })[0];
    assert.ok(Math.abs(deviation[AU_MKT] - 1.5 * marketDev) < 1e-12);
  });

  test('round-trips through toJSON/fromJSON', () => {
    const h = new EquityReturnTickHandler({ vol: 0.2, model: 'MEAN_REVERTING', beta: { [US_MKT]: 1.1 }, idioVol: { [AU_MKT]: 0.05 } });
    const clone = EquityReturnTickHandler.fromJSON(h.toJSON());
    assert.deepEqual(
      clone.call({ sim: { rng: mkRng() }, state: {} }),
      h.call({ sim: { rng: mkRng() }, state: {} }),
    );
  });
});

// ─── §6 test 4/5: statistical calibration + correlation ──────────────────────────

describe('EquityReturnTickHandler — statistics', () => {
  test('realized market-factor sd ≈ equityReturnVol and mean ≈ 0 over many years', () => {
    // Draw the market factor directly the way the handler does, so the calibration is
    // of the process itself. WHITE_NOISE: marketDev = vol·√dt·gaussian.
    const rng = mkRng(2026);
    const vol = 0.18;
    const N = 20000;
    let sum = 0, sumSq = 0;
    for (let i = 0; i < N; i++) {
      const dev = vol * gaussianFrom(rng); // dt = 1
      sum += dev; sumSq += dev * dev;
    }
    const mean = sum / N;
    const sd = Math.sqrt(sumSq / N - mean * mean);
    assert.ok(Math.abs(mean) < 0.01, `mean ${mean} not ≈ 0`);
    assert.ok(Math.abs(sd - vol) < 0.01, `sd ${sd} not ≈ ${vol}`);
  });

  test('betas at 1 + idio 0 ⇒ all sleeves move in lockstep (correlation 1)', () => {
    // The direct regression against Option A's diversification bug: with a single shared
    // factor and unit betas, every sleeve equals the market deviation exactly.
    const ones = Object.fromEntries(EQUITY_SLEEVES.map(k => [k, 1]));
    const h = new EquityReturnTickHandler({ beta: ones, idioVol: {} });
    for (let i = 0; i < 200; i++) {
      const { marketDev, deviation } = h.call({ sim: { rng: mkRng(i) }, state: {} })[0];
      for (const sleeve of EQUITY_SLEEVES) {
        assert.ok(Math.abs(deviation[sleeve] - marketDev) < 1e-12);
      }
    }
  });
});

// ─── EquityReturnStepReducer ─────────────────────────────────────────────────────

describe('EquityReturnStepReducer', () => {
  let reducer;
  beforeEach(() => { reducer = new EquityReturnStepReducer(); });

  test('stores the per-sleeve deviation and market factor', () => {
    const action = { type: 'EQUITY_RETURN_STEP_APPLY', marketDev: 0.03, deviation: { [US_MKT]: 0.03, [AU_MKT]: 0.021 } };
    const next = reducer.reduce({}, action);
    assert.deepEqual(next.equityReturnDev, { [US_MKT]: 0.03, [AU_MKT]: 0.021 });
    assert.equal(next.equityReturnMarketDev, 0.03);
  });

  test('a malformed action (no deviation) is a no-op', () => {
    const st = { equityReturnDev: { [US_MKT]: 0.01 } };
    const next = reducer.reduce(st, { type: 'EQUITY_RETURN_STEP_APPLY' });
    assert.equal(next.equityReturnDev, st.equityReturnDev);
  });
});

// ─── EquityReturnReducer (the fold) ──────────────────────────────────────────────

describe('EquityReturnReducer', () => {
  let reducer;
  beforeEach(() => { reducer = new EquityReturnReducer(); });

  const baseState = () => ({
    effectiveGrowthRates: { [US_MKT]: 0.10, [AU_MKT]: 0.09, [`${US_MKT}::acctA`]: 0.11 },
    equityReturnDev: {},
  });

  test('no stored deviation ⇒ no-op (byte-identical to before)', () => {
    const st = baseState();
    const next = reducer.reduce(st, { type: 'US_PERIOD_ADVANCE' });
    assert.equal(next.effectiveGrowthRates, st.effectiveGrowthRates); // same reference
  });

  test('all-zero deviation ⇒ no-op', () => {
    const st = baseState();
    st.equityReturnDev = Object.fromEntries(EQUITY_SLEEVES.map(k => [k, 0]));
    const next = reducer.reduce(st, { type: 'US_PERIOD_ADVANCE' });
    assert.equal(next.effectiveGrowthRates, st.effectiveGrowthRates);
  });

  test('folds the sleeve deviation onto the member key AND its per-account variants', () => {
    const st = baseState();
    st.equityReturnDev = { [US_MKT]: -0.05, [AU_MKT]: 0.02 };
    const next = reducer.reduce(st, { type: 'US_PERIOD_ADVANCE' });
    assert.ok(Math.abs(next.effectiveGrowthRates[US_MKT] - 0.05) < 1e-12);          // 0.10 - 0.05
    assert.ok(Math.abs(next.effectiveGrowthRates[`${US_MKT}::acctA`] - 0.06) < 1e-12); // 0.11 - 0.05
    assert.ok(Math.abs(next.effectiveGrowthRates[AU_MKT] - 0.11) < 1e-12);         // 0.09 + 0.02
  });

  test('a sleeve absent from effectiveGrowthRates is skipped (no phantom key)', () => {
    const st = { effectiveGrowthRates: { [US_MKT]: 0.10 }, equityReturnDev: { [AU_MKT]: 0.02 } };
    const next = reducer.reduce(st, { type: 'US_PERIOD_ADVANCE' });
    assert.ok(!(AU_MKT in next.effectiveGrowthRates), 'created a growth rate for an absent sleeve');
    assert.equal(next.effectiveGrowthRates[US_MKT], 0.10);
  });
});

// ─── §5.3 / §6 test 6: drift compensation (Phase 3) ──────────────────────────────

describe('drift compensation', () => {
  const ROTH_BETA = DEFAULT_EQUITY_BETA[US_MKT];  // 1.0

  test('GEOMETRIC (default) emits driftComp = ((β·σ)² + σ_idio²)/2 per sleeve', () => {
    const vol = 0.18;
    const h = new EquityReturnTickHandler({ vol, idioVol: { [AU_MKT]: 0.1 } });
    const { driftComp } = h.call({ sim: { rng: mkRng() }, state: {} })[0];
    // US_MKT: β 1.0, no idio ⇒ (1.0·0.18)²/2 = 0.0162.
    assert.ok(Math.abs(driftComp[US_MKT] - (Math.pow(ROTH_BETA * vol, 2)) / 2) < 1e-12);
    // AU_MKT: β 0.7, idio 0.1 ⇒ ((0.7·0.18)² + 0.1²)/2.
    const expSuper = (Math.pow(DEFAULT_EQUITY_BETA[AU_MKT] * vol, 2) + 0.1 * 0.1) / 2;
    assert.ok(Math.abs(driftComp[AU_MKT] - expSuper) < 1e-12);
  });

  test('NONE emits zero driftComp for every sleeve', () => {
    const h = new EquityReturnTickHandler({ vol: 0.18, driftComp: 'NONE' });
    const { driftComp } = h.call({ sim: { rng: mkRng() }, state: {} })[0];
    for (const s of EQUITY_SLEEVES) assert.equal(driftComp[s], 0);
  });

  test('driftComp is deterministic — does NOT consume the RNG (cursor unadvanced)', () => {
    // Same market draw ⇒ same deviation regardless of driftComp mode; comp is config-only.
    const g = new EquityReturnTickHandler({ vol: 0.18, driftComp: 'GEOMETRIC' }).call({ sim: { rng: mkRng(9) }, state: {} })[0];
    const n = new EquityReturnTickHandler({ vol: 0.18, driftComp: 'NONE' }).call({ sim: { rng: mkRng(9) }, state: {} })[0];
    assert.deepEqual(g.deviation, n.deviation);
    assert.equal(g.marketDev, n.marketDev);
  });

  test('the fold applies deviation + driftComp together', () => {
    const reducer = new EquityReturnReducer();
    const st = {
      effectiveGrowthRates: { [US_MKT]: 0.10 },
      equityReturnDev:       { [US_MKT]: -0.05 },
      equityReturnDriftComp: { [US_MKT]: 0.0162 },
    };
    const next = reducer.reduce(st, { type: 'US_PERIOD_ADVANCE' });
    // 0.10 + (−0.05 + 0.0162) = 0.0662.
    assert.ok(Math.abs(next.effectiveGrowthRates[US_MKT] - 0.0662) < 1e-12);
  });

  test('driftComp alone (dev all-zero) still folds — a nonzero comp is not a no-op', () => {
    const reducer = new EquityReturnReducer();
    const st = {
      effectiveGrowthRates: { [US_MKT]: 0.10 },
      equityReturnDev:       { [US_MKT]: 0 },
      equityReturnDriftComp: { [US_MKT]: 0.0162 },
    };
    const next = reducer.reduce(st, { type: 'US_PERIOD_ADVANCE' });
    assert.ok(Math.abs(next.effectiveGrowthRates[US_MKT] - 0.1162) < 1e-12);
  });

  // §6 test 6: the realized geometric mean over a long horizon.
  test('realized geometric mean ≈ anchor under GEOMETRIC, ≈ anchor − σ²/2 under NONE', () => {
    const anchor = 0.10, vol = 0.18, N = 40000;
    const realizedGeo = (mode) => {
      const h = new EquityReturnTickHandler({ vol, driftComp: mode });
      const rng = mkRng(2026);
      let sumLog = 0;
      for (let i = 0; i < N; i++) {
        const o = h.call({ sim: { rng }, state: {} })[0];               // US_MKT: β 1.0, idio 0
        const r = anchor + o.deviation[US_MKT] + o.driftComp[US_MKT];
        sumLog += Math.log(1 + r);
      }
      return Math.exp(sumLog / N) - 1;
    };
    const geoNone = realizedGeo('NONE');
    const geoGeom = realizedGeo('GEOMETRIC');
    // NONE leaves the ≈σ²/2 drag in; GEOMETRIC adds it back.
    assert.ok(geoNone < anchor - 0.01, `NONE should show drag, got ${geoNone}`);
    assert.ok(Math.abs(geoNone - (anchor - vol * vol / 2)) < 0.004, `NONE ≈ anchor−σ²/2, got ${geoNone}`);
    assert.ok(Math.abs(geoGeom - anchor) < 0.004, `GEOMETRIC ≈ anchor, got ${geoGeom}`);
    assert.ok(Math.abs(geoGeom - anchor) < Math.abs(geoNone - anchor), 'GEOMETRIC must be closer to the anchor than NONE');
  });
});

// ─── e2e: inertness + determinism ────────────────────────────────────────────────

describe('stochastic equity — e2e', () => {
  const END = Date.UTC(2040, 0, 1);
  const nw = (sim) => Math.round(sim.state.metrics?.netWorth ?? 0);

  // §6 test 1: inertness.
  test('stochastic OFF ⇒ two default runs are byte-identical', () => {
    const a = loadSim({ simEnd: END, stepTo: END }).sim;
    const b = loadSim({ params: { equityReturnStochastic: false }, simEnd: END, stepTo: END }).sim;
    assert.equal(nw(a), nw(b));
  });

  test('OFF ⇒ no EQUITY_RETURN_TICK is scheduled', () => {
    const { sim } = loadSim({ simEnd: END });
    const scheduled = (sim.events ?? []).some(e => e.type === 'EQUITY_RETURN_TICK');
    assert.equal(scheduled, false);
  });

  // §6 test 2: determinism.
  test('stochastic ON ⇒ reproducible across identical runs, and moves the number', () => {
    const on1 = loadSim({ params: { equityReturnStochastic: true, equityReturnVol: 0.18 }, simEnd: END, stepTo: END }).sim;
    const on2 = loadSim({ params: { equityReturnStochastic: true, equityReturnVol: 0.18 }, simEnd: END, stepTo: END }).sim;
    const off = loadSim({ simEnd: END, stepTo: END }).sim;
    assert.equal(nw(on1), nw(on2), 'same seed ⇒ same result (reproducible)');
    assert.notEqual(nw(on1), nw(off), 'a stochastic return path should perturb equity growth');
  });
});
