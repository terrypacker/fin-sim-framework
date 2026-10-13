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
 * evt-shock-severity-scope.test.mjs — severity scales only what it measures (design 121 §7).
 *
 * `severity` is the trough depth of the EQUITY decline, so a sweep scales the equity level
 * break and every equity `returnAdjustment`, and nothing else.
 *
 * SEV-1  every preset: equity keys scale by target ÷ headline; fixed income, gold and every
 *        other key keep the preset's value
 * SEV-2  a rates leg's fixed-income returnAdjustment still equals its interestRateAdjustment
 *        after a sweep — the pair no longer drifts apart
 * SEV-3  at the preset's own severity, nothing moves
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applySeverity }  from '../../src/scenarios/toolsets/economic-regimes-toolset.js';
import { SHOCK_LIBRARY }  from '../../src/finance/economic-shocks/shock-library.js';
import { EQUITY_SLEEVES } from '../../src/finance/economic-regimes/rate-keys.js';

const RATED = Object.entries(SHOCK_LIBRARY).filter(([, s]) => s.severity);
const legsOf = (s) => s.legs ?? [{ id: '-', regime: s.regime }];

test('SEV-1: a sweep scales equity keys and leaves every other key at the preset value', () => {
  for (const [id, preset] of RATED) {
    const target = preset.severity * 1.5;
    const k = target / preset.severity;
    const swept = applySeverity(preset, target);
    legsOf(preset).forEach((leg, i) => {
      const before = leg.regime?.returnAdjustment ?? {};
      const after  = legsOf(swept)[i].regime?.returnAdjustment ?? {};
      for (const [rk, v] of Object.entries(before)) {
        const expected = EQUITY_SLEEVES.includes(rk) ? v * k : v;
        assert.ok(Math.abs(after[rk] - expected) < 1e-12,
          `${id}.${leg.id}.${rk}: expected ${expected}, got ${after[rk]}`);
      }
    });
  }
});

test('SEV-2: fixed-income return and rate adjustments stay paired under a sweep', () => {
  let pairs = 0;
  for (const [id, preset] of RATED) {
    for (const leg of legsOf(applySeverity(preset, preset.severity * 0.5))) {
      const ira = leg.regime?.interestRateAdjustment ?? {};
      for (const [rk, v] of Object.entries(ira)) {
        if (!rk.startsWith('FIXED_INCOME_') || leg.regime.returnAdjustment?.[rk] == null) continue;
        assert.equal(leg.regime.returnAdjustment[rk], v, `${id}.${leg.id}.${rk}`);
        pairs++;
      }
    }
  }
  assert.ok(pairs >= 7, `the library's rates legs must be exercised, saw ${pairs} pairs`);
});

test('SEV-3: at its own severity a preset is unchanged', () => {
  for (const [id, preset] of RATED) {
    const swept = applySeverity(preset, preset.severity);
    assert.deepEqual(legsOf(swept).map(l => l.regime ?? null), legsOf(preset).map(l => l.regime ?? null), id);
    assert.deepEqual(swept.levelEffects, preset.levelEffects, id);
  }
});
