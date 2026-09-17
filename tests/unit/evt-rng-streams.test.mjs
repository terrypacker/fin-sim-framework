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
 * Design 107 §15.5 — year-keyed RNG substreams, the thing that makes two arms comparable.
 *
 * The defect these exist to remove is NOT "the arms get different random numbers". Measured on
 * a paycheck-vs-no-paycheck pair, both arms drew the identical 1,862 values in the identical
 * order — and diverged anyway, because from draw 484 the same value landed on a different
 * DATE. A z that is 2035's equity shock in one arm is 2036's in the other. So the property
 * under test is ALIGNMENT: a draw must be a pure function of (seed, label, year).
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Simulation } from '../../src/simulation-framework/simulation.js';

/** A bare Simulation is heavy to construct; the RNG surface is self-contained. */
function rngHost(seed, { streams = true } = {}) {
  const host = Object.create(Simulation.prototype);
  host.createRNG = Simulation.prototype.createRNG;
  host.rngStream = Simulation.prototype.rngStream;
  host.reseed    = Simulation.prototype.reseed;
  host.rng = host.createRNG(seed);
  host.useRngStreams = streams;
  return host;
}
const take = (gen, n) => Array.from({ length: n }, () => gen());

test('RNG-1: a substream is a pure function of (seed, label, year)', () => {
  const h = rngHost(1);
  assert.deepEqual(take(h.rngStream('equity', 2035), 5), take(h.rngStream('equity', 2035), 5));
  assert.notDeepEqual(take(h.rngStream('equity', 2035), 5), take(h.rngStream('equity', 2036), 5));
  assert.notDeepEqual(take(h.rngStream('equity', 2035), 5), take(h.rngStream('inflation', 2035), 5));
  assert.notDeepEqual(take(h.rngStream('equity', 2035), 5), take(rngHost(2).rngStream('equity', 2035), 5));
});

test('RNG-2: draws elsewhere cannot shift a substream — the whole point', () => {
  const h = rngHost(1);
  const before = take(h.rngStream('equity', 2040), 3);
  // Another process draws an arbitrary number of times, as a differing arm would.
  take(h.rngStream('fx', 2040), 17);
  take(h.rngStream('inflation', 2040), 5);
  h.rng(); h.rng(); h.rng();
  assert.deepEqual(take(h.rngStream('equity', 2040), 3), before,
    'the equity path must not move because an unrelated process drew more often');
});

test('RNG-3: adjacent years are not adjacent states', () => {
  // Seeding a substream with seed+year would put consecutive years on consecutive states,
  // and this generator makes those visibly correlated — a hashed key avoids it.
  const h = rngHost(7);
  const a = h.rngStream('equity', 2040)();
  const b = h.rngStream('equity', 2041)();
  assert.ok(Math.abs(a - b) > 0.01, `consecutive years drew ${a} and ${b}`);
});

test('RNG-4: OFF is the default and falls back to the shared cursor, byte-identically', () => {
  const off = rngHost(1, { streams: false });
  assert.equal(off.rngStream('equity', 2035), off.rng, 'the same function object, not a copy');
  // …and the shared cursor keeps its historic sequence, which is why every existing golden
  // is unmoved by this feature.
  const plain = rngHost(1, { streams: false });
  assert.deepEqual(take(plain.rngStream('equity', 2035), 4), take(rngHost(1, { streams: false }).rng, 4));
});

test('RNG-5: reseed repoints the substreams too, not just the cursor', () => {
  // `rngState` is a moving cursor and cannot seed a substream; `rngSeed` is kept for that.
  // Forgetting to update it in `reseed` would leave every substream on the CONSTRUCTION seed,
  // so a scenario's `randomSeed` would silently move the shared cursor only.
  const h = rngHost(1);
  const atSeed1 = take(h.rngStream('equity', 2035), 3);
  h.reseed(2);
  assert.notDeepEqual(take(h.rngStream('equity', 2035), 3), atSeed1);
  assert.deepEqual(take(h.rngStream('equity', 2035), 3), take(rngHost(2).rngStream('equity', 2035), 3));
});
