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
 * evt-tips-real-yield.test.mjs — TIPS at a market real yield (design 121 §8).
 *
 * TIPS-1  trailing inflation is level(now) ÷ level(a year ago) − 1, read off the per-year
 *         history less its spread; with no history it is the current effective rate
 * TIPS-2  the market real yield is the nominal curve at the tenor less trailing inflation,
 *         with no floor — §8's check against §4: −1.0 % in phase 1, +7.2 % in phase 2
 * TIPS-3  build: an unpinned TIPS ladder prices every rung at the real yield for its own
 *         tenor and stamps MARKET; a pinned one keeps its coupon and stamps PINNED; a nominal
 *         ladder is unchanged and carries no mode
 * TIPS-4  roll: a MARKET rung re-locks at the real yield for the roll term; a PINNED rung,
 *         and a rung with no mode (pre-design-121 or editor-built), keeps its coupon
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { trailingInflation, tipsRealYield, resolveYield } from '../../src/finance/economic-regimes/yield-curve.js';
import { BondLadderReducer }   from '../../src/finance/behavioral/bond-ladder-reducer.js';
import { BondMaturityReducer } from '../../src/finance/economic-regimes/bond-maturity-reducer.js';
import { ALLOCATION }          from '../../src/finance/holdings/allocation.js';

const ms = (y, m = 0, d = 1) => Date.UTC(y, m, d);
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-12, `${what}: expected ${b}, got ${a}`);

/** A US curve: anchor `fi` at the 5-year, 1y −0.5 pp, 10y +0.5 pp. */
const CURVE = [{ tenor: 1, spread: -0.005 }, { tenor: 5, spread: 0 }, { tenor: 10, spread: 0.005 }];

function rateState({ fi = 0.05, year = 2031, levels = null, spread = 0, infl = 0.03 } = {}) {
  return {
    effectiveInterestRates:  { FIXED_INCOME_US: fi },
    yieldCurve:              { US: CURVE },
    effectiveInflationRates: { US: infl },
    currentPeriods:          { US: { startMs: ms(year) } },
    ...(levels ? { bracketIndexAccumulatorByYear: { US: levels } } : {}),
    ...(spread ? { bracketIndexSpreads: { US: spread } } : {}),
  };
}

test('TIPS-1: trailing inflation reads the per-year history, less its spread', () => {
  near(trailingInflation(rateState({ levels: { 2030: 1.0, 2031: 1.05 } }), 'US'), 0.05, 'no spread');
  near(trailingInflation(rateState({ levels: { 2030: 1.0, 2031: 1.06 }, spread: 0.01 }), 'US'), 0.05,
    'spread removed');
  // It is the TRAILING year, not the current rate: a surge priced in this year is not yet in it.
  near(trailingInflation(rateState({ levels: { 2030: 1.0, 2031: 1.03 }, infl: 0.09 }), 'US'), 0.03,
    'trailing, not current');
  near(trailingInflation(rateState({ infl: 0.04 }), 'US'), 0.04, 'no history ⇒ the current rate');
  near(trailingInflation(rateState({ levels: { 2031: 1.05 }, infl: 0.04 }), 'US'), 0.04,
    'one year of history is not 12 months');
});

test('TIPS-2: the real yield is nominal at the tenor less trailing inflation, with no floor', () => {
  const s = rateState({ fi: 0.05, levels: { 2030: 1.0, 2031: 1.03 } });
  near(tipsRealYield(s, { rateKey: 'FIXED_INCOME_US', tenorYears: 10 }),
    resolveYield(s, { rateKey: 'FIXED_INCOME_US', tenorYears: 10 }) - 0.03, '10-year');
  assert.equal(tipsRealYield({}, { rateKey: 'FIXED_INCOME_US' }), null, 'no anchor ⇒ null');

  // §8's check against §4's calibrated stagflation, at the 5-year anchor.
  near(tipsRealYield(rateState({ fi: 0.070, levels: { 2030: 1.0, 2031: 1.08 } }),
    { rateKey: 'FIXED_INCOME_US', tenorYears: 5 }), -0.010, 'phase 1: negative, not floored');
  near(tipsRealYield(rateState({ fi: 0.102, levels: { 2030: 1.0, 2031: 1.03 } }),
    { rateKey: 'FIXED_INCOME_US', tenorYears: 5 }), 0.072, 'phase 2');
});

// ── Build ────────────────────────────────────────────────────────────────────────────

function buildLadder(opts, state) {
  const s = { ...state, acct: { role: 'us-stock', country: 'US', balance: 50_000,
    holdings: [{ id: 'b', allocation: ALLOCATION.BOND, marketValue: 50_000, costBasis: 50_000 }] } };
  const out = new BondLadderReducer({ stateKey: 'acct', targetRungs: 5, ...opts })
    .reduce(s, { type: 'US_PERIOD_ADVANCE' });
  return out.acct.holdings.filter(h => h.allocation === ALLOCATION.BOND);
}

test('TIPS-3: an unpinned TIPS ladder builds at the real yield; pinned and nominal are unchanged', () => {
  const s = rateState({ fi: 0.05, levels: { 2030: 1.0, 2031: 1.04 } });

  const tips = buildLadder({ inflationLinked: true }, s);
  assert.equal(tips.length, 5);
  tips.forEach((h, k) => {
    near(h.couponRate, resolveYield(s, { rateKey: 'FIXED_INCOME_US', tenorYears: k + 1 }) - 0.04, `rung ${k}`);
    assert.equal(h.tipsCouponMode, 'MARKET');
  });

  const pinned = buildLadder({ inflationLinked: true, couponRate: 0.018 }, s);
  assert.ok(pinned.every(h => h.couponRate === 0.018 && h.tipsCouponMode === 'PINNED'));
  const forced = buildLadder({ inflationLinked: true, couponRate: 0.018, tipsCouponMode: 'MARKET' }, s);
  assert.ok(forced.every(h => h.couponRate === 0.018 && h.tipsCouponMode === 'MARKET'),
    'a pinned coupon is respected at build whatever the roll mode');

  const nominal = buildLadder({}, s);
  nominal.forEach((h, k) => {
    near(h.couponRate, resolveYield(s, { rateKey: 'FIXED_INCOME_US', tenorYears: k + 1 }), `nominal rung ${k}`);
    assert.ok(!('tipsCouponMode' in h), 'a nominal rung carries no mode');
  });
});

// ── Roll ─────────────────────────────────────────────────────────────────────────────

function rollOne(rungFields, state) {
  const asOf = ms(2031, 0, 2);
  const s = {
    ...state,
    currentPeriods: { US: { startMs: asOf } },
    acct: { balance: 10_000, holdings: [{
      id: 't', allocation: 'BOND', marketValue: 10_000, costBasis: 10_000, faceValue: 10_000,
      maturityDate: new Date(ms(2031)), purchaseDate: new Date(ms(2026)),
      rollAtMaturity: true, rollTermYears: 10, inflationLinked: true, couponRate: 0.015,
      rateKey: 'FIXED_INCOME_US', ...rungFields,
    }] },
  };
  return new BondMaturityReducer().reduce(s, { type: 'US_PERIOD_ADVANCE' }).acct.holdings[0];
}

test('TIPS-4: a MARKET rung re-locks at the real yield on roll; PINNED and legacy keep their coupon', () => {
  const s = rateState({ fi: 0.06, levels: { 2030: 1.0, 2031: 1.035 } });
  const real10 = resolveYield(s, { rateKey: 'FIXED_INCOME_US', tenorYears: 10 }) - 0.035;

  const market = rollOne({ tipsCouponMode: 'MARKET' }, s);
  assert.equal(market.inflationLinked, true, 'rolled into another TIPS');
  near(market.couponRate, real10, 'MARKET re-locks');
  assert.equal(market.tipsCouponMode, 'MARKET', 'and keeps its rule for the next roll');

  assert.equal(rollOne({ tipsCouponMode: 'PINNED' }, s).couponRate, 0.015, 'PINNED keeps its coupon');
  assert.equal(rollOne({}, s).couponRate, 0.015, 'no mode (legacy / editor-built) keeps its coupon');
});
