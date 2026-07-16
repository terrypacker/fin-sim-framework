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
 * behavioral-registry.test.mjs
 *
 * Tests for design/29 §4 BEHAVIORAL_STRATEGY_REGISTRY scaffold (Increment 1).
 *
 *   - Registry has all 9 required keys
 *   - Each entry exposes handlers, reducers, paramSchema as functions
 *   - Selecting [] registers nothing (no handlers/reducers)
 *   - Selecting a key returns that strategy's arrays
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { BEHAVIORAL_STRATEGY_REGISTRY } from '../../src/finance/behavioral/behavioral-strategy-registry.js';
import { REGIME_TAG }                   from '../../src/finance/economic-regimes/regime-tag.js';

const EXPECTED_KEYS = [
  'PANIC_SELL',
  'CONTRIBUTION_SUSPENSION',
  'TAX_LOSS_HARVEST',
  'STRATEGIC_ASSET_LOCATION',
  'OPPORTUNISTIC_REBALANCE',
  'DOWNTURN_ROTH_CONVERSION',
  'CASH_BUCKET_DRAWDOWN',
  'TAX_GAIN_HARVEST',
  'TARGET_ALLOCATION',
];

const context = { parameters: {} };

test('BEH-REG-1: registry exports all 9 required strategy keys', () => {
  for (const key of EXPECTED_KEYS) {
    assert.ok(key in BEHAVIORAL_STRATEGY_REGISTRY, `missing key: ${key}`);
  }
});

test('BEH-REG-2: each entry exposes handlers, reducers, paramSchema as functions', () => {
  for (const [key, entry] of Object.entries(BEHAVIORAL_STRATEGY_REGISTRY)) {
    assert.strictEqual(typeof entry.handlers,    'function', `${key}.handlers must be a function`);
    assert.strictEqual(typeof entry.reducers,    'function', `${key}.reducers must be a function`);
    assert.strictEqual(typeof entry.paramSchema, 'function', `${key}.paramSchema must be a function`);
  }
});

test('BEH-REG-3: selecting [] (empty strategies) registers nothing', () => {
  const selected = [];
  const handlers = selected.flatMap(k => BEHAVIORAL_STRATEGY_REGISTRY[k].handlers(context));
  const reducers = selected.flatMap(k => BEHAVIORAL_STRATEGY_REGISTRY[k].reducers(context));
  assert.strictEqual(handlers.length, 0);
  assert.strictEqual(reducers.length, 0);
});

test('BEH-REG-4: each entry returns arrays from handlers and reducers', () => {
  for (const [key, entry] of Object.entries(BEHAVIORAL_STRATEGY_REGISTRY)) {
    const h = entry.handlers(context);
    const r = entry.reducers(context);
    const s = entry.paramSchema();
    assert.ok(Array.isArray(h), `${key}.handlers must return Array`);
    assert.ok(Array.isArray(r), `${key}.reducers must return Array`);
    assert.ok(Array.isArray(s), `${key}.paramSchema must return Array`);
  }
});

test('BEH-REG-5: REGIME_TAG includes PANIC_SELL_TRIGGER', () => {
  assert.strictEqual(REGIME_TAG.PANIC_SELL_TRIGGER, 'PANIC_SELL_TRIGGER');
});

test('BEH-REG-6: REGIME_TAG retains ECONOMIC_STRESS', () => {
  assert.strictEqual(REGIME_TAG.ECONOMIC_STRESS, 'ECONOMIC_STRESS');
});
