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
 * yield-curve.test.mjs — design 67 (bond yield curve / term structure).
 *
 * The curve is representation C: the `effectiveInterestRates[FIXED_INCOME_{country}]`
 * scalar is the LEVEL anchor, and `state.yieldCurve[country]` is an additive SHAPE of
 * `{ tenor, spread }` points, linearly interpolated and clamped. A bond's own-tenor
 * yield is `level + interpolateSpread(shape, tenor)`; an absent shape ⇒ flat ⇒
 * byte-identical to the pre-67 single rate.
 *
 * Covers: the primitive (interpolateSpread / resolveYield / countryOfRateKey), the
 * back-compat identity at each rerouted consumer (flat ≡ single-rate), and the
 * headline payoff — a ladder earns a term premium on an upward curve, and a curve
 * twist marks a long bond differently from a short one.
 */

import { test, describe, beforeEach } from 'node:test';
import assert                         from 'node:assert/strict';

import {
  interpolateSpread, resolveYield, countryOfRateKey,
} from '../../src/finance/economic-regimes/yield-curve.js';
import { RATE_KEYS, RATE_KEY_META } from '../../src/finance/economic-regimes/rate-keys.js';
import { BondPriceAdjustReducer }   from '../../src/finance/economic-regimes/bond-price-adjust-reducer.js';
import { BondMaturityReducer }      from '../../src/finance/economic-regimes/bond-maturity-reducer.js';
import { materializeLadder }        from '../../src/finance/behavioral/bond-ladder-reducer.js';
import { Holding }                  from '../../src/finance/holdings/holding.js';
import { ALLOCATION }               from '../../src/finance/holdings/allocation.js';

const US = RATE_KEYS.FIXED_INCOME_US;
const AU = RATE_KEYS.FIXED_INCOME_AU;
const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;
const ms = (y, m = 0, d = 1) => Date.UTC(y, m, d);

// A realistic upward-sloping shape anchored at the 5y level (spread 0).
const SLOPED = [
  { tenor: 1,  spread: -0.010 },
  { tenor: 5,  spread:  0.000 },
  { tenor: 10, spread:  0.006 },
  { tenor: 30, spread:  0.012 },
];

// ─── interpolateSpread ─────────────────────────────────────────────────────────

describe('interpolateSpread', () => {
  test('empty / absent shape ⇒ 0 at every tenor (the flat identity)', () => {
    for (const t of [0.5, 1, 5, 20, 40]) {
      assert.equal(interpolateSpread([], t), 0);
      assert.equal(interpolateSpread(null, t), 0);
      assert.equal(interpolateSpread(undefined, t), 0);
    }
  });

  test('returns the anchor spread exactly at each anchor point', () => {
    assert.equal(interpolateSpread(SLOPED, 1), -0.010);
    assert.equal(interpolateSpread(SLOPED, 5), 0);
    assert.equal(interpolateSpread(SLOPED, 10), 0.006);
    assert.equal(interpolateSpread(SLOPED, 30), 0.012);
  });

  test('linear interpolation between anchors', () => {
    // Midway 1y↔5y: (-0.010 + 0) / 2 at tenor 3.
    assert.ok(Math.abs(interpolateSpread(SLOPED, 3) - (-0.005)) < 1e-12);
    // Midway 5y↔10y (tenor 7.5): 0.003.
    assert.ok(Math.abs(interpolateSpread(SLOPED, 7.5) - 0.003) < 1e-12);
  });

  test('clamps to the endpoints beyond the first/last anchor', () => {
    assert.equal(interpolateSpread(SLOPED, 0.25), -0.010); // below first ⇒ first
    assert.equal(interpolateSpread(SLOPED, 100),   0.012); // above last  ⇒ last
  });

  test('unsorted anchors and malformed points are tolerated', () => {
    const messy = [{ tenor: 10, spread: 0.006 }, { tenor: 1, spread: -0.010 },
                   { tenor: NaN, spread: 0.5 }, { tenor: 5, spread: 0 }, null];
    assert.ok(Math.abs(interpolateSpread(messy, 3) - (-0.005)) < 1e-12);
  });
});

// ─── countryOfRateKey ──────────────────────────────────────────────────────────

describe('countryOfRateKey', () => {
  test('maps FIXED_INCOME_* to its country, else null', () => {
    assert.equal(countryOfRateKey(US), 'US');
    assert.equal(countryOfRateKey(AU), 'AU');
    assert.equal(countryOfRateKey('SAVINGS_US'), 'US');
    assert.equal(countryOfRateKey(null), null);
    assert.equal(countryOfRateKey('GOLD'), null);
  });
});

// ─── resolveYield ──────────────────────────────────────────────────────────────

describe('resolveYield', () => {
  const flat  = { effectiveInterestRates: { [US]: 0.04 } };
  const curve = { effectiveInterestRates: { [US]: 0.04 }, yieldCurve: { US: SLOPED } };

  test('flat curve ⇒ the level at every tenor (back-compat identity)', () => {
    for (const t of [1, 2, 5, 10, 30, null]) {
      assert.equal(resolveYield(flat, { rateKey: US, tenorYears: t }), 0.04);
    }
  });

  test('null tenor (perpetual fund) resolves at the 5y fund point', () => {
    assert.equal(RATE_KEY_META[US].defaultDuration, 5);
    // On a sloped curve the 5y anchor has spread 0, so a fund is unchanged.
    assert.equal(resolveYield(curve, { rateKey: US, tenorYears: null }), 0.04);
  });

  test('sloped curve ⇒ level + own-tenor spread (long > short)', () => {
    assert.ok(Math.abs(resolveYield(curve, { rateKey: US, tenorYears: 1 })  - 0.030) < 1e-12);
    assert.ok(Math.abs(resolveYield(curve, { rateKey: US, tenorYears: 30 }) - 0.052) < 1e-12);
    assert.ok(resolveYield(curve, { rateKey: US, tenorYears: 30 })
            > resolveYield(curve, { rateKey: US, tenorYears: 1 }));
  });

  test('per-account `<rateKey>::<stateKey>` override wins over the shared level', () => {
    const s = { effectiveInterestRates: { [US]: 0.04, [`${US}::acctA`]: 0.06 }, yieldCurve: { US: SLOPED } };
    // 30y off the 0.06 per-account level = 0.072.
    assert.ok(Math.abs(resolveYield(s, { rateKey: US, stateKey: 'acctA', tenorYears: 30 }) - 0.072) < 1e-12);
  });

  test('absent anchor / missing rateKey ⇒ null (preserves the float fallback)', () => {
    assert.equal(resolveYield(curve, { rateKey: 'NOPE', tenorYears: 3 }), null);
    assert.equal(resolveYield(curve, { rateKey: null, tenorYears: 3 }), null);
    assert.equal(resolveYield({}, { rateKey: US, tenorYears: 3 }), null);
  });

  test('independent AU shape off the AU anchor', () => {
    const s = { effectiveInterestRates: { [AU]: 0.03 }, yieldCurve: { AU: SLOPED, US: [] } };
    assert.ok(Math.abs(resolveYield(s, { rateKey: AU, tenorYears: 30 }) - 0.042) < 1e-12);
    // US on the same state is flat (no US shape).
    const sUs = { effectiveInterestRates: { [US]: 0.04 }, yieldCurve: { AU: SLOPED, US: [] } };
    assert.equal(resolveYield(sUs, { rateKey: US, tenorYears: 30 }), 0.04);
  });
});

// ─── Consumer: BondPriceAdjustReducer (curve twist marks by tenor) ──────────────

function bondState({ shape, priorShape, level, priorLevel, ttmYears, asOfY = 2030 }) {
  const maturityDate = ttmYears != null ? new Date(ms(asOfY) + ttmYears * YEAR_MS) : null;
  const h = new Holding({ allocation: ALLOCATION.BOND, marketValue: 100_000, rateKey: US, duration: 30 });
  h.id = 'h1';
  if (maturityDate) h.maturityDate = maturityDate;
  return {
    effectiveInterestRates: { [US]: level },
    priorMarkRates:         { [US]: priorLevel },
    yieldCurve:             { US: shape },
    priorMarkCurve:         { US: priorShape ?? shape },
    currentPeriods:         { US: { startMs: ms(asOfY) } },
    acct: { balance: 100_000, holdings: [h] },
  };
}

describe('BondPriceAdjustReducer — curve reroute', () => {
  let reducer;
  beforeEach(() => { reducer = new BondPriceAdjustReducer(); });

  test('flat curve ≡ pre-67 single-rate mark (level delta only)', () => {
    // No shape → the mark is exactly -effDuration·Δlevel·mv, as before design 67.
    const st = bondState({ shape: [], level: 0.05, priorLevel: 0.04, ttmYears: null });
    const next = reducer.reduce(st, { type: 'US_PERIOD_ADVANCE' });
    const mv = next.acct.holdings[0].marketValue;
    const expected = 100_000 + (-(30 * (0.05 - 0.04) * 100_000)); // effDuration = staticDuration (fund)
    assert.ok(Math.abs(mv - expected) < 0.02, `flat mark ${mv} vs ${expected}`);
  });

  test('a curve twist (shape steepens) marks a long bond down even with the level flat', () => {
    // Level unchanged; the 30y spread rises from 0 → +0.012 between periods (a bear
    // steepener at the long end). effDuration for a 30y (staticDuration 30, ttm 30) = 30.
    const st = bondState({
      shape: SLOPED, priorShape: [{ tenor: 30, spread: 0 }],
      level: 0.05, priorLevel: 0.05, ttmYears: 30,
    });
    const next = reducer.reduce(st, { type: 'US_PERIOD_ADVANCE' });
    assert.ok(next.acct.holdings[0].marketValue < 100_000,
      'a long-end steepening (own-tenor yield up) must mark the long bond down with the level flat');
  });

  test('priorMarkCurve is snapshotted after the mark', () => {
    const st = bondState({ shape: SLOPED, level: 0.05, priorLevel: 0.05, ttmYears: 10 });
    const next = reducer.reduce(st, { type: 'US_PERIOD_ADVANCE' });
    assert.deepEqual(next.priorMarkCurve.US, SLOPED);
  });
});

// ─── Consumer: materializeLadder (term premium) ─────────────────────────────────

describe('materializeLadder — term premium', () => {
  const state = { effectiveInterestRates: { [US]: 0.04 }, yieldCurve: { US: SLOPED } };
  const asOfMs = ms(2030);

  test('each rung is priced at its own tenor on an upward curve (long rung > short rung)', () => {
    const rungs = materializeLadder({
      bondValue: 100_000, rungs: 5, spacingYears: 1, asOfMs,
      stateKey: 'x', rateKey: US, couponRate: 0.04,
      couponForTenor: (t) => resolveYield(state, { rateKey: US, tenorYears: t }),
    });
    const coupons = rungs.map(r => r.couponRate);
    // 1y..5y off the sloped curve = 0.03, 0.0325, 0.035, 0.0375, 0.04.
    assert.ok(coupons[0] < coupons[4], 'the long rung must earn more than the short rung');
    assert.ok(Math.abs(coupons[0] - 0.03) < 1e-9);
    assert.ok(Math.abs(coupons[4] - 0.04) < 1e-9);
  });

  test('flat curve ⇒ every rung at the level (back-compat identity)', () => {
    const flat = { effectiveInterestRates: { [US]: 0.04 }, yieldCurve: { US: [] } };
    const rungs = materializeLadder({
      bondValue: 100_000, rungs: 5, spacingYears: 1, asOfMs,
      stateKey: 'x', rateKey: US, couponRate: 0.04,
      couponForTenor: (t) => resolveYield(flat, { rateKey: US, tenorYears: t }),
    });
    for (const r of rungs) assert.equal(r.couponRate, 0.04);
  });

  test('no resolver (UI builder path) falls back to the flat couponRate', () => {
    const rungs = materializeLadder({
      bondValue: 100_000, rungs: 3, spacingYears: 1, asOfMs,
      stateKey: 'x', rateKey: US, couponRate: 0.045,
    });
    for (const r of rungs) assert.equal(r.couponRate, 0.045);
  });
});

// ─── Consumer: BondMaturityReducer roll (re-lock at the roll-term tenor) ─────────

describe('BondMaturityReducer — roll re-locks at the roll-term yield', () => {
  test('a rolling rung re-locks its coupon at the ladder-term (rollTermYears) point', () => {
    const asOfY = 2030;
    const matured = new Holding({
      allocation: ALLOCATION.BOND, marketValue: 20_000, rateKey: US, duration: 5,
    });
    matured.id = 'r0';
    matured.faceValue = 20_000;
    matured.maturityDate = new Date(ms(asOfY));       // matured now
    matured.purchaseDate = new Date(ms(asOfY - 5));
    matured.rollAtMaturity = true;
    matured.rollTermYears  = 5;                        // rolls into a fresh 5y bond
    matured.couponRate     = 0.02;

    const state = {
      effectiveInterestRates: { [US]: 0.04 },
      yieldCurve:             { US: SLOPED },
      currentPeriods:         { US: { startMs: ms(asOfY) } },
      acct: { balance: 20_000, holdings: [matured] },
    };
    const next = new BondMaturityReducer().reduce(state, { type: 'US_PERIOD_ADVANCE' });
    const rolled = next.acct.holdings[0];
    // 5y point spread is 0 ⇒ re-locks at the level 0.04 (not the old 0.02).
    assert.ok(Math.abs(rolled.couponRate - 0.04) < 1e-9, `rolled coupon ${rolled.couponRate}`);
  });
});
