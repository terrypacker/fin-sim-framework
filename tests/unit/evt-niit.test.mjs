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
 * evt-niit.test.mjs
 * Net Investment Income Tax (IRC §1411) — a flat 3.8% surtax on the lesser of
 * net investment income (NII) and the excess of MAGI over a statutory threshold
 * (MFJ $250k / Single $200k, not inflation-indexed).
 *
 * Two layers, mirroring tax-rates.test.mjs:
 *   Classification — investment classifiers populate usNetInvestmentIncomeYTD
 *                    (interest, dividends, coupons, net rents); non-investment
 *                    ordinary income does NOT.
 *   Rates          — computeTax() applies the 3.8% surtax with the lesser-of rule,
 *                    including the gains-in-MAGI add-back and the FTC ordering
 *                    (NIIT is not creditable against foreign tax).
 *
 * Run with: node --test tests/unit/evt-niit.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { UsTaxRates2025 } from '../../src/finance/tax/us/us-tax-rates-2025.js';
import { UsTaxModule2026 } from '../../src/finance/tax/us/us-tax-module-2026.js';
import { AuTaxModule2026 } from '../../src/finance/tax/au/au-tax-module-2026.js';

const usRates = new UsTaxRates2025();

/** Minimal US-only state for computeTax calls. */
function usState(overrides = {}) {
  return {
    usOrdinaryIncomeYTD:      0,
    usNegativeIncomeYTD:      0,
    usCapitalGainsYTD:        0,
    usCollectibleGainsYTD:    0,
    usNetInvestmentIncomeYTD: 0,
    usPenaltyYTD:             0,
    ...overrides,
  };
}

/** Extract a named reducer fn from a tax module instance. */
function getFn(module, actionType) {
  return module.getReducerFns().get(actionType);
}

const RATE = 0.038;
const MFJ_THRESHOLD    = 250_000;
const SINGLE_THRESHOLD = 200_000;

// ══════════════════════════════════════════════════════════════════════════════
// EVT-NIIT: Classification — investment income feeds usNetInvestmentIncomeYTD
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-NIIT: interest, dividends, coupons and net rents populate usNetInvestmentIncomeYTD', () => {
  const m = new UsTaxModule2026();
  const investmentActions = [
    ['FIXED_INCOME_EARNINGS_TAX', 1_000],
    ['STOCK_DIVIDEND_TAX',        2_000],
    ['BOND_COUPON_TAX',           3_000],
    ['US_RENTAL_INCOME_TAX',      4_000],
  ];
  for (const [type, amount] of investmentActions) {
    const s0 = usState();
    const next = getFn(m, type)(s0, { amount, residency: 'US' });
    assert.equal(next.usNetInvestmentIncomeYTD, amount, `${type} → NII bucket`);
    // Still also lands in the ordinary bucket (NII is a parallel tag, not a move).
    assert.equal(next.usOrdinaryIncomeYTD, amount, `${type} → ordinary bucket`);
  }
});

test('EVT-NIIT: a rental loss reduces the NII pool (negative amount)', () => {
  const m = new UsTaxModule2026();
  const s0 = usState({ usNetInvestmentIncomeYTD: 5_000, usOrdinaryIncomeYTD: 5_000 });
  const next = getFn(m, 'US_RENTAL_INCOME_TAX')(s0, { amount: -2_000, residency: 'US' });
  assert.equal(next.usNetInvestmentIncomeYTD, 3_000);
});

test('EVT-NIIT: non-investment ordinary income does NOT feed usNetInvestmentIncomeYTD', () => {
  const m = new UsTaxModule2026();
  const nonInvestment = [
    ['WAGES_INCOME_TAX',      { amount: 100_000, residency: 'US' }],
    ['SS_INCOME_TAX',         { amount:  40_000, residency: 'US' }],
    ['K401_WITHDRAWAL_TAX',   { amount:  50_000, penaltyAmount: 0, residency: 'US' }],
    ['IRA_RMD_TAX',           { amount:  30_000, residency: 'US' }],
    ['ROTH_CONVERSION_TAX',   { amount:  25_000 }],
  ];
  for (const [type, action] of nonInvestment) {
    const s0 = usState();
    const next = getFn(m, type)(s0, action);
    assert.equal(next.usNetInvestmentIncomeYTD ?? 0, 0, `${type} must not touch NII bucket`);
  }
});

// A US person is taxed on WORLDWIDE net investment income, so AU-source interest,
// dividends and net rents feed usNetInvestmentIncomeYTD too. No effectiveExchangeRates
// on the state ⇒ toUSD falls back 1:1, so the AUD `amount` lands unscaled in the
// (USD) NII bucket — exactly what we assert.
test('EVT-NIIT: AU-source investment income feeds usNetInvestmentIncomeYTD (worldwide)', () => {
  const m = new AuTaxModule2026();
  const auInvestmentActions = [
    ['AU_SAVINGS_EARNINGS_TAX',                1_000],
    ['AU_FIXED_INCOME_EARNINGS_TAX',           1_500],
    ['AU_RENTAL_INCOME_TAX',                   2_000],
    ['AU_DIVIDEND_FRANKED_RESIDENT_TAX',       2_500],
    ['AU_DIVIDEND_UNFRANKED_RESIDENT_TAX',     3_000],
    ['AU_DIVIDEND_UNFRANKED_NONRESIDENT_TAX',  3_500],
  ];
  for (const [type, amount] of auInvestmentActions) {
    const s0 = usState({ auOrdinaryIncomeYTD: 0, auFrankingCreditYTD: 0 });
    const next = getFn(m, type)(s0, { amount, residency: 'AU' });
    assert.equal(next.usNetInvestmentIncomeYTD, amount, `${type} → NII bucket`);
    // Also lands in worldwide ordinary income (the MAGI side).
    assert.equal(next.usOrdinaryIncomeYTD, amount, `${type} → ordinary bucket`);
  }
});

test('EVT-NIIT: an AU rental loss reduces the NII pool (signed)', () => {
  const m = new AuTaxModule2026();
  const s0 = usState({ usNetInvestmentIncomeYTD: 5_000, usOrdinaryIncomeYTD: 5_000, auOrdinaryIncomeYTD: 0 });
  const next = getFn(m, 'AU_RENTAL_INCOME_TAX')(s0, { amount: -2_000, residency: 'AU' });
  assert.equal(next.usNetInvestmentIncomeYTD, 3_000);
});

test('EVT-NIIT: AU non-investment income does NOT feed usNetInvestmentIncomeYTD', () => {
  const m = new AuTaxModule2026();
  // AU wages and AU super earnings are worldwide US income but not NII (wages are
  // earned income; super earnings are treated as pension-type income outside §1411).
  const nonInvestment = [
    ['AU_WAGES_INCOME_TAX',            { amount: 80_000, residency: 'AU' }],
    ['SUPER_WITHDRAWAL_EARNINGS_TAX',  { amount: 30_000, residency: 'US' }],
  ];
  for (const [type, action] of nonInvestment) {
    const s0 = usState({ auOrdinaryIncomeYTD: 0 });
    const next = getFn(m, type)(s0, action);
    assert.equal(next.usNetInvestmentIncomeYTD ?? 0, 0, `${type} must not touch NII bucket`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-NIIT: Rates — computeTax() applies 3.8% on lesser-of(NII, MAGI − threshold)
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-NIIT: below the MFJ threshold → no NIIT', () => {
  // MAGI = 200k ordinary + 20k NII = 220k < 250k.
  const detail = usRates.computeTax(usState({
    usOrdinaryIncomeYTD:      200_000,
    usNetInvestmentIncomeYTD:  20_000,
  }));
  assert.equal(detail.niitTax, 0);
  assert.equal(detail.grossTax, detail.grossTax); // sanity: no NaN
});

test('EVT-NIIT: MAGI-capped — surtax on (MAGI − threshold) when NII is larger', () => {
  // NII (interest/dividends) is a SUBSET of ordinary income, so MAGI = the
  // ordinary total (270k), not ordinary + NII. Excess = 20k; NII = 40k → the
  // MAGI excess is the binding (smaller) limb.
  const detail = usRates.computeTax(usState({
    usOrdinaryIncomeYTD:      270_000,   // MAGI = 270k (includes the 40k NII)
    usNetInvestmentIncomeYTD:  40_000,
  }));
  const excess = 270_000 - MFJ_THRESHOLD;       // 20_000
  assert.equal(detail.netInvestmentIncome, 40_000);
  assert.equal(detail.modifiedAgi, 270_000);
  assert.equal(detail.niitTax, RATE * excess);  // 3.8% × 20k
});

test('EVT-NIIT: NII-capped — surtax on NII when the MAGI excess is larger', () => {
  // Ordinary 400k + NII 20k → MAGI 420k, excess 170k; NII 20k → lesser = NII.
  const detail = usRates.computeTax(usState({
    usOrdinaryIncomeYTD:      400_000,
    usNetInvestmentIncomeYTD:  20_000,
  }));
  assert.equal(detail.niitTax, RATE * 20_000);
});

test('EVT-NIIT: capital and collectible gains count as NII and lift MAGI', () => {
  // No investment-interest bucket; gains alone. Ordinary 240k + cg 40k + coll 10k
  // → MAGI 290k, excess 40k; NII = 0 + 40k + 10k = 50k → lesser = excess 40k.
  const detail = usRates.computeTax(usState({
    usOrdinaryIncomeYTD:   240_000,
    usCapitalGainsYTD:      40_000,
    usCollectibleGainsYTD:  10_000,
  }));
  assert.equal(detail.netInvestmentIncome, 50_000);
  assert.equal(detail.modifiedAgi, 290_000);
  assert.equal(detail.niitTax, RATE * 40_000);
});

test('EVT-NIIT: retirement/wage income lifts MAGI but is not itself NII', () => {
  // 300k of pure ordinary (wages/RMD) with only 10k of true investment income.
  // MAGI 310k, excess 60k; NII 10k → surtax on 10k only (not on the wages).
  const detail = usRates.computeTax(usState({
    usOrdinaryIncomeYTD:      300_000,
    usNetInvestmentIncomeYTD:  10_000,
  }));
  assert.equal(detail.niitTax, RATE * 10_000);
});

test('EVT-NIIT: Single threshold ($200k) bites earlier than MFJ ($250k)', () => {
  // NII is a subset of ordinary income → MAGI = 210k.
  const base = {
    usOrdinaryIncomeYTD:      210_000,
    usNetInvestmentIncomeYTD:  30_000,
  };
  const mfj    = usRates.computeTax(usState({ ...base, usFilingSingle: false }));
  const single = usRates.computeTax(usState({ ...base, usFilingSingle: true  }));

  // MFJ: MAGI 210k < 250k → no NIIT.
  assert.equal(mfj.niitTax, 0);
  // Single: excess = 210k − 200k = 10k; NII 30k → lesser = excess 10k.
  assert.equal(single.niitThreshold, SINGLE_THRESHOLD);
  assert.equal(single.niitTax, RATE * 10_000);
});

test('EVT-NIIT: threshold is NOT inflation-indexed (constant across the wrapper)', async () => {
  const { InflationAdjustedUsTaxRates } = await import(
    '../../src/finance/tax/inflation-adjusted-tax-rates.js');
  const inflated = new InflationAdjustedUsTaxRates(new UsTaxRates2025(), 1.5);
  const detail = inflated.computeTax(usState({
    usOrdinaryIncomeYTD:      320_000,   // MAGI 320k, excess 70k vs the FIXED 250k
    usNetInvestmentIncomeYTD:  40_000,   // NII 40k → the binding limb
  }));
  // Had the threshold inflated by 1.5× (→375k) there would be no excess and no
  // NIIT; it stays statutory at 250k, so the surtax still applies.
  assert.equal(detail.niitThreshold, MFJ_THRESHOLD);
  assert.equal(detail.niitTax, RATE * 40_000);
});

test('EVT-NIIT: NIIT is added on top of gross tax and net liability', () => {
  const detail = usRates.computeTax(usState({
    usOrdinaryIncomeYTD:      260_000,
    usNetInvestmentIncomeYTD:  40_000,
  }));
  const chapter1 = detail.ordinaryTax + detail.capitalGainsTax
                 + detail.collectiblesTax + detail.penaltyTax;
  assert.ok(detail.niitTax > 0);
  assert.equal(detail.grossTax, chapter1 + detail.niitTax);
  // No foreign activity → no FTC → netLiability = grossTax.
  assert.equal(detail.netLiability, detail.grossTax);
});

test('EVT-NIIT: the §904 FTC cannot offset NIIT (cross-border ordering)', () => {
  // A US person with foreign-source income and a big pool of foreign tax paid.
  // The FTC wipes out the Chapter-1 tax on the foreign slice, but NIIT must
  // survive in full — it is outside the credit system.
  const state = usState({
    usOrdinaryIncomeYTD:      300_000,
    usNetInvestmentIncomeYTD:  40_000,   // MAGI 340k, excess 90k; NII 40k → 40k
    foreignGeneralIncomeYTD:  300_000,   // treat the ordinary income as foreign
    ftcCurrentGeneral:        200_000,   // ample foreign tax available to credit
    ftcPoolGeneral:           {},
    ftcPoolPassive:           {},
    currentPeriods:           { US: { startMs: Date.UTC(2025, 0, 1) } },
  });
  const detail = usRates.computeTax(state);

  assert.ok(detail.credits > 0, 'FTC should apply against Chapter-1 tax');
  const expectedNiit = RATE * 40_000;
  assert.equal(detail.niitTax, expectedNiit);
  // Even if the FTC fully covers the Chapter-1 tax, net liability is at least the
  // full NIIT — the credit never reaches it.
  assert.ok(detail.netLiability >= expectedNiit - 1e-6,
    `netLiability ${detail.netLiability} must retain the full NIIT ${expectedNiit}`);
});
