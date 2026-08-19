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
 * fx-calibration.test.mjs — design 92 step 2 (calibrate σ and k from history).
 *
 * FXC-1  Recovery: the estimator run on a SYNTHETIC OU path with known σ and k returns
 *        those parameters. This is the test that makes the calibration mean anything —
 *        run only against real data, an estimator returns a plausible-looking number for
 *        any input and nobody ever learns whether it is the right number.
 * FXC-2  Working detector: a path built with a DIFFERENT σ produces a different estimate,
 *        in the right direction. Without this, FXC-1 passes for an estimator that returns
 *        a constant close to the truth by luck.
 * FXC-3  Drift is measured, never folded into σ. A path with strong drift and the same
 *        innovations reports the drift in μ̂ and leaves σ̂ unmoved (design 92 §5).
 * FXC-4  No mean reversion (a pure random walk) reports k = null, not a large number.
 * FXC-5  Refusal: too few observations throws rather than fitting noise.
 * FXC-6  The shipped defaults match the packaged series' post-float calibration. FRED
 *        revises history, so this is what forces a re-decision after a rate refresh
 *        instead of letting the defaults quietly go stale (design 92 §7).
 * FXC-7  The term-structure fit recovers a known OU's parameters from a synthetic path,
 *        and the analytic `ouChangeSd` it fits against agrees with the ENGINE's own step
 *        function. Fitting against a formula the simulation does not implement would
 *        calibrate the wrong process.
 * FXC-8  `estimableHorizons` excludes horizons with too few independent windows. This is
 *        the filter that decides the answer: including the post-float 20-year point
 *        (~2 independent windows, and lower than its own 10-year figure, which no
 *        diffusion can produce) reverses the conclusion about k.
 * FXC-9  On the packaged series the term-structure fit and the lag-1 AR(1) fit DISAGREE,
 *        with AR(1) reverting faster. A working detector: if these ever coincide, one of
 *        the two estimators has stopped doing what it claims.
 */

import { test }   from 'node:test';
import assert     from 'node:assert/strict';

import { estimateFxProcess, calibrateWindow, fitFxTermStructure, ouChangeSd,
         estimableHorizons, empiricalTermStructure, POST_FLOAT_MONTH, MIN_MONTHS }
  from '../../scripts/lib/fx-calibration.mjs';
import { USD_AUD_H10_MONTHLY } from '../../src/finance/fx/data/usd-aud-h10-monthly.js';
import { FX_PROCESS_MODELS, gaussianFrom } from '../../src/finance/fx/fx-process-models.js';

/** Deterministic uniform [0,1) — mulberry32, so these tests never flake. */
function seededRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a monthly level path from the engine's own MEAN_REVERTING step, so the estimator
 * is checked against the process it is meant to parameterise rather than against a
 * second implementation of an OU that might share a mistake.
 *
 * @param {{ sigma: number, k: number, months: number, seed: number, anchor?: number,
 *           driftAnnual?: number, model?: string }} opts
 */
function synthPath({ sigma, k, months, seed, anchor = 1.42, driftAnnual = 0, model = 'MEAN_REVERTING' }) {
  const step = FX_PROCESS_MODELS[model];
  const rng  = seededRng(seed);
  const dt   = 1 / 12;
  const levels = [];
  let dev = 0;
  for (let i = 0; i < months; i++) {
    const z = gaussianFrom(rng);
    dev = step(dev, { sigma, dt, k, z });
    // Drift enters the LEVEL, exactly as the engine's anchor + regime drift does; it is
    // not part of the deviation the OU walks.
    levels.push(anchor * Math.exp(driftAnnual * i * dt) * Math.exp(dev));
  }
  return levels;
}

test('FXC-1 recovers known sigma and k from a synthetic OU path', () => {
  // A long path: k is a notoriously noisy estimate at short samples, which is itself the
  // reason MIN_MONTHS exists. 4000 months is far longer than any real window and isolates
  // estimator bias from sampling error.
  const r = estimateFxProcess(synthPath({ sigma: 0.11, k: 0.30, months: 4000, seed: 7 }));

  assert.ok(Math.abs(r.sigmaAnnual - 0.11) < 0.01,
    `sigma: expected ~0.11, got ${r.sigmaAnnual.toFixed(4)}`);
  assert.ok(Math.abs(r.reversionSpeed - 0.30) < 0.06,
    `k: expected ~0.30, got ${r.reversionSpeed.toFixed(4)}`);
  assert.ok(r.halfLifeYears > 1.5 && r.halfLifeYears < 3.5,
    `half-life: expected ~2.3 yr, got ${r.halfLifeYears.toFixed(2)}`);
});

test('FXC-2 a different sigma moves the estimate in the right direction', () => {
  const lo = estimateFxProcess(synthPath({ sigma: 0.06, k: 0.30, months: 4000, seed: 7 }));
  const hi = estimateFxProcess(synthPath({ sigma: 0.22, k: 0.30, months: 4000, seed: 7 }));

  assert.ok(hi.sigmaAnnual > lo.sigmaAnnual * 2.5,
    `expected sigma to scale with the input: ${lo.sigmaAnnual} -> ${hi.sigmaAnnual}`);
  assert.ok(Math.abs(lo.sigmaAnnual - 0.06) < 0.01);
  assert.ok(Math.abs(hi.sigmaAnnual - 0.22) < 0.02);
});

test('FXC-3 drift is reported in mu and does not leak into sigma', () => {
  const flat    = estimateFxProcess(synthPath({ sigma: 0.11, k: 0.30, months: 4000, seed: 7 }));
  const drifted = estimateFxProcess(
    synthPath({ sigma: 0.11, k: 0.30, months: 4000, seed: 7, driftAnnual: 0.02 }),
  );

  // Same innovations, same seed — only a deterministic exponential trend added.
  assert.ok(Math.abs(drifted.driftAnnual - 0.02) < 0.002,
    `drift: expected ~2%/yr, got ${(drifted.driftAnnual * 100).toFixed(2)}%`);
  assert.ok(Math.abs(flat.driftAnnual) < 0.01,
    `undrifted path should report ~0 drift, got ${(flat.driftAnnual * 100).toFixed(2)}%`);
  // A constant log-linear trend adds nothing to the sd of the INCREMENTS.
  assert.ok(Math.abs(drifted.sigmaAnnual - flat.sigmaAnnual) < 1e-9,
    'sigma must be unaffected by drift');
});

test('FXC-4 a pure random walk reports no mean reversion rather than a large k', () => {
  const r = estimateFxProcess(
    synthPath({ sigma: 0.11, k: 0, months: 2000, seed: 3, model: 'RANDOM_WALK' }),
  );
  // rho1 for a random walk sits at ~1; k must come back null, not a huge or negative number.
  assert.ok(r.rho1 > 0.95, `expected rho1 near 1 for a random walk, got ${r.rho1}`);
  assert.ok(r.reversionSpeed === null || r.reversionSpeed < 0.1,
    `expected no meaningful reversion, got k=${r.reversionSpeed}`);
});

test('FXC-5 refuses a window too short to fit', () => {
  assert.throws(
    () => estimateFxProcess(new Array(MIN_MONTHS - 1).fill(1.42)),
    /at least 36 monthly observations/,
  );
  assert.throws(
    () => calibrateWindow(USD_AUD_H10_MONTHLY, '2026-01', '2026-07'),
    /at least 36 are needed/,
  );
});

test('FXC-6 shipped defaults match the post-float calibration of the packaged series', async () => {
  const r = calibrateWindow(USD_AUD_H10_MONTHLY, POST_FLOAT_MONTH, null);
  // `calibrateWindow` promotes the TERM-STRUCTURE estimates into the primary fields;
  // the shipped defaults must track those, not the lag-1 AR(1) ones.
  assert.ok(r.term, 'post-float window should support a term-structure fit');
  assert.equal(r.reversionSpeed, r.term.reversionSpeed);

  const { US_AU_CROSS_BORDER } = await import(
    '../../src/scenarios/toolsets/us-au-cross-border-toolset.js'
  );
  const params = US_AU_CROSS_BORDER.paramSchema({ parameters: {} });
  const byKey  = Object.fromEntries(params.map((p) => [p.key, p]));

  // Tolerances absorb a routine FRED revision without absorbing a real shift. If this
  // fails after `npm run fetch:rates`, that is the point: re-run calibrate-fx.mjs and
  // decide, rather than shipping a default that no longer describes the series.
  assert.ok(
    Math.abs(byKey.fxVolatility.defaultValue - r.sigmaAnnual) < 0.01,
    `fxVolatility default ${byKey.fxVolatility.defaultValue} vs calibrated `
    + `${r.sigmaAnnual.toFixed(4)} — re-run scripts/lab/calibrate-fx.mjs`,
  );
  assert.ok(
    Math.abs(byKey.fxReversionSpeed.defaultValue - r.reversionSpeed) < 0.05,
    `fxReversionSpeed default ${byKey.fxReversionSpeed.defaultValue} vs calibrated `
    + `${r.reversionSpeed.toFixed(4)} — re-run scripts/lab/calibrate-fx.mjs`,
  );

  // The service-level fallbacks must agree with the schema, or a scenario that omits the
  // parameter silently runs a different process from one that sets it to the default.
  const { FxService } = await import('../../src/finance/fx/fx-service.js');
  const svc  = new FxService();
  const { handlers } = svc.getContributions(
    ['USD', 'AUD'], null, null, { fxProcessModel: 'MEAN_REVERTING' },
  );
  const tick = handlers.find((h) => h.constructor.type === 'FxTickHandler');
  assert.ok(tick, 'expected an FxTickHandler when a stochastic model is active');
  assert.equal(tick.reversionSpeed, byKey.fxReversionSpeed.defaultValue);
});

test('FXC-7 term-structure fit recovers a known OU, and matches the engine step function', () => {
  // 1. The analytic formula the fit minimises against must describe the process the
  //    simulation actually runs. Compare it to FX_PROCESS_MODELS.MEAN_REVERTING directly.
  const sigma = 0.114;
  const k     = 0.113;
  const dt    = 1 / 12;
  const step  = FX_PROCESS_MODELS.MEAN_REVERTING;
  for (const h of [1, 5, 10]) {
    const diffs = [];
    for (let s = 1; s <= 1500; s++) {
      const rng = seededRng(s);
      let dev = 0;
      for (let i = 0; i < 600; i++) dev = step(dev, { sigma, dt, k, z: gaussianFrom(rng) });
      const start = dev;
      for (let i = 0; i < h * 12; i++) dev = step(dev, { sigma, dt, k, z: gaussianFrom(rng) });
      diffs.push(dev - start);
    }
    const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const emp  = Math.sqrt(diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / (diffs.length - 1));
    const analytic = ouChangeSd(sigma, k, h);
    assert.ok(Math.abs(Math.log(emp / analytic)) < 0.10,
      `${h}y: engine ${emp.toFixed(4)} vs analytic ${analytic.toFixed(4)}`);
  }

  // 2. Recovery from a synthetic path built with the engine's own step function.
  const levels = synthPath({ sigma, k, months: 6000, seed: 11 });
  const fit = fitFxTermStructure(levels, { horizonsYears: [1, 2, 3, 5, 7, 10] });
  assert.ok(Math.abs(fit.sigmaAnnual - sigma) < 0.015,
    `sigma: expected ~${sigma}, got ${fit.sigmaAnnual.toFixed(4)}`);
  assert.ok(Math.abs(fit.reversionSpeed - k) < 0.05,
    `k: expected ~${k}, got ${fit.reversionSpeed.toFixed(4)}`);
});

test('FXC-8 estimableHorizons drops horizons with too few independent windows', () => {
  // 511 post-float months: 20y gives floor(511/240) = 2 independent windows, so it is out;
  // 10y gives 4 and stays. Including the 20y point is what reverses the conclusion on k.
  assert.deepEqual(estimableHorizons(511), [1, 2, 3, 5, 7, 10]);
  assert.ok(!estimableHorizons(511).includes(20));
  assert.deepEqual(estimableHorizons(1200), [1, 2, 3, 5, 7, 10, 15, 20]);

  // And the reason it matters, stated as an assertion on the real data: the post-float
  // 20-year dispersion comes out BELOW its own 10-year figure, which no diffusion can do.
  const i0 = USD_AUD_H10_MONTHLY.months.findIndex((m) => m >= POST_FLOAT_MONTH);
  const levels = USD_AUD_H10_MONTHLY.audPerUsd.slice(i0);
  const [tenY, twentyY] = empiricalTermStructure(levels, [10, 20]);
  assert.ok(twentyY < tenY,
    'the artefact this filter exists for should still be present in the data '
    + `(10y=${tenY.toFixed(4)}, 20y=${twentyY.toFixed(4)})`);
});

test('FXC-9 term-structure and lag-1 estimates disagree, with AR(1) reverting faster', () => {
  const r = calibrateWindow(USD_AUD_H10_MONTHLY, POST_FLOAT_MONTH, null);
  assert.ok(r.term.reversionSpeed < r.ar1ReversionSpeed * 0.6,
    `expected the lag-1 estimate to revert materially faster: term=${r.term.reversionSpeed.toFixed(3)} `
    + `vs ar1=${r.ar1ReversionSpeed.toFixed(3)}`);
  // sigma is NOT where the two disagree — that half of the calibration was always right.
  const i0     = USD_AUD_H10_MONTHLY.months.findIndex((m) => m >= POST_FLOAT_MONTH);
  const levels = USD_AUD_H10_MONTHLY.audPerUsd.slice(i0);
  const ar1Sigma = estimateFxProcess(levels).sigmaAnnual;
  assert.ok(Math.abs(r.term.sigmaAnnual - ar1Sigma) < 0.01,
    `sigma should agree between the two estimators: term=${r.term.sigmaAnnual.toFixed(4)} `
    + `vs ar1=${ar1Sigma.toFixed(4)}`);
  assert.ok(r.term.halfLifeYears > 4 && r.term.halfLifeYears < 9,
    `post-float half-life should be ~6 years, got ${r.term.halfLifeYears.toFixed(1)}`);
});
