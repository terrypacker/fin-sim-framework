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
 * evt-target-allocation.test.mjs — design 61 Phase 1 (Lever A).
 *
 * The searchable static holding-allocation mix. Covers:
 *   - stick-breaking synthesis always lands on the simplex (Σ=1), no scale-degeneracy;
 *   - named presets round-trip through allocWeightsFromMix → synthesizeTargetAllocation;
 *   - a shifted weight measurably changes the applied mix;
 *   - the TARGET_ALLOCATION registry entry feeds the synthesized continuous target to
 *     the rebalancer under OPTIMIZED, and the Object param under STATIC;
 *   - the schema exposes one axis per non-residual class, gated on OPTIMIZED.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import {
  ALLOC_WEIGHT_CLASSES, ALLOCATION_PRESETS, ALLOCATION_OPTIMIZED_MODE,
  allocWeightKey, synthesizeTargetAllocation, allocWeightsFromMix,
  allocWeightsFromPreset, buildAllocWeightSchema, DEFAULT_ALLOC_WEIGHT_PARAMS,
  presentAllocations,
} from '../../src/scenarios/intl-retirement-scenario.js';
import { BEHAVIORAL_STRATEGY_REGISTRY } from '../../src/finance/behavioral/behavioral-strategy-registry.js';
import { ACCOUNT_ROLES } from '../../src/finance/state/account-roles.js';
import { ALLOCATION }    from '../../src/finance/holdings/allocation.js';

const sum = o => Object.values(o).reduce((s, v) => s + v, 0);
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

// ── Synthesis: always on the simplex ───────────────────────────────────────────

test('ALLOC-1: synthesizeTargetAllocation sums to 1 for arbitrary weights (no degenerate ray)', () => {
  const cases = [
    { [allocWeightKey('EQUITY')]: 0.7, [allocWeightKey('BOND')]: 0.9, [allocWeightKey('CASH')]: 0.3 },
    { [allocWeightKey('EQUITY')]: 0,   [allocWeightKey('BOND')]: 0,   [allocWeightKey('CASH')]: 0 },
    { [allocWeightKey('EQUITY')]: 1,   [allocWeightKey('BOND')]: 1,   [allocWeightKey('CASH')]: 1 },
    {},   // all default → the 60/40
  ];
  for (const p of cases) {
    const mix = synthesizeTargetAllocation(p);
    assert.ok(near(sum(mix), 1), `mix must sum to 1, got ${sum(mix)} for ${JSON.stringify(p)}`);
    for (const [cls, frac] of Object.entries(mix)) {
      assert.ok(frac >= 0 && frac <= 1, `share for ${cls} out of [0,1]: ${frac}`);
    }
  }
});

test('ALLOC-2: scale-invariance is broken — w and 2w give different mixes', () => {
  // A naive normalize-by-sum would map w and 2w to the SAME mix (the phantom ray).
  // Stick-breaking treats each weight as a fraction of the remaining stick, so
  // doubling the (clamped) weights changes the outcome.
  const w  = { [allocWeightKey('EQUITY')]: 0.3, [allocWeightKey('BOND')]: 0.3, [allocWeightKey('CASH')]: 0.3 };
  const w2 = { [allocWeightKey('EQUITY')]: 0.6, [allocWeightKey('BOND')]: 0.6, [allocWeightKey('CASH')]: 0.6 };
  assert.notDeepStrictEqual(synthesizeTargetAllocation(w), synthesizeTargetAllocation(w2));
});

// ── Presets round-trip ─────────────────────────────────────────────────────────

test('ALLOC-3: every named preset round-trips through weights → synthesized mix', () => {
  for (const [name, mix] of Object.entries(ALLOCATION_PRESETS)) {
    const params = allocWeightsFromPreset(name);
    const got    = synthesizeTargetAllocation(params);
    for (const cls of ALLOC_WEIGHT_CLASSES) {
      assert.ok(near(got[cls] ?? 0, mix[cls] ?? 0),
        `${name}.${cls}: expected ${mix[cls]}, got ${got[cls]}`);
    }
  }
});

test('ALLOC-4: default weight params reproduce the 60/40 default mix', () => {
  const mix = synthesizeTargetAllocation(DEFAULT_ALLOC_WEIGHT_PARAMS);
  assert.ok(near(mix[ALLOCATION.EQUITY], 0.60));
  assert.ok(near(mix[ALLOCATION.BOND],   0.40));
  assert.ok(near(mix[ALLOCATION.CASH],   0));
  assert.ok(near(mix[ALLOCATION.GOLD],   0));
});

test('ALLOC-5: a shifted weight measurably changes the mix', () => {
  const base    = synthesizeTargetAllocation(allocWeightsFromMix(ALLOCATION_PRESETS.SIXTY_FORTY));
  const shifted = synthesizeTargetAllocation({
    ...allocWeightsFromMix(ALLOCATION_PRESETS.SIXTY_FORTY),
    [allocWeightKey('EQUITY')]: 0.30,   // dial equity down
  });
  assert.ok(shifted[ALLOCATION.EQUITY] < base[ALLOCATION.EQUITY],
    'lowering the equity weight must lower the equity share');
  assert.ok(near(sum(shifted), 1));
});

// ── Registry wiring: OPTIMIZED synthesizes; STATIC uses the Object param ─────────

const ACCOUNTS = [
  { stateKey: 'iraAccount',    role: ACCOUNT_ROLES.IRA },
  { stateKey: 'rothAccount',   role: ACCOUNT_ROLES.ROTH },
  { stateKey: 'usStockAccount', role: ACCOUNT_ROLES.US_STOCK },  // taxable brokerage
  { stateKey: 'usSavings',     role: ACCOUNT_ROLES.US_SAVINGS }, // neither — excluded
];

function targetFromReducers(parameters) {
  const reducers = BEHAVIORAL_STRATEGY_REGISTRY.TARGET_ALLOCATION.reducers({
    parameters, accounts: ACCOUNTS,
  });
  // First reducer is the RebalanceToTargetReducer carrying the target.
  return reducers[0].targetAllocation;
}

test('ALLOC-6: OPTIMIZED drives the rebalancer target from the synthesized continuous mix', () => {
  const parameters = {
    allocationStrategy: ALLOCATION_OPTIMIZED_MODE,
    ...allocWeightsFromPreset('ALL_WEATHER'),
  };
  const target = targetFromReducers(parameters);
  const expect = synthesizeTargetAllocation(parameters, presentAllocations(ACCOUNTS));
  assert.deepStrictEqual(target, expect);
  assert.ok(near(sum(target), 1));
});

test('ALLOC-7: STATIC falls back to the Object rebalanceTargetAllocation param', () => {
  // Must be a TOTAL mix now (design 61 §12.2 Q3) — every allocation named explicitly.
  const obj = { EQUITY: 0.5, BOND: 0.5, CASH: 0, GOLD: 0 };
  const target = targetFromReducers({ allocationStrategy: 'STATIC', rebalanceTargetAllocation: obj });
  assert.deepStrictEqual(target, obj);
});

test('ALLOC-7b: an authored mix that is PARTIAL or does not sum to 1 is rejected at compile', () => {
  // Design 61 §12.2 Q3. A partial mix is indistinguishable from deliberate zeros, and a
  // silently rescaled sum is how an authored 0.75/0.25/0/0.25 became an executed
  // 0.6/0.2/0/0.2. Both are now loud errors at the param boundary, with no shim.
  assert.throws(
    () => targetFromReducers({ allocationStrategy: 'STATIC', rebalanceTargetAllocation: { EQUITY: 0.6, BOND: 0.4 } }),
    /must name EVERY allocation explicitly — missing CASH, GOLD/);

  assert.throws(
    () => targetFromReducers({ allocationStrategy: 'STATIC',
      rebalanceTargetAllocation: { EQUITY: 0.75, BOND: 0.25, CASH: 0, GOLD: 0.25 } }),
    /must sum to 1, got 1\.250000/);

  assert.throws(
    () => targetFromReducers({ allocationStrategy: 'STATIC',
      rebalanceTargetAllocation: { EQUITY: 1, BOND: 0, CASH: 0, GOLD: 0, SILVER: 0 } }),
    /unknown allocation "SILVER"/);
});

test('ALLOC-7c: a glidepath anchor is validated per anchor, and named in the error', () => {
  // The real-world failure: a 39-anchor glidepath baked before GOLD existed, where one
  // anchor silently targeted gold at 0% and the next rebalance liquidated it.
  assert.throws(
    () => targetFromReducers({
      allocationStrategy: 'STATIC',
      allocationSchedule: 'GLIDEPATH',
      allocationGlidepath: [
        { age: 47, weights: { EQUITY: 0.76, BOND: 0.12, CASH: 0, GOLD: 0.12 } },   // fine
        { age: 53, weights: { EQUITY: 1,    BOND: 0,    CASH: 0 } },               // missing GOLD
      ],
    }),
    /allocationGlidepath\[1\] \(age 53\).*missing GOLD/s);
});

test('ALLOC-7d: a regime-target map is validated per tag', () => {
  assert.throws(
    () => targetFromReducers({
      allocationStrategy: 'STATIC',
      allocationSchedule: 'REGIME_CONDITIONED',
      allocationRegimeTargets: { NORMAL: { EQUITY: 0.6, BOND: 0.4, CASH: 0, GOLD: 0 },
                                 ECONOMIC_STRESS: { EQUITY: 0.3, BOND: 0.3, CASH: 0.2 } },
    }),
    /allocationRegimeTargets\["ECONOMIC_STRESS"\].*missing GOLD/s);
});

test('ALLOC-8: tax-advantaged AND taxable accounts are rebalanced; cash excluded (Phase 2)', () => {
  const reducers = BEHAVIORAL_STRATEGY_REGISTRY.TARGET_ALLOCATION.reducers({
    parameters: { allocationStrategy: ALLOCATION_OPTIMIZED_MODE }, accounts: ACCOUNTS,
  });
  const keys = reducers[0].accounts.map(a => a.stateKey).sort();
  assert.deepStrictEqual(keys, ['iraAccount', 'rothAccount', 'usStockAccount']);
  // Split drift bands wired (taxable wide, sheltered tight).
  assert.strictEqual(reducers[0].driftBandTaxable, 0.10);
  assert.strictEqual(reducers[0].driftBandSheltered, 0.02);
});

// ── Schema shape ────────────────────────────────────────────────────────────────

test('ALLOC-9: schema exposes one axis per non-residual class, gated on OPTIMIZED', () => {
  const schema = buildAllocWeightSchema();
  const keys   = schema.map(s => s.key);
  // K−1 axes: the last class (GOLD) is the stick-breaking residual, no param.
  assert.deepStrictEqual(keys, ALLOC_WEIGHT_CLASSES.slice(0, -1).map(allocWeightKey));
  for (const s of schema) {
    assert.strictEqual(s.type, 'Number');
    assert.strictEqual(s.opt, true);
    // Compound gate (Phase-4 leak fix): the lever must be selected AND OPTIMIZED.
    assert.deepStrictEqual(s.visibleWhen, [
      { param: 'behavioralStrategies', includes: 'TARGET_ALLOCATION' },
      { param: 'allocationStrategy',   equals:   ALLOCATION_OPTIMIZED_MODE },
    ]);
  }
});

test('ALLOC-10: paramSchema exposes allocationStrategy gated on the TARGET_ALLOCATION strategy', () => {
  const schema = BEHAVIORAL_STRATEGY_REGISTRY.TARGET_ALLOCATION.paramSchema();
  const strat  = schema.find(s => s.key === 'allocationStrategy');
  assert.ok(strat, 'allocationStrategy param present');
  assert.deepStrictEqual(strat.options, ['STATIC', ALLOCATION_OPTIMIZED_MODE]);
  assert.deepStrictEqual(strat.visibleWhen, { param: 'behavioralStrategies', includes: 'TARGET_ALLOCATION' });
});
