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
 * tips-deflation-904.test.mjs: issue #792.
 *
 * A TIPS deflation adjustment reaches the US return as a NEGATIVE BOND_COUPON_TAX, which
 * nets into `usOrdinaryIncomeYTD`. For a US resident that bond is US-source and in no
 * §904 basket, so in a year where the deflation outran the year's bond interest, gross
 * income from all sources fell below the passive basket's gross and
 * `_assertFtcInvariants` threw. MC seed 47 of the dot-com regime did exactly that.
 *
 * Treas. Reg. §1.1275-7(f)(1)(i) (docs/us-tax/CFR-26-1.1275-7-Inflation-Indexed-Debt-
 * Instruments.txt): the adjustment first reduces the interest on the instrument, and the
 * excess "is treated as an ordinary loss". The excess is a deduction, not negative gross
 * income.
 *
 * Run with: node --test tests/unit/tips-deflation-904.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { UsTaxModule2026 } from '../../src/finance/tax/us/us-tax-module-2026.js';
import { UsTaxRates2026 }  from '../../src/finance/tax/us/us-tax-rates-2026.js';

const usModule = new UsTaxModule2026();
const classify = (type) => usModule.getReducerFns().get(type);

// The seed-47 settle (2030), reduced to the fields that matter: 6,531.59 of net ordinary
// income after −14,046.81 of US bond interest, against 8,197.10 of AU passive income.
const SEED_47 = {
  usOrdinaryIncomeYTD:     6_531.59,
  usBondInterestYTD:     -14_046.81,
  foreignPassiveIncomeYTD: 8_197.10,
  foreignGeneralIncomeYTD: 0,
  ftcPoolPassive:          { 2027: 54.69, 2028: 940.73, 2029: 1_101.21 },
};

test('TIPS-904-1: BOND_COUPON_TAX books the signed bond interest beside ordinary income', () => {
  const fn = classify('BOND_COUPON_TAX');
  let s = { usOrdinaryIncomeYTD: 0, usNetInvestmentIncomeYTD: 0 };
  s = fn(s, { type: 'BOND_COUPON_TAX', amount: 4_000, federalTaxableAmount: 4_000, residency: 'US' });
  s = fn(s, { type: 'BOND_COUPON_TAX', amount: -900, federalTaxableAmount: -900, residency: 'US' });
  assert.equal(s.usBondInterestYTD, 3_100);
  assert.equal(s.usOrdinaryIncomeYTD, 3_100, 'ordinary income keeps the net, as before');
});

test('TIPS-904-2: a zero coupon does not create the key', () => {
  const s = classify('BOND_COUPON_TAX')({ usOrdinaryIncomeYTD: 0 },
    { type: 'BOND_COUPON_TAX', amount: 0, federalTaxableAmount: 0, residency: 'US' });
  assert.equal('usBondInterestYTD' in s, false);
});

test('TIPS-904-3: the seed-47 settle no longer breaks the §904 partition', () => {
  // Strict in tests: before #792 this threw "basket gross sums to 8197.10, which exceeds
  // gross income from all sources 6531.59".
  const out = new UsTaxRates2026().computeTax(SEED_47);
  assert.ok(Math.abs(out.ftc.grossIncomeAllSources - (6_531.59 + 14_046.81)) < 0.01,
    'line 3e adds the excess deflation back: it is a deduction, not negative income');
  assert.ok(out.ftc.grossIncomeAllSources >= out.ftc.passive.gross);
  assert.ok(Math.abs(out.bondDeflationLoss - 14_046.81) < 0.01);
});

test('TIPS-904-4: the loss moves lines 3e and 3c together, and nothing that is taxed', () => {
  const rates = new UsTaxRates2026();
  const state = { usOrdinaryIncomeYTD: 90_000, usBondInterestYTD: -5_000, foreignPassiveIncomeYTD: 30_000 };
  const out   = rates.computeTax(state);
  const bare  = rates.computeTax({ ...state, usBondInterestYTD: 0 });
  assert.ok(Math.abs((out.ftc.grossIncomeAllSources - bare.ftc.grossIncomeAllSources) - 5_000) < 0.01);
  assert.ok(Math.abs((out.ftc.unrelatedDeductions   - bare.ftc.unrelatedDeductions)   - 5_000) < 0.01);
  assert.equal(out.adjustedGrossIncome, bare.adjustedGrossIncome, 'already netted into ordinary income');
  assert.equal(out.taxableIncome,       bare.taxableIncome);
  assert.equal(out.regularTax,          bare.regularTax);
  // The loss joins the UNRELATED pool, so a slice of it is apportioned to the basket:
  // slightly less credit, never more.
  assert.ok(out.ftc.credit <= bare.ftc.credit + 1e-9);
});

test('TIPS-904-5: deflation that bond interest absorbs is not a loss', () => {
  // §1.1275-7(f)(1)(i): it "reduces the amount of interest otherwise includible". Net
  // bond interest above zero leaves gross income exactly as booked.
  const rates = new UsTaxRates2026();
  const out   = rates.computeTax({ usOrdinaryIncomeYTD: 50_000, usBondInterestYTD: 1_200 });
  const bare  = rates.computeTax({ usOrdinaryIncomeYTD: 50_000 });
  assert.equal(out.bondDeflationLoss, 0);
  assert.equal(out.ftc.grossIncomeAllSources, bare.ftc.grossIncomeAllSources);
});
