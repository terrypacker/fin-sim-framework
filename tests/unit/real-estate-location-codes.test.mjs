/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { resolvePropertyRateKey } from '../../src/scenarios/toolsets/economic-regimes-toolset.js';
import { RATE_KEYS }              from '../../src/finance/economic-regimes/rate-keys.js';
import { RealProperty }           from '../../src/finance/assets/real-property.js';
import { Collectible }            from '../../src/finance/assets/collectible.js';

// ─── resolvePropertyRateKey ───────────────────────────────────────────────────

describe('resolvePropertyRateKey', () => {
  test('US property with no market → REAL_ESTATE_US', () => {
    const p = new RealProperty(500_000, { country: 'US', market: null });
    assert.equal(resolvePropertyRateKey(p), RATE_KEYS.REAL_ESTATE_US);
  });

  test('AU property with no market → REAL_ESTATE_AU', () => {
    const p = new RealProperty(500_000, { country: 'AU', market: null });
    assert.equal(resolvePropertyRateKey(p), RATE_KEYS.REAL_ESTATE_AU);
  });

  test('US property with market code → REAL_ESTATE_{market}', () => {
    const p = new RealProperty(1_000_000, { country: 'US', market: 'US-SF-BAY' });
    assert.equal(resolvePropertyRateKey(p), 'REAL_ESTATE_US-SF-BAY');
  });

  test('AU property with market code → REAL_ESTATE_{market}', () => {
    const p = new RealProperty(800_000, { country: 'AU', market: 'AU-NSW-SYD' });
    assert.equal(resolvePropertyRateKey(p), 'REAL_ESTATE_AU-NSW-SYD');
  });

  test('collectible → RATE_KEYS.COLLECTIBLE', () => {
    const c = new Collectible(10_000, { country: 'US' });
    assert.equal(resolvePropertyRateKey(c), RATE_KEYS.COLLECTIBLE);
  });
});

// ─── Regional shock only affects matching market properties ───────────────────

describe('regional shock targets only matching market', () => {
  test('SF_BAY_HOUSING_CRASH maps to REAL_ESTATE_US-SF-BAY rate key', () => {
    const sfProp  = new RealProperty(1_000_000, { country: 'US', market: 'US-SF-BAY' });
    const usProp  = new RealProperty(500_000,   { country: 'US', market: null });
    const auProp  = new RealProperty(600_000,   { country: 'AU', market: null });

    assert.equal(resolvePropertyRateKey(sfProp),  'REAL_ESTATE_US-SF-BAY');
    assert.equal(resolvePropertyRateKey(usProp),  RATE_KEYS.REAL_ESTATE_US);
    assert.equal(resolvePropertyRateKey(auProp),  RATE_KEYS.REAL_ESTATE_AU);

    // A shock on 'REAL_ESTATE_US-SF-BAY' should not match country-level keys
    assert.notEqual(resolvePropertyRateKey(sfProp), RATE_KEYS.REAL_ESTATE_US);
    assert.notEqual(resolvePropertyRateKey(sfProp), RATE_KEYS.REAL_ESTATE_AU);
    assert.notEqual(resolvePropertyRateKey(usProp), 'REAL_ESTATE_US-SF-BAY');
  });

  test('RealProperty.market field round-trips via constructor', () => {
    const p = new RealProperty(500_000, { country: 'US', market: 'US-SF-BAY' });
    assert.equal(p.market, 'US-SF-BAY');
  });

  test('RealProperty with no market defaults to null', () => {
    const p = new RealProperty(500_000, { country: 'US' });
    assert.equal(p.market, null);
  });
});
