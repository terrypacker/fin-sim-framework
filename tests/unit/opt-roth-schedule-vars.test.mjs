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
 * opt-roth-schedule-vars.test.mjs
 *
 * Design 39 §12 / Step 9 — buildRothScheduleOptConfigs, the batch-optimizer
 * sibling of buildExpenseBandOptConfigs: one continuous `incomeTarget` variable
 * per per-year rothConversionSchedule entry. Mirrors opt-band-vars.test.mjs.
 *
 * Run with: node --test tests/unit/opt-roth-schedule-vars.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildOptVariables }      from '../../src/finance/optimization/intl-retirement-opt-config.js';
import { OPT_PARAM_TYPES }        from '../../src/finance/optimization/optimization-objectives.js';
import { OptimizationProblem }    from '../../src/finance/optimization/optimization-problem.js';
import { set }                    from '../../src/finance/monte-carlo/mc-param-paths.js';

const SCHED = [
  { year: 2030, incomeTarget: 0 },
  { year: 2031, incomeTarget: 100_000 },
];

const rothVars = (vars) => vars.filter(v => v.paramKey.startsWith('rothConversionSchedule['));

describe('buildRothScheduleOptConfigs (via buildOptVariables)', () => {
  test('emits one continuous controllable variable per schedule entry', () => {
    const vars = rothVars(buildOptVariables({ rothConversionSchedule: SCHED }));
    assert.equal(vars.length, 2);
    assert.deepEqual(
      vars.map(v => v.paramKey),
      ['rothConversionSchedule[0].incomeTarget', 'rothConversionSchedule[1].incomeTarget']);
    for (const v of vars) {
      assert.equal(v.type, OPT_PARAM_TYPES.CONTINUOUS);
      assert.equal(v.controllable, true);   // design 39 — actuatable by the MPC controller
      assert.equal(v.min, 0);               // 0 = no conversion that year (OFF)
      assert.equal(v.group, 'Roth Conversion Schedule');
    }
  });

  test('no schedule variables when the scenario has no per-year schedule', () => {
    assert.equal(rothVars(buildOptVariables({})).length, 0);
  });

  // Regression: a stale non-array value (e.g. the "[object Object],…" string a
  // pre-RothScheduleList free-text editor could persist) must NOT throw
  // `flatMap is not a function` and abort the whole sim/opt build — it degrades
  // to "no schedule". Same guard covers spendingExpenseBands.
  test('a non-array (stale string) schedule yields no variables instead of throwing', () => {
    assert.doesNotThrow(() => buildOptVariables({ rothConversionSchedule: '[object Object],[object Object]' }));
    assert.equal(rothVars(buildOptVariables({ rothConversionSchedule: '[object Object],[object Object]' })).length, 0);
    assert.doesNotThrow(() => buildOptVariables({ spendingExpenseBands: '[object Object]' }));
  });
});

describe('nested-path routing', () => {
  test('set() writes an income target at its nested path', () => {
    const params = { rothConversionSchedule: structuredClone(SCHED) };
    set(params, 'rothConversionSchedule[1].incomeTarget', 120_000);
    assert.equal(params.rothConversionSchedule[1].incomeTarget, 120_000);
    assert.equal(params.rothConversionSchedule[0].incomeTarget, 0);   // untouched
  });
});

describe('roth schedule variable drives the simulation end-to-end', () => {
  test('a higher income target converts more IRA→Roth (higher terminal Roth balance)', () => {
    const base = {
      rothConversionEnabled:  true,
      rothConversionSchedule: [{ year: 2030, incomeTarget: 0 }],
    };
    const problem = new OptimizationProblem({
      variables: [{
        paramKey: 'rothConversionSchedule[0].incomeTarget',
        type: OPT_PARAM_TYPES.CONTINUOUS, min: 0, max: 200_000, step: 1_000,
      }],
      baseParams: base,
      simStart: new Date(Date.UTC(2026, 0, 1)),
      simEnd:   new Date(Date.UTC(2034, 0, 1)),
    });

    const off = problem.evaluate({ 'rothConversionSchedule[0].incomeTarget': 0 });
    const on  = problem.evaluate({ 'rothConversionSchedule[0].incomeTarget': 150_000 });

    assert.ok(on.result.rothFinalBalance > off.result.rothFinalBalance,
      `conversion should raise the terminal Roth balance: on=${on.result.rothFinalBalance} off=${off.result.rothFinalBalance}`);
  });
});
