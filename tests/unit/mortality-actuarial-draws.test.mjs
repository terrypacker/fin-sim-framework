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
 * mortality-actuarial-draws.test.mjs
 *
 * Tests for design/27 Increment 3 — MC actuarial lifespan draws.
 *
 *  MC-1: ActuarialLifespanDistribution produces sensible values near the table mean
 *  MC-2: Seeded RNG reproduces the same draw
 *  MC-3: Sampled lifespan is always > currentAge (clamped from below)
 *  MC-4: lookupLifeTable returns CDC_2024 for US, AU_2022 for AU, CDC_2024 as fallback
 *  MC-5: buildMortalityMcConfigs emits one variable per person in params.people
 *  MC-6: Female sex uses table.F parameters (different from M)
 */

import { test }   from 'node:test';
import assert      from 'node:assert/strict';

import { ActuarialLifespanDistribution, DISTRIBUTION_TYPES } from '../../src/simulation-framework/distributions.js';
import { CDC_2024, AU_2022, lookupLifeTable }                from '../../src/finance/monte-carlo/life-tables.js';

// Minimal seeded RNG (same algorithm as Simulation.createRNG / makeSeededRng)
function makeSeededRng(seed) {
  let s = seed;
  return () => {
    s = Math.trunc(s + 0x6D2B79F5);
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t ^= t + Math.imul(t ^ t >>> 7, 61 | t);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ── MC-1 ──────────────────────────────────────────────────────────────────────

test('MC-1: actuarial draws cluster near the CDC_2024 male mean across 1000 samples', () => {
  const dist = new ActuarialLifespanDistribution({ table: CDC_2024, sex: 'M', currentAge: 0 });
  const rng  = makeSeededRng(42);
  const samples = Array.from({ length: 1_000 }, () => dist.sample(rng));
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
  // Should be within 5 years of the true mean for this sample size
  assert.ok(Math.abs(mean - CDC_2024.M.mean) < 5, `mean ${mean.toFixed(1)} should be near ${CDC_2024.M.mean}`);
});

// ── MC-2 ──────────────────────────────────────────────────────────────────────

test('MC-2: seeded RNG reproduces the same draw', () => {
  const dist = new ActuarialLifespanDistribution({ table: CDC_2024, sex: 'M', currentAge: 0 });
  const rng1 = makeSeededRng(7);
  const rng2 = makeSeededRng(7);
  const s1 = dist.sample(rng1);
  const s2 = dist.sample(rng2);
  assert.strictEqual(s1, s2, 'same seed must produce same draw');
});

// ── MC-3 ──────────────────────────────────────────────────────────────────────

test('MC-3: sampled lifespan always exceeds currentAge (clamp)', () => {
  const currentAge = 70;
  const dist = new ActuarialLifespanDistribution({ table: CDC_2024, sex: 'M', currentAge });
  const rng  = makeSeededRng(99);
  for (let i = 0; i < 500; i++) {
    const s = dist.sample(rng);
    assert.ok(s > currentAge, `draw ${s.toFixed(1)} must exceed currentAge ${currentAge}`);
  }
});

// ── MC-4 ──────────────────────────────────────────────────────────────────────

test('MC-4: lookupLifeTable returns correct table per residency', () => {
  assert.strictEqual(lookupLifeTable('US'),    CDC_2024, 'US → CDC_2024');
  assert.strictEqual(lookupLifeTable('AU'),   AU_2022,  'AU → AU_2022');
  assert.strictEqual(lookupLifeTable(),        CDC_2024, 'undefined → CDC_2024 fallback');
  assert.strictEqual(lookupLifeTable('OTHER'), CDC_2024, 'unknown → CDC_2024 fallback');
});

// ── MC-5 ──────────────────────────────────────────────────────────────────────

test('MC-5: buildMortalityMcConfigs emits one variable per person in params.people', async () => {
  // Dynamic import to avoid importing the whole mc-config in the test runner discovery pass
  const { IntlRetirementMcConfig } = await import('../../src/finance/monte-carlo/intl-retirement-mc-config.js');
  const params = {
    people: {
      primary: { name: 'Alice', residency: 'US',  sex: 'F', lifeExpectancy: 90, currentAge: 48 },
      spouse:  { name: 'Bob',   residency: 'AU', sex: 'M', lifeExpectancy: 90, currentAge: 43 },
    },
  };
  const cfg     = new IntlRetirementMcConfig();
  const allVars = cfg.buildVariables(params);
  const mortVars = allVars.filter(v => v.paramKey?.startsWith('people.'));

  assert.strictEqual(mortVars.length, 2, 'should emit two mortality variables');
  const primary = mortVars.find(v => v.paramKey === 'people.primary.lifeExpectancy');
  const spouse  = mortVars.find(v => v.paramKey === 'people.spouse.lifeExpectancy');
  assert.ok(primary, 'primary lifespan variable should exist');
  assert.ok(spouse,  'spouse lifespan variable should exist');
  assert.strictEqual(primary.type, DISTRIBUTION_TYPES.ACTUARIAL_LIFESPAN);
  assert.strictEqual(primary.enabled, false, 'disabled by default');
});

// ── MC-6 ──────────────────────────────────────────────────────────────────────

test('MC-6: female sex draws from table.F (higher mean than M for CDC_2024)', () => {
  const distM = new ActuarialLifespanDistribution({ table: CDC_2024, sex: 'M', currentAge: 0 });
  const distF = new ActuarialLifespanDistribution({ table: CDC_2024, sex: 'F', currentAge: 0 });
  const rng   = makeSeededRng(1);
  const samplesM = Array.from({ length: 500 }, () => distM.sample(rng));
  const rng2  = makeSeededRng(1);
  const samplesF = Array.from({ length: 500 }, () => distF.sample(rng2));
  const meanM = samplesM.reduce((s, v) => s + v, 0) / samplesM.length;
  const meanF = samplesF.reduce((s, v) => s + v, 0) / samplesF.length;
  assert.ok(meanF > meanM, `Female mean ${meanF.toFixed(1)} should exceed male mean ${meanM.toFixed(1)}`);
});
