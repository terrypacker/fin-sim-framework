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

import { buildOptVariables } from '../../src/finance/optimization/intl-retirement-opt-config.js';
import { OPT_PARAM_TYPES }   from '../../src/finance/optimization/optimization-objectives.js';
import { OptimizationProblem } from '../../src/finance/optimization/optimization-problem.js';
import { set } from '../../src/finance/monte-carlo/mc-param-paths.js';

const BANDS = [
  { startAge: 65, monthlyAmount: 7000 },
  { startAge: 75, monthlyAmount: 6000 },
  { startAge: 85, monthlyAmount: 5500 },
];

const bandVars = (vars) => vars.filter(v => v.paramKey.startsWith('spendingExpenseBands['));

describe('buildExpenseBandOptConfigs (via buildOptVariables)', () => {
  test('emits one nested-path INTEGER variable per band when EXPLICIT_BANDS is active', () => {
    const vars = buildOptVariables({ spendingExpenseBands: BANDS, spendingStrategy: ['EXPLICIT_BANDS'] });
    const bands = bandVars(vars);
    assert.strictEqual(bands.length, 3);
    assert.deepStrictEqual(
      bands.map(v => v.paramKey),
      ['spendingExpenseBands[0].monthlyAmount',
       'spendingExpenseBands[1].monthlyAmount',
       'spendingExpenseBands[2].monthlyAmount']);
    for (const v of bands) {
      assert.strictEqual(v.type, OPT_PARAM_TYPES.INTEGER);
      assert.strictEqual(v.group, 'Spending Bands');
      assert.strictEqual(v.controllable, true); // design 38 §6.0 — actuatable by MPC
    }
  });

  test('search range is centred on each band amount, stepped by 500', () => {
    const vars = bandVars(buildOptVariables({ spendingExpenseBands: BANDS, spendingStrategy: ['EXPLICIT_BANDS'] }));
    const first = vars[0];
    assert.strictEqual(first.min, 3500);  // 7000 * 0.5
    assert.strictEqual(first.max, 10500); // 7000 * 1.5
    assert.strictEqual(first.step, 500);
  });

  test('band variables are hidden when EXPLICIT_BANDS is not selected', () => {
    const vars = buildOptVariables({ spendingExpenseBands: BANDS, spendingStrategy: ['FIXED'] });
    assert.strictEqual(bandVars(vars).length, 0);
  });

  test('no band variables when the scenario has no expense bands', () => {
    const vars = buildOptVariables({ spendingStrategy: ['EXPLICIT_BANDS'] });
    assert.strictEqual(bandVars(vars).length, 0);
  });
});

describe('nested-path routing', () => {
  test('set() writes a band amount at its nested path (design 25a)', () => {
    const params = { spendingExpenseBands: structuredClone(BANDS) };
    set(params, 'spendingExpenseBands[1].monthlyAmount', 9000);
    assert.strictEqual(params.spendingExpenseBands[1].monthlyAmount, 9000);
    assert.strictEqual(params.spendingExpenseBands[0].monthlyAmount, 7000); // untouched
  });
});

describe('band variable drives the simulation end-to-end', () => {
  test('higher band spending yields lower terminal net worth', () => {
    // startAge 0 so the band is active across the whole window regardless of the
    // default scenario's (sub-65) primary age.
    const base = {
      spendingStrategy: ['EXPLICIT_BANDS'],
      spendingExpenseBands: [{ startAge: 0, monthlyAmount: 7000 }],
    };
    const problem = new OptimizationProblem({
      variables: [{ paramKey: 'spendingExpenseBands[0].monthlyAmount', type: OPT_PARAM_TYPES.INTEGER, min: 4000, max: 12000, step: 1000 }],
      baseParams: base,
      simStart: new Date(Date.UTC(2026, 0, 1)),
      simEnd:   new Date(Date.UTC(2034, 0, 1)),
    });
    const low  = problem.evaluate({ 'spendingExpenseBands[0].monthlyAmount': 4000 });
    const high = problem.evaluate({ 'spendingExpenseBands[0].monthlyAmount': 12000 });
    assert.ok(high.result.finalNetWorthUsd < low.result.finalNetWorthUsd,
      `spending more should leave less: high=${high.result.finalNetWorthUsd} low=${low.result.finalNetWorthUsd}`);
  });
});
