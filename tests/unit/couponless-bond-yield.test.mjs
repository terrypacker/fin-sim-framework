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
 * couponless-bond-yield.test.mjs — design 99 P5a (D-6): a BOND lot with no contractual
 * coupon floats on the regime-adjusted curve at its remaining tenor; one that names a
 * coupon keeps it; TIPS and zero-coupon lots keep their existing fallback.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { couponlessYield, yearsToMaturity } from '../../src/finance/economic-regimes/couponless-yield.js';
import { computeHoldingsCoupons }          from '../../src/finance/holdings/holdings-earnings.js';

const CURVE = [{ tenor: 1, spread: -0.010 }, { tenor: 5, spread: 0 }, { tenor: 10, spread: 0.006 }];
// A rate regime has pushed the US fixed-income level from the 4% param to 5.5%.
const STATE = { effectiveInterestRates: { FIXED_INCOME_US: 0.055 }, yieldCurve: { US: CURVE } };
const AS_OF = new Date(Date.UTC(2030, 0, 1));
const near  = (a, b) => Math.abs(a - b) < 1e-12;

test('CBY-1: a fund (no maturity) earns the regime-adjusted level at the 5y anchor', () => {
  assert.ok(near(couponlessYield(STATE, { rateKey: 'FIXED_INCOME_US' }, { asOf: AS_OF }), 0.055));
});

test('CBY-2: a dated lot earns the curve at its REMAINING tenor', () => {
  const tenYear = { rateKey: 'FIXED_INCOME_US', maturityDate: new Date(Date.UTC(2040, 0, 1)) };
  const oneYear = { rateKey: 'FIXED_INCOME_US', maturityDate: new Date(Date.UTC(2031, 0, 1)) };
  assert.ok(Math.abs(yearsToMaturity(tenYear, AS_OF.getTime()) - 10) < 0.01);
  assert.ok(Math.abs(couponlessYield(STATE, tenYear, { asOf: AS_OF }) - (0.055 + 0.006)) < 1e-4);
  assert.ok(Math.abs(couponlessYield(STATE, oneYear, { asOf: AS_OF }) - (0.055 - 0.010)) < 1e-4);
});

test('CBY-3: TIPS and zero-coupon lots do not float; no curve in state ⇒ null', () => {
  assert.equal(couponlessYield(STATE, { rateKey: 'FIXED_INCOME_US', inflationLinked: true }, { asOf: AS_OF }), null);
  assert.equal(couponlessYield(STATE, { rateKey: 'FIXED_INCOME_US', zeroCoupon: true }, { asOf: AS_OF }), null);
  assert.equal(couponlessYield({}, { rateKey: 'FIXED_INCOME_US' }, { asOf: AS_OF }), null);
});

test('CBY-4: the coupon path — an authored coupon is fixed; a coupon-less lot floats; flat param is the last resort', () => {
  const state = {
    ...STATE,
    acct: { holdings: [
      { id: 'fixed', allocation: 'BOND', rateKey: 'FIXED_INCOME_US', marketValue: 100_000, couponRate: 0.03 },
      { id: 'fund',  allocation: 'BOND', rateKey: 'FIXED_INCOME_US', marketValue: 100_000 },
    ] },
  };
  const { amount } = computeHoldingsCoupons({ state, stateKey: 'acct', fallbackRate: 0.04, currentDate: AS_OF });
  assert.equal(amount, 3_000 + 5_500, 'the fund earns the regime-adjusted 5.5%, not the flat 4% param');

  const noCurve = { acct: state.acct };
  assert.equal(computeHoldingsCoupons({ state: noCurve, stateKey: 'acct', fallbackRate: 0.04, currentDate: AS_OF }).amount,
    3_000 + 4_000, 'with no curve in state the flat param still pays');
});
