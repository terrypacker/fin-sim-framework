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
 * roth-retarget.test.mjs — design 42.
 *
 * The retargetRothConversionEvents helper (the rollout-side twin of the live
 * ROTH.actuate), and the snapshot-rollout regression it fixes: in a
 * snapshot-seeded rollout the Roth income-target param must actually move the
 * conversion (previously it was inert because the injected queue overrode it).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { retargetRothConversionEvents } from '../../src/scenarios/toolsets/us-roth-conversion-toolset.js';
import { OptimizationProblem }  from '../../src/finance/optimization/optimization-problem.js';
import { OPT_PARAM_TYPES }      from '../../src/finance/optimization/optimization-objectives.js';
import { makeInitialSnapshot }  from '../../src/finance/mpc/mpc-controller.js';

const BASE_YEAR = 2025;
const ev = (year, target) => ({
  type: 'ROTH_CONVERSION_POLICY_EVALUATE',
  date: new Date(Date.UTC(year, 11, 1)),   // Dec 1
  data: { targetIncome: target, iraKey: 'iraAccount', rothKey: 'rothAccount' },
});

describe('retargetRothConversionEvents', () => {
  test('rewrites future matching-year events to the inflation-compounded nominal target', () => {
    const queue = [ev(2028, 250_000), ev(2029, 250_000)];
    const hits = retargetRothConversionEvents(queue, [{ year: 2028, incomeTarget: 100_000 }],
      { inflationRate: 0.03, nowMs: +new Date(Date.UTC(2027, 11, 31)) });
    assert.equal(hits, 1);
    const expected = 100_000 * Math.pow(1.03, 2028 - BASE_YEAR);
    assert.ok(Math.abs(queue[0].data.targetIncome - expected) < 1e-6, 'now-year event compounded');
    assert.equal(queue[1].data.targetIncome, 250_000, 'other year untouched (keeps the window)');
  });

  test('leaves already-fired (past) events untouched — forward-effective only', () => {
    const queue = [ev(2027, 250_000)];   // Dec 1 2027, before "now" = Dec 31 2027
    const hits = retargetRothConversionEvents(queue, [{ year: 2027, incomeTarget: 100_000 }],
      { nowMs: +new Date(Date.UTC(2027, 11, 31)) });
    assert.equal(hits, 0);
    assert.equal(queue[0].data.targetIncome, 250_000, 'past event not rewritten');
  });

  test('a 0 target is applied (a genuine "skip this year")', () => {
    const queue = [ev(2028, 250_000)];
    retargetRothConversionEvents(queue, [{ year: 2028, incomeTarget: 0 }],
      { nowMs: +new Date(Date.UTC(2027, 0, 1)) });
    assert.equal(queue[0].data.targetIncome, 0, 'window conversion overridden to skip');
  });

  test('empty / missing schedule and non-conversion events are no-ops', () => {
    const queue = [ev(2028, 250_000), { type: 'SOMETHING_ELSE', date: new Date(Date.UTC(2028, 0, 1)), data: {} }];
    assert.equal(retargetRothConversionEvents(queue, [], { nowMs: 0 }), 0);
    assert.equal(retargetRothConversionEvents(queue, [{ year: 2099, incomeTarget: 9 }], { nowMs: 0 }), 0,
      'no event for that year');
    assert.equal(queue[0].data.targetIncome, 250_000);
  });
});

// ── The regression this design exists for ───────────────────────────────────────
// Before design 42 a snapshot-seeded rollout ignored rothConversionSchedule (the
// injected queue overrode it), so the cockpit's income-target lever was inert and
// solvers disagreed on a flat objective. Now the param moves the snapshot rollout.

describe('snapshot-seeded rollout honors the Roth income-target (design 42 gate)', () => {
  const SIM_START = new Date(Date.UTC(2026, 0, 1));
  const SIM_END   = new Date(Date.UTC(2040, 0, 1));
  const NOW       = new Date(Date.UTC(2027, 11, 31));   // Dec 31 2027 (this year's conv already fired)
  // A single scheduled conversion year (2028) so the controlled year is the only
  // conversion — isolating the lever's effect.
  const BASE = { rothConversionEnabled: true, rothConversionSchedule: [{ year: 2028, incomeTarget: 0 }] };

  const rothBalAt = (target) => {
    const snapshot = makeInitialSnapshot({ simStart: SIM_START, simEnd: SIM_END, asOfDate: NOW, baseParams: BASE });
    const committed = { ...BASE, rothConversionSchedule: [{ year: 2028, incomeTarget: target }] };
    const problem = new OptimizationProblem({
      variables: [{ paramKey: 'rothConversionSchedule[0].incomeTarget', type: OPT_PARAM_TYPES.CONTINUOUS, min: 0, max: 400_000, step: 1_000 }],
      baseParams: committed,
      simStart: SIM_START, simEnd: SIM_END,
      initialState: { kind: 'snapshot', snapshot },
    });
    return problem.evaluate({ 'rothConversionSchedule[0].incomeTarget': target }).result.rothFinalBalance;
  };

  test('raising the income target converts more IRA→Roth in a SNAPSHOT rollout (was inert before the fix)', () => {
    const off = rothBalAt(0);
    const on  = rothBalAt(200_000);
    assert.ok(on > off,
      `snapshot rollout must respond to the schedule param: on=${Math.round(on)} off=${Math.round(off)}`);
  });
});
