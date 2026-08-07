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
 * control-scope.test.mjs — design 88 §5 / D10: a controller must not be pointed at a
 * quantity it has no lever for.
 *
 * The MPC/OPT lever set acts on the spending rate and on drawdown-eligible balances.
 * It cannot sell a house, find a buyer for a private stake, or unlock super early. So
 * terminal NET WORTH contains a component `U` that no admissible policy can move, and
 * anchoring a die-with-target goal on it is not merely imprecise — it changes the shape
 * of the objective:
 *
 *   • the terminal term is `λ·|terminal − target|`, whose whole purpose is the
 *     TWO-SIDED penalty that produces an interior optimum;
 *   • terminal worth = U + L(policy), so if `U > target` then `terminal − target > 0`
 *     for EVERY policy — the kink is unreachable, the absolute value collapses to a
 *     linear term, and the best response is to drive the reachable pool L toward zero.
 *
 * "Die with $X" silently becomes "die with nothing you can spend". These tests pin the
 * mechanism (not just the default value) so a future reader who flips the default back
 * has to delete an explanation rather than change a constant.
 *
 * Measured on the reference plan (2026-08-07, 2026→2060, EXPLICIT_BANDS spending):
 *   U_real ≈ $2.38M · real worth floor $5.08M · real liquid floor $2.69M
 *   target $5.0M real → worth scope commits $12,000/mo and lands liquidity at $2.69M;
 *                       liquid scope commits  $4,773/mo and lands liquidity at $4.99M.
 * A $7,227/mo difference in the advice, from the choice of measure alone.
 */

import { test }   from 'node:test';
import assert     from 'node:assert/strict';

import { OPTIMIZATION_OBJECTIVES, resolveTerminalKey, DIE_WITH_TARGET_AXES }
  from '../../src/finance/optimization/optimization-objectives.js';
import { CockpitController } from '../../src/finance/mpc/cockpit-controller.js';

/**
 * A synthetic rollout: spending `spend` leaves `liquid` of reachable wealth, on top of
 * an un-leverable `U` the controller cannot touch. Consumption is what was spent.
 */
function rollout({ spend, liquid, U, target }) {
  return {
    lifetimeConsumption:         spend,
    finalNetLiquidity:           liquid,
    finalNetWorthUsd:            liquid + U,
    terminalWealthTarget:        target,
    terminalWealthTargetPenalty: 10,
    terminalPriceLevel:          1,
  };
}

/** argmax of an objective over a candidate sweep. */
function best(objective, candidates) {
  return candidates.reduce((b, c) =>
    (objective.evaluate(c.result) > objective.evaluate(b.result) ? c : b));
}

/**
 * The sweep: spending 1..5 burns reachable wealth 5..1. `U = 3` is un-leverable, so
 * terminal worth ranges over 8..4 and terminal liquidity over 5..1.
 */
function sweep(U, target) {
  return [1, 2, 3, 4, 5].map(spend => ({
    spend,
    result: rollout({ spend, liquid: 6 - spend, U, target }),
  }));
}

const WORTH  = OPTIMIZATION_OBJECTIVES.DIE_WITH_TARGET;
const LIQUID = OPTIMIZATION_OBJECTIVES.DIE_WITH_TARGET_LIQUID;

test('88 §5.2: with U above the target, the WORTH anchor loses its kink and corners the policy', () => {
  // target 2 < U 3 ⇒ terminal worth (4..8) can never reach it.
  const candidates = sweep(3, 2);
  const chosen = best(WORTH, candidates);
  assert.equal(chosen.spend, 5,
    'the worth-scoped goal should be pinned at the max-spend corner — the penalty is '
    + 'one-sided, so every extra dollar spent is a strict improvement');
  assert.equal(chosen.result.finalNetLiquidity, 1,
    'and it lands on the LOWEST reachable wealth available — "die with target" '
    + 'has become "die with as little spendable as the lever allows"');
});

test('88 §5.2 CONTROL: the same target under the LIQUID scope has an interior optimum', () => {
  // Same U, same target — only the measure changes. Terminal liquidity spans 1..5,
  // so the target of 2 IS reachable and the kink comes back.
  const candidates = sweep(3, 2);
  const chosen = best(LIQUID, candidates);
  assert.equal(chosen.result.finalNetLiquidity, 2, 'the liquid goal lands ON its target');
  assert.equal(chosen.spend, 4, 'which is an interior policy, not a corner');

  // The control that proves the two tests above are measuring the scope and not the
  // sweep: had the worth arm also been interior, the first test would pass for the
  // wrong reason.
  assert.notEqual(best(WORTH, candidates).spend, chosen.spend,
    'CONTROL FAILED: both scopes agree here, so neither test says anything about scope');
});

test('88 §5.2: the two scopes AGREE whenever the target is below both floors', () => {
  // A target under the liquid floor is unreachable in either scope, so both corner.
  // The flip is not a universal change of advice — it changes the advice exactly in
  // the band of targets that only the liquid scope can serve, and that band is U wide.
  const candidates = sweep(3, 0);
  assert.equal(best(WORTH, candidates).spend, best(LIQUID, candidates).spend);
});

test('88 D10: the default terminal scope is liquid, everywhere it is resolved', () => {
  assert.equal(resolveTerminalKey({}), 'liquid');
  assert.equal(DIE_WITH_TARGET_AXES.scope[0].value, 'liquid',
    'the FIRST axis option is what an untouched UI select shows — this ordering is '
    + 'the default scope for every goal the cockpit and OPT panels build');

  const c = new CockpitController({
    simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd:   new Date(Date.UTC(2030, 0, 1)),
  });
  assert.equal(c.objective, LIQUID,
    'the MPC cockpit defaulted to the worth-scoped variant for its whole life, while '
    + 'a comment three files away recommended the liquid one (design 88 §5.4)');
});

test('88 D10: the worth-scoped variants still exist, for reporting comparisons', () => {
  // The flip is a change of DEFAULT, not a removal: "what does this plan look like on
  // a net-worth basis?" is a legitimate reporting question (D7/OQ6).
  assert.ok(WORTH, 'DIE_WITH_TARGET must remain available');
  assert.equal(resolveTerminalKey({ scope: 'worth' }), 'worth');
  assert.equal(resolveTerminalKey({ scope: 'worth', basis: 'afterTax' }), 'afterTaxWorth');
  assert.ok(DIE_WITH_TARGET_AXES.scope.some(o => o.value === 'worth'));
});
