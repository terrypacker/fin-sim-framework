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
 * us-passive-loss-limitation.test.mjs — design 86 G5 / G5b, IRC §469.
 *
 * Rental activity is passive per se (§469(c)(2)), so a net rental loss cannot offset
 * wages, interest, dividends or gains. It is suspended and carried forward under
 * §469(b). Before this, the signed rental result went straight into
 * `usOrdinaryIncomeYTD` and a foreign rental loss reduced US ordinary income without
 * limit — driving it negative in a measured run.
 *
 * G5b is the sharp end: the unlimited loss reduced total gross income while the SAME
 * loss inside `foreignPassiveIncomeYTD` was floored away when the basket gross was
 * formed. The general basket's gross then exceeded total gross income, the §904
 * denominator collapsed to zero with a live numerator on it, and
 * `_assertFtcInvariants` THREW. Suspending the loss removes it from both places at
 * once, which is what restores the partition.
 *
 *   PAL-1: a rental loss no longer offsets wages; it is suspended.
 *   PAL-2: the pool is released against later passive income, and only that.
 *   PAL-3: a passive PROFIT year is untouched when there is no pool.
 *   PAL-4: partial release carries the remainder.
 *   PAL-5: pure — repeated computeTax gives the same answer and never spends the pool.
 *   PAL-6: G5b — the §904 invariants hold on the exact shape that used to throw.
 *   PAL-7: no passive activity ⇒ the return is unchanged and has no §469 lines.
 *   PAL-8: the return shows the suspension and still foots.
 *
 * Run with: node --test tests/unit/us-passive-loss-limitation.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { UsTaxRates2026 } from '../../src/finance/tax/us/us-tax-rates-2026.js';
import { _computePassiveLossLimitation } from '../../src/finance/tax/us/us-tax-rates-base.js';

const rates = () => new UsTaxRates2026();

const usState = (o = {}) => ({
  people: { primary: { residency: 'US' } },
  usOrdinaryIncomeYTD: 0,
  usNegativeIncomeYTD: 0,
  usCapitalGainsYTD: 0,
  usCollectibleGainsYTD: 0,
  usPenaltyYTD: 0,
  usSeEarningsYTD: 0,
  usSsWagesYTD: 0,
  ...o,
});

/** A year with `rent` of net rental result already folded into ordinary income. */
const withRental = (wages, rent, o = {}) => usState({
  usOrdinaryIncomeYTD: wages + rent,
  usPassiveActivityIncomeYTD: rent,
  usForeignPassiveActivityIncomeYTD: rent,
  foreignPassiveIncomeYTD: rent,
  ...o,
});

describe('§469 passive activity loss limitation', () => {
  test('PAL-1: a rental loss is suspended, not offset against wages', () => {
    const r = rates();
    const y = r.computeTax(withRental(200_000, -40_000));
    assert.equal(y.passiveLoss.suspended, 40_000);
    assert.equal(y.passiveLoss.closing, 40_000);
    // Income is back to the wages alone — the loss did not reduce it.
    assert.equal(y.inputs.grossOrdinaryIncome, 200_000);

    const noRental = r.computeTax(usState({ usOrdinaryIncomeYTD: 200_000 }));
    assert.equal(y.netLiability, noRental.netLiability,
      'a suspended loss must change nothing about this year');
  });

  test('PAL-2: the pool is released against later passive income only', () => {
    const r = rates();
    // Same wages, a passive PROFIT, and a pool standing from an earlier year.
    const y = r.computeTax(withRental(200_000, 30_000, { usPassiveLossCarryforward: 40_000 }));
    assert.equal(y.passiveLoss.released, 30_000, 'capped at the passive income available');
    assert.equal(y.passiveLoss.closing, 10_000);
    assert.equal(y.inputs.grossOrdinaryIncome, 200_000, 'the profit is exactly offset');

    // Wages alone cannot release it: with no passive income, nothing comes out.
    const noPassive = r.computeTax(usState({
      usOrdinaryIncomeYTD: 200_000, usPassiveLossCarryforward: 40_000,
    }));
    assert.equal(noPassive.passiveLoss.released, 0);
    assert.equal(noPassive.passiveLoss.closing, 40_000);
  });

  test('PAL-3: a passive profit with no pool is left alone', () => {
    const r = rates();
    const y = r.computeTax(withRental(120_000, 25_000));
    assert.equal(y.passiveLoss.suspended, 0);
    assert.equal(y.passiveLoss.released, 0);
    assert.equal(y.inputs.grossOrdinaryIncome, 145_000, 'passive income is taxed normally');
  });

  test('PAL-4: partial release carries the remainder forward', () => {
    const r = rates();
    let pool = 0;
    const rents = [-50_000, -20_000, 30_000, 25_000, 40_000];
    const released = [];
    for (const rent of rents) {
      const y = r.computeTax(withRental(150_000, rent, { usPassiveLossCarryforward: pool }));
      released.push(y.passiveLoss.released);
      pool = y.passiveLoss.closing;
    }
    assert.deepEqual(released, [0, 0, 30_000, 25_000, 15_000]);
    assert.equal(pool, 0, '70,000 suspended, 70,000 released');
  });

  test('PAL-5: pure — never spends the pool it was handed', () => {
    const r = rates();
    const state = withRental(150_000, 20_000, { usPassiveLossCarryforward: 60_000 });
    const a = r.computeTax(state);
    const b = r.computeTax(state);
    assert.deepEqual(a.passiveLoss, b.passiveLoss);
    assert.equal(state.usPassiveLossCarryforward, 60_000, 'input state not mutated');
  });

  test('PAL-6: the §904 invariants hold on the shape that used to throw', () => {
    // A foreign rental loss larger than the other income, with foreign tax paid.
    // Pre-86: general basket gross exceeded total gross income, totalTaxable went to
    // zero with a live numerator, and _assertFtcInvariants threw. FTC_LIMITATION_STRICT
    // defaults to strict outside a production build, so a regression fails right here.
    const r = rates();
    const state = usState({
      usOrdinaryIncomeYTD:               50_503 - 17_494,
      usPassiveActivityIncomeYTD:        -17_494,
      usForeignPassiveActivityIncomeYTD: -17_494,
      foreignGeneralIncomeYTD:            50_503,
      foreignPassiveIncomeYTD:           -17_494,
      ftcCurrentGeneral:                   4_593,
      currentPeriods: { US: { startMs: Date.UTC(2038, 0, 1) } },
    });
    const y = r.computeTax(state);       // must not throw
    assert.equal(y.passiveLoss.suspended, 17_494);
    assert.ok(y.ftc.general.numerator <= y.ftc.totalTaxable + 1e-6,
      `numerator ${y.ftc.general.numerator} must fit the denominator ${y.ftc.totalTaxable}`);
    assert.ok(y.ftc.general.frac + (y.ftc.passive?.frac ?? 0) <= 1 + 1e-6,
      'the §904 fractions must still partition');
  });

  test('PAL-7: no passive activity leaves the return untouched', () => {
    const r = rates();
    const y = r.computeTax(usState({ usOrdinaryIncomeYTD: 180_000 }));
    assert.equal(y.passiveLoss.suspended, 0);
    assert.equal(y.passiveLoss.closing, 0);
    assert.equal(y.inputs.grossOrdinaryIncome, 180_000);
    assert.ok(!y.lineItems.some(l => /§469|Passive Loss/i.test(l.label)),
      'no §469 lines on an ordinary return');
  });

  test('PAL-8: the return shows the suspension and still foots', () => {
    const r = rates();
    const y = r.computeTax(withRental(200_000, -40_000));
    const labels = y.lineItems.map(l => l.label);
    assert.ok(labels.includes('Passive Loss Suspended (§469)'));
    assert.ok(labels.includes('Suspended Passive Losses — carried forward'));
    assert.ok(Math.abs(y.grossTax - y.credits - y.netLiability) < 0.005,
      `gross ${y.grossTax} − credits ${y.credits} != net ${y.netLiability}`);
  });

  test('PAL-U1: the limitation function itself, at the edges', () => {
    // Suspension and release are mutually exclusive by construction.
    const loss = _computePassiveLossLimitation({
      usPassiveActivityIncomeYTD: -10_000, usPassiveLossCarryforward: 5_000,
    });
    assert.deepEqual([loss.suspended, loss.released, loss.closing], [10_000, 0, 15_000]);
    assert.equal(loss.adjustment, 10_000, 'income is raised by the suspended loss');

    // A negative pool (a corrupt save) is floored rather than becoming income.
    const neg = _computePassiveLossLimitation({
      usPassiveActivityIncomeYTD: 8_000, usPassiveLossCarryforward: -3_000,
    });
    assert.deepEqual([neg.released, neg.closing, neg.adjustment], [0, 0, 0]);

    // Absent accumulators ⇒ entirely inert.
    assert.deepEqual(_computePassiveLossLimitation({}),
      { opening: 0, netPassive: 0, suspended: 0, released: 0, closing: 0,
        adjustment: 0, foreignAdjustment: -0 });
  });

  test('PAL-U2: a DOMESTIC rental loss does not touch the foreign basket', () => {
    // usForeignPassiveActivityIncomeYTD stays 0 for a US property, so the add-back
    // must not be attributed to the foreign passive basket.
    const dom = _computePassiveLossLimitation({
      usPassiveActivityIncomeYTD: -20_000, usForeignPassiveActivityIncomeYTD: 0,
    });
    assert.equal(dom.suspended, 20_000);
    assert.equal(dom.foreignAdjustment, 0, 'nothing leaves the foreign basket');
  });
});
