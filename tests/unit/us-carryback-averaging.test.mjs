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
 * The §172(b)(1)(B) farming-loss carryback and §1301 farm income averaging (design 134 step
 * 4g-3), both read from the return history the settle keeps.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import {
  _farmingLossCarryback, _computeFarmIncomeAveraging, _regularTaxOn,
} from '../../src/finance/tax/us/us-tax-rates-base.js';
import { nextReturnHistory } from '../../src/finance/tax/tax-settle-classes.js';
import { UsTaxRates2026 } from '../../src/finance/tax/us/us-tax-rates-2026.js';
import { validateUsPriorReturns } from '../../src/finance/payroll/business-income.js';
import { GOLDEN_SPECS } from '../helpers/golden-specs.js';
import { runGolden } from '../helpers/golden-harness.js';

const R = new UsTaxRates2026();
const B = R._brackets_single, L = R._ltcg_single;
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const row = (year, ordinary, over = {}) => ({
  year, ordinary, gain: 0, jBase: ordinary, nolBase: ordinary + 16_100, nolUsed: 0, brackets: B, ltcgBrackets: L, ...over,
});

describe('farming-loss carryback (§172(b)(1)(B))', () => {
  const history = [row(2026, 60_000), row(2027, 150_000)];

  test('the loss goes to the second year back first, each taking 80% of its income', () => {
    const c = _farmingLossCarryback({ usReturnHistory: history }, 200_000, 2028);
    // 2026: 80% × 76,100 = 60,880.  2027: 80% × 166,100 = 132,880, of the 139,120 left.
    assert.deepStrictEqual(c.years.map(y => y.year), [2026, 2027]);
    close(c.years[0].absorbed, 60_880);
    close(c.years[1].absorbed, 132_880);
    close(c.carriedBack, 193_760);
    // The refund is each year's regular tax on the income the loss took away.
    close(c.years[0].refund, _regularTaxOn(60_000, 0, B, L) - _regularTaxOn(0, 0, B, L));
    close(c.years[1].refund, _regularTaxOn(150_000, 0, B, L) - _regularTaxOn(150_000 - 132_880, 0, B, L));
    close(c.refund, c.years[0].refund + c.years[1].refund);
  });

  test('a small loss stops in the earlier year; the waiver carries none back', () => {
    const c = _farmingLossCarryback({ usReturnHistory: history }, 10_000, 2028);
    assert.deepStrictEqual(c.years.map(y => [y.year, y.absorbed]), [[2026, 10_000]]);
    assert.strictEqual(_farmingLossCarryback({ usReturnHistory: history, usFarmingLossCarryback: false }, 10_000, 2028).carriedBack, 0);
  });

  test('a year not on record takes nothing', () => {
    assert.strictEqual(_farmingLossCarryback({ usReturnHistory: [] }, 10_000, 2028).carriedBack, 0);
  });

  test('the settle amends the years the loss went to and keeps three', () => {
    const c = _farmingLossCarryback({ usReturnHistory: history }, 10_000, 2028);
    const next = nextReturnHistory([row(2025, 1), ...history], {
      nol: { carryback: c.years },
      returnSummary: { year: 2028, ordinary: 0, gain: 0, nolBase: 0, nolUsed: 0, brackets: B, ltcgBrackets: L },
    });
    assert.deepStrictEqual(next.map(r => r.year), [2026, 2027, 2028]);
    assert.strictEqual(next[0].ordinary, 50_000);
    assert.strictEqual(next[0].nolUsed, 10_000);
    assert.strictEqual(next[0].jBase, 50_000);
  });
});

describe('farm income averaging (§1301, Schedule J)', () => {
  const low = [row(2025, 20_000), row(2026, 20_000), row(2027, 20_000)];
  const state = (over = {}) => ({ usFarmIncomeAveraging: true, usQbiYTD: 300_000, usReturnHistory: low, ...over });
  const run = (st, ordinary = 280_000) =>
    _computeFarmIncomeAveraging(st, { taxYear: 2028, ordinary, gain: 0, seAdjustment: 10_000, brackets: B, ltcgBrackets: L });

  test('a big year after low ones elects the least-tax amount and saves tax', () => {
    const a = run(state());
    assert.ok(a.elected);
    assert.ok(a.electedFarmIncome > 0 && a.electedFarmIncome <= 280_000);
    const total = (e) => _regularTaxOn(280_000 - e, 0, B, L)
      + 3 * (_regularTaxOn(20_000 + e / 3, 0, B, L) - _regularTaxOn(20_000, 0, B, L));
    close(a.reduction, total(0) - total(a.electedFarmIncome));
    // No amount does better (a brute-force check on a 1,000 grid).
    for (let e = 0; e <= 280_000; e += 1_000) assert.ok(total(e) >= total(a.electedFarmIncome) - 1e-6, `EFI ${e}`);
    assert.deepStrictEqual(a.baseYears.map(b => b.year), [2025, 2026, 2027]);
  });

  test('EFI is the farm net less its SE-tax share, capped at taxable income', () => {
    // Farm 30,000 − 10,000 = 20,000 < taxable income: the cap is the farm.
    assert.ok(run(state({ usQbiYTD: 30_000 })).electedFarmIncome <= 20_000);
  });

  test('off, a missing base year, or high base years: no election', () => {
    assert.strictEqual(run(state({ usFarmIncomeAveraging: false })).reduction, 0);
    const missing = run(state({ usReturnHistory: low.slice(1) }));
    assert.strictEqual(missing.elected, false);
    assert.match(missing.unavailable, /2025/);
    // Base years already at the top rate: averaging cannot help.
    assert.strictEqual(run(state({ usReturnHistory: low.map(r => ({ ...r, jBase: 2_000_000 })) })).elected, false);
  });

  test('the settle adds a third of the EFI to each base year, and bases this year on TI − EFI', () => {
    const a = run(state());
    const next = nextReturnHistory(low, {
      averaging: a,
      returnSummary: { year: 2028, ordinary: 280_000, gain: 0, nolBase: 0, nolUsed: 0, brackets: B, ltcgBrackets: L },
    });
    close(next.find(r => r.year === 2026).jBase, 20_000 + a.electedFarmIncome / 3);
    close(next.find(r => r.year === 2028).jBase, 280_000 - a.electedFarmIncome, 0.01);
  });
});

describe('usPriorReturns (Q31)', () => {
  test('validated', () => {
    assert.deepStrictEqual(validateUsPriorReturns([{ year: 2025, taxableIncome: -5_000 }]), []);
    assert.match(validateUsPriorReturns([{ year: '2025', taxableIncome: 1 }]).join(), /whole year/);
    assert.match(validateUsPriorReturns([{ year: 2025 }]).join(), /must be a number/);
    assert.match(validateUsPriorReturns([{ year: 2025, taxableIncome: 1 }, { year: 2025, taxableIncome: 2 }]).join(), /duplicate/);
  });
});

describe('in a household run', () => {
  const base = GOLDEN_SPECS.find(s => s.name === 'us-farm-operator');
  const spec = (params = {}, rows, prior) => ({
    ...base, name: 'carryback', params: { ...(base.params ?? {}), ...params },
    mutateCfg: (cfg) => {
      cfg.businessIncome = rows;
      if (prior) cfg.usPriorReturns = prior;
    },
  });
  const settles = (s) => {
    const { sim, state } = runGolden(s);
    const byYear = new Map();
    for (const e of sim.journal.journal) {
      if (e.action?.type !== 'US_TAX_SETTLE_APPLY') continue;
      const y = new Date(e.date).getUTCFullYear();
      if (!byYear.has(y)) byYear.set(y, (e.action.data ?? e.action).taxDetail);
    }
    const refunds = sim.journal.journal.filter(e => e.action?.type === 'US_TAX_REFUND_CREDIT'
      && (e.action.data ?? e.action).carryback).map(e => (e.action.data ?? e.action).amount);
    return { byYear, refunds, state };
  };
  // A good 2026, then a 2027 drought under the §461(l) threshold that outruns the wage. The
  // year before the run comes from Q31.
  const drought = [
    { id: 'farm', personId: 'primary', kind: 'SCHEDULE_F', startDate: '2026-01-01', endDate: '2026-12-31', net: 120_000 },
    { id: 'drought', personId: 'primary', kind: 'SCHEDULE_F', startDate: '2027-01-01', endDate: '2027-12-31', net: -250_000 },
  ];
  const prior2025 = [{ year: 2025, taxableIncome: 50_000 }];

  test('a drought year is carried back two years, into Q31\'s year first, and refunded', () => {
    const { byYear, refunds, state } = settles(spec({}, drought, prior2025));
    const nol = byYear.get(2027).nol;
    assert.strictEqual(nol.excessBusinessLoss, 0);
    assert.ok(nol.arising > 0, 'the drought outruns the wage');
    assert.deepStrictEqual(nol.carryback.map(c => c.year), [2025, 2026]);
    close(nol.carryback[0].absorbed, 40_000);   // 80% of the 50,000 Q31 gave
    assert.strictEqual(refunds.length, 1);
    close(refunds[0], +nol.carrybackRefund.toFixed(2), 0.006);
    // What was not carried back, plus the §461(l) excess, carries forward.
    close(nol.closing, nol.arising - nol.carriedBack + nol.excessBusinessLoss);
    // The history keeps the last three returns (the amendment is unit-tested above).
    assert.deepStrictEqual(state.usReturnHistory.map(r => r.year), [2027, 2028, 2029]);
  });

  test('waived, nothing is refunded and it all carries forward', () => {
    const { byYear, refunds } = settles(spec({ usFarmingLossCarryback: false }, drought, prior2025));
    assert.strictEqual(refunds.length, 0);
    const nol = byYear.get(2027).nol;
    close(nol.closing, nol.arising + nol.excessBusinessLoss);
  });

  test('averaging starts once three base years are on record, or from Q31', () => {
    const boom = [{ id: 'farm', personId: 'primary', kind: 'SCHEDULE_F', startDate: '2026-01-01', net: 400_000 }];
    const without = settles(spec({ usFarmIncomeAveraging: true }, boom)).byYear;
    assert.match(without.get(2026).averaging.unavailable, /2023, 2024, 2025/);
    assert.ok(without.get(2029).averaging.elected === false || without.get(2029).averaging.reduction >= 0);
    const prior = [2023, 2024, 2025].map(year => ({ year, taxableIncome: 10_000 }));
    const withQ31 = settles(spec({ usFarmIncomeAveraging: true }, boom, prior)).byYear;
    assert.ok(withQ31.get(2026).averaging.elected, 'base years from Q31');
    assert.ok(withQ31.get(2026).averaging.reduction > 0);
  });
});
