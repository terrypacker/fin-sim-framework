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
import assert from 'node:assert/strict';

import { OPTIMIZATION_OBJECTIVES, DEFAULT_TERMINAL_WEALTH_PENALTY }
  from '../../src/finance/optimization/optimization-objectives.js';
import { OptimizationProblem } from '../../src/finance/optimization/optimization-problem.js';

const { DIE_WITH_TARGET, MIN_LIFETIME_TAXES, MAX_NET_WORTH } = OPTIMIZATION_OBJECTIVES;

// ─── DIE_WITH_TARGET ──────────────────────────────────────────────────────────

describe('DIE_WITH_TARGET objective', () => {
  test('is a maximize objective', () => {
    assert.strictEqual(DIE_WITH_TARGET.direction, 'maximize');
  });

  test('penalty is two-sided (over- and under-shooting the target cost equally)', () => {
    const base = { lifetimeConsumption: 1_000_000, terminalWealthTarget: 500_000, terminalWealthTargetPenalty: 10 };
    const over  = DIE_WITH_TARGET.evaluate({ ...base, finalNetWorthUsd: 600_000 });
    const under = DIE_WITH_TARGET.evaluate({ ...base, finalNetWorthUsd: 400_000 });
    assert.strictEqual(over, under);
    assert.strictEqual(over, 1_000_000 - 10 * 100_000);
  });

  test('a large penalty makes the target binding (hitting it beats more consumption off-target)', () => {
    const onTarget  = DIE_WITH_TARGET.evaluate({
      lifetimeConsumption: 1_000_000, finalNetWorthUsd: 0, terminalWealthTarget: 0, terminalWealthTargetPenalty: 10 });
    const offTarget = DIE_WITH_TARGET.evaluate({
      lifetimeConsumption: 1_100_000, finalNetWorthUsd: 50_000, terminalWealthTarget: 0, terminalWealthTargetPenalty: 10 });
    assert.ok(onTarget > offTarget, `${onTarget} should beat ${offTarget}`);
  });

  test('falls back to the default penalty weight when unset', () => {
    const score = DIE_WITH_TARGET.evaluate({
      lifetimeConsumption: 0, finalNetWorthUsd: 100, terminalWealthTarget: 0 });
    assert.strictEqual(score, -DEFAULT_TERMINAL_WEALTH_PENALTY * 100);
  });

  test('windowed: subtracts the snapshot consumption (MPC horizon)', () => {
    const result   = { lifetimeConsumption: 1_000_000, finalNetWorthUsd: 0, terminalWealthTarget: 0, terminalWealthTargetPenalty: 10 };
    const snapshot = { state: { cumulativeConsumption: 200_000 } };
    assert.strictEqual(DIE_WITH_TARGET.evaluate(result, { snapshot }), 800_000);
  });
});

// ─── MIN_LIFETIME_TAXES ───────────────────────────────────────────────────────

describe('MIN_LIFETIME_TAXES objective', () => {
  test('is a minimize objective reading cumulativeTaxesPaid', () => {
    assert.strictEqual(MIN_LIFETIME_TAXES.direction, 'minimize');
    assert.strictEqual(MIN_LIFETIME_TAXES.evaluate({ cumulativeTaxesPaid: 50_000 }), 50_000);
  });

  test('windowed: taxes within the window are terminal − snapshot accumulator', () => {
    const result   = { cumulativeTaxesPaid: 50_000 };
    const snapshot = { state: { cumulativeTaxesPaid: 20_000 } };
    assert.strictEqual(MIN_LIFETIME_TAXES.evaluate(result, { snapshot }), 30_000);
  });
});

// ─── Terminal objectives keep the pure single-arg shape ──────────────────────

describe('terminal objectives', () => {
  test('MAX_NET_WORTH ignores the snapshot argument', () => {
    assert.strictEqual(MAX_NET_WORTH.evaluate({ finalNetWorthUsd: 123 }), 123);
    assert.strictEqual(MAX_NET_WORTH.evaluate({ finalNetWorthUsd: 123 }, { snapshot: { state: {} } }), 123);
  });
});

// ─── Integration: accumulators are wired and scored ──────────────────────────

describe('lifetime accumulators in a real rollout', () => {
  test('evaluate() surfaces positive lifetime taxes and consumption', () => {
    const problem = new OptimizationProblem({
      variables: [],
      objective: MIN_LIFETIME_TAXES,
      simStart: new Date(Date.UTC(2026, 0, 1)),
      simEnd:   new Date(Date.UTC(2031, 0, 1)),
    });
    const { result } = problem.evaluate({});
    assert.ok(result.lifetimeConsumption > 0, 'expenses should accumulate consumption');
    assert.ok(result.cumulativeTaxesPaid >= 0 && Number.isFinite(result.cumulativeTaxesPaid));
  });
});
