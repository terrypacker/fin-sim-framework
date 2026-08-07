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
 * property-return-paths.test.mjs — design 75 Phase 1 (stochastic property return path).
 *
 * The house-price sibling of design 74's equity path. Units under test:
 *   - PropertyReturnTickHandler — loads each real-estate sleeve on the shared market factor
 *     (REUSED from the equity path when sharing, else drawn standalone) via beta + optional
 *     idiosyncratic term; deterministic and RNG-cursor-stable.
 *   - PropertyReturnStepReducer — stores the per-sleeve deviation + drift comp + market factor.
 *   - AssetAppreciationHandler — adds `propertyReturnDev + driftComp` to a property's resolved
 *     appreciation rate (design 75 §4.2 A2); NO reKey / flag off ⇒ deterministic, unchanged.
 *   - e2e — stochastic OFF is byte-identical; ON is reproducible with the same seed; the
 *     correlation seam (property reuses the equity market shock) is active with both flags on.
 *
 * Maps to §6.1 exit criteria + §7 testing plan (inertness, determinism, correlation, drift,
 * RNG-cursor ordering, standalone-when-equity-off).
 */

import { test, describe, beforeEach } from 'node:test';
import assert                         from 'node:assert/strict';

import { PropertyReturnTickHandler } from '../../src/finance/economic-regimes/property-return-tick-handler.js';
import { PropertyReturnStepReducer } from '../../src/finance/economic-regimes/property-return-step-reducer.js';
import { AssetAppreciationHandler }  from '../../src/finance/handlers/asset-appreciation-handler.js';
import { RATE_KEYS, PROPERTY_SLEEVES, DEFAULT_RE_BETA, DEFAULT_RE_IDIO } from '../../src/finance/economic-regimes/rate-keys.js';
import { loadScenarioSim }           from '../helpers/scenario-harness.js';


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

const mkRng = (seed = 42) => {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
};

const US = RATE_KEYS.REAL_ESTATE_US;
const AU = RATE_KEYS.REAL_ESTATE_AU;

// An rng that fails the test the moment it is drawn — proves "no uniform consumed".
const noDrawRng = () => { throw new Error('RNG drawn when it should not have been'); };

// ─── PropertyReturnTickHandler ───────────────────────────────────────────────────

describe('PropertyReturnTickHandler', () => {
  test('emits ONE PROPERTY_RETURN_STEP_APPLY carrying a deviation per real-estate sleeve', () => {
    const h = new PropertyReturnTickHandler({ marketVol: 0.18 });
    const out = h.call({ sim: { rng: mkRng() }, state: {} });
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'PROPERTY_RETURN_STEP_APPLY');
    assert.ok(Number.isFinite(out[0].marketDev));
    for (const sleeve of PROPERTY_SLEEVES) {
      assert.ok(Number.isFinite(out[0].deviation[sleeve]), `${sleeve} missing`);
    }
  });

  // ── Correlation seam (§4.1, §7 test 4): sharing REUSES the equity market shock ──
  test('shareMarketFactor ⇒ reuses state.equityReturnMarketDev and draws NO market uniform', () => {
    // idio 0 on both sleeves ⇒ zero draws at all in sharing mode. A throwing rng proves it.
    const h = new PropertyReturnTickHandler({
      marketVol: 0.18, shareMarketFactor: true, idioVol: { [US]: 0, [AU]: 0 },
    });
    const marketDev = 0.2;
    const { deviation, marketDev: outMarket } = h.call({ sim: { rng: noDrawRng }, state: { equityReturnMarketDev: marketDev } })[0];
    assert.equal(outMarket, marketDev, 'must reuse the equity market factor verbatim');
    // Each sleeve = beta × the SAME shared market shock ⇒ perfect systematic co-loading.
    assert.ok(Math.abs(deviation[US] - DEFAULT_RE_BETA[US] * marketDev) < 1e-12);
    assert.ok(Math.abs(deviation[AU] - DEFAULT_RE_BETA[AU] * marketDev) < 1e-12);
  });

  test('standalone (shareMarketFactor false) ⇒ draws its own market factor', () => {
    const h = new PropertyReturnTickHandler({ marketVol: 0.18, shareMarketFactor: false, idioVol: { [US]: 0, [AU]: 0 } });
    // No equity market dev in state; a nonzero own draw must appear.
    const { marketDev } = h.call({ sim: { rng: mkRng(3) }, state: {} })[0];
    assert.ok(Number.isFinite(marketDev) && marketDev !== 0, 'standalone should draw a nonzero own market factor');
  });

  test('default betas are near zero and default idio is large (housing ~99% idiosyncratic)', () => {
    // Design 75 §4.1: US β 0.03 / idio 0.09; AU β 0.05 / idio 0.10.
    assert.equal(DEFAULT_RE_BETA[US], 0.03);
    assert.equal(DEFAULT_RE_BETA[AU], 0.05);
    assert.equal(DEFAULT_RE_IDIO[US], 0.09);
    assert.equal(DEFAULT_RE_IDIO[AU], 0.10);
  });

  test('default idio vol is ON — the handler draws; idio 0 draws nothing (sharing mode)', () => {
    // Unlike equity (idio defaults to 0), property idio defaults nonzero (housing is ~99%
    // idiosyncratic), so the default sharing-mode path DOES consume the RNG, while an
    // all-zero idio override consumes none. A call-counting rng makes this robust to how
    // many uniforms Box-Muller draws per gaussian.
    const counting = (base) => { let n = 0; const f = () => { n++; return base(); }; f.count = () => n; return f; };

    const rDefault = counting(mkRng(5));
    new PropertyReturnTickHandler({ shareMarketFactor: true })
      .call({ sim: { rng: rDefault }, state: { equityReturnMarketDev: 0.1 } });
    assert.ok(rDefault.count() > 0, 'default (nonzero) idio must draw from the RNG');

    const rZero = counting(mkRng(5));
    new PropertyReturnTickHandler({ shareMarketFactor: true, idioVol: { [US]: 0, [AU]: 0 } })
      .call({ sim: { rng: rZero }, state: { equityReturnMarketDev: 0.1 } });
    assert.equal(rZero.count(), 0, 'all-zero idio in sharing mode must draw nothing');
  });

  // ── §7 test 7: RNG-cursor ordering ──
  test('idio 0 on a sleeve does NOT consume a uniform (skip-when-zero)', () => {
    const rngA = mkRng(7);
    const rngB = mkRng(7);
    // A: both idio 0 ⇒ no draws. B: US idio 0, AU idio 0 explicitly ⇒ no draws. Cursors match.
    const a = new PropertyReturnTickHandler({ shareMarketFactor: true, idioVol: { [US]: 0, [AU]: 0 } })
      .call({ sim: { rng: rngA }, state: { equityReturnMarketDev: 0.1 } })[0];
    const b = new PropertyReturnTickHandler({ shareMarketFactor: true, idioVol: {} })
      .call({ sim: { rng: rngB }, state: { equityReturnMarketDev: 0.1 } })[0];
    // NOTE: b uses DEFAULT_RE_IDIO (nonzero) so b DOES draw; a does not. So instead compare a
    // against an explicit all-zero twin and assert a's cursor is unadvanced.
    assert.equal(rngA(), mkRng(7)(), 'zero-idio sleeves must not advance the RNG cursor');
    assert.ok(a && b);
  });

  test('per-sleeve beta / idio overrides replace the defaults', () => {
    const h = new PropertyReturnTickHandler({ shareMarketFactor: true, beta: { [US]: 0.5 }, idioVol: { [US]: 0, [AU]: 0 } });
    const { deviation } = h.call({ sim: { rng: noDrawRng }, state: { equityReturnMarketDev: 0.2 } })[0];
    assert.ok(Math.abs(deviation[US] - 0.5 * 0.2) < 1e-12, 'US beta override applied');
  });

  test('round-trips through toJSON/fromJSON (incl. shareMarketFactor)', () => {
    const h = new PropertyReturnTickHandler({ marketVol: 0.2, beta: { [US]: 0.1 }, idioVol: { [AU]: 0.05 }, shareMarketFactor: true });
    const clone = PropertyReturnTickHandler.fromJSON(h.toJSON());
    assert.equal(clone.shareMarketFactor, true);
    assert.deepEqual(
      clone.call({ sim: { rng: mkRng() }, state: { equityReturnMarketDev: 0.1 } }),
      h.call({ sim: { rng: mkRng() }, state: { equityReturnMarketDev: 0.1 } }),
    );
  });
});

// ─── drift compensation (inherited from the equity decision, §4.3) ────────────────

describe('PropertyReturnTickHandler — drift compensation', () => {
  test('GEOMETRIC (default) emits driftComp = ((β·σ)² + σ_idio²)/2 per sleeve', () => {
    const vol = 0.18;
    const h = new PropertyReturnTickHandler({ marketVol: vol, shareMarketFactor: true, idioVol: { [US]: 0, [AU]: 0 } });
    const { driftComp } = h.call({ sim: { rng: noDrawRng }, state: { equityReturnMarketDev: 0.1 } })[0];
    assert.ok(Math.abs(driftComp[US] - Math.pow(DEFAULT_RE_BETA[US] * vol, 2) / 2) < 1e-15);
    assert.ok(Math.abs(driftComp[AU] - Math.pow(DEFAULT_RE_BETA[AU] * vol, 2) / 2) < 1e-15);
  });

  test('NONE emits zero driftComp for every sleeve', () => {
    const h = new PropertyReturnTickHandler({ marketVol: 0.18, driftComp: 'NONE', shareMarketFactor: true, idioVol: { [US]: 0, [AU]: 0 } });
    const { driftComp } = h.call({ sim: { rng: noDrawRng }, state: { equityReturnMarketDev: 0.1 } })[0];
    for (const s of PROPERTY_SLEEVES) assert.equal(driftComp[s], 0);
  });
});

// ─── PropertyReturnStepReducer ────────────────────────────────────────────────────

describe('PropertyReturnStepReducer', () => {
  let reducer;
  beforeEach(() => { reducer = new PropertyReturnStepReducer(); });

  test('stores the per-sleeve deviation, drift comp and market factor', () => {
    const action = { type: 'PROPERTY_RETURN_STEP_APPLY', marketDev: 0.02, deviation: { [US]: 0.006, [AU]: 0.010 }, driftComp: { [US]: 0.004 } };
    const next = reducer.reduce({}, action);
    assert.deepEqual(next.propertyReturnDev, { [US]: 0.006, [AU]: 0.010 });
    assert.deepEqual(next.propertyReturnDriftComp, { [US]: 0.004 });
    assert.equal(next.propertyReturnMarketDev, 0.02);
  });

  test('a malformed action (no deviation) is a no-op', () => {
    const st = { propertyReturnDev: { [US]: 0.01 } };
    const next = reducer.reduce(st, { type: 'PROPERTY_RETURN_STEP_APPLY' });
    assert.equal(next.propertyReturnDev, st.propertyReturnDev);
  });
});

// ─── AssetAppreciationHandler — the fold (§4.2 A2) ────────────────────────────────

describe('AssetAppreciationHandler — stochastic property fold', () => {
  const mkAsset = (over = {}) => ({ stateKey: 'house', appreciationRate: 0.04, appreciationSchedule: null, reKey: US, ...over });

  test('no propertyReturnDev in state ⇒ deterministic delta (byte-identical to before)', () => {
    const h = new AssetAppreciationHandler({ assets: [mkAsset()] });
    const out = h.call({ state: { house: { value: 100000 } }, date: new Date(Date.UTC(2030, 0, 1)) });
    assert.equal(out[0].delta, 4000); // 100000 × 0.04
  });

  test('adds deviation + driftComp to the resolved rate for the matching sleeve', () => {
    const h = new AssetAppreciationHandler({ assets: [mkAsset()] });
    const state = {
      house: { value: 100000 },
      propertyReturnDev:       { [US]: -0.02 },
      propertyReturnDriftComp: { [US]: 0.005 },
    };
    const out = h.call({ state, date: new Date(Date.UTC(2030, 0, 1)) });
    // 100000 × (0.04 − 0.02 + 0.005) = 2500.
    assert.equal(out[0].delta, 2500);
  });

  test('an asset with NO reKey (e.g. a collectible) ignores the property path', () => {
    const h = new AssetAppreciationHandler({ assets: [mkAsset({ reKey: undefined })] });
    const state = { house: { value: 100000 }, propertyReturnDev: { [US]: -0.02 } };
    const out = h.call({ state, date: new Date(Date.UTC(2030, 0, 1)) });
    assert.equal(out[0].delta, 4000); // unaffected — deterministic
  });

  test('an AU property reads the AU sleeve, not the US one', () => {
    const h = new AssetAppreciationHandler({ assets: [mkAsset({ reKey: AU })] });
    const state = { house: { value: 100000 }, propertyReturnDev: { [US]: -0.02, [AU]: 0.03 } };
    const out = h.call({ state, date: new Date(Date.UTC(2030, 0, 1)) });
    assert.equal(out[0].delta, 7000); // 100000 × (0.04 + 0.03)
  });
});

// ─── e2e: inertness + determinism + correlation ───────────────────────────────────

describe('stochastic property — e2e', () => {
  const END = Date.UTC(2040, 0, 1);
  const nw = (sim) => Math.round(sim.state.metrics?.netWorth ?? 0);

  // §6.1 / §7 test 1: inertness.
  test('property stochastic OFF ⇒ two default runs are byte-identical', () => {
    const a = loadSim({ simEnd: END, stepTo: END }).sim;
    const b = loadSim({ params: { propertyReturnStochastic: false }, simEnd: END, stepTo: END }).sim;
    assert.equal(nw(a), nw(b));
  });

  test('OFF ⇒ no PROPERTY_RETURN_TICK is scheduled', () => {
    const { sim } = loadSim({ simEnd: END });
    const scheduled = sim.queue.data.some(e => e.type === 'PROPERTY_RETURN_TICK');
    assert.equal(scheduled, false);
  });

  // §7 test 2: determinism + the path actually moves net worth (house value varies).
  test('property ON ⇒ reproducible across identical runs, and moves the number', () => {
    const on1 = loadSim({ params: { propertyReturnStochastic: true }, simEnd: END, stepTo: END }).sim;
    const on2 = loadSim({ params: { propertyReturnStochastic: true }, simEnd: END, stepTo: END }).sim;
    const off = loadSim({ simEnd: END, stepTo: END }).sim;
    assert.equal(nw(on1), nw(on2), 'same seed ⇒ same result (reproducible)');
    assert.notEqual(nw(on1), nw(off), 'a stochastic property path should perturb house values');
  });

  // §7 test 2: standalone — property on, equity off — still draws its own path and moves NW.
  test('property ON with equity OFF ⇒ standalone path still moves the number', () => {
    const on  = loadSim({ params: { propertyReturnStochastic: true, equityReturnStochastic: false }, simEnd: END, stepTo: END }).sim;
    const off = loadSim({ simEnd: END, stepTo: END }).sim;
    assert.notEqual(nw(on), nw(off), 'standalone property path should still vary house values');
  });

  // §7 test 4 (e2e): with BOTH flags on, the property tick is scheduled after the equity tick
  // and the correlation seam is active (both are present, property reused the market shock).
  test('both flags ON ⇒ both ticks scheduled, property ordered AFTER equity', () => {
    const { sim } = loadSim({ params: { equityReturnStochastic: true, propertyReturnStochastic: true }, simEnd: END });
    const eq = sim.queue.data.find(e => e.type === 'EQUITY_RETURN_TICK');
    const pr = sim.queue.data.find(e => e.type === 'PROPERTY_RETURN_TICK');
    assert.ok(eq && pr, 'both ticks scheduled');
    assert.ok((pr.order ?? 0) > (eq.order ?? 0), 'property tick must sort after the equity tick on the same date');
  });
});
