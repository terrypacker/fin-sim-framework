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
 * Feasibility-first solvency ranking (design/80 U2).
 *
 * The controller was observed committing plans its own rollout flagged
 * `scenarioFailed`, five epochs running (design/80 §2.7). The scalar objective
 * prices ruin as `μ · deficit` — one term among three — so a candidate can buy its
 * way past insolvency with enough consumption reward. These tests pin the
 * structural guarantee that replaces that numeric race:
 *
 *   · every solvent candidate outranks every insolvent one, at any μ;
 *   · insolvent candidates stay ORDERED by least shortfall, so a solver keeps a
 *     gradient back toward feasibility when the whole range is under water;
 *   · the flag is opt-in — the default score path is untouched.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { OptimizationProblem } from '../../src/finance/optimization/optimization-problem.js';
import { OPTIMIZATION_OBJECTIVES, infeasibilityOf, isFeasibleResult,
         windowedDeficit, INFEASIBLE_OFFSET }
  from '../../src/finance/optimization/optimization-objectives.js';

/** A problem whose rollout is stubbed, so these are pure scoring tests. */
function problemWith(result, { feasibilityFirst = false, snapshot = null } = {}) {
  const p = new OptimizationProblem({
    variables: [],
    objective: OPTIMIZATION_OBJECTIVES.DIE_WITH_TARGET_LIQUID,
    feasibilityFirst,
    initialState: snapshot ? { kind: 'snapshot', snapshot } : { kind: 'compile', cfgTemplate: null },
  });
  p._rolloutResult = () => result;
  return p;
}

/** A rollout result in the shape `_readResult` produces. */
const mkResult = ({ liquidity = 0, deficit = 0, failed = false, consumption = 0 }) => ({
  finalNetLiquidity:   liquidity,
  lifetimeConsumption: consumption,
  cumulativeDeficit:   deficit,
  scenarioFailed:      failed,
  terminalPriceLevel:  1,
  terminalWealthTarget: 0,
});

describe('infeasibilityOf / isFeasibleResult', () => {
  test('a solvent rollout is feasible', () => {
    const r = mkResult({ liquidity: 500_000 });
    assert.equal(infeasibilityOf(r, null), 0);
    assert.equal(isFeasibleResult(r, null), true);
  });

  test('a deficit is the infeasibility magnitude', () => {
    assert.equal(infeasibilityOf(mkResult({ deficit: 645_626 }), null), 645_626);
  });

  test('scenarioFailed with no accrued deficit is still infeasible', () => {
    // A plan can trip the flag on the final step before shortfall accumulates.
    // Treating that as feasible is how a ruined plan slips through.
    const r = mkResult({ failed: true, deficit: 0 });
    assert.ok(infeasibilityOf(r, null) > 0);
    assert.equal(isFeasibleResult(r, null), false);
  });

  test('deficit is windowed against the snapshot accumulator', () => {
    // Deficit already accrued in the realized past belongs to the past, not to the
    // candidate being scored.
    const snapshot = { state: { cumulativeDeficit: 1_000 } };
    assert.equal(windowedDeficit(mkResult({ deficit: 1_000 }), snapshot), 0);
    assert.equal(windowedDeficit(mkResult({ deficit: 1_600 }), snapshot), 600);
  });
});

describe('feasibilityFirst ranking', () => {
  test('off by default — the plain objective score is unchanged', () => {
    const r = mkResult({ deficit: 645_626, consumption: 1_829_677 });
    const plain = problemWith(r).evaluate({}).score;
    // μ·deficit dominates, so the score is deeply negative — but FINITE and not
    // offset. This is the pre-design-80 behaviour and must be byte-identical.
    assert.ok(plain < 0);
    assert.ok(plain > -INFEASIBLE_OFFSET);
  });

  test('a solvent candidate outranks an insolvent one that consumes far more', () => {
    // The observed failure shape: more consumption, ruin accepted as its price.
    const solvent  = problemWith(mkResult({ liquidity: 169_963, consumption: 1_715_322 }),
      { feasibilityFirst: true }).evaluate({}).score;
    const ruinous  = problemWith(mkResult({ deficit: 645_626, consumption: 1_829_677 }),
      { feasibilityFirst: true }).evaluate({}).score;
    assert.ok(solvent > ruinous, `expected solvent ${solvent} > ruinous ${ruinous}`);
    assert.ok(ruinous < -INFEASIBLE_OFFSET);
  });

  test('the guarantee holds even when μ is set to zero', () => {
    // The point of a STRUCTURAL guard: it cannot be defeated by mis-calibration.
    // With μ=0 the plain objective would happily prefer the ruinous plan, because
    // λ is capped at λ·target and here target is 0 — nothing else opposes it.
    const mk = (res) => {
      const p = problemWith({ ...res, deficitPenalty: 0 }, { feasibilityFirst: true });
      return p.evaluate({}).score;
    };
    const solvent = mk(mkResult({ liquidity: 169_963, consumption: 1_715_322 }));
    const ruinous = mk(mkResult({ deficit: 645_626, consumption: 1_829_677 }));
    assert.ok(solvent > ruinous, 'feasibility must not depend on the deficit penalty weight');
  });

  test('insolvent candidates stay ordered by least shortfall', () => {
    // Without this a solver has no gradient when every candidate is under water —
    // the real case when a lever RANGE floor sits above the affordable level.
    const mild   = problemWith(mkResult({ deficit: 645_626 }),   { feasibilityFirst: true }).evaluate({}).score;
    const severe = problemWith(mkResult({ deficit: 3_612_628 }), { feasibilityFirst: true }).evaluate({}).score;
    assert.ok(mild > severe, `least-bad must rank higher: ${mild} vs ${severe}`);
  });

  test('scores stay finite so CEM can refit its elite distribution', () => {
    // -Infinity would poison the Gaussian mean/σ update, which is why the offset
    // is a large finite constant rather than the obvious sentinel.
    const s = problemWith(mkResult({ deficit: 3_612_628 }), { feasibilityFirst: true }).evaluate({}).score;
    assert.ok(Number.isFinite(s));
  });

  test('feasible scores are untouched by the flag', () => {
    const r = mkResult({ liquidity: 169_963, consumption: 1_715_322 });
    assert.equal(
      problemWith(r, { feasibilityFirst: true }).evaluate({}).score,
      problemWith(r, { feasibilityFirst: false }).evaluate({}).score);
  });
});
