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
 * au-franked-dividends.test.mjs — ITAA 1997 Div 207 imputation (design 90 §8, design 76 §8).
 *
 * The model treated a franked dividend as a **pure tax shield**: no Australian assessable
 * income at all, and a franking credit equal to 100% of the cash. Two errors, both
 * favouring the household, compounding rather than cancelling — design 76 §8.2 measured
 * the credit as ≈2.33× overstated on income that was untaxed at the margin.
 *
 * The Act, read from `docs/au-tax/ITAA-1997/`:
 *
 *   s207-20(1) — the franking credit is included in assessable income "in addition to
 *                any other amount included … in relation to the distribution" (the cash).
 *   s207-20(2) — a tax offset "equal to the franking credit".
 *   s202-60(2) — the credit is `distribution × 1 ÷ gross-up rate`, and the Dictionary
 *                defines the gross-up rate as `(100% − r) ÷ r`, giving `cash × r/(1−r)`.
 *   s67-25(1)  — Division 207 offsets are REFUNDABLE outside the listed carve-outs.
 *
 * The economic shape those three produce, and the one this file pins: a fully franked
 * dividend is roughly **neutral at a 30% marginal rate**, real tax above it, and a
 * **refund** below it.
 *
 * Run with: node --test tests/unit/au-franked-dividends.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { frankingCreditOn, CORPORATE_TAX_RATE } from '../../src/finance/tax/au/franking.js';
import { AuTaxModule2026 } from '../../src/finance/tax/au/au-tax-module-2026.js';
import { AuTaxRates2025 }  from '../../src/finance/tax/au/au-tax-rates-2025.js';

const au = new AuTaxRates2025();
const fn = new AuTaxModule2026().getReducerFns().get('AU_DIVIDEND_FRANKED_RESIDENT_TAX');

const baseState = (o = {}) => ({
  usOrdinaryIncomeYTD: 0, usNetInvestmentIncomeYTD: 0, foreignPassiveIncomeYTD: 0,
  auOrdinaryIncomeYTD: 0, auFrankingCreditYTD: 0,
  effectiveExchangeRates: { USD_AUD: 1 }, ...o,
});

const resident = (o = {}) => ({
  auOrdinaryIncomeYTD: 0, auCapitalGainsYTD: 0, auDiscountableGainsYTD: 0,
  auFrankingCreditYTD: 0, auSuperTaxYTD: 0, auTaxLossPool: 0, auCapitalLossPool: 0,
  people: { primary: { residency: 'AU' } }, ...o,
});

// ─── s202-60(2): the credit is a gross-up, not the cash ─────────────────────

test('s202-60(2): a fully franked dividend carries cash × 30/70 at the full company rate', () => {
  assert.ok(Math.abs(frankingCreditOn(7_000) - 3_000) < 1e-9,
    'A$7,000 franked at 30% carries exactly A$3,000 — the tax the company already paid');
  // The pre-design-90 model returned 7,000 here: 2.33× too much.
  assert.ok(frankingCreditOn(7_000) < 7_000);
});

test('s202-60(2): the base-rate-entity rate gives a smaller credit, and the rate is a table', () => {
  // 25/75 = 0.3333 against 30/70 = 0.4286 — a fifth less credit. A literal 0.30 would
  // silently mis-state every small-company holding, which is why the rate is a lookup.
  const full = frankingCreditOn(1_000, { corporateTaxRate: CORPORATE_TAX_RATE.FULL });
  const base = frankingCreditOn(1_000, { corporateTaxRate: CORPORATE_TAX_RATE.BASE_RATE_ENTITY });
  assert.ok(Math.abs(full - 1_000 * (30 / 70)) < 1e-9);
  assert.ok(Math.abs(base - 1_000 * (25 / 75)) < 1e-9);
  assert.ok(base < full);
});

test('partial franking scales the credit; a nonsense rate yields 0 rather than Infinity', () => {
  assert.ok(Math.abs(frankingCreditOn(1_000, { frankedPercent: 0.5 }) - 500 * (30 / 70)) < 1e-9);
  assert.equal(frankingCreditOn(1_000, { corporateTaxRate: 1 }), 0, 'r=1 would divide by zero');
  assert.equal(frankingCreditOn(1_000, { corporateTaxRate: 0 }), 0);
});

// ─── s207-20(1): the income half, which the model booked at zero ────────────

test('s207-20(1): assessable income is cash PLUS the gross-up', () => {
  const s = fn(baseState(), { amount: 7_000 });
  assert.ok(Math.abs(s.auOrdinaryIncomeYTD - 10_000) < 0.01,
    'A$7,000 cash + A$3,000 gross-up = A$10,000 assessable');
  assert.ok(Math.abs(s.auFrankingCreditYTD - 3_000) < 0.01);
});

test('the US figure stays the CASH dividend — the gross-up has no US analogue', () => {
  const s = fn(baseState(), { amount: 7_000 });
  assert.equal(s.usOrdinaryIncomeYTD, 7_000, 'grossing up the US side would invent income');
  assert.equal(s.usNetInvestmentIncomeYTD, 7_000, 'NIIT base is the cash too (§1411)');
});

// ─── The economic shape: neutral at 30%, tax above, refund below ────────────

test('a franked dividend is roughly NEUTRAL at a 30% marginal rate', () => {
  // This is the whole point of imputation and the thing the shield model destroyed.
  // Assess A$10,000 of grossed-up dividend against a taxpayer already in the 30% band,
  // and compare to the same taxpayer without it. The extra tax ≈ the credit.
  const withDiv    = au._assessResidentPreFito(resident({ auOrdinaryIncomeYTD: 90_000 + 10_000, auFrankingCreditYTD: 3_000 }));
  const withoutDiv = au._assessResidentPreFito(resident({ auOrdinaryIncomeYTD: 90_000 }));
  const delta = withDiv.netLiabilityPreFito - withoutDiv.netLiabilityPreFito;

  // Marginal rate in this band is 30% + 2% Medicare, so the residual is the levy on the
  // grossed-up amount — small, and crucially NOT the −A$3,000 the shield model produced.
  assert.ok(delta > 0, `a franked dividend must not REDUCE tax; delta ${delta.toFixed(2)}`);
  assert.ok(Math.abs(delta) < 500, `near-neutral at 30%, got ${delta.toFixed(2)}`);
});

test('s67-25: below the company rate the excess credit is REFUNDED, not forfeited', () => {
  // A retiree with no other income. Assessable A$10,000 is under the tax-free threshold,
  // so base tax is 0 and the whole A$3,000 credit is refundable. The old
  // `Math.min(credit, baseTax)` returned 0 here and destroyed it — and it short-changed
  // precisely the low-income filer, which is design 76 §8.2's note about gap 3.
  const a = au._assessResidentPreFito(resident({ auOrdinaryIncomeYTD: 10_000, auFrankingCreditYTD: 3_000 }));
  assert.equal(a.baseTax, 0, 'below the tax-free threshold');
  assert.equal(a.netLiabilityPreFito, -3_000, 'the full credit is a refund owed');
});

test('s67-25: the offset reaches the Medicare levy too, not just base tax', () => {
  // The old cap was `min(credit, baseTax)`, which could not touch the levy. A refundable
  // offset applies against the whole liability.
  const a = au._assessResidentPreFito(resident({ auOrdinaryIncomeYTD: 30_000, auFrankingCreditYTD: 100_000 }));
  assert.ok(a.medicareLevy > 0, 'there IS a levy at this income');
  assert.equal(a.netLiabilityPreFito, a.baseTax + a.medicareLevy - 100_000);
  assert.ok(a.netLiabilityPreFito < 0);
});

test('above the company rate a franked dividend costs real tax', () => {
  // The top-band case: 45% + levy against a 30% credit leaves genuine tax to pay. If this
  // came out ≤ 0 the shield had returned.
  const withDiv    = au._assessResidentPreFito(resident({ auOrdinaryIncomeYTD: 250_000 + 10_000, auFrankingCreditYTD: 3_000 }));
  const withoutDiv = au._assessResidentPreFito(resident({ auOrdinaryIncomeYTD: 250_000 }));
  const delta = withDiv.netLiabilityPreFito - withoutDiv.netLiabilityPreFito;
  assert.ok(delta > 1_000, `top-rate taxpayer pays real tax on a franked dividend, got ${delta.toFixed(2)}`);
});

// ─── The control: an ordinary offset is unchanged ───────────────────────────

test('a credit smaller than the tax still simply reduces it (refundability is not a rebate)', () => {
  const a = au._assessResidentPreFito(resident({ auOrdinaryIncomeYTD: 90_000, auFrankingCreditYTD: 500 }));
  const b = au._assessResidentPreFito(resident({ auOrdinaryIncomeYTD: 90_000 }));
  assert.ok(Math.abs((b.netLiabilityPreFito - a.netLiabilityPreFito) - 500) < 1e-9);
  assert.ok(a.netLiabilityPreFito > 0);
});

// ─── Per-person attribution ─────────────────────────────────────────────────
//
// Both halves must attribute IDENTICALLY — splitting them would hand one spouse the
// income and the other the offset, which is worse than either error alone. That is
// covered against the real attribution harness in
// `design-76-attribution-statekey.test.mjs` ("franked dividend credit attributes to the
// stamped account owner"), extended by design 90 §8 to assert the assessable half too.
// Deliberately NOT duplicated here with a hand-rolled state: `resolveAttributionAsset`
// has real preconditions, and a second weaker fixture that satisfies them differently
// would be a worse test that looked like better coverage.

test('household fallback: with no attributable account, both halves land on the scalars', () => {
  // The unattributed path still has to book BOTH halves — design 76 P5's warning fires
  // on the amount reaching the settle unattributed, and an income of 0 would silence it
  // while quietly restoring the shield.
  const s = fn(baseState(), { amount: 7_000 });
  assert.ok(Math.abs(s.auOrdinaryIncomeYTD - 10_000) < 0.01);
  assert.ok(Math.abs(s.auFrankingCreditYTD - 3_000) < 0.01);
});
