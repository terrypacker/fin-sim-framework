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
 * §461(l) excess business loss and the §172 net operating loss (design 134 step 4g). Figures
 * from the statutes and the Rev. Procs on disk (docs/us-tax/).
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { _computeBusinessLossLimits } from '../../src/finance/tax/us/us-tax-rates-base.js';
import { UsTaxRates2024 } from '../../src/finance/tax/us/us-tax-rates-2024.js';
import { UsTaxRates2025 } from '../../src/finance/tax/us/us-tax-rates-2025.js';
import { UsTaxRates2026 } from '../../src/finance/tax/us/us-tax-rates-2026.js';
import { UsTaxRates2027 } from '../../src/finance/tax/us/us-tax-rates-2027.js';
import { InflationAdjustedUsTaxRates } from '../../src/finance/tax/inflation-adjusted-tax-rates.js';
import { GOLDEN_SPECS } from '../helpers/golden-specs.js';
import { runGolden } from '../helpers/golden-harness.js';

const R26 = new UsTaxRates2026();
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
/** One row's net, a W-2 wage, and the AGI those make (before losses), single filer. */
const limits = ({ row = 0, wages = 0, other = 0, gains = 0, allowance = 0, carry, std = 16_100, single = true, rates = R26 } = {}) =>
  _computeBusinessLossLimits(
    { usQbiYTD: row, usSeEarningsYTD: row, usSsWagesYTD: wages, ...(carry != null ? { usNolCarryforward: carry } : {}) },
    { agi: row + wages + other - allowance, stdDeduction: std, capitalLossAllowance: allowance, netCapitalGain: gains },
    rates, single);

describe('§461(l) and the §172 NOL (design 134 step 4g)', () => {
  test('the thresholds are the Rev. Procs\'; a projected year indexes them', () => {
    const t = (r) => [r._eblThresholdMfj, r._eblThresholdSingle];
    assert.deepStrictEqual(t(new UsTaxRates2024()), [610_000, 305_000]);
    assert.deepStrictEqual(t(new UsTaxRates2025()), [626_000, 313_000]);
    assert.deepStrictEqual(t(R26), [512_000, 256_000]);   // P.L. 119-21 re-based to 2024
    assert.deepStrictEqual(t(new UsTaxRates2027()), [528_000, 264_000]);
    close(new InflationAdjustedUsTaxRates(R26, 1.1)._eblThresholdSingle, 281_600);
  });

  test('a loss the wage absorbs makes no NOL and touches nothing', () => {
    const l = limits({ row: -20_000, wages: 80_000 });
    assert.deepStrictEqual([l.excessBusinessLoss, l.arising, l.deduction, l.closing], [0, 0, 0, 0]);
  });

  test('a loss beyond all income carries forward; the standard deduction makes none of it', () => {
    // Wage 30,000, interest 5,000, loss 60,000. The interest takes 5,000 of the 16,100
    // standard deduction and the rest of it is lost ((d)(4)), so the loss offsets only the
    // wage: the NOL is 60,000 − 30,000 = 30,000.
    const l = limits({ row: -60_000, wages: 30_000, other: 5_000 });
    close(l.arising, 30_000);
    close(l.closing, 30_000);
  });

  test('a capital loss allowance is added back: it cannot make an NOL ((d)(2))', () => {
    const l = limits({ row: -60_000, wages: 30_000, allowance: 3_000 });
    close(l.arising, 30_000);
  });

  test('over the threshold the excess is disallowed this year and carried as an NOL', () => {
    // A 400,000 loss, single, 2026: 144,000 is excess. The allowed 256,000 against a
    // 100,000 wage leaves an NOL of 156,000. Both carry.
    const l = limits({ row: -400_000, wages: 100_000 });
    close(l.excessBusinessLoss, 144_000);
    close(l.arising, 156_000);
    close(l.closing, 300_000);
    // Joint, the threshold doubles.
    assert.strictEqual(limits({ row: -400_000, wages: 100_000, single: false }).excessBusinessLoss, 0);
  });

  test('the carry-in is deducted up to 80% of taxable income (§172(a)(2)(B))', () => {
    // TI before the NOL = 60,000 + 20,000 gains − 16,100 = 63,900; 80% = 51,120.
    const big = limits({ wages: 60_000, gains: 20_000, carry: 100_000 });
    close(big.deduction, 51_120);
    close(big.closing, 100_000 - 51_120);
    const small = limits({ wages: 60_000, carry: 10_000 });
    close(small.deduction, 10_000);
    assert.strictEqual(small.closing, 0);
  });

  test('a module with no threshold limits nothing', () => {
    const l = _computeBusinessLossLimits({ usQbiYTD: -1e7, usSeEarningsYTD: -1e7 },
      { agi: -1e7, stdDeduction: 0, capitalLossAllowance: 0, netCapitalGain: 0 },
      { _eblThresholdMfj: Infinity, _eblThresholdSingle: Infinity }, true);
    assert.strictEqual(l.excessBusinessLoss, 0);
  });
});

describe('a loss year then a profitable one, in a household run', () => {
  const base = GOLDEN_SPECS.find(s => s.name === 'us-farm-operator');
  const spec = {
    ...base, simEnd: new Date(Date.UTC(2030, 0, 1)),
    mutateCfg: (cfg) => {
      cfg.businessIncome = [
        { id: 'drought', personId: 'primary', kind: 'SCHEDULE_F', startDate: '2027-01-01', endDate: '2027-12-31', net: -400_000 },
        { id: 'farm', personId: 'primary', kind: 'SCHEDULE_F', startDate: '2028-01-01', net: 150_000 },
      ];
    },
  };
  const { sim, state } = runGolden(spec);
  const nol = new Map();
  for (const e of sim.journal.journal) {
    if (e.action?.type !== 'US_TAX_SETTLE_APPLY') continue;
    const y = new Date(e.date).getUTCFullYear();
    if (!nol.has(y)) nol.set(y, (e.action.data ?? e.action).taxDetail.nol);
  }

  test('the loss year disallows the excess and carries it', () => {
    // The household's wage absorbs the 264,000 the limit allows, so only the excess carries.
    const y = nol.get(2027);
    close(y.excessBusinessLoss, 400_000 - 264_000);   // 2027's threshold
    assert.strictEqual(y.arising, 0);
    close(y.closing, y.excessBusinessLoss);
    assert.strictEqual(y.deduction, 0);
  });

  test('the next year deducts it, within 80% of taxable income, and the settle clears the carry', () => {
    const y = nol.get(2028);
    close(y.opening, nol.get(2027).closing, 0.01);
    assert.ok(y.deduction <= 0.8 * y.base + 1e-9);
    close(y.deduction, y.opening);   // 80% of 2028's taxable income is far more than the carry
    assert.strictEqual(nol.get(2029).opening, 0);
    assert.strictEqual(state.usNolCarryforward, 0, 'written once there was a carry, then cleared');
  });
});
