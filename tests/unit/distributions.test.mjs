/*
 * Copyright (c) 2026 Terry Packer.
 *
 * This file is part of Terry Packer's Work.
 * See www.terrypacker.com for further info.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';
import { Simulation } from '../../src/simulation-framework/simulation.js';
import {
  ConstantDistribution,
  UniformDistribution,
  NormalDistribution,
  LogNormalDistribution,
  BernoulliDistribution,
  createDistribution,
  DISTRIBUTION_TYPES,
} from '../../src/simulation-framework/distributions.js';

// Build a reproducible rng using the same algorithm as Simulation.createRNG()
function makeRng(seed = 42) {
  const sim = new Simulation(new Date('2026-01-01'), { seed });
  return () => sim.rng();
}

function sampleN(dist, n, seed = 1) {
  const rng = makeRng(seed);
  const samples = [];
  for (let i = 0; i < n; i++) samples.push(dist.sample(rng));
  return samples;
}

function mean(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }
function variance(arr) {
  const m = mean(arr);
  return arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length;
}

// ─── ConstantDistribution ─────────────────────────────────────────────────────

test('ConstantDistribution: always returns the configured value', () => {
  const d = new ConstantDistribution({ value: 3.14 });
  const rng = makeRng();
  for (let i = 0; i < 100; i++) assert.equal(d.sample(rng), 3.14);
});

test('ConstantDistribution: works with negative values', () => {
  const d = new ConstantDistribution({ value: -99 });
  assert.equal(d.sample(makeRng()), -99);
});

test('ConstantDistribution: works with zero', () => {
  const d = new ConstantDistribution({ value: 0 });
  assert.equal(d.sample(makeRng()), 0);
});

// ─── UniformDistribution ──────────────────────────────────────────────────────

test('UniformDistribution: all samples in [min, max]', () => {
  const d = new UniformDistribution({ min: 2, max: 5 });
  const samples = sampleN(d, 1000);
  for (const v of samples) {
    assert.ok(v >= 2 && v <= 5, `sample ${v} out of [2, 5]`);
  }
});

test('UniformDistribution: mean converges to (min+max)/2', () => {
  const d = new UniformDistribution({ min: 0, max: 1 });
  const m = mean(sampleN(d, 10000));
  assert.ok(Math.abs(m - 0.5) < 0.02, `mean ${m} not near 0.5`);
});

test('UniformDistribution: throws when min > max', () => {
  assert.throws(() => new UniformDistribution({ min: 5, max: 2 }), RangeError);
});

test('UniformDistribution: degenerate case min === max returns that value', () => {
  const d = new UniformDistribution({ min: 7, max: 7 });
  assert.equal(d.sample(makeRng()), 7);
});

// ─── NormalDistribution ───────────────────────────────────────────────────────

test('NormalDistribution: mean converges to configured mean', () => {
  const d = new NormalDistribution({ mean: 5, stdDev: 2 });
  const m = mean(sampleN(d, 10000));
  assert.ok(Math.abs(m - 5) < 0.1, `mean ${m} not near 5`);
});

test('NormalDistribution: variance converges to stdDev^2', () => {
  const d = new NormalDistribution({ mean: 0, stdDev: 3 });
  const v = variance(sampleN(d, 10000));
  assert.ok(Math.abs(v - 9) < 0.5, `variance ${v} not near 9`);
});

test('NormalDistribution: stdDev=0 always returns mean', () => {
  const d = new NormalDistribution({ mean: 42, stdDev: 0 });
  assert.equal(d.sample(makeRng()), 42);
  assert.equal(d.sample(makeRng()), 42);
});

test('NormalDistribution: throws on negative stdDev', () => {
  assert.throws(() => new NormalDistribution({ mean: 0, stdDev: -1 }), RangeError);
});

test('NormalDistribution: negative mean supported', () => {
  const d = new NormalDistribution({ mean: -10, stdDev: 1 });
  const m = mean(sampleN(d, 5000));
  assert.ok(Math.abs(m - (-10)) < 0.1, `mean ${m} not near -10`);
});

// ─── LogNormalDistribution ────────────────────────────────────────────────────

test('LogNormalDistribution: all samples are positive', () => {
  const d = new LogNormalDistribution({ mean: 0.07, stdDev: 0.15 });
  const samples = sampleN(d, 1000);
  for (const v of samples) assert.ok(v > 0, `non-positive sample: ${v}`);
});

test('LogNormalDistribution: mean converges to configured real-space mean', () => {
  const targetMean = 1.07;
  const d = new LogNormalDistribution({ mean: targetMean, stdDev: 0.10 });
  const m = mean(sampleN(d, 20000));
  assert.ok(Math.abs(m - targetMean) < 0.03, `mean ${m} not near ${targetMean}`);
});

test('LogNormalDistribution: stdDev=0 returns deterministic value near mean', () => {
  const d = new LogNormalDistribution({ mean: 2, stdDev: 0 });
  const v = d.sample(makeRng());
  assert.ok(Math.abs(v - 2) < 1e-10, `expected ~2, got ${v}`);
});

test('LogNormalDistribution: throws on non-positive mean', () => {
  assert.throws(() => new LogNormalDistribution({ mean: 0, stdDev: 1 }), RangeError);
  assert.throws(() => new LogNormalDistribution({ mean: -1, stdDev: 1 }), RangeError);
});

test('LogNormalDistribution: throws on negative stdDev', () => {
  assert.throws(() => new LogNormalDistribution({ mean: 1, stdDev: -1 }), RangeError);
});

// ─── BernoulliDistribution ────────────────────────────────────────────────────

test('BernoulliDistribution: only returns 0 or 1', () => {
  const d = new BernoulliDistribution({ probability: 0.3 });
  const samples = sampleN(d, 500);
  for (const v of samples) assert.ok(v === 0 || v === 1);
});

test('BernoulliDistribution: frequency converges to probability', () => {
  const d = new BernoulliDistribution({ probability: 0.4 });
  const samples = sampleN(d, 10000);
  const freq = samples.filter(v => v === 1).length / samples.length;
  assert.ok(Math.abs(freq - 0.4) < 0.02, `frequency ${freq} not near 0.4`);
});

test('BernoulliDistribution: probability=0 always returns 0', () => {
  const d = new BernoulliDistribution({ probability: 0 });
  const samples = sampleN(d, 100);
  assert.ok(samples.every(v => v === 0));
});

test('BernoulliDistribution: probability=1 always returns 1', () => {
  const d = new BernoulliDistribution({ probability: 1 });
  const samples = sampleN(d, 100);
  assert.ok(samples.every(v => v === 1));
});

test('BernoulliDistribution: throws on out-of-range probability', () => {
  assert.throws(() => new BernoulliDistribution({ probability: -0.1 }), RangeError);
  assert.throws(() => new BernoulliDistribution({ probability: 1.1 }), RangeError);
});

// ─── createDistribution factory ───────────────────────────────────────────────

test('createDistribution: creates ConstantDistribution from type string', () => {
  const d = createDistribution({ type: DISTRIBUTION_TYPES.CONSTANT, value: 5 });
  assert.ok(d instanceof ConstantDistribution);
  assert.equal(d.sample(makeRng()), 5);
});

test('createDistribution: creates NormalDistribution from type string', () => {
  const d = createDistribution({ type: DISTRIBUTION_TYPES.NORMAL, mean: 0, stdDev: 1 });
  assert.ok(d instanceof NormalDistribution);
});

test('createDistribution: creates UniformDistribution from type string', () => {
  const d = createDistribution({ type: DISTRIBUTION_TYPES.UNIFORM, min: 0, max: 10 });
  assert.ok(d instanceof UniformDistribution);
});

test('createDistribution: creates LogNormalDistribution from type string', () => {
  const d = createDistribution({ type: DISTRIBUTION_TYPES.LOG_NORMAL, mean: 1, stdDev: 0.1 });
  assert.ok(d instanceof LogNormalDistribution);
});

test('createDistribution: creates BernoulliDistribution from type string', () => {
  const d = createDistribution({ type: DISTRIBUTION_TYPES.BERNOULLI, probability: 0.5 });
  assert.ok(d instanceof BernoulliDistribution);
});

test('createDistribution: throws on unknown type', () => {
  assert.throws(() => createDistribution({ type: 'unknown' }), /Unknown distribution/);
});

// ─── Reproducibility ──────────────────────────────────────────────────────────

test('NormalDistribution: same seed produces identical sample sequence', () => {
  const d = new NormalDistribution({ mean: 0, stdDev: 1 });
  const s1 = sampleN(d, 20, 99);
  const s2 = sampleN(d, 20, 99);
  assert.deepEqual(s1, s2);
});

test('UniformDistribution: same seed produces identical sample sequence', () => {
  const d = new UniformDistribution({ min: 0, max: 1 });
  const s1 = sampleN(d, 20, 77);
  const s2 = sampleN(d, 20, 77);
  assert.deepEqual(s1, s2);
});
