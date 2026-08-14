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
 * section-904b2-rate-differential.test.mjs — the capital gain rate differential
 * adjustment (design 90 §4.5, step 9).
 *
 * **Why this file exists and the golden fixtures do not cover it.** The adjustment scales
 * foreign source capital gain down to the share of full-rate tax it actually bears, on
 * both sides of the §904 fraction. It fires only in a year with a realised capital gain
 * above the \$20,000 adjustment-exception de minimis — one year in fifteen on the
 * reference plan. Every case here therefore builds the gain deliberately.
 *
 * Authority, all on disk:
 *   `docs/us-tax/USCODE-2024-…-sec904.txt` §904(b)(2)(B) — the two clauses, foreign
 *     numerator and "entire taxable income"; §904(b)(3)(E) — the rate differential
 *     portion as `(topRate − altRate) ÷ topRate`.
 *   `docs/us-tax/IRS-Pub-514-Foreign-Tax-Credit-2025.txt` pp.30–32 — Table 4's rate
 *     groups, the published factors, and Example 4 (Beth), used verbatim below.
 *   `docs/us-tax/IRS-Form-1116-Instructions-2025.txt` — the *Worksheet for Line 18*
 *     complements, the line 3d "without regard to any adjustments" rule, and the
 *     adjustment exception's two thresholds.
 *
 * Run with: node --test tests/unit/section-904b2-rate-differential.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { _computeRateDifferentialAdjustment, _computeCapitalLossBasketAdjustment }
  from '../../src/finance/tax/us/us-tax-rates-base.js';
import { UsTaxRates2026 } from '../../src/finance/tax/us/us-tax-rates-2026.js';

/** A 37% top ordinary rate — the rate every published Pub 514 factor is computed at. */
const TOP = 0.37;

/** Defaults that make one rate group the only moving part. */
const adj = (o = {}) => _computeRateDifferentialAdjustment({
  ltcgBands: [], collectibleGain: 0, unrecaptured1250Gain: 0, shortTermGain: 0,
  topOrdinaryRate: TOP, netGeneral: 0, netPassive: 0,
  // Push both exception tests out of the way unless a case is about them.
  taxableOrdinary: Infinity, exceptionThreshold: 0,
  ...o,
});

const near = (actual, expected, eps, msg) =>
  assert.ok(Math.abs(actual - expected) <= eps,
    `${msg ?? ''} expected ≈${expected}, got ${actual}`);

// ─── §904(b)(3)(E): the factor is derived, not transcribed ───────────────────
//
// The statute defines the surviving share as altRate ÷ topRate. Pub 514 publishes that
// ratio evaluated at 37%. Reproducing the published numbers from the formula is what
// proves the derivation is the same arithmetic — and it is the guard that a rate module
// with a different top bracket cannot silently keep 2025's factors.

describe('§904(b)(3)(E) — the published factors are the formula at a 37% top rate', () => {
  const cases = [
    ['15% rate group', { ltcgBands: [{ rate: 0.15, income: 1_000 }] }, 0.4054],
    ['20% rate group', { ltcgBands: [{ rate: 0.20, income: 1_000 }] }, 0.5405],
    ['25% rate group', { unrecaptured1250Gain: 1_000 },                0.6757],
    ['28% rate group', { collectibleGain: 1_000 },                     0.7568],
    ['0% rate group',  { ltcgBands: [{ rate: 0.00, income: 1_000 }] }, 0.0000],
  ];

  for (const [name, group, factor] of cases) {
    test(`${name} survives at ${factor}`, () => {
      const r = adj({ ...group, netPassive: 1_000 });
      near(r.includedFraction, factor, 5e-5, name);
      // Pub 514's line-1a factor and the line-18 worksheet's multiplier are exact
      // complements — 0.7568 and 0.2432. That is the same number seen from both sides
      // of the fraction, and it is why one adjustment can serve numerator and denominator.
      near(r.worldwide, 1_000 * (1 - factor), 0.05, `${name} line-18 complement`);
      near(r.passive,   1_000 * (1 - factor), 0.05, `${name} line-1a reduction`);
    });
  }

  test('short-term gain is not adjusted at all', () => {
    const r = adj({ shortTermGain: 1_000, netPassive: 1_000 });
    assert.equal(r.includedFraction, 1);
    assert.equal(r.worldwide, 0);
    assert.equal(r.passive, 0);
  });

  test('a different top rate moves every factor', () => {
    // §904(b)(3)(E) reads the top rate off §1, so a module with a 39.6% top bracket
    // must produce 15/39.6, not 15/37. Transcribed factors would not.
    const r = adj({ ltcgBands: [{ rate: 0.15, income: 1_000 }], netPassive: 1_000,
                    topOrdinaryRate: 0.396 });
    near(r.includedFraction, 0.15 / 0.396, 1e-9, 'derived from the module top rate');
    assert.notEqual(Math.round(r.includedFraction * 1e4), 4054);
  });
});

// ─── Pub 514 Example 4 (Beth), verbatim ──────────────────────────────────────
//
//   "Beth has \$200 of capital gains in the 28% rate group that are general category
//    income and no other items of capital gain or loss. Beth must adjust the capital gain
//    before it is included on line 1a as follows:  \$200 × 0.7568 = \$151.36"

describe('Pub 514 Example 4 — Beth', () => {
  const beth = () => adj({ collectibleGain: 200, netGeneral: 200 });

  test('the general basket includes \$151.36, not \$200', () => {
    const r = beth();
    near(200 - r.general, 151.36, 0.01, 'line 1a');
  });

  test('the denominator loses the same \$48.64', () => {
    near(beth().worldwide, 200 - 151.36, 0.01, 'Worksheet for Line 18');
  });

  test('the passive basket, having no gain, is untouched', () => {
    assert.equal(beth().passive, 0);
  });
});

// ─── The blend across rate groups ────────────────────────────────────────────

describe('mixed rate groups blend by amount', () => {
  // \$1,000 at 15% (0.4054) and \$1,000 at 28% (0.7568) → (405.4 + 756.8)/2000.
  const mixed = () => adj({
    ltcgBands: [{ rate: 0.15, income: 1_000 }],
    collectibleGain: 1_000,
    netPassive: 2_000,
  });

  test('the included fraction is the amount-weighted mean of the group factors', () => {
    near(mixed().includedFraction, (0.4054 + 0.7568) / 2, 5e-5);
  });

  test('short-term gain enters the blend at 1 and dilutes the reduction', () => {
    const withSt = adj({
      ltcgBands: [{ rate: 0.15, income: 1_000 }], shortTermGain: 1_000, netPassive: 2_000,
    });
    near(withSt.includedFraction, (0.4054 + 1) / 2, 5e-5);
    assert.ok(withSt.worldwide < mixed().worldwide,
      'a basket half in short-term gain must lose less than one half in collectibles');
  });

  test('zero worldwide gain is fully inert', () => {
    const r = adj({ netPassive: 0 });
    assert.equal(r.worldwide, 0);
    assert.equal(r.includedFraction, 1);
  });
});

// ─── The partition invariant survives, by construction ───────────────────────
//
// The whole reason design 90 §4.5 called this "independent of the partition invariant"
// is that it rescales gain already in the right basket. That is only true because
// §904(b)(3)(A) ran first and capped Σ basket gain at the worldwide figure. This pins the
// consequence: the denominator can never fall by less than the numerators do.

describe('Σ basket reductions never exceed the worldwide reduction', () => {
  test('two baskets sharing the whole worldwide gain reduce it exactly', () => {
    const r = adj({
      ltcgBands: [{ rate: 0.20, income: 3_000 }], netGeneral: 1_000, netPassive: 2_000,
    });
    near(r.general + r.passive, r.worldwide, 1e-9, 'no slack when all gain is foreign');
  });

  test('a US-source share of the gain leaves the denominator falling faster', () => {
    // \$3,000 of worldwide gain, only \$1,000 of it in a foreign basket.
    const r = adj({
      ltcgBands: [{ rate: 0.20, income: 3_000 }], netPassive: 1_000,
    });
    assert.ok(r.general + r.passive < r.worldwide,
      'US-source gain is removed from the denominator with no basket to match it');
  });

  test('the §904(b)(3)(A) chain hands over post-adjustment figures', () => {
    // The two adjustments compose: Pub 514's own p.28 example, then the rate differential
    // on what it leaves. `netGeneral`/`netPassive` are the handover.
    const capBasket = _computeCapitalLossBasketAdjustment(
      { foreignGeneralCapGainsYTD: 600, foreignPassiveCapGainsYTD: 300 },
      { shortTermGain: 0, longTermGain: 750, collectibleGain: 0, unrecaptured1250Gain: 0 });
    near(capBasket.netPassive, 250, 0.01, 'Pub 514 p.28: \$300 − \$50');
    near(capBasket.netGeneral, 500, 0.01, 'Pub 514 p.28: \$600 − \$100');

    const r = adj({
      ltcgBands: [{ rate: 0.15, income: 750 }],
      netGeneral: capBasket.netGeneral, netPassive: capBasket.netPassive,
    });
    near(r.general, 500 * (1 - 0.4054), 0.05, 'the rate differential scales the ADJUSTED gain');
    near(r.passive, 250 * (1 - 0.4054), 0.05);
  });
});

// ─── The adjustment exception ────────────────────────────────────────────────

describe('the Form 1116 adjustment exception', () => {
  const small = (o = {}) => _computeRateDifferentialAdjustment({
    ltcgBands: [{ rate: 0.15, income: 19_000 }],
    topOrdinaryRate: TOP, netPassive: 19_000,
    taxableOrdinary: 100_000, exceptionThreshold: 394_600,
    ...o,
  });

  test('under both thresholds, nothing is adjusted', () => {
    const r = small();
    assert.equal(r.exceptionApplied, true);
    assert.equal(r.worldwide, 0);
    assert.equal(r.passive, 0);
    assert.equal(r.includedFraction, 1);
  });

  test('\$20,000 of foreign net capital gain forfeits it', () => {
    const r = small({ ltcgBands: [{ rate: 0.15, income: 20_000 }], netPassive: 20_000 });
    assert.equal(r.exceptionApplied, false);
    assert.ok(r.worldwide > 0);
  });

  test('taxable ordinary income above the 32%-bracket floor forfeits it', () => {
    const r = small({ taxableOrdinary: 394_601 });
    assert.equal(r.exceptionApplied, false);
    assert.ok(r.worldwide > 0);
  });

  test('the threshold is read off the module bracket table, not transcribed', () => {
    // The Form 1116 instructions state \$394,600 MFJ / \$197,300 otherwise for 2025, and
    // those are the 32%-bracket floors in `UsTaxRates2025` to the dollar. Asserting the
    // 2026 module's own floors keeps the two from drifting apart under the inflation
    // wrapper — a transcribed pair would be a second copy that never moves.
    const m = new UsTaxRates2026();
    const floor = (b) => b.find(([, rate]) => rate >= 0.32)[0];
    assert.equal(floor(m._brackets_mfj),    403_550);
    assert.equal(floor(m._brackets_single), 201_775);
  });
});

// ─── End to end through computeTax, where the §904 invariant lives ───────────
//
// The helper tests above pin the arithmetic. This one pins the wiring, and it is
// mutation-verified: stub `rateDiff` back to `{ worldwide: 0, general: 0, passive: 0 }`
// in `computeTax` and the first two tests here go red. Per design 90 §10 — when an
// invariant is a property of state, test it on state.

describe('the adjustment reaches the §904 limitation', () => {
  // An AU-resident US citizen realising a large foreign-source gain: §865(a) sources
  // personal-property gain by the seller's residence, so the whole gain is foreign
  // passive (design 83 G10). Shaped like the reference plan's one big disposal year.
  //
  // `usOrdinaryIncomeYTD` is WORLDWIDE ordinary income and must contain both foreign
  // ordinary accumulators, or the baskets do not partition gross income and the fixture
  // trips design 83's invariant before reaching anything this file is about.
  const bigGainYear = (o = {}) => ({
    people: { primary: { residency: 'AU' } },
    currentPeriods: { US: { startMs: Date.UTC(2033, 0, 1) } },
    usOrdinaryIncomeYTD: 200_000,          // 180,000 AU wages + 4,000 AU interest + US
    usCapitalGainsYTD:   800_000,
    foreignPassiveIncomeYTD:   800_000 + 4_000,
    foreignPassiveCapGainsYTD: 800_000,
    foreignGeneralIncomeYTD:   180_000,
    ftcCurrentPassive: 120_000,
    ftcCurrentGeneral: 30_000,
    ...o,
  });

  test('the passive basket loses its rate differential portion', () => {
    const detail = new UsTaxRates2026().computeTax(bigGainYear());
    assert.equal(detail.rateDifferential.exceptionApplied, false);
    assert.ok(detail.ftc.passive.capGainAdjustment > 0,
      'the basket carrying the gain must be scaled down');
    assert.equal(detail.ftc.general.capGainAdjustment, 0,
      'a basket holding no capital gain is untouched — every disposal books to passive');
  });

  test('the denominator falls by at least as much as the numerators', () => {
    const rates  = new UsTaxRates2026();
    const detail = rates.computeTax(bigGainYear());
    const { ftc, rateDifferential: rd } = detail;

    assert.ok(rd.worldwide > 0);
    assert.ok(ftc.passive.capGainAdjustment + ftc.general.capGainAdjustment
              <= rd.worldwide + 0.01,
      'otherwise the fractions could sum past 1 and §904(g) would be needed to absorb it');
    // The invariant itself — `_assertFtcInvariants` throws in test, so reaching here is
    // already half the assertion; this states the property it guards.
    assert.ok(ftc.general.frac + ftc.passive.frac <= 1.01,
      'the §904 fractions partition one taxpayer');
  });

  test('it cuts the limit, and only in the direction §904(b)(2) intends', () => {
    // Same year, run with the gain replaced by an equal amount of ordinary foreign
    // income. Preferential-rate income must buy strictly LESS limitation room than
    // full-rate income does — that is the whole provision in one comparison.
    const rates = new UsTaxRates2026();
    const withGain = rates.computeTax(bigGainYear());
    const asOrdinary = rates.computeTax(bigGainYear({
      usOrdinaryIncomeYTD: 200_000 + 800_000,
      usCapitalGainsYTD:   0,
      foreignPassiveCapGainsYTD: 0,
    }));
    assert.ok(withGain.ftc.passive.frac < asOrdinary.ftc.passive.frac,
      `capital gain must buy less §904 room than ordinary income: `
      + `${withGain.ftc.passive.frac} vs ${asOrdinary.ftc.passive.frac}`);
  });

  test('a year under the de minimis is left exactly alone', () => {
    const detail = new UsTaxRates2026().computeTax(bigGainYear({
      usCapitalGainsYTD: 15_000,
      foreignPassiveIncomeYTD: 15_000 + 4_000,
      foreignPassiveCapGainsYTD: 15_000,
    }));
    assert.equal(detail.rateDifferential.exceptionApplied, true);
    assert.equal(detail.ftc.passive.capGainAdjustment, 0);
    assert.equal(detail.rateDifferential.worldwide, 0);
  });
});
