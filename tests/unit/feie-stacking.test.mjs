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
 * feie-stacking.test.mjs — design 52 §4.2.
 *
 * Foreign Earned Income Exclusion (Form 2555) on the US return: exclude AU-source
 * earned income up to the per-person cap when elected, applying the IRS stacking
 * rule (excluded income still lifts the marginal rate on the remainder). Gated by
 * usFeieElected; a partial move-in year is suppressed.
 */

import { test }   from 'node:test';
import assert     from 'node:assert/strict';

import { UsTaxRates2025 } from '../../src/finance/tax/us/us-tax-rates-2025.js';

// USD_AUD = 1 so AUD-denominated earned income converts 1:1 to USD, keeping the
// arithmetic transparent.
const baseState = {
  usFilingSingle: false,
  effectiveExchangeRates: { USD_AUD: 1 },
  people: { primary: { residency: 'AU' } },   // residencySinceMs null ⇒ qualifies
  auPersonEarnedIncomeYTD: { primary: 100_000 },
  usOrdinaryIncomeYTD: 200_000,   // 100k AU wages (foreign earned) + 100k other
};

test('FEIE off: tax is the plain bracket tax on the full taxable income', () => {
  const r = new UsTaxRates2025().computeTax({ ...baseState, usFeieElected: false });
  assert.equal(r.feieExcluded, 0);
  // agi 200k − stdDed 30k = 170k taxable; tax(170k) MFJ 2025 = 27,228.
  assert.ok(Math.abs(r.ordinaryTax - 27_228) < 1, `ordinaryTax ${r.ordinaryTax}`);
});

test('FEIE on: excludes the earned income up to cap and taxes the remainder stacked', () => {
  const r = new UsTaxRates2025().computeTax({ ...baseState, usFeieElected: true });
  assert.equal(r.feieExcluded, 100_000, 'excluded = min(earned, cap)');
  assert.equal(r.taxableIncomeAfterFeie, 70_000, '170k taxable − 100k excluded');

  // Stacking: tax(170k) − tax(100k) = 27,228 − 11,828 = 15,400.
  assert.ok(Math.abs(r.ordinaryTax - 15_400) < 1, `stacked ordinaryTax ${r.ordinaryTax}`);

  // Must exceed the *naive* exclusion (remainder taxed from the bottom): tax(70k)
  // = 7,923. Stacking taxes the top slice at the higher marginal brackets.
  const naive = 7_923;
  assert.ok(r.ordinaryTax > naive, `stacked ${r.ordinaryTax} must exceed naive ${naive}`);
});

test('FEIE toggle changes the liability; nothing else moves', () => {
  const off = new UsTaxRates2025().computeTax({ ...baseState, usFeieElected: false });
  const on  = new UsTaxRates2025().computeTax({ ...baseState, usFeieElected: true });
  assert.ok(on.netLiability < off.netLiability, 'electing FEIE lowers US tax');
});

test('cap binds: earned income above the cap is only excluded up to the cap', () => {
  const r = new UsTaxRates2025().computeTax({
    ...baseState,
    usFeieElected: true,
    auPersonEarnedIncomeYTD: { primary: 180_000 },
    usOrdinaryIncomeYTD: 280_000,
  });
  assert.equal(r.feieExcluded, 130_000, 'excluded capped at the 2025 FEIE cap');
});

test('per-person caps aggregate (MFJ: each spouse their own cap)', () => {
  const r = new UsTaxRates2025().computeTax({
    ...baseState,
    usFeieElected: true,
    people: { primary: { residency: 'AU' }, spouse: { residency: 'AU' } },
    auPersonEarnedIncomeYTD: { primary: 130_000, spouse: 130_000 },
    usOrdinaryIncomeYTD: 300_000,
  });
  assert.equal(r.feieExcluded, 260_000, 'each spouse excludes up to their own cap');
});

test('non-resident earner does not get FEIE', () => {
  const r = new UsTaxRates2025().computeTax({
    ...baseState,
    usFeieElected: true,
    people: { primary: { residency: 'US' } },
  });
  assert.equal(r.feieExcluded, 0);
});

test('partial move-in year is suppressed; the first full year qualifies', () => {
  const jul1_2031 = Date.UTC(2031, 6, 1);
  const mk = (taxYear) => ({
    ...baseState,
    usFeieElected: true,
    people: { primary: { residency: 'AU', residencySinceMs: jul1_2031 } },
    currentPeriods: { US: { startMs: Date.UTC(taxYear, 0, 1) } },
  });
  // Move year 2031 (resident only Jul–Dec) → suppressed.
  assert.equal(new UsTaxRates2025().computeTax(mk(2031)).feieExcluded, 0);
  // 2032 is the first full qualifying year → excluded.
  assert.equal(new UsTaxRates2025().computeTax(mk(2032)).feieExcluded, 100_000);
});
