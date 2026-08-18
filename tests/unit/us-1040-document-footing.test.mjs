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

// ─── Unrecaptured §1250 gain (the F4 defect) ─────────────────────────────────
//
// Design 83 G7 gave the engine a fourth rate group and added its tax to `regularTax`,
// but the document module never grew a line for it — so on any return with a
// depreciated property the listed tax lines fell short of the printed Gross Tax by
// the whole §1250 charge, and the Income section never showed the gain that produced
// it. `npm run export:tax -- --check` reports it as a Tax Computation footing
// violation; the arithmetic was always right, the return simply did not say where the
// money came from.
//
// The slice is carved OUT of `usCapitalGainsYTD` by the disposal reducers rather than
// folded into it, so it is income no other line on the return contains — which is why
// this cannot be checked by summing the capital-gain line alone.

/** Ordinary income small enough that the bracket differential beats the 25% ceiling. */
const U1250_LOW_ORDINARY = {
  usOrdinaryIncomeYTD:       40_000,
  usUnrecaptured1250GainYTD: 60_000,
  usCapitalGainsYTD:        200_000,
  usFilingSingle:            false,
};

/** Ordinary income high enough that the ceiling binds. */
const U1250_CEILING = {
  usOrdinaryIncomeYTD:       600_000,
  usUnrecaptured1250GainYTD: 60_000,
  usFilingSingle:            false,
};

test('F1040-7: the Tax Computation lines sum to Gross Tax with a §1250 slice present', () => {
  for (const [name, state] of [['low ordinary', U1250_LOW_ORDINARY], ['ceiling', U1250_CEILING]]) {
    const detail = new UsTaxRates2025().computeTax(state);
    assert.ok(detail.unrecapturedSection1250Tax > 0, `${name}: fixture actually charges §1250 tax`);

    const doc = new UsTaxDocument2026().generate(detail, 2025);
    assert.ok(
      Math.abs(foot(doc, 'Tax Computation', 'Gross Tax') - detail.grossTax) < EPS,
      `${name}: the listed tax lines must sum to the Gross Tax line printed beneath them`,
    );
  }
});

test('F1040-8: the §1250 gain and its tax are both listed, matching the engine', () => {
  const detail = new UsTaxRates2025().computeTax(U1250_LOW_ORDINARY);
  const doc    = new UsTaxDocument2026().generate(detail, 2025);

  const gain = line(doc, 'Income', 'Unrecaptured §1250 Gain (25% rate, Sch. D line 19)');
  const tax  = line(doc, 'Tax Computation', 'Unrecaptured §1250 Gain Tax (25% max)');
  assert.ok(gain, '§1250 income line present');
  assert.ok(tax,  '§1250 tax line present');
  assert.equal(gain.amount, detail.unrecapturedSection1250Gain);
  assert.equal(tax.amount,  detail.unrecapturedSection1250Tax);

  // The slice is NOT inside the capital-gain line — the accumulators partition the
  // taxable gain. A reader adding the two must not be double-counting.
  const ltcg = line(doc, 'Income', 'Long-Term Capital Gains (Sch. D)');
  assert.equal(ltcg.amount, U1250_LOW_ORDINARY.usCapitalGainsYTD);
  assert.equal(doc.summary.grossIncome,
    detail.inputs.grossOrdinaryIncome + ltcg.amount + gain.amount,
    'summary gross income counts the §1250 slice exactly once');
});

test('F1040-9: the §1250 supporting detail is whichever §1(h)(1)(D) limb set the tax', () => {
  // The bracket differential wins: the bands ARE the computation and must sum to it.
  const low = new UsTaxRates2025().computeTax(U1250_LOW_ORDINARY);
  assert.equal(low.brackets.unrecap1250.ceilingApplied, false, 'fixture: differential wins');
  const lowLine = line(new UsTaxDocument2026().generate(low, 2025),
    'Tax Computation', 'Unrecaptured §1250 Gain Tax (25% max)');
  assert.ok(lowLine.bands?.length, 'differenced bands attached');
  assert.equal(lowLine.flat, undefined, 'no flat row — the ceiling did not bite');
  assert.ok(Math.abs(lowLine.bands.reduce((s, b) => s + b.tax, 0) - lowLine.amount) < EPS,
    'Σ band.tax equals the line, which is what the worksheet verifier checks');

  // The ceiling wins: the bands would OVERSTATE the line, so a flat 25% row is shown.
  const cap = new UsTaxRates2025().computeTax(U1250_CEILING);
  assert.equal(cap.brackets.unrecap1250.ceilingApplied, true, 'fixture: ceiling binds');
  const capLine = line(new UsTaxDocument2026().generate(cap, 2025),
    'Tax Computation', 'Unrecaptured §1250 Gain Tax (25% max)');
  assert.equal(capLine.bands, undefined, 'no band schedule — it would not foot to the line');
  assert.equal(capLine.flat.rate, 0.25);
  assert.ok(Math.abs(capLine.flat.rate * capLine.flat.income - capLine.amount) < EPS);
});

test('F1040-10: §1(h)(1)(D)(ii) sheltering is disclosed, not left as a silent gap', () => {
  // No ordinary income, so the standard deduction has to land on the §1250 layer first
  // (SD-2 in tax-rates.test.mjs). The income line states the GROSS slice, the bands span
  // the sheltered one, and without this row nothing on the return bridges them.
  const detail = new UsTaxRates2025().computeTax({
    usUnrecaptured1250GainYTD: 60_000,
    usCapitalGainsYTD:        200_000,
    usFilingSingle:            false,
  });
  const doc     = new UsTaxDocument2026().generate(detail, 2025);
  const shelter = line(doc, 'Income', '  …less unused standard deduction absorbed (§1(h)(1)(D)(ii))');
  assert.ok(shelter, 'shelter row present when the deduction reaches this layer');
  assert.ok(shelter.sub, 'marked `sub` so no footing sum counts it');
  assert.equal(shelter.amount,
    -(detail.unrecapturedSection1250Gain - detail.brackets.unrecap1250.gain));
});

test('F1040-11: a return with no depreciated property carries no §1250 lines at all', () => {
  const doc    = doc1040({ usOrdinaryIncomeYTD: 200_000, usCapitalGainsYTD: 100_000 });
  const labels = doc.sections.flatMap(s => s.lineItems.map(li => li.label));
  assert.ok(!labels.some(l => l.includes('1250')), 'no permanently-zero §1250 rows');

  const detail = new UsTaxRates2025().computeTax({
    usOrdinaryIncomeYTD: 200_000, usCapitalGainsYTD: 100_000,
  });
  assert.ok(Math.abs(foot(doc, 'Tax Computation', 'Gross Tax') - detail.grossTax) < EPS);
});
