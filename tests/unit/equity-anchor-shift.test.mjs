/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

// Design 98 M2 — `equityAnchorShift`, the ONE systematic draw on the equity return. It
// moves every market's total by the same amount (so the markets cannot cancel each other
// out, F3), reaches nothing that is not an equity market, and at its default of 0 is inert.

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { runGolden, normalizeState } from '../helpers/golden-harness.js';
import { MARKET_GROWTH_PARAMS }      from '../../src/scenarios/toolsets/economic-regimes-toolset.js';
import { DEFAULT_MC_VARIABLE_CONFIGS } from '../../src/finance/monte-carlo/intl-retirement-mc-config.js';
import { RATE_KEYS }                 from '../../src/finance/economic-regimes/rate-keys.js';

const SPEC = { name: 'equity-anchor-shift',
  simStart: new Date(Date.UTC(2026, 0, 1)), simEnd: new Date(Date.UTC(2028, 0, 1)) };
const withShift = shift => runGolden({ ...SPEC, mutateCfg: cfg => {
  if (shift != null) cfg.parameters.equityAnchorShift = shift;
} });

test('EAS-1: the shift moves every market total by the same amount, and gold not at all', () => {
  const base  = withShift(null).state.baseGrowthRates;
  const moved = withShift(0.02).state.baseGrowthRates;
  for (const m of MARKET_GROWTH_PARAMS) {
    assert.equal(+(moved[m.rateKey] - base[m.rateKey]).toFixed(12), 0.02, `${m.rateKey} shifts by the anchor`);
  }
  assert.equal(moved[RATE_KEYS.GOLD], base[RATE_KEYS.GOLD], 'gold is not an equity market');
  for (const [k, v] of Object.entries(base)) {
    if (!MARKET_GROWTH_PARAMS.some(m => m.rateKey === k)) assert.equal(moved[k], v, `${k} untouched`);
  }
});

test('EAS-2: at 0 the anchor is inert — byte-identical end state', () => {
  assert.deepEqual(normalizeState(withShift(0).state), normalizeState(withShift(null).state));
});

test('EAS-3: MC samples ONE equity axis by default, not the per-market totals', () => {
  const on = DEFAULT_MC_VARIABLE_CONFIGS.filter(c => c.enabled !== false).map(c => c.paramKey);
  assert.ok(on.includes('equityAnchorShift'));
  for (const m of MARKET_GROWTH_PARAMS) {
    assert.ok(!on.includes(m.key), `${m.key} off — drawn independently the markets cancel (F3)`);
  }
  const row = DEFAULT_MC_VARIABLE_CONFIGS.find(c => c.paramKey === 'equityAnchorShift');
  assert.equal(row.mean, 0);
  // Design 98 M3: estimation uncertainty only — the stochastic path carries the rest.
  assert.equal(row.stdDev, 0.015);
});
