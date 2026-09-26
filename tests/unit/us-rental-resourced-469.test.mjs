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
 * us-rental-resourced-469.test.mjs — a US rental held by an AU resident, where the
 * §469 pass (design 86 G5/G5b) meets Art. 27(1)(c) re-sourcing (design 83 G3).
 *
 * `US_RENTAL_INCOME_TAX` puts an AU resident's US rent in the foreign PASSIVE basket
 * by treaty. The §469 pass reads its own companion accumulator to decide how much of
 * a suspension or release leaves that basket — and the companion was fed only by the
 * AU rental classifier, on the reading that a basket rental is always foreign-SITUS.
 * A US property rented while resident in Australia is in the basket without being
 * foreign-situs, so `usOrdinaryIncomeYTD` moved by the whole §469 adjustment while
 * nothing left the basket: the accumulators stopped partitioning gross income and
 * `_assertFtcInvariants` threw mid-run, at the settle that first released the pool.
 *
 * The Art. 22(2) counterfactual is the second half. It removes the re-sourced rent
 * from the basket, so it has to remove it from the §469 pass too, or the "without"
 * pass releases the pool against rent the return no longer contains.
 *
 *   RES469-1: the classifier tags the rent in BOTH §469 accumulators and the US-source slice
 *   RES469-2: a US-resident rental tags neither — only the household total
 *   RES469-3: the release leaves the passive basket, so the §904 invariants hold
 *   RES469-4: withoutUsSourceIncome takes the rent out of the §469 pass as well
 *
 * Run with: node --test tests/unit/us-rental-resourced-469.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { UsTaxModule2026 } from '../../src/finance/tax/us/us-tax-module-2026.js';
import { UsTaxRates2026 }  from '../../src/finance/tax/us/us-tax-rates-2026.js';
import { withoutUsSourceIncome } from '../../src/finance/tax/tax-settle-classes.js';

const rentalFn = new UsTaxModule2026().getReducerFns().get('US_RENTAL_INCOME_TAX');

const base = (o = {}) => ({
  people: { primary: { residency: 'AU' } },
  usOrdinaryIncomeYTD: 0,
  usNegativeIncomeYTD: 0,
  usCapitalGainsYTD: 0,
  usCollectibleGainsYTD: 0,
  usPenaltyYTD: 0,
  usSeEarningsYTD: 0,
  usSsWagesYTD: 0,
  exchangeRates: { AUDUSD: 0.65 },
  ...o,
});

describe('a US rental re-sourced into the passive basket, under §469', () => {
  test('RES469-1: an AU resident\'s US rent is tagged in both §469 accumulators', () => {
    const next = rentalFn(base(), { amount: 9_000, residency: 'AU' });
    assert.equal(next.usPassiveActivityIncomeYTD, 9_000);
    assert.equal(next.usForeignPassiveActivityIncomeYTD, 9_000,
      'the rent is in the foreign passive BASKET, so the companion must hold it');
    assert.equal(next.usSourcePassiveActivityUsdYTD, 9_000,
      'and the US-source slice, so the counterfactual can un-merge it');
    assert.equal(next.usSourcePassiveUsdYTD, 9_000);
  });

  test('RES469-2: the same rent while US-resident is in no basket at all', () => {
    const next = rentalFn(base({ people: { primary: { residency: 'US' } } }),
      { amount: 9_000, residency: 'US' });
    assert.equal(next.usPassiveActivityIncomeYTD, 9_000);
    assert.equal(next.usForeignPassiveActivityIncomeYTD ?? 0, 0);
    assert.equal(next.usSourcePassiveActivityUsdYTD ?? 0, 0);
  });

  test('RES469-3: releasing the pool leaves the basket — the §904 invariants hold', () => {
    // The shape that threw: a profit year that releases a pool built by earlier rental
    // losses, against rent that sits in the passive basket by treaty.
    // Built through the classifier, not by hand: the tagging under test is the
    // classifier's, and hand-writing the accumulators would assert the fix into
    // existence.
    const rent = 649.16;
    const state = rentalFn(base({
      usOrdinaryIncomeYTD: 113_856.90,
      usPassiveLossCarryforward: 121_162.80,
      foreignGeneralIncomeYTD: 113_604.47,
      foreignPassiveIncomeYTD: 99.09,
      usSourcePassiveUsdYTD: 153.34,
      usSourceOrdinaryUsdYTD: 153.34,
      ftcCurrentForeignTax: 5_000,
    }), { amount: rent, residency: 'AU' });

    const y = new UsTaxRates2026().computeTax(state);   // threw before the fix
    assert.equal(y.passiveLoss.released, rent);

    const gross = y.ftc.grossIncomeAllSources;
    const basketSum = (y.ftc.general?.gross ?? 0) + (y.ftc.passive?.gross ?? 0);
    assert.ok(basketSum <= gross + 0.01,
      `basket gross ${basketSum} must not exceed gross income ${gross}`);
    // The release came out of the basket the rent was in, not out of gross income alone.
    assert.ok(approxEq(basketSum, gross), 'the baskets still partition gross income');
  });

  test('RES469-4: the Art. 22(2) counterfactual removes the rent from the §469 pass', () => {
    const w = withoutUsSourceIncome(base({
      usPassiveActivityIncomeYTD: 5_000,          // 4,000 foreign-situs + 1,000 re-sourced
      usForeignPassiveActivityIncomeYTD: 5_000,
      usSourcePassiveActivityUsdYTD: 1_000,
    }));
    assert.equal(w.usPassiveActivityIncomeYTD, 4_000);
    assert.equal(w.usForeignPassiveActivityIncomeYTD, 4_000);
    assert.equal(w.usSourcePassiveActivityUsdYTD, 0);
  });
});

function approxEq(a, b, eps = 0.02) { return Math.abs(a - b) <= eps; }
