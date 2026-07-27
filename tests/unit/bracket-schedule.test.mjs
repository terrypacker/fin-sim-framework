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
 * bracket-schedule.test.mjs — design 71 Phase 1.
 *
 * The shared marginal-bracket helper that replaced three byte-identical private
 * copies (US federal, AU, US state) and added the per-band detail the tax worksheet
 * export reports.
 *
 * Layers:
 *   Equivalence — applyBrackets() reproduces the pre-71 private implementation
 *                 EXACTLY (bit-for-bit), across the real bracket tables. This is the
 *                 refactor's safety net: any divergence would have moved the golden.
 *   Bands       — every band emitted (including unreached ones), top band open-ended,
 *                 Σ band.tax === total, Σ band.income === income.
 *   Differences — subtractBands() for the LTCG §1(h) stack and the FEIE stack.
 *   Payload     — computeTax() reports `brackets`, and it reconciles to the line
 *                 totals it claims to explain.
 *
 * Run with: node --test tests/unit/bracket-schedule.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import {
  applyBrackets,
  applyBracketsDetailed,
  marginalBracketRate,
  subtractBands,
  flatRateBand,
} from '../../src/finance/tax/bracket-schedule.js';
import { UsTaxRates2025 } from '../../src/finance/tax/us/us-tax-rates-2025.js';

/**
 * The pre-design-71 private implementation, preserved verbatim as the equivalence
 * oracle. If the shared helper ever stops agreeing with this, the refactor changed
 * behavior — which is the one thing Phase 1 promised not to do.
 */
function legacyApplyBrackets(income, brackets) {
  if (income <= 0) return 0;
  let tax = 0;
  for (let i = 0; i < brackets.length; i++) {
    const [lo, rate] = brackets[i];
    const hi = i + 1 < brackets.length ? brackets[i + 1][0] : Infinity;
    if (income <= lo) break;
    tax += (Math.min(income, hi) - lo) * rate;
  }
  return tax;
}

const MFJ_2025 = new UsTaxRates2025()._brackets_mfj;
const LTCG_MFJ = new UsTaxRates2025()._ltcg_mfj;

// ─── Equivalence with the replaced implementation ────────────────────────────

test('BS-1: applyBrackets is bit-identical to the pre-71 private copy', () => {
  const incomes = [
    -50_000, -1, 0, 0.01, 1, 23_849.99, 23_850, 23_850.01,
    50_000, 96_950, 100_000, 206_700, 247_000, 394_600,
    501_050, 751_600, 1_000_000, 12_345_678.9,
  ];
  for (const table of [MFJ_2025, LTCG_MFJ, []]) {
    for (const income of incomes) {
      assert.equal(
        applyBrackets(income, table),
        legacyApplyBrackets(income, table),
        `divergence at income ${income} on a ${table.length}-band table`,
      );
    }
  }
});

test('BS-2: marginalBracketRate matches the table it was read from', () => {
  assert.equal(marginalBracketRate(0,       MFJ_2025), 0);
  assert.equal(marginalBracketRate(-100,    MFJ_2025), 0);
  assert.equal(marginalBracketRate(10_000,  MFJ_2025), 0.10);
  assert.equal(marginalBracketRate(23_850,  MFJ_2025), 0.10);  // at the threshold, not over it
  assert.equal(marginalBracketRate(23_851,  MFJ_2025), 0.12);
  assert.equal(marginalBracketRate(247_000, MFJ_2025), 0.24);
  assert.equal(marginalBracketRate(9e9,     MFJ_2025), 0.37);
  assert.equal(marginalBracketRate(100_000, []),       0);
});

// ─── Band detail ─────────────────────────────────────────────────────────────

test('BS-3: bands reproduce the design-71 §6 worked example', () => {
  const { tax, bands } = applyBracketsDetailed(247_000, MFJ_2025);

  assert.equal(bands.length, MFJ_2025.length, 'every band is emitted, reached or not');
  assert.deepEqual(
    bands.map(b => [b.rate, b.income, b.tax]),
    [
      [0.10,  23_850, 2_385],
      [0.12,  73_100, 8_772],
      [0.22, 109_750, 24_145],
      [0.24,  40_300, 9_672],
      [0.32,       0, 0],
      [0.35,       0, 0],
      [0.37,       0, 0],
    ],
  );
  assert.equal(tax, 44_974);
});

test('BS-4: bands sum to the total and to the income they explain', () => {
  for (const income of [0, 1, 47_000, 247_000, 850_000]) {
    const { tax, bands } = applyBracketsDetailed(income, MFJ_2025);
    const sumTax    = bands.reduce((s, b) => s + b.tax,    0);
    const sumIncome = bands.reduce((s, b) => s + b.income, 0);
    // Σ band.tax === total is EXACT, not approximate: the total is accumulated by
    // the same additions in the same order. This is what makes the CSV's
    // `SUMIF(parentLine) === line amount` check meaningful.
    assert.equal(sumTax, tax, `Σ band.tax !== total at income ${income}`);
    assert.equal(sumIncome, Math.max(0, income), `Σ band.income !== income at ${income}`);
  }
});

test('BS-5: the top band is open-ended and the rest are bounded', () => {
  const { bands } = applyBracketsDetailed(1_000_000, MFJ_2025);
  assert.equal(bands.at(-1).upper, null, 'top band has no upper bound');
  assert.equal(bands.at(-1).lower, 751_600);
  assert.equal(bands.at(-1).income, 1_000_000 - 751_600);
  for (const b of bands.slice(0, -1)) {
    assert.ok(b.upper != null && b.upper > b.lower, 'non-top bands are bounded');
  }
});

test('BS-6: non-positive income yields zero bands, not negative ones', () => {
  for (const income of [0, -1, -500_000]) {
    const { tax, bands } = applyBracketsDetailed(income, MFJ_2025);
    assert.equal(tax, 0);
    assert.equal(bands.length, MFJ_2025.length, 'band count stays constant — the CSV stays rectangular');
    assert.ok(bands.every(b => b.income === 0 && b.tax === 0));
  }
});

// ─── Differential schedules ──────────────────────────────────────────────────

test('BS-7: subtractBands isolates the LTCG stack (IRC §1(h))', () => {
  // §6 example: $40,000 of LTCG stacked on $247,000 of taxable ordinary income.
  const stacked = applyBracketsDetailed(247_000 + 40_000, LTCG_MFJ);
  const base    = applyBracketsDetailed(247_000,          LTCG_MFJ);
  const bands   = subtractBands(stacked.bands, base.bands);

  assert.deepEqual(
    bands.map(b => [b.rate, b.income, b.tax]),
    [
      [0.00,      0, 0],       // the 0% band was fully consumed by ordinary income
      [0.15, 40_000, 6_000],   // the whole gain lands in the 15% band
      [0.20,      0, 0],
    ],
  );
  assert.equal(bands.reduce((s, b) => s + b.tax, 0), stacked.tax - base.tax);
});

test('BS-8: subtractBands rejects operands from different tables', () => {
  const a = applyBracketsDetailed(100_000, MFJ_2025);
  const b = applyBracketsDetailed(100_000, LTCG_MFJ);
  assert.throws(() => subtractBands(a.bands, b.bands), /band count mismatch/);

  const shifted = a.bands.map(x => ({ ...x, lower: x.lower + 1 }));
  assert.throws(() => subtractBands(a.bands, shifted), /band 0 mismatch/);
});

test('BS-9: flatRateBand defaults to rate × income but accepts an override', () => {
  // Note the expected tax is the literal float product (2800.0000000000005), not the
  // rounded 2800: the engine computes `collectibles * 0.28` and the band must report
  // exactly what it computed. Rounding here would hide real residue — design 71 §4.2.
  assert.deepEqual(flatRateBand(0.28, 10_000), { rate: 0.28, income: 10_000, tax: 10_000 * 0.28 });
  // The override exists for taxes whose statutory amount is not the bare product
  // (thresholds, caps) — NIIT and the SS portion of SECA both use it.
  assert.deepEqual(flatRateBand(0.038, 48_000, 1_824), { rate: 0.038, income: 48_000, tax: 1_824 });
});

// ─── The computeTax payload ──────────────────────────────────────────────────

test('BS-10: computeTax reports brackets that reconcile to its own line totals', () => {
  const rates = new UsTaxRates2025();
  // Design 71 §6: MFJ, $300k ordinary, $23k pre-tax, $40k LTCG, $8k investment income.
  const r = rates.computeTax({
    usOrdinaryIncomeYTD:      300_000,
    usNegativeIncomeYTD:       23_000,
    usCapitalGainsYTD:         40_000,
    usNetInvestmentIncomeYTD:   8_000,
    usFilingSingle:            false,
  });

  assert.equal(r.brackets.table, 'MFJ');
  assert.equal(r.brackets.feieStacked, null, 'no FEIE elected');
  assert.equal(r.brackets.seca, null, 'no self-employment income');

  const sum = bands => bands.reduce((s, b) => s + b.tax, 0);
  assert.equal(sum(r.brackets.ordinary), r.ordinaryTax,     'ordinary bands explain ordinaryTax');
  assert.equal(sum(r.brackets.ltcg),     r.capitalGainsTax, 'ltcg bands explain capitalGainsTax');
  assert.equal(r.brackets.collectibles.tax, r.collectiblesTax);
  assert.equal(r.brackets.niit.tax,         r.niitTax);

  // The §6 figures, which the design doc and the example CSV both publish.
  assert.equal(Math.round(r.ordinaryTax),     44_974);
  assert.equal(Math.round(r.capitalGainsTax),  6_000);
  assert.equal(Math.round(r.niitTax),          1_824);
  assert.equal(Math.round(r.grossTax),        52_798);
  assert.equal(Math.round(r.netLiability),    52_798);

  // Σ band.income over the ordinary schedule === taxable ordinary income (line 5).
  assert.equal(
    r.brackets.ordinary.reduce((s, b) => s + b.income, 0),
    r.taxableIncome,
  );
});

test('BS-11: brackets.table follows the filing status actually applied', () => {
  const rates = new UsTaxRates2025();
  const single = rates.computeTax({ usOrdinaryIncomeYTD: 120_000, usFilingSingle: true });
  assert.equal(single.brackets.table, 'Single');
  assert.equal(single.brackets.ordinary.length, rates._brackets_single.length);
  assert.equal(single.brackets.ordinary.reduce((s, b) => s + b.tax, 0), single.ordinaryTax);
});

test('BS-12: SECA breakdown appears only with SE income and reconciles', () => {
  const rates = new UsTaxRates2025();
  const r = rates.computeTax({
    usOrdinaryIncomeYTD: 200_000,
    usSeEarningsYTD:     150_000,
    usSsWagesYTD:         50_000,
    usFilingSingle:      false,
  });

  const seca = r.brackets.seca;
  assert.ok(seca, 'SECA breakdown present when there is SE income');
  assert.equal(seca.netEarnings, 150_000 * rates._seNetFactor);
  // W-2 wages fill the Social Security wage base before SE earnings (design 69).
  assert.equal(seca.ssWagesApplied,  50_000);
  assert.equal(seca.ssBaseRemaining, rates._ficaWageBase - 50_000);
  assert.equal(seca.socialSecurity.tax + seca.medicare.tax, seca.tax);
  assert.equal(seca.tax, r.selfEmploymentTax);
  assert.equal(seca.deduction, r.selfEmploymentTaxDeduction);
  assert.equal(seca.additionalMedicare.tax, r.additionalMedicareTax);
});
