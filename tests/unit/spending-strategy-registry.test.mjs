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
 * spending-strategy-registry.test.mjs
 *
 * Tests for design/26 §4.1 SPENDING_STRATEGY_REGISTRY.
 *
 *   - Registry has required keys
 *   - FIXED returns no reducers (InflationAdjustReducer wired by toolset)
 *   - REGIME_AWARE returns a RegimeAwareSpendingReducer
 *   - paramSchema entries carry expected fields
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { SPENDING_STRATEGY_REGISTRY } from '../../src/finance/spending/spending-strategy-registry.js';
import { RegimeAwareSpendingReducer } from '../../src/finance/spending/strategies/regime-aware-spending-reducer.js';
import { AgeBandedSpendingReducer, DEFAULT_AGE_BANDS } from '../../src/finance/spending/strategies/age-banded-spending-reducer.js';

const context = { parameters: {} };

test('SPEND-REG-1: registry exports FIXED and REGIME_AWARE keys', () => {
  assert.ok('FIXED' in SPENDING_STRATEGY_REGISTRY);
  assert.ok('REGIME_AWARE' in SPENDING_STRATEGY_REGISTRY);
});

test('SPEND-REG-2: FIXED.reducers returns empty array', () => {
  const reducers = SPENDING_STRATEGY_REGISTRY.FIXED.reducers(context);
  assert.ok(Array.isArray(reducers));
  assert.strictEqual(reducers.length, 0);
});

test('SPEND-REG-3: FIXED.paramSchema returns empty array', () => {
  const schema = SPENDING_STRATEGY_REGISTRY.FIXED.paramSchema();
  assert.ok(Array.isArray(schema));
  assert.strictEqual(schema.length, 0);
});

test('SPEND-REG-4: REGIME_AWARE.reducers returns one RegimeAwareSpendingReducer', () => {
  const reducers = SPENDING_STRATEGY_REGISTRY.REGIME_AWARE.reducers(context);
  assert.strictEqual(reducers.length, 1);
  assert.ok(reducers[0] instanceof RegimeAwareSpendingReducer);
});

test('SPEND-REG-5: REGIME_AWARE reducer uses default cutPct when not in params', () => {
  const reducers = SPENDING_STRATEGY_REGISTRY.REGIME_AWARE.reducers(context);
  assert.ok(Math.abs(reducers[0].regimeAwareCutPct - 0.15) < 1e-10);
});

test('SPEND-REG-6: REGIME_AWARE reducer respects regimeAwareCutPct from params', () => {
  const ctx = { parameters: { regimeAwareCutPct: 0.25 } };
  const reducers = SPENDING_STRATEGY_REGISTRY.REGIME_AWARE.reducers(ctx);
  assert.ok(Math.abs(reducers[0].regimeAwareCutPct - 0.25) < 1e-10);
});

test('SPEND-REG-7: REGIME_AWARE.paramSchema returns regimeAwareCutPct entry', () => {
  const schema = SPENDING_STRATEGY_REGISTRY.REGIME_AWARE.paramSchema();
  assert.strictEqual(schema.length, 1);
  assert.strictEqual(schema[0].key, 'regimeAwareCutPct');
  assert.strictEqual(schema[0].type, 'Number');
  assert.ok(Math.abs(schema[0].defaultValue - 0.15) < 1e-10);
});

test('SPEND-REG-9: AGE_BANDED.reducers returns one AgeBandedSpendingReducer with default bands', () => {
  const reducers = SPENDING_STRATEGY_REGISTRY.AGE_BANDED.reducers(context);
  assert.strictEqual(reducers.length, 1);
  assert.ok(reducers[0] instanceof AgeBandedSpendingReducer);
  assert.strictEqual(reducers[0].bands, DEFAULT_AGE_BANDS);
  assert.strictEqual(reducers[0].slice, 'discretionary');
});

test('SPEND-REG-10: AGE_BANDED respects spendingAgeBands and ageBandSpendingSlice params', () => {
  const bands = [{ startAge: 70, multiplier: 0.8, annualRealDrift: -0.02 }];
  const ctx = { parameters: { spendingAgeBands: bands, ageBandSpendingSlice: 'both' } };
  const reducers = SPENDING_STRATEGY_REGISTRY.AGE_BANDED.reducers(ctx);
  assert.strictEqual(reducers[0].bands, bands);
  assert.strictEqual(reducers[0].slice, 'both');
});

test('SPEND-REG-11: ageBandDeclineRate synthesizes a one-band glide anchored at retirement age', () => {
  const ctx = {
    parameters: { ageBandDeclineRate: -0.015 },
    people: [{ birthDate: new Date(Date.UTC(1960, 0, 1)), retirementDate: new Date(Date.UTC(2025, 0, 1)) }],
  };
  const reducers = SPENDING_STRATEGY_REGISTRY.AGE_BANDED.reducers(ctx);
  const bands = reducers[0].bands;
  assert.strictEqual(bands.length, 2);
  assert.strictEqual(bands[1].startAge, 65); // 2025 − 1960
  assert.ok(Math.abs(bands[1].annualRealDrift - (-0.015)) < 1e-12);
});

test('SPEND-REG-12: AGE_BANDED.paramSchema exposes the three knobs', () => {
  const schema = SPENDING_STRATEGY_REGISTRY.AGE_BANDED.paramSchema();
  const keys = schema.map(s => s.key);
  assert.ok(keys.includes('spendingAgeBands'));
  assert.ok(keys.includes('ageBandSpendingSlice'));
  assert.ok(keys.includes('ageBandDeclineRate'));
});

test('SPEND-REG-8: each entry exposes reducers and paramSchema', () => {
  for (const [key, entry] of Object.entries(SPENDING_STRATEGY_REGISTRY)) {
    assert.strictEqual(typeof entry.reducers, 'function',    `${key}.reducers must be a function`);
    assert.strictEqual(typeof entry.paramSchema, 'function', `${key}.paramSchema must be a function`);
  }
});
