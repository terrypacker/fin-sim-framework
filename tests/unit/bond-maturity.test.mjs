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
 * bond-maturity.test.mjs — design 66 §G4 (maturity & pull-to-par).
 *
 * Covers the two new mechanics an *individual bond* (a BOND holding with a
 * non-null `maturityDate`) gains over a perpetual bond *fund*:
 *   1. Effective-duration decay + pull-to-par convergence in BondPriceAdjustReducer.
 *   2. Redemption-at-par (to cash) / roll in BondMaturityReducer.
 */

import { test, describe, beforeEach } from 'node:test';
import assert                         from 'node:assert/strict';

import { BondPriceAdjustReducer } from '../../src/finance/economic-regimes/bond-price-adjust-reducer.js';
import { BondMaturityReducer }    from '../../src/finance/economic-regimes/bond-maturity-reducer.js';
import { ALLOCATION }             from '../../src/finance/holdings/allocation.js';
import { RATE_KEYS }              from '../../src/finance/economic-regimes/rate-keys.js';
import { Holding }                from '../../src/finance/holdings/holding.js';

const ms = (y, m = 0, d = 1) => Date.UTC(y, m, d);

function bond(overrides = {}) {
  const h = new Holding({
    allocation:  ALLOCATION.BOND,
    marketValue: 100_000,
    rateKey:     RATE_KEYS.FIXED_INCOME_US,
    duration:    5,
    ...overrides,
  });
  h.id = overrides.id ?? 'b1';
  return h;
}

/** State with one account + a US period at `asOfY`, and a prior mark one year back. */
function stateWith(holding, { asOfY = 2030, effectiveRate = 0.04, priorRate = 0.04 } = {}) {
  return {
    effectiveInterestRates: { [RATE_KEYS.FIXED_INCOME_US]: effectiveRate },
    priorMarkRates:         { [RATE_KEYS.FIXED_INCOME_US]: priorRate },
    priorMarkMs:            ms(asOfY - 1),
    currentPeriods:         { US: { startMs: ms(asOfY) } },
    acct: { balance: holding.marketValue, holdings: [holding] },
  };
}

// ─── Duration decay ───────────────────────────────────────────────────────────

describe('BondPriceAdjustReducer — maturity-decayed duration (§G4)', () => {
  let reducer;
  beforeEach(() => { reducer = new BondPriceAdjustReducer(); });

  test('individual bond near maturity marks LESS than a fund on the same rate move', () => {
    // faceValue null on both ⇒ isolate the rate-mark effect (no pull-to-par).
    const fund  = bond({ id: 'fund',  maturityDate: null });
    const indiv = bond({ id: 'indiv', maturityDate: new Date(ms(2031)) }); // ttm ≈ 1yr < duration 5

    const fundNext  = reducer.reduce(stateWith(fund,  { effectiveRate: 0.05, priorRate: 0.04 }), { type: 'US_PERIOD_ADVANCE' });
    const indivNext = reducer.reduce(stateWith(indiv, { effectiveRate: 0.05, priorRate: 0.04 }), { type: 'US_PERIOD_ADVANCE' });

    const fundDrop  = 100_000 - fundNext.acct.holdings[0].marketValue;
    const indivDrop = 100_000 - indivNext.acct.holdings[0].marketValue;
    // Fund uses full duration 5; individual uses min(5, ~1) ≈ 1 → ~1/5 the move.
    assert.ok(fundDrop > 4000 && fundDrop < 5001, `fund drop ${fundDrop}`);
    assert.ok(indivDrop > 500 && indivDrop < 1100, `individual drop ${indivDrop}`);
    assert.ok(indivDrop < fundDrop / 3, 'individual bond near maturity is far less rate-sensitive');
  });
});

// ─── Pull-to-par convergence ───────────────────────────────────────────────────

describe('BondPriceAdjustReducer — pull-to-par (§G4)', () => {
  let reducer;
  beforeEach(() => { reducer = new BondPriceAdjustReducer(); });

  test('a marked-down individual bond recovers toward faceValue with no rate change', () => {
    const h = bond({ marketValue: 95_000, faceValue: 100_000, maturityDate: new Date(ms(2034)) }); // ttm ≈ 4yr
    const next = reducer.reduce(stateWith(h, { effectiveRate: 0.04, priorRate: 0.04 }), { type: 'US_PERIOD_ADVANCE' });
    const mv = next.acct.holdings[0].marketValue;
    // frac ≈ dt/(ttm+dt) ≈ 1/5 → recover ~1/5 of the 5,000 gap ≈ +1,000.
    assert.ok(mv > 95_500 && mv < 96_500, `expected ~96,000, got ${mv}`);
  });

  test('at maturity the price snaps fully to par', () => {
    const h = bond({ marketValue: 95_000, faceValue: 100_000, maturityDate: new Date(ms(2030)) }); // ttm = 0
    const next = reducer.reduce(stateWith(h, { asOfY: 2030, effectiveRate: 0.04, priorRate: 0.04 }), { type: 'US_PERIOD_ADVANCE' });
    assert.equal(next.acct.holdings[0].marketValue, 100_000);
  });

  test('a bond fund (no maturityDate) is NOT pulled to par', () => {
    const h = bond({ marketValue: 95_000, faceValue: null, maturityDate: null });
    const next = reducer.reduce(stateWith(h, { effectiveRate: 0.04, priorRate: 0.04 }), { type: 'US_PERIOD_ADVANCE' });
    assert.equal(next.acct.holdings[0].marketValue, 95_000, 'perpetual fund does not recover on its own');
  });

  test('priorMarkMs is stamped for the next period', () => {
    const h = bond({ maturityDate: new Date(ms(2034)), faceValue: 100_000 });
    const next = reducer.reduce(stateWith(h, { asOfY: 2030 }), { type: 'US_PERIOD_ADVANCE' });
    assert.equal(next.priorMarkMs, ms(2030));
  });
});

// ─── Redemption / roll ──────────────────────────────────────────────────────────

describe('BondMaturityReducer — redemption at par (§G4)', () => {
  let reducer;
  beforeEach(() => { reducer = new BondMaturityReducer(); });

  test('a matured bond is redeemed to a CASH holding at faceValue', () => {
    const h = bond({ marketValue: 99_800, faceValue: 100_000, costBasis: 100_000, maturityDate: new Date(ms(2030)) });
    const next = reducer.reduce(stateWith(h, { asOfY: 2030 }), { type: 'US_PERIOD_ADVANCE' });
    const red = next.acct.holdings[0];
    assert.equal(red.allocation, ALLOCATION.CASH);
    assert.equal(red.marketValue, 100_000);
    assert.equal(red.costBasis, 100_000);
    assert.equal(red.maturityDate, null);
    assert.equal(red.faceValue, null);
    assert.equal(red.couponRate, null);
    assert.equal(red.id, 'b1', 'holding id is preserved');
    assert.equal(next.acct.balance, 100_000, 'balance re-syncs to the redeemed value');
  });

  test('a not-yet-matured bond is left untouched', () => {
    const h = bond({ faceValue: 100_000, maturityDate: new Date(ms(2035)) }); // after 2030 asOf
    const next = reducer.reduce(stateWith(h, { asOfY: 2030 }), { type: 'US_PERIOD_ADVANCE' });
    assert.equal(next.acct.holdings[0].allocation, ALLOCATION.BOND);
    assert.equal(next.acct.holdings[0].maturityDate.getTime(), ms(2035));
  });

  test('a bond fund (no maturityDate) never matures', () => {
    const h = bond({ maturityDate: null });
    const next = reducer.reduce(stateWith(h, { asOfY: 2099 }), { type: 'US_PERIOD_ADVANCE' });
    assert.equal(next.acct.holdings[0].allocation, ALLOCATION.BOND);
  });

  test('rollAtMaturity re-issues a fresh par bond at the current yield, same term', () => {
    const h = bond({
      marketValue: 100_000, faceValue: 100_000, costBasis: 100_000,
      purchaseDate: new Date(ms(2025)), maturityDate: new Date(ms(2030)),   // 5-year term
      couponRate: 0.03, rollAtMaturity: true,
    });
    const st = stateWith(h, { asOfY: 2030, effectiveRate: 0.06 });          // market yield now 6%
    const next = reducer.reduce(st, { type: 'US_PERIOD_ADVANCE' });
    const rolled = next.acct.holdings[0];
    assert.equal(rolled.allocation, ALLOCATION.BOND, 'still a bond after rolling');
    assert.equal(rolled.couponRate, 0.06, 'new coupon locks in the current market yield');
    assert.equal(rolled.purchaseDate.getTime(), ms(2030), 'roll date is the new acquisition date');
    assert.equal(rolled.maturityDate.getTime(), ms(2035), 'same 5-year term rolled forward');
    assert.equal(rolled.marketValue, 100_000);
  });
});

// ─── Ladder roll-to-tail (§G8) ──────────────────────────────────────────────────

describe('BondMaturityReducer — ladder roll-to-tail (§G8)', () => {
  let reducer;
  beforeEach(() => { reducer = new BondMaturityReducer(); });

  test('a rung with rollTermYears rolls to the ladder TAIL, not its own term', () => {
    // Own term is 5y (2025→2030), but the ladder length is 8y. On maturity the near
    // rung must roll to +8y (→2038) to become the new far rung — NOT +5y.
    const rung = bond({
      marketValue: 20_000, faceValue: 20_000, costBasis: 20_000,
      purchaseDate: new Date(ms(2025)), maturityDate: new Date(ms(2030)),
      couponRate: 0.03, rollAtMaturity: true, rollTermYears: 8,
    });
    const next = reducer.reduce(stateWith(rung, { asOfY: 2030, effectiveRate: 0.05 }), { type: 'US_PERIOD_ADVANCE' });
    const rolled = next.acct.holdings[0];
    assert.equal(rolled.allocation, ALLOCATION.BOND);
    assert.equal(rolled.maturityDate.getTime(), ms(2038), 'rolls to the fixed ladder term (+8y), not its own +5y');
    assert.equal(rolled.couponRate, 0.05, 'coupon re-locks to the current market yield (G1)');
    assert.equal(rolled.marketValue, 20_000, 'par proceeds redeployed');
    assert.equal(rolled.rollAtMaturity, true, 'keeps rolling every term');
    assert.equal(rolled.rollTermYears, 8, 'ladder length is preserved for the next roll');
  });

  test('a non-rolling ladder rung falls to CASH at maturity (spend-down)', () => {
    const rung = bond({
      marketValue: 20_000, faceValue: 20_000, costBasis: 20_000,
      purchaseDate: new Date(ms(2025)), maturityDate: new Date(ms(2030)),
      rollAtMaturity: false, rollTermYears: 8,   // rollTermYears inert without rollAtMaturity
    });
    const next = reducer.reduce(stateWith(rung, { asOfY: 2030 }), { type: 'US_PERIOD_ADVANCE' });
    const red = next.acct.holdings[0];
    assert.equal(red.allocation, ALLOCATION.CASH, 'redeems to cash');
    assert.equal(red.rollTermYears, null, 'ladder term cleared on redemption');
    assert.equal(red.marketValue, 20_000);
  });

  test('a 5-year ladder self-perpetuates: after advancing a year the near rung re-lands at the tail', () => {
    // Rungs maturing 2031..2035, ladder length 5y (rollTermYears:5), all rolling.
    // Advance the clock to 2031: the 2031 rung matures and rolls to 2036 (2031+5) —
    // exactly the tail, so the set becomes {2032,2033,2034,2035,2036} = {1..5} from now.
    const rungs = [1, 2, 3, 4, 5].map((yr, i) => {
      const h = bond({
        id: `rung-${i}`, marketValue: 20_000, faceValue: 20_000, costBasis: 20_000,
        purchaseDate: new Date(ms(2030)), maturityDate: new Date(ms(2030 + yr)),
        couponRate: 0.04, rollAtMaturity: true, rollTermYears: 5,
      });
      return h;
    });
    const state = {
      effectiveInterestRates: { [RATE_KEYS.FIXED_INCOME_US]: 0.045 },
      currentPeriods:         { US: { startMs: ms(2031) } },
      acct: { balance: 100_000, holdings: rungs },
    };
    const next = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' });
    const maturities = next.acct.holdings.map(h => new Date(h.maturityDate).getUTCFullYear()).sort();
    assert.deepEqual(maturities, [2032, 2033, 2034, 2035, 2036], 'spacing preserved: the matured near rung re-lands at the tail');
    const rolled = next.acct.holdings.find(h => h.id === 'rung-0');
    assert.equal(rolled.allocation, ALLOCATION.BOND, 'the rolled rung is still a bond');
    assert.equal(rolled.couponRate, 0.045, 'rolled rung re-locks the current yield');
    assert.equal(next.acct.balance, 100_000, 'gross value conserved across the roll');
  });

  // The rolled bond used to be re-based at par unconditionally, which was harmless while
  // every bond reaching here WAS a par bond. A ladder rebuild now carries the replaced
  // sleeve's basis onto its rungs (design 62 §9.5 follow-up), so a rung can mature with
  // basis below par — and re-basing at par would erase that gain untaxed, re-opening the
  // hole one maturity at a time.
  test('a roll CARRIES a non-par cost basis instead of stepping it up to par', () => {
    const rung = bond({
      marketValue: 20_000, faceValue: 20_000, costBasis: 12_000,
      costBaseByCountry: { AU: 15_000 }, acquisitionPriceLevel: 1.2,
      purchaseDate: new Date(ms(2025)), maturityDate: new Date(ms(2030)),
      couponRate: 0.03, rollAtMaturity: true, rollTermYears: 8,
    });
    const rolled = reducer
      .reduce(stateWith(rung, { asOfY: 2030 }), { type: 'US_PERIOD_ADVANCE' })
      .acct.holdings[0];
    assert.equal(rolled.marketValue, 20_000, 'par proceeds redeployed');
    assert.equal(rolled.costBasis, 12_000, 'basis carried — the discount is deferred, not erased');
    assert.deepEqual(rolled.costBaseByCountry, { AU: 15_000 }, 'per-country base carried with it');
    assert.equal(rolled.acquisitionPriceLevel, 1.2, 'indexation base carried with it');
    assert.equal(rolled.purchaseDate.getTime(), ms(2030),
      'the holding-period clock still restarts — the rolled bond is a new instrument');
  });

  test('a bond that carries no basis at all still redeploys at par (unchanged)', () => {
    const rung = bond({
      marketValue: 20_000, faceValue: 20_000,
      purchaseDate: new Date(ms(2025)), maturityDate: new Date(ms(2030)),
      rollAtMaturity: true, rollTermYears: 5,
    });
    rung.costBasis = undefined;
    const rolled = reducer
      .reduce(stateWith(rung, { asOfY: 2030 }), { type: 'US_PERIOD_ADVANCE' })
      .acct.holdings[0];
    assert.equal(rolled.costBasis, 20_000, 'falls back to par when there is no basis to carry');
  });
});

// ─── TIPS ladder rungs roll as TIPS (§G5 × §G8) ────────────────────────────────

describe('BondMaturityReducer — an inflation-linked LADDER rung rolls as a TIPS', () => {
  let reducer;
  beforeEach(() => { reducer = new BondMaturityReducer(); });

  // The roll used to hard-set `inflationLinked: false` on every rolled bond. That is
  // right for a LONE accreting instrument (it is not re-issued as one), but on a ladder
  // it silently converted a TIPS ladder into a NOMINAL ladder within one ladder length —
  // the direct opposite of §10.3's "the ladder self-perpetuates", and it re-locked the
  // rung at the NOMINAL curve yield while the principal went on indexing to CPI, paying
  // for inflation twice.
  test('a rolling TIPS rung stays inflation-linked and keeps its REAL coupon', () => {
    const rung = bond({
      marketValue: 26_000,          // principal has indexed up from 20,000
      faceValue: 20_000, costBasis: 26_000,
      purchaseDate: new Date(ms(2025)), maturityDate: new Date(ms(2030)),
      couponRate: 0.01,             // a contracted REAL yield
      rollAtMaturity: true, rollTermYears: 8, inflationLinked: true,
    });
    const next = reducer.reduce(stateWith(rung, { asOfY: 2030, effectiveRate: 0.05 }), { type: 'US_PERIOD_ADVANCE' });
    const rolled = next.acct.holdings[0];
    assert.equal(rolled.inflationLinked, true, 'still a TIPS after the roll');
    assert.equal(rolled.couponRate, 0.01, 'keeps the real yield — NOT re-locked at the 5% nominal curve');
    assert.equal(rolled.maturityDate.getTime(), ms(2038), 'rolls to the ladder tail like any rung');
    assert.equal(rolled.marketValue, 26_000, 'reinvests the INDEXED principal, not the original face');
    assert.equal(rolled.faceValue, 26_000, 'face moves to the indexed principal so the next deflation floor is current');
  });

  test('a LONE inflation-linked bond still rolls into a plain nominal bond (back-compat)', () => {
    const lone = bond({
      marketValue: 26_000, faceValue: 20_000, costBasis: 26_000,
      purchaseDate: new Date(ms(2025)), maturityDate: new Date(ms(2030)),
      couponRate: 0.01, rollAtMaturity: true, inflationLinked: true,   // no rollTermYears ⇒ not a rung
    });
    const next = reducer.reduce(stateWith(lone, { asOfY: 2030, effectiveRate: 0.05 }), { type: 'US_PERIOD_ADVANCE' });
    const rolled = next.acct.holdings[0];
    assert.equal(rolled.inflationLinked, false, 'unchanged §G5 behavior for a bond that is not a ladder rung');
    assert.equal(rolled.couponRate, 0.05, 're-locks at the nominal curve, as before');
  });
});

// ─── Ghost par: a drained lot redeems for nothing ──────────────────────────────

describe('BondMaturityReducer — a zero-value rung cannot redeem its stale par', () => {
  let reducer;
  beforeEach(() => { reducer = new BondMaturityReducer(); });

  // `faceValue` is a parallel field and not every value-move path maintains it. A
  // cross-border transfer sweeping an account leaves its bond lots at zero market value
  // holding full par; redeeming that par mints money from units already spent, and
  // `rollAtMaturity` compounds the invention (measured: $556,636 across 14 empty rungs,
  // and gross income of 1e+66 by the end of a 48-year run).
  test('a nominal rung drained to zero redeems at zero, not at its old face', () => {
    const drained = bond({
      marketValue: 0, faceValue: 41_563, costBasis: 0,
      purchaseDate: new Date(ms(2025)), maturityDate: new Date(ms(2030)),
      rollAtMaturity: true, rollTermYears: 14,
    });
    const h = reducer.reduce(stateWith(drained, { asOfY: 2030 }), { type: 'US_PERIOD_ADVANCE' }).acct.holdings[0];
    assert.equal(h.marketValue, 0);
    assert.equal(h.faceValue, 0, 'the stale par is cleared, not redeemed');
  });

  test('a drained TIPS rung does not mint money through the deflation floor', () => {
    // The floor takes max(marketValue, faceValue), so an empty TIPS rung is the worst
    // case: it redeems at FULL original par with nothing behind it.
    const drained = bond({
      marketValue: 0, faceValue: 41_563, costBasis: 0,
      purchaseDate: new Date(ms(2025)), maturityDate: new Date(ms(2030)),
      rollAtMaturity: true, rollTermYears: 14, inflationLinked: true,
    });
    const h = reducer.reduce(stateWith(drained, { asOfY: 2030 }), { type: 'US_PERIOD_ADVANCE' }).acct.holdings[0];
    assert.equal(h.marketValue, 0, 'the deflation floor protects units still held — not units already spent');
    assert.equal(h.faceValue, 0);
  });

  test('a rung with units left is untouched by the guard', () => {
    const live = bond({
      marketValue: 20_000, faceValue: 20_000, costBasis: 20_000,
      purchaseDate: new Date(ms(2025)), maturityDate: new Date(ms(2030)),
      rollAtMaturity: true, rollTermYears: 8, couponRate: 0.03,
    });
    const h = reducer.reduce(stateWith(live, { asOfY: 2030, effectiveRate: 0.05 }), { type: 'US_PERIOD_ADVANCE' }).acct.holdings[0];
    assert.equal(h.marketValue, 20_000, 'a live rung still rolls at par');
    assert.equal(h.maturityDate.getTime(), ms(2038));
  });
});
