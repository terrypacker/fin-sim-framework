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
 * au-min-tax-topup-offsets.test.mjs
 *
 * Design 57's 30% CGT minimum-tax top-up vs. the offsets that reduce the return
 * (design 84 G10).
 *
 * The top-up used to be added OUTSIDE the offset clamp:
 *
 *   netLiability = max(0, baseTax + medicareLevy − franking − fito) + minTaxTopUp
 *
 * which made it a levy no offset could reach. A return whose whole liability was
 * the top-up — a low-ordinary-income filer realising a gain in the 0%/14% bands,
 * which is precisely who the 30% floor is aimed at — paid the top-up in full while
 * its FITO evaporated. That also broke the design 71 §6 footing invariant on the
 * printed return, because the document has always shown the top-up INSIDE Gross Tax
 * with the Credits section beneath it: `Gross Tax + credits != Net Tax Liability`.
 *
 * Only FITO can trigger it. `frankingOffset` is capped at `baseTax`, so franking
 * credits can never exceed `baseTax + medicareLevy` and never reach the clamp —
 * which is why every observed violation showed zero franking credits.
 *
 * Run with: node --test tests/unit/au-min-tax-topup-offsets.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { AuTaxRates2027 } from '../../src/finance/tax/au/au-tax-rates-2027.js';
import { AuTaxRates2026 } from '../../src/finance/tax/au/au-tax-rates-2026.js';

/**
 * An AU-resident state with every bucket explicitly present. `auRealCapitalGainsYTD`
 * has to be stated rather than defaulted: FY2027 treats a *present zero* as
 * authoritative and only an absent bucket falls back to the gross gain.
 */
const auResident = (overrides = {}) => ({
  people: { primary: { residency: 'AU' } },
  auOrdinaryIncomeYTD: 0,
  auCapitalGainsYTD: 0,
  auRealCapitalGainsYTD: 0,
  auNonResidentWithholdingYTD: 0,
  auSuperTaxYTD: 0,
  auFrankingCreditYTD: 0,
  ...overrides,
});

/** The design 71 §6 invariant, read off the return the document prints. */
const assertFoots = (tax, label) => {
  const credits = tax.frankingOffset + tax.fito;
  assert.ok(
    Math.abs(tax.grossTax - credits - tax.netLiability) < 0.005,
    `${label}: Gross ${tax.grossTax.toFixed(2)} − credits ${credits.toFixed(2)} `
    + `!= net ${tax.netLiability.toFixed(2)}`,
  );
};

// ─── G10: the offset must reach the top-up ───────────────────────────────────

test('G10: FITO reduces a liability that is entirely minimum-tax top-up', () => {
  const rates = new AuTaxRates2027();
  // A$15,000 real gain, no ordinary income: the whole gain sits in the tax-free
  // band, so baseTax and the Medicare levy are both 0 and the 30% floor is the
  // entire liability.
  const base = auResident({ auCapitalGainsYTD: 15_000, auRealCapitalGainsYTD: 15_000 });

  const noOffset = rates.computeTax(base);
  assert.strictEqual(noOffset.baseTax, 0, 'gain sits in the tax-free band');
  assert.strictEqual(noOffset.medicareLevy, 0);
  assert.strictEqual(noOffset.cgtMinimumTaxTopUp, 4_500, '30% × 15,000');
  assert.strictEqual(noOffset.grossTax, 4_500, 'the top-up IS the gross tax');

  // A$800 of US tax on the same gain — under the de-minimis, so the whole amount
  // is offset with no §770-75 limit computed.
  const withFito = rates.computeTax({ ...base, usTaxPaidOnUsSourceAud: 800 });
  assert.strictEqual(withFito.fito, 800, 'de-minimis credits the full amount');
  assert.strictEqual(withFito.grossTax, 4_500, 'gross tax is unchanged by the offset');
  // Pre-fix this returned 4,500 — the offset was clamped away against a zero
  // baseTax and the top-up was then added back on top of the clamp.
  assert.strictEqual(withFito.netLiability, 3_700, 'the offset reaches the top-up');
  assertFoots(withFito, 'de-minimis FITO against a top-up-only return');
});

test('G10: an above-de-minimis FITO reaches the top-up through the §770-75 limit', () => {
  const rates = new AuTaxRates2027();
  // The same A$15,000 gain, now entirely US-source, with A$2,000 of US tax on it.
  // Above A$1,000 ⇒ the limit is computed by re-assessing with the US-source slice
  // removed, which here strips the whole return, so the limit is the full A$4,500.
  const tax = rates.computeTax(auResident({
    auCapitalGainsYTD: 15_000,
    auRealCapitalGainsYTD: 15_000,
    usSourceCapGainsAudYTD: 15_000,
    usSourceRealCapGainsAudYTD: 15_000,
    usTaxPaidOnUsSourceAud: 2_000,
  }));

  assert.strictEqual(tax.fitoDeMinimis, false, 'above the shortcut');
  assert.strictEqual(tax.fitoLimit, 4_500, 'the limit sees the top-up (step 1 − step 2)');
  assert.strictEqual(tax.fito, 2_000, 'limited by the foreign tax actually paid');
  assert.strictEqual(tax.netLiability, 2_500, '4,500 − 2,000');  // pre-fix: 4,500
  assertFoots(tax, 'limited FITO against a top-up-only return');
});

test('G10: the printed return foots — Gross Tax + credits = Net Tax Liability', () => {
  const rates = new AuTaxRates2027();
  const tax = rates.computeTax(auResident({
    auCapitalGainsYTD: 15_000, auRealCapitalGainsYTD: 15_000,
    usTaxPaidOnUsSourceAud: 800,
  }));
  const at = label => tax.lineItems.find(l => l.label.startsWith(label))?.amount;

  // Read straight off the line items, the way the CSV export's --check does.
  assert.strictEqual(at('Gross Tax'), 4_500);
  assert.strictEqual(at('Franking Credits'), -0);
  assert.strictEqual(at('Foreign Income Tax Offset'), -800);
  assert.strictEqual(at('Net Tax Liability'), 3_700);
  assert.strictEqual(
    at('Gross Tax') + at('Franking Credits') + at('Foreign Income Tax Offset'),
    at('Net Tax Liability'),
  );
});

// ─── The offset is non-refundable: excess is forfeited, not absorbed ──────────

test('a de-minimis offset larger than the liability is capped and the excess forfeited', () => {
  const rates = new AuTaxRates2027();
  // A$2,000 gain ⇒ a A$600 top-up and nothing else, against A$900 of US tax.
  const tax = rates.computeTax(auResident({
    auCapitalGainsYTD: 2_000, auRealCapitalGainsYTD: 2_000,
    usTaxPaidOnUsSourceAud: 900,
  }));

  assert.strictEqual(tax.grossTax, 600, '30% × 2,000');
  assert.strictEqual(tax.fito, 600, 'offset taken is capped at the liability it can absorb');
  assert.strictEqual(tax.netLiability, 0, 'never negative — FITO is not refundable');
  // The A$300 the taxpayer cannot use is lost (no carryforward, design 52 §4.5).
  // Reported as forfeited rather than silently dropped: the worksheet's
  // "excess forfeited" row is `foreignIncomeTaxOffset − fito`.
  assert.strictEqual(tax.inputs.foreignIncomeTaxOffset - tax.fito, 300);
  assertFoots(tax, 'over-large de-minimis offset');
});

// ─── Inertness: the fix must not move a return it does not apply to ──────────

test('INERT: FY2026 (no minimum tax) is unchanged', () => {
  const rates = new AuTaxRates2026();
  // 50% discount regime, no top-up at all — the arithmetic the fix rewrote
  // collapses back to exactly what it was.
  const tax = rates.computeTax(auResident({
    auOrdinaryIncomeYTD: 40_000,
    auCapitalGainsYTD: 20_000,
    auFrankingCreditYTD: 3_000,
    usTaxPaidOnUsSourceAud: 900,
  }));
  assert.strictEqual(tax.cgtMinimumTaxTopUp, 0, 'no FY2026 top-up');
  assert.strictEqual(
    tax.netLiability,
    Math.max(0, tax.baseTax + tax.medicareLevy - tax.frankingOffset - tax.fito),
    'identical to the pre-fix formula when the top-up is 0',
  );
  assertFoots(tax, 'FY2026');
});

test('INERT: FY2027 with a top-up the ordinary tax already absorbs is unchanged', () => {
  const rates = new AuTaxRates2027();
  // A$40,000 ordinary + A$20,000 real gain: baseTax and the Medicare levy are far
  // larger than the offsets, so the old clamp never bound and the answer is the
  // same either way. This is the common shape — it is why the golden never caught
  // this, and why the violation only ever showed on the low-income filer.
  const tax = rates.computeTax(auResident({
    auOrdinaryIncomeYTD: 40_000,
    auCapitalGainsYTD: 20_000, auRealCapitalGainsYTD: 20_000,
    auFrankingCreditYTD: 3_000,
    usTaxPaidOnUsSourceAud: 900,
  }));
  assert.ok(tax.cgtMinimumTaxTopUp > 0, 'the top-up is live');
  assert.ok(tax.baseTax + tax.medicareLevy - tax.frankingOffset - tax.fito > 0,
    'the old clamp would not have bound');
  assert.strictEqual(
    tax.netLiability,
    Math.max(0, tax.baseTax + tax.medicareLevy - tax.frankingOffset - tax.fito)
      + tax.cgtMinimumTaxTopUp,
    'identical to the pre-fix formula when the clamp does not bind',
  );
  assertFoots(tax, 'FY2027 ordinary-dominated');
});

test('INERT: the Age Pension exemption still removes the top-up entirely', () => {
  const rates = new AuTaxRates2027();
  const tax = rates.computeTax(auResident({
    auCapitalGainsYTD: 15_000, auRealCapitalGainsYTD: 15_000,
    auMinTaxExempt: true,
    usTaxPaidOnUsSourceAud: 800,
  }));
  assert.strictEqual(tax.cgtMinimumTaxTopUp, 0, 'exempt: no floor to offset against');
  assert.strictEqual(tax.grossTax, 0);
  assert.strictEqual(tax.fito, 0, 'no liability ⇒ no offset taken');
  assert.strictEqual(tax.netLiability, 0);
  assertFoots(tax, 'exempt filer');
});
