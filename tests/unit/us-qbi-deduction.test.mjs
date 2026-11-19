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
 * §199A, the qualified business income deduction (design 134 step 4e). Figures from the
 * statute and the Rev. Procs on disk (docs/us-tax/).
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { _computeQbiDeduction } from '../../src/finance/tax/us/us-tax-rates-base.js';
import { UsTaxRates2025 } from '../../src/finance/tax/us/us-tax-rates-2025.js';
import { UsTaxRates2026 } from '../../src/finance/tax/us/us-tax-rates-2026.js';
import { UsTaxRates2027 } from '../../src/finance/tax/us/us-tax-rates-2027.js';
import { InflationAdjustedUsTaxRates } from '../../src/finance/tax/inflation-adjusted-tax-rates.js';

const R26 = new UsTaxRates2026();
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
/** A household whose only SE earnings are the business, at an AGI and std deduction given. */
const run = (qbiYtd, { agi = 200_000, std = 32_200, seDeduction = 0, gains = 0, w2 = 0, ubia = 0, carry, rates = R26, single = false } = {}) =>
  _computeQbiDeduction(
    { usQbiYTD: qbiYtd, usQbiW2WagesYTD: w2, usQbiUbiaYTD: ubia, ...(carry != null ? { usQbiLossCarryforward: carry } : {}) },
    { agi, stdDeduction: std, seDeduction, usSeEarningsYTD: qbiYtd, netCapitalGain: gains }, rates, single);

describe('§199A deduction (design 134 step 4e)', () => {
  test('the year figures are the Rev. Procs\'', () => {
    assert.deepStrictEqual([R26._qbiThresholdMfj, R26._qbiThresholdSingle, R26._qbiPhaseInMfj, R26._qbiPhaseInSingle,
      R26._qbiMinDeduction, R26._qbiMinActiveQbi], [403_500, 201_750, 150_000, 75_000, 400, 1_000]);
    const r27 = new UsTaxRates2027();
    assert.deepStrictEqual([r27._qbiThresholdMfj, r27._qbiMinDeduction, r27._qbiMinActiveQbi], [416_600, 415, 1_030]);
    const r25 = new UsTaxRates2025();
    assert.deepStrictEqual([r25._qbiThresholdMfj, r25._qbiPhaseInMfj, r25._qbiMinDeduction], [394_600, 100_000, 0]);
  });

  test('below the threshold: 20% of QBI after the SE-tax adjustment', () => {
    const q = run(50_000, { seDeduction: 3_532.39 });
    close(q.seAdjustment, 3_532.39);
    close(q.deduction, 0.2 * (50_000 - 3_532.39));
  });

  test('the SE-tax adjustment is the business\'s share of the SE earnings', () => {
    const q = _computeQbiDeduction({ usQbiYTD: 30_000 },
      { agi: 150_000, stdDeduction: 32_200, seDeduction: 4_000, usSeEarningsYTD: 40_000, netCapitalGain: 0 }, R26, false);
    close(q.seAdjustment, 3_000);
  });

  test('capped at 20% of taxable income less net capital gain', () => {
    // TI before the deduction = 60,000 + 20,000 − 32,200 = 47,800; less gains 27,800; 20% = 5,560.
    const q = run(50_000, { agi: 60_000, gains: 20_000 });
    close(q.incomeCap, 5_560);
    close(q.deduction, 5_560);
  });

  test('above the range with no W-2 wages or UBIA, only the minimum deduction is left', () => {
    const q = run(80_000, { agi: 700_000 });
    assert.strictEqual(q.component, 0);
    assert.strictEqual(q.minimum, true);
    assert.strictEqual(q.deduction, 400);
    // Before 2026 there is no minimum.
    assert.strictEqual(run(80_000, { agi: 700_000, std: 30_000, rates: new UsTaxRates2025() }).deduction, 0);
  });

  test('inside the range the wage limit phases in linearly', () => {
    // TI = 510,200 − 32,200 = 478,000: halfway through 403,500 + 150,000. 20% = 16,000; limit 0.
    const q = run(80_000, { agi: 510_200 });
    close(q.taxableIncome, 478_000);
    close(q.component, 16_000 - 16_000 * (478_000 - 403_500) / 150_000);
  });

  test('above the range W-2 wages and UBIA set the limit', () => {
    // 50% × 20,000 = 10,000 vs 25% × 20,000 + 2.5% × 400,000 = 15,000.
    const q = run(100_000, { agi: 700_000, w2: 20_000, ubia: 400_000 });
    close(q.wageLimit, 15_000);
    close(q.deduction, 15_000);
  });

  test('a net loss gives no deduction and carries to next year (§199A(c)(2))', () => {
    const loss = run(-12_000);
    assert.strictEqual(loss.deduction, 0);
    assert.strictEqual(loss.closing, 12_000);
    const next = run(30_000, { carry: 12_000 });
    close(next.qbi, 18_000);
    close(next.deduction, 3_600);
    assert.strictEqual(next.closing, 0);
    // A carried loss larger than this year's income keeps carrying.
    assert.strictEqual(run(5_000, { carry: 12_000 }).closing, 7_000);
  });

  test('no business income, no carry: nothing at all', () => {
    assert.strictEqual(run(0).deduction, 0);
  });

  test('a projected year indexes the threshold and minimum, not the range', () => {
    const p = new InflationAdjustedUsTaxRates(R26, 1.1);
    close(p._qbiThresholdMfj, 403_500 * 1.1);
    close(p._qbiMinDeduction, 440);
    assert.strictEqual(p._qbiPhaseInMfj, 150_000);
  });
});
