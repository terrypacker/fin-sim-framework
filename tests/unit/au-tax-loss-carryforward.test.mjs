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
 * au-tax-loss-carryforward.test.mjs — design 86 G1, ITAA 1997 Div 36.
 *
 * A tax loss is carried forward indefinitely and deducted from later assessable
 * income. Before this, every AU accumulator reset at settle and a loss year was
 * simply assessed at zero, so the excess was DESTROYED — which made a negatively
 * geared property held by someone with little other income produce a deduction worth
 * nothing at all, every year, forever.
 *
 *   LOSS-1: a loss year banks its excess; the next profit year deducts it.
 *   LOSS-2: partial absorption carries the remainder, in order incurred.
 *   LOSS-3: the pool reaches the net capital gain, after the Div 115 discount —
 *           Div 36 deducts from TOTAL assessable income, not from ordinary alone.
 *   LOSS-4: the pool never goes negative and never exceeds the income available.
 *   LOSS-5: the FITO counterfactual deducts INSIDE each pass — a pass with less
 *           income absorbs less loss. Hoisting it out overstates the FITO limit.
 *   LOSS-6: `_assessResidentPreFito` is PURE — repeated calls give the same answer,
 *           because it is evaluated several times per settle (FITO limit, §865(g)(2)
 *           CGT rate) and a pool spent by the first pass would corrupt the rest.
 *   LOSS-7: no pool ⇒ byte-for-byte the pre-86 return, and no extra line items.
 *   LOSS-8: the return prints opening / deducted / closing, and still foots.
 *
 * Run with: node --test tests/unit/au-tax-loss-carryforward.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { AuTaxRates2026 } from '../../src/finance/tax/au/au-tax-rates-2026.js';

const auResident = (overrides = {}) => ({
  people: { primary: { residency: 'AU' } },
  auOrdinaryIncomeYTD: 0,
  auCapitalGainsYTD: 0,
  auNonResidentWithholdingYTD: 0,
  auSuperTaxYTD: 0,
  auFrankingCreditYTD: 0,
  ...overrides,
});

const rates = () => new AuTaxRates2026();

/** The design 71 §6 footing invariant, read off the printed return. */
const assertFoots = (tax, label) => {
  const credits = tax.frankingOffset + tax.fito;
  assert.ok(Math.abs(tax.grossTax - credits - tax.netLiability) < 0.005,
    `${label}: gross ${tax.grossTax} − credits ${credits} != net ${tax.netLiability}`);
};

describe('Div 36 loss carryforward', () => {
  test('LOSS-1: a loss year banks its excess and the next profit year deducts it', () => {
    const r = rates();
    const lossYear = r.computeTax(auResident({ auOrdinaryIncomeYTD: -40_000 }));
    assert.equal(lossYear.assessableIncome, 0, 'a loss year is assessed at zero');
    assert.equal(lossYear.netLiability, 0);
    assert.equal(lossYear.closingLossPool, 40_000, 'the excess is BANKED, not destroyed');

    const profitYear = r.computeTax(auResident({
      auOrdinaryIncomeYTD: 100_000, auTaxLossPool: lossYear.closingLossPool,
    }));
    assert.equal(profitYear.lossDeducted, 40_000);
    assert.equal(profitYear.assessableIncome, 60_000);
    assert.equal(profitYear.closingLossPool, 0, 'fully absorbed');

    // …and it is genuinely cheaper than the same year with no pool.
    const noPool = r.computeTax(auResident({ auOrdinaryIncomeYTD: 100_000 }));
    assert.ok(profitYear.netLiability < noPool.netLiability);
  });

  test('LOSS-2: partial absorption carries the remainder forward', () => {
    const r = rates();
    const y = r.computeTax(auResident({ auOrdinaryIncomeYTD: 30_000, auTaxLossPool: 50_000 }));
    assert.equal(y.lossDeducted, 30_000, 'capped at the income available');
    assert.equal(y.assessableIncome, 0);
    assert.equal(y.closingLossPool, 20_000, 'the rest survives to next year');
  });

  test('LOSS-3: the pool reaches the net capital gain, after the Div 115 discount', () => {
    // Div 36 deducts from TOTAL assessable income. The discount applies first, so a
    // A$100k gain becomes A$50k assessable and a A$50k pool wipes it out exactly.
    const r = rates();
    const y = r.computeTax(auResident({
      auCapitalGainsYTD: 100_000, auDiscountableGainsYTD: 100_000, auTaxLossPool: 50_000,
    }));
    assert.equal(y.discountedCapitalGains, 50_000, 'discount first');
    assert.equal(y.lossDeducted, 50_000, 'then the loss');
    assert.equal(y.assessableIncome, 0);
    assert.equal(y.netLiability, 0, 'the disposal is fully sheltered');
  });

  test('LOSS-4: the pool is never negative and never over-deducts', () => {
    const r = rates();
    // A loss year with a pool already standing: nothing is deducted (no income), and
    // the year's own loss is ADDED. Deduction and creation are mutually exclusive.
    const y = r.computeTax(auResident({ auOrdinaryIncomeYTD: -10_000, auTaxLossPool: 25_000 }));
    assert.equal(y.lossDeducted, 0);
    assert.equal(y.closingLossPool, 35_000);

    // A negative pool (a corrupt save) is floored rather than becoming income.
    const neg = r.computeTax(auResident({ auOrdinaryIncomeYTD: 50_000, auTaxLossPool: -5_000 }));
    assert.equal(neg.lossDeducted, 0);
    assert.equal(neg.assessableIncome, 50_000);
    assert.equal(neg.closingLossPool, 0);
  });

  test('LOSS-5: the FITO counterfactual absorbs less loss than the real pass', () => {
    // The limit is "AU tax with the US-source income − AU tax without it". If the
    // deduction were hoisted outside the split, the without-pass would claim the full
    // pool against reduced income, understate its own tax, widen the differential and
    // OVER-fund the FITO.
    const r = rates();
    const state = auResident({
      auOrdinaryIncomeYTD: 120_000,
      usSourceOrdinaryAudYTD: 80_000,
      usTaxPaidOnUsSourceAud: 20_000,
      auTaxLossPool: 60_000,
    });
    const withPool = r.computeTax(state);
    const noPool   = r.computeTax({ ...state, auTaxLossPool: 0 });

    assert.equal(withPool.lossDeducted, 60_000);
    // The without-pass sees 120k − 80k = 40k, so it can only absorb 40k of the pool.
    // That leaves it with 0 assessable income and 0 tax, so the limit is the whole
    // pre-FITO liability of the real pass.
    assert.ok(withPool.fitoLimit < noPool.fitoLimit,
      `a loss-sheltered return has less AU tax to relieve: ${withPool.fitoLimit} vs ${noPool.fitoLimit}`);
    assert.ok(withPool.fito <= withPool.fitoLimit + 0.005, 'offset never exceeds its limit');
    assertFoots(withPool, 'LOSS-5');
  });

  test('LOSS-6: the assessment is pure — it never spends the pool it was handed', () => {
    // It is evaluated several times per settle (FITO limit, §865(g)(2) CGT rate).
    // A pool drawn down in place would be spent by whichever pass ran first.
    const r = rates();
    const state = auResident({
      auOrdinaryIncomeYTD: 90_000, auCapitalGainsYTD: 20_000,
      auDiscountableGainsYTD: 20_000, auTaxLossPool: 30_000,
    });
    const a = r.computeTax(state);
    const b = r.computeTax(state);
    assert.deepEqual(
      [a.lossDeducted, a.closingLossPool, a.netLiability],
      [b.lossDeducted, b.closingLossPool, b.netLiability],
      'repeated assessment must be identical',
    );
    assert.equal(state.auTaxLossPool, 30_000, 'the input state is not mutated');
  });

  test('LOSS-7: no pool leaves the return exactly as it was', () => {
    const r = rates();
    const before = r.computeTax(auResident({ auOrdinaryIncomeYTD: 85_000 }));
    assert.equal(before.openingLossPool, 0);
    assert.equal(before.lossDeducted, 0);
    assert.equal(before.closingLossPool, 0);
    assert.equal(before.assessableIncome, 85_000);
    assert.ok(!before.lineItems.some(l => /Loss/i.test(l.label)),
      'no loss lines on an ordinary return');
  });

  test('LOSS-8: the return prints opening / deducted / closing, and foots', () => {
    const r = rates();
    const y = r.computeTax(auResident({ auOrdinaryIncomeYTD: 70_000, auTaxLossPool: 25_000 }));
    const labels = y.lineItems.map(l => l.label);
    assert.ok(labels.includes('Carried-Forward Tax Losses — opening'));
    assert.ok(labels.includes('Prior-Year Losses Deducted'));
    assert.ok(labels.includes('Carried-Forward Tax Losses — closing'));
    const deducted = y.lineItems.find(l => l.label === 'Prior-Year Losses Deducted');
    assert.equal(deducted.amount, -25_000, 'shown as a deduction, i.e. negative');
    assert.equal(y.assessableIncome, 45_000);
    assertFoots(y, 'LOSS-8');
  });

  test('LOSS-9: a multi-year chain nets out exactly', () => {
    const r = rates();
    let pool = 0;
    const incomes = [-30_000, -20_000, 15_000, 60_000, 40_000];
    const deducted = [];
    for (const inc of incomes) {
      const y = r.computeTax(auResident({ auOrdinaryIncomeYTD: inc, auTaxLossPool: pool }));
      deducted.push(y.lossDeducted);
      pool = y.closingLossPool;
    }
    assert.deepEqual(deducted, [0, 0, 15_000, 35_000, 0], 'oldest-first, capped at income');
    assert.equal(pool, 0, '50,000 of losses met 115,000 of income and are spent');
  });
});
