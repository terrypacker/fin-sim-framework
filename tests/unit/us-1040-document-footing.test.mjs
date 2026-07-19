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
 * us-1040-document-footing.test.mjs — design 71 Phase 3.
 *
 * The Form 1040 document is the *displayed* projection of a TaxComputationResult, and
 * three of its lines were missing: SECA, the Additional Medicare surtax, and the
 * ½-SE-tax deduction (design 69 added them to the engine and to
 * `taxDetail.lineItems`, but never to the document's sections). For a self-employed
 * filer the visible lines therefore did NOT sum to the Gross Tax line printed beneath
 * them, and AGI did not follow from the lines above it (design 71 §2.2).
 *
 * A fourth defect, found while building the worksheet export (§7.1): the FEIE line
 * reported the uncapped qualifying exclusion rather than the amount actually applied.
 *
 * These tests state the footing invariants directly, so the document cannot silently
 * drift from the engine again.
 *
 * Run with: node --test tests/unit/us-1040-document-footing.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { UsTaxRates2025 }    from '../../src/finance/tax/us/us-tax-rates-2025.js';
import { UsTaxDocument2026 } from '../../src/finance/tax/us/us-tax-document-2026.js';

const EPS = 1e-6;

const doc1040 = state => new UsTaxDocument2026()
  .generate(new UsTaxRates2025().computeTax(state), 2025);

const section = (doc, heading) => doc.sections.find(s => s.heading === heading);
/** Footing sums LINE items only — `sub` rows are components of the line above. */
const foot = (doc, heading, stopLabel) => {
  const items = section(doc, heading).lineItems;
  const stop  = items.findIndex(li => li.label === stopLabel);
  return items.slice(0, stop).filter(li => !li.sub).reduce((s, li) => s + li.amount, 0);
};
const line = (doc, heading, label) =>
  section(doc, heading).lineItems.find(li => li.label === label);

// ─── The self-employed case (the §2.2 defect) ────────────────────────────────

const SE_STATE = {
  usOrdinaryIncomeYTD: 300_000,
  usSeEarningsYTD:     150_000,
  usSsWagesYTD:        150_000,   // enough W-2 wages to push past the addl-Medicare threshold
  usNegativeIncomeYTD:  10_000,
  usFilingSingle:      false,
};

test('F1040-1: the Tax Computation lines sum to Gross Tax for a self-employed filer', () => {
  const detail = new UsTaxRates2025().computeTax(SE_STATE);
  assert.ok(detail.selfEmploymentTax     > 0, 'fixture actually generates SECA');
  assert.ok(detail.additionalMedicareTax > 0, 'fixture actually generates the surtax');

  const doc = new UsTaxDocument2026().generate(detail, 2025);
  assert.ok(
    Math.abs(foot(doc, 'Tax Computation', 'Gross Tax') - detail.grossTax) < EPS,
    'the listed tax lines must sum to the Gross Tax line printed beneath them',
  );
});

test('F1040-2: SECA and the Additional Medicare surtax are listed, matching the engine', () => {
  const detail = new UsTaxRates2025().computeTax(SE_STATE);
  const doc    = new UsTaxDocument2026().generate(detail, 2025);

  const seca = line(doc, 'Tax Computation', 'Self-Employment Tax (Schedule SE)');
  const addl = line(doc, 'Tax Computation', 'Additional Medicare Tax (0.9%)');
  assert.ok(seca, 'SECA line present');
  assert.ok(addl, 'Additional Medicare line present');
  assert.equal(seca.amount, detail.selfEmploymentTax);
  assert.equal(addl.amount, detail.additionalMedicareTax);

  // The SS/Medicare split rides as sub-rows and sums back to the SECA line.
  const ss  = line(doc, 'Tax Computation', 'Social Security portion (12.4%)');
  const med = line(doc, 'Tax Computation', 'Medicare portion (2.9%)');
  assert.ok(ss.sub && med.sub, 'components are marked `sub` so footing skips them');
  assert.ok(Math.abs(ss.amount + med.amount - seca.amount) < EPS);
});

test('F1040-3: the Income section explains AGI via the ½ SE-tax deduction', () => {
  const detail = new UsTaxRates2025().computeTax(SE_STATE);
  const doc    = new UsTaxDocument2026().generate(detail, 2025);

  const deduction = line(doc, 'Income', '½ Self-Employment Tax Deduction');
  assert.ok(deduction, 'the above-the-line deduction is listed (IRC §164(f))');
  assert.equal(deduction.amount, -detail.selfEmploymentTaxDeduction);

  assert.ok(
    Math.abs(foot(doc, 'Income', 'Adjusted Gross Income') - detail.adjustedGrossIncome) < EPS,
    'gross income + adjustments + ½ SE deduction must equal the AGI line',
  );
});

test('F1040-4: a wage-only return omits the SE lines entirely', () => {
  const doc = doc1040({ usOrdinaryIncomeYTD: 200_000, usFilingSingle: false });
  const labels = doc.sections.flatMap(s => s.lineItems.map(li => li.label));

  for (const absent of [
    '½ Self-Employment Tax Deduction',
    'Self-Employment Tax (Schedule SE)',
    'Additional Medicare Tax (0.9%)',
  ]) {
    assert.ok(!labels.includes(absent), `${absent} should not appear without SE income`);
  }
  // …and the section still foots, which is the point of the conditional lines.
  const detail = new UsTaxRates2025().computeTax({ usOrdinaryIncomeYTD: 200_000 });
  assert.ok(Math.abs(foot(doc, 'Tax Computation', 'Gross Tax') - detail.grossTax) < EPS);
});

// ─── FEIE (the §7.1 defect) ──────────────────────────────────────────────────

test('F1040-5: the FEIE line reports the exclusion APPLIED, not the uncapped amount', () => {
  // A qualifying exclusion far larger than taxable ordinary income: the stacking
  // rule caps what can actually be excluded, and only the capped figure keeps the
  // Income section footing.
  const state = {
    usOrdinaryIncomeYTD: 60_000,
    usFeieElected:       true,
    people:              { p1: { residency: 'AU', residencySinceMs: null } },
    auPersonEarnedIncomeYTD: { p1: 60_000 },
    exchangeRates:       { AUD: { USD: 1 } },
    usFilingSingle:      false,
  };
  const detail = new UsTaxRates2025().computeTax(state);
  assert.ok(detail.feieExcluded > 0, 'fixture actually elects FEIE');
  assert.ok(
    detail.feieApplied < detail.feieExcluded,
    'fixture exercises the cap (qualifying exclusion exceeds taxable income)',
  );

  const doc  = new UsTaxDocument2026().generate(detail, 2025);
  const feie = line(doc, 'Income', 'Foreign Earned Income Exclusion (Form 2555)');
  assert.equal(feie.amount, -detail.feieApplied, 'the applied (capped) exclusion is shown');
  assert.notEqual(feie.amount, -detail.feieExcluded, 'not the uncapped qualifying amount');
});

test('F1040-6: feieApplied equals feieExcluded when the cap does not bite', () => {
  const detail = new UsTaxRates2025().computeTax({
    usOrdinaryIncomeYTD: 400_000,
    usFeieElected:       true,
    people:              { p1: { residency: 'AU', residencySinceMs: null } },
    auPersonEarnedIncomeYTD: { p1: 90_000 },
    exchangeRates:       { AUD: { USD: 1 } },
  });
  assert.equal(detail.feieApplied, detail.feieExcluded);
  assert.ok(detail.feieApplied > 0);
});
