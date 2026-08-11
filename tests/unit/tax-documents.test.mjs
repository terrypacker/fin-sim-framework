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
 * tax-documents.test.mjs
 * Unit tests for the JournalReportingService / TaxDocumentRegistry pipeline.
 *
 * Run with: node --test tests/unit/tax-documents.test.mjs
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { UsTaxDocument2026 }      from '../../src/finance/tax/us/us-tax-document-2026.js';
import { AuTaxDocument2026 }      from '../../src/finance/tax/au/au-tax-document-2026.js';
import { AuTaxDocument2027 }      from '../../src/finance/tax/au/au-tax-document-2027.js';
import { TaxDocumentRegistry }    from '../../src/finance/tax/tax-document-registry.js';
import { JournalReportingService } from '../../src/finance/journal-reporting-service.js';
import { UsTaxRates2025 }         from '../../src/finance/tax/us/us-tax-rates-2025.js';
import { AuTaxRates2025 }         from '../../src/finance/tax/au/au-tax-rates-2025.js';
import { AuTaxRates2027 }         from '../../src/finance/tax/au/au-tax-rates-2027.js';
import { worksheetRowsFromDocuments, tableDocumentToCsv, cellText } from '../../src/finance/tax/tax-worksheet-export.js';

import { TypeRegistry as _TypeRegistry } from '../../src/simulation-framework/type-registry.js';
import { US_INCOME as _US_INCOME }       from '../../src/scenarios/toolsets/us-income-toolset.js';

/** Minimal registry carrying the disposal action declarations under test. */
function buildTypeRegistryForDisposals() {
  const reg = new _TypeRegistry();
  reg.registerToolset(_US_INCOME);
  return reg;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function usDetail(overrides = {}) {
  return new UsTaxRates2025().computeTax({
    usOrdinaryIncomeYTD:   100_000,
    usNegativeIncomeYTD:   5_000,
    usCapitalGainsYTD:     20_000,
    usCollectibleGainsYTD: 0,
    usPenaltyYTD:          0,
    ...overrides,
  });
}

function auResidentDetail(overrides = {}) {
  return new AuTaxRates2025().computeTax({
    people:                      { primary: { residency: 'AU' } },
    auOrdinaryIncomeYTD:         80_000,
    auCapitalGainsYTD:           20_000,
    auNonResidentWithholdingYTD: 0,
    auSuperTaxYTD:               1_500,
    auFrankingCreditYTD:         2_000,
    ...overrides,
  });
}

function auNrDetail(overrides = {}) {
  return new AuTaxRates2025().computeTax({
    people:                      { primary: { residency: 'US' } },
    auOrdinaryIncomeYTD:         50_000,
    auCapitalGainsYTD:           0,
    auNonResidentWithholdingYTD: 10_000,
    auSuperTaxYTD:               0,
    auFrankingCreditYTD:         0,
    ...overrides,
  });
}

function makeEntry(cc, taxDetail, dateMs = Date.UTC(2026, 0, 1)) {
  return {
    date:   new Date(dateMs),
    action: { type: `${cc}_TAX_SETTLE_APPLY`, data: { taxDetail } },
  };
}

/**
 * The ITR out of a `generate()` result.
 *
 * A resident AU return with any CGT activity comes back as an ARRAY — the ITR, its
 * CGT summary worksheet, and the CGT schedule when the entity threshold is met. Tests
 * asserting on the return itself want the first element.
 */
function itrOf(result) { return Array.isArray(result) ? result[0] : result; }

/**
 * A supplementary document by title fragment.
 *
 * Positional indexing (`const [, cgt] = ...`) is what broke when the CGT summary
 * worksheet was inserted between the ITR and the schedule, and it would break again
 * on the next form. Ask for the document by name.
 */
function docNamed(result, fragment) {
  return [].concat(result).find(d => d.title.includes(fragment));
}

// ══════════════════════════════════════════════════════════════════════════════
// UsTaxDocument2026
// ══════════════════════════════════════════════════════════════════════════════

test('UsTaxDocument2026: title includes taxYear', () => {
  const doc = new UsTaxDocument2026().generate(usDetail(), 2025);
  assert.ok(doc.title.includes('2025'), `expected title to include 2025, got: ${doc.title}`);
});

test('UsTaxDocument2026: country is US', () => {
  const doc = new UsTaxDocument2026().generate(usDetail(), 2025);
  assert.strictEqual(doc.country, 'US');
});

test('UsTaxDocument2026: has Income, Tax Computation, and Credits sections', () => {
  const doc = new UsTaxDocument2026().generate(usDetail(), 2025);
  const headings = doc.sections.map(s => s.heading);
  assert.ok(headings.includes('Income'));
  assert.ok(headings.includes('Tax Computation'));
  assert.ok(headings.includes('Credits'));
});

test('UsTaxDocument2026: summary netLiability matches taxDetail', () => {
  const detail = usDetail();
  const doc    = new UsTaxDocument2026().generate(detail, 2025);
  assert.strictEqual(doc.summary.netLiability, detail.netLiability);
});

test('UsTaxDocument2026: summary effectiveRate and marginalRate present', () => {
  const detail = usDetail();
  const doc    = new UsTaxDocument2026().generate(detail, 2025);
  assert.ok(typeof doc.summary.effectiveRate === 'number');
  assert.ok(typeof doc.summary.marginalRate  === 'number');
});

test('UsTaxDocument2026: Income section contains Adjusted Gross Income line', () => {
  const detail = usDetail();
  const doc    = new UsTaxDocument2026().generate(detail, 2025);
  const income = doc.sections.find(s => s.heading === 'Income');
  const agi    = income.lineItems.find(li => li.label === 'Adjusted Gross Income');
  assert.ok(agi, 'AGI line item not found');
  assert.strictEqual(agi.amount, detail.adjustedGrossIncome);
});

test('UsTaxDocument2026: Tax Computation section Gross Tax matches taxDetail', () => {
  const detail = usDetail();
  const doc    = new UsTaxDocument2026().generate(detail, 2025);
  const comp   = doc.sections.find(s => s.heading === 'Tax Computation');
  const gross  = comp.lineItems.find(li => li.label === 'Gross Tax');
  assert.strictEqual(gross.amount, detail.grossTax);
});

test('UsTaxDocument2026: per-§904-basket FTC credit lines are negative (reduce liability)', () => {
  const detail = usDetail({
    foreignPassiveIncomeYTD: 40_000,
    ftcCurrentPassive:       3_000,
    effectiveExchangeRates:  { USD_AUD: 1 },
    currentPeriods:          { US: { startMs: Date.UTC(2025, 0, 1) } },
  });
  const doc     = new UsTaxDocument2026().generate(detail, 2025);
  const credits = doc.sections.find(s => s.heading === 'Credits');
  const passive = credits.lineItems.find(li => li.label === 'Foreign Tax Credit — Passive (§904)');
  assert.ok(passive != null && passive.amount < 0, 'Passive FTC should be < 0 (reduces tax)');
});

test('UsTaxDocument2026: FEIE exclusion appears in the Income section when elected', () => {
  const detail = usDetail({
    usFeieElected:           true,
    people:                  { primary: { residency: 'AU' } },
    auPersonEarnedIncomeYTD: { primary: 90_000 },
    effectiveExchangeRates:  { USD_AUD: 1 },
  });
  const doc    = new UsTaxDocument2026().generate(detail, 2025);
  const income = doc.sections.find(s => s.heading === 'Income');
  const feie   = income.lineItems.find(li => li.label.includes('Foreign Earned Income Exclusion'));
  assert.ok(feie != null && feie.amount < 0, 'FEIE line present and negative');
});

test('AuTaxDocument2026: FITO line appears when US tax was paid on US-source income', () => {
  const detail = auResidentDetail({
    auOrdinaryIncomeYTD:    120_000,
    usSourceOrdinaryAudYTD: 60_000,
    usTaxPaidOnUsSourceAud: 12_000,
  });
  const doc     = itrOf(new AuTaxDocument2026().generate(detail, 2025));
  const credits = doc.sections.find(s => s.heading === 'Credits');
  const fito    = credits.lineItems.find(li => li.label.includes('Foreign Income Tax Offset'));
  assert.ok(fito != null && fito.amount < 0, 'FITO line present and negative');
});

// ══════════════════════════════════════════════════════════════════════════════
// AuTaxDocument2026 — resident path
// ══════════════════════════════════════════════════════════════════════════════

test('AuTaxDocument2026 resident: title includes FY label', () => {
  const doc = itrOf(new AuTaxDocument2026().generate(auResidentDetail(), 2025));
  assert.ok(doc.title.includes('FY 2025'), `expected FY label, got: ${doc.title}`);
});

test('AuTaxDocument2026 resident: filingStatus is Individual Resident', () => {
  const doc = itrOf(new AuTaxDocument2026().generate(auResidentDetail(), 2025));
  assert.strictEqual(doc.filingStatus, 'Individual Resident');
});

test('AuTaxDocument2026 resident: has Income, Tax Computation, Credits sections', () => {
  const doc      = itrOf(new AuTaxDocument2026().generate(auResidentDetail(), 2025));
  const headings = doc.sections.map(s => s.heading);
  assert.ok(headings.includes('Income'));
  assert.ok(headings.includes('Tax Computation'));
  assert.ok(headings.includes('Credits'));
});

test('AuTaxDocument2026 resident: CGT Discount line is negative', () => {
  const detail  = auResidentDetail({ auCapitalGainsYTD: 40_000 });
  const doc     = itrOf(new AuTaxDocument2026().generate(detail, 2025));
  const income  = doc.sections.find(s => s.heading === 'Income');
  const discount = income.lineItems.find(li => li.label === 'CGT 50% Discount');
  assert.ok(discount, 'CGT Discount line not found');
  assert.ok(discount.amount <= 0, 'CGT Discount should be <= 0');
});

test('AuTaxDocument2026 resident: summary netLiability matches taxDetail', () => {
  const detail = auResidentDetail();
  const doc    = itrOf(new AuTaxDocument2026().generate(detail, 2025));
  assert.strictEqual(doc.summary.netLiability, detail.netLiability);
});

test('AuTaxDocument2026 resident: Franking Credits line is negative', () => {
  const detail  = auResidentDetail({ auFrankingCreditYTD: 5_000 });
  const doc     = itrOf(new AuTaxDocument2026().generate(detail, 2025));
  const credits = doc.sections.find(s => s.heading === 'Credits');
  const fc      = credits.lineItems.find(li => li.label === 'Franking Credits');
  assert.ok(fc.amount <= 0, 'Franking Credits should be <= 0 (reduces tax)');
});

test('AuTaxDocument2026 resident: Tax on Income splits into ordinary + capital gains sub-rows summing to the total', () => {
  const doc  = itrOf(new AuTaxDocument2026().generate(auResidentDetail(), 2025));
  const comp = doc.sections.find(s => s.heading === 'Tax Computation');
  const total = comp.lineItems.find(li => li.label === 'Tax on Income').amount;
  const ord   = comp.lineItems.find(li => li.label === 'Tax on Ordinary Income');
  const cg    = comp.lineItems.find(li => li.label === 'Tax on Capital Gains');
  assert.ok(ord?.sub && cg?.sub, 'both breakdown rows present and flagged sub');
  assert.ok(Math.abs((ord.amount + cg.amount) - total) < 1e-6, 'sub-rows sum to Tax on Income');
  assert.ok(cg.amount > 0, 'a positive capital gain adds incremental bracket tax');
});

test('AuTaxDocument2026 resident: no breakdown sub-rows when there are no capital gains', () => {
  const doc  = itrOf(new AuTaxDocument2026().generate(auResidentDetail({ auCapitalGainsYTD: 0 }), 2025));
  const comp = doc.sections.find(s => s.heading === 'Tax Computation');
  assert.ok(!comp.lineItems.some(li => li.sub), 'no sub-rows without a capital gain');
});

// ══════════════════════════════════════════════════════════════════════════════
// AuTaxDocument2027 — CGT reform (design 57): indexation relief + 30% min-tax
// ══════════════════════════════════════════════════════════════════════════════

// Gain sits in the 30% bracket (ordinary 80k), so no min-tax top-up. realGain
// 12k < gross 20k ⇒ 8k of cost-base indexation relief.
function au2027Detail(overrides = {}) {
  return new AuTaxRates2027().computeTax({
    people:                      { primary: { residency: 'AU' } },
    auOrdinaryIncomeYTD:         80_000,
    auCapitalGainsYTD:           20_000,
    auRealCapitalGainsYTD:       12_000,
    auNonResidentWithholdingYTD: 0,
    auSuperTaxYTD:               1_500,
    auFrankingCreditYTD:         2_000,
    ...overrides,
  });
}

test('AuTaxDocument2027 resident: relabels relief as Cost-Base Indexation, no "50% Discount" line', () => {
  const doc    = itrOf(new AuTaxDocument2027().generate(au2027Detail(), 2027));
  const income = doc.sections.find(s => s.heading === 'Income');
  assert.ok(income.lineItems.some(li => li.label === 'Cost-Base Indexation Relief'),
    'expected a Cost-Base Indexation Relief line');
  assert.ok(!income.lineItems.some(li => li.label === 'CGT 50% Discount'),
    'must not show the removed 50% discount label for FY2027+');
});

test('AuTaxDocument2027 resident: relief = gross − indexed real gain, and it is negative', () => {
  const detail = au2027Detail();
  const doc    = itrOf(new AuTaxDocument2027().generate(detail, 2027));
  const income = doc.sections.find(s => s.heading === 'Income');
  const relief = income.lineItems.find(li => li.label === 'Cost-Base Indexation Relief');
  const net    = income.lineItems.find(li => li.label === 'Net Capital Gains (indexed)');
  assert.equal(relief.amount, -8_000, 'relief = -(20k gross − 12k indexed)');
  assert.ok(relief.amount < 0, 'relief reduces assessable income');
  assert.equal(net.amount, 12_000, 'net capital gains = indexed real gain');
});

test('AuTaxDocument2027 resident: Tax Computation reconciles to Gross Tax with min-tax top-up', () => {
  // Low ordinary income ⇒ the gain's marginal rate is below 30% ⇒ a top-up fires.
  const detail = au2027Detail({ auOrdinaryIncomeYTD: 0, auCapitalGainsYTD: 30_000, auRealCapitalGainsYTD: 30_000, auFrankingCreditYTD: 0 });
  assert.ok(detail.cgtMinimumTaxTopUp > 0, 'fixture should produce a 30% min-tax top-up');
  const doc  = itrOf(new AuTaxDocument2027().generate(detail, 2027));
  const comp = doc.sections.find(s => s.heading === 'Tax Computation');
  const topUp = comp.lineItems.find(li => li.label === 'CGT Minimum Tax Top-up (30%)');
  assert.ok(topUp, 'expected a CGT Minimum Tax Top-up line');
  const gross = comp.lineItems.find(li => li.label === 'Gross Tax').amount;
  // Exclude the Gross Tax total itself, the breakdown sub-rows (which restate
  // "Tax on Income", they are not additional amounts), and memo rows (design 77 §5.3
  // — the super FUND tax, disclosed but not part of the member's liability).
  const sumOfParts = comp.lineItems
    .filter(li => li.label !== 'Gross Tax' && !li.sub && !li.memo)
    .reduce((s, li) => s + li.amount, 0);
  assert.ok(Math.abs(sumOfParts - gross) < 1e-6, 'section line items must sum to Gross Tax');
});

test('AuTaxDocument2027 resident: no top-up line when the gain is already taxed at >= 30%', () => {
  const doc  = itrOf(new AuTaxDocument2027().generate(au2027Detail(), 2027));
  const comp = doc.sections.find(s => s.heading === 'Tax Computation');
  assert.ok(!comp.lineItems.some(li => li.label === 'CGT Minimum Tax Top-up (30%)'),
    'no top-up when marginal rate on the gain already >= 30%');
});

test('AuTaxDocument2027 resident: Tax on Income breakdown sub-rows sum to the total (top-up excluded)', () => {
  // Low-ordinary case: baseTax split still sums to Tax on Income; the 30% top-up
  // is a separate line and must NOT be folded into the capital-gains sub-row.
  const detail = au2027Detail({ auOrdinaryIncomeYTD: 0, auCapitalGainsYTD: 30_000, auRealCapitalGainsYTD: 30_000, auFrankingCreditYTD: 0 });
  const doc    = itrOf(new AuTaxDocument2027().generate(detail, 2027));
  const comp   = doc.sections.find(s => s.heading === 'Tax Computation');
  const total  = comp.lineItems.find(li => li.label === 'Tax on Income').amount;
  const ord    = comp.lineItems.find(li => li.label === 'Tax on Ordinary Income').amount;
  const cg     = comp.lineItems.find(li => li.label === 'Tax on Capital Gains').amount;
  assert.ok(Math.abs((ord + cg) - total) < 1e-6, 'sub-rows sum to Tax on Income');
  // The CG sub-row is only the marginal bracket tax on the gain — below the 30%
  // floor (that gap is exactly why the top-up fires) and reported as a distinct line.
  assert.ok(cg < 0.30 * 30_000, 'CG sub-row is the sub-30% marginal bracket tax, not the floored amount');
  assert.ok(comp.lineItems.some(li => li.label === 'CGT Minimum Tax Top-up (30%)'), 'top-up is its own line');
});

test('TaxDocumentRegistry: an FY2027+ AU settle entry resolves to the AuTaxDocument2027 formatter', () => {
  const entry = makeEntry('AU', au2027Detail(), Date.UTC(2068, 0, 1)); // FY2067-68 → highest ≤ = 2027
  const doc   = itrOf(new TaxDocumentRegistry().generate(entry));
  const income = doc.sections.find(s => s.heading === 'Income');
  assert.ok(income.lineItems.some(li => li.label === 'Cost-Base Indexation Relief'),
    'registry should pick AuTaxDocument2027 (reform labels), not the 2026 fallback');
});

// ══════════════════════════════════════════════════════════════════════════════
// AuTaxDocument2026 — non-resident path
// ══════════════════════════════════════════════════════════════════════════════

test('AuTaxDocument2026 non-resident: title includes Non-Resident', () => {
  const doc = itrOf(new AuTaxDocument2026().generate(auNrDetail(), 2025));
  assert.ok(doc.title.includes('Non-Resident'), `expected Non-Resident in title, got: ${doc.title}`);
});

test('AuTaxDocument2026 non-resident: filingStatus is Individual Non-Resident', () => {
  const doc = itrOf(new AuTaxDocument2026().generate(auNrDetail(), 2025));
  assert.strictEqual(doc.filingStatus, 'Individual Non-Resident');
});

test('AuTaxDocument2026 non-resident: no Credits section', () => {
  const doc      = itrOf(new AuTaxDocument2026().generate(auNrDetail(), 2025));
  const headings = doc.sections.map(s => s.heading);
  assert.ok(!headings.includes('Credits'), 'Non-resident should not have a Credits section');
});

test('AuTaxDocument2026 non-resident: NR withholding tax line present', () => {
  const detail = auNrDetail({ auNonResidentWithholdingYTD: 10_000 });
  const doc    = itrOf(new AuTaxDocument2026().generate(detail, 2025));
  const comp   = doc.sections.find(s => s.heading === 'Tax Computation');
  const nrLine = comp.lineItems.find(li => li.label.includes('Non-Resident Withholding Tax'));
  assert.ok(nrLine, 'NR withholding tax line not found');
  assert.strictEqual(nrLine.amount, detail.nonResidentWithholdingTax);
});

// ══════════════════════════════════════════════════════════════════════════════
// TaxDocumentRegistry
// ══════════════════════════════════════════════════════════════════════════════

test('TaxDocumentRegistry: generates US document for TAX_SETTLE_APPLY entry', () => {
  const registry = new TaxDocumentRegistry();
  const detail   = { ...usDetail(), taxYear: 2025 };
  const entry    = makeEntry('US', detail);
  const doc      = registry.generate(entry);
  assert.strictEqual(doc.country, 'US');
  assert.strictEqual(doc.taxYear, 2025);
});

test('TaxDocumentRegistry: generates AU document for TAX_SETTLE_APPLY entry', () => {
  const registry = new TaxDocumentRegistry();
  const detail   = { ...auResidentDetail(), taxYear: 2025 };
  const entry    = makeEntry('AU', detail);
  const doc      = itrOf(registry.generate(entry));
  assert.strictEqual(doc.country, 'AU');
  assert.strictEqual(doc.taxYear, 2025);
});

test('TaxDocumentRegistry: returns null when taxDetail is absent', () => {
  const registry = new TaxDocumentRegistry();
  const entry    = { date: new Date(), action: { type: 'US_TAX_SETTLE_APPLY', data: {} } };
  assert.strictEqual(registry.generate(entry), null);
});

test('TaxDocumentRegistry: falls back to highest registered year for future years', () => {
  const registry = new TaxDocumentRegistry();
  const detail   = { ...usDetail(), taxYear: 2040 };
  const entry    = makeEntry('US', detail);
  const doc      = registry.generate(entry);
  assert.strictEqual(doc.country, 'US');
  assert.strictEqual(doc.taxYear, 2040);
});

test('TaxDocumentRegistry: uses taxDetail.taxYear over entry date when both present', () => {
  const registry = new TaxDocumentRegistry();
  // taxDetail says 2024, entry date would imply 2030
  const detail   = { ...usDetail(), taxYear: 2024 };
  const entry    = makeEntry('US', detail, Date.UTC(2030, 0, 1));
  const doc      = registry.generate(entry);
  assert.strictEqual(doc.taxYear, 2024);
});

test('TaxDocumentRegistry: returns array of documents for per-person AU settlement', () => {
  const registry = new TaxDocumentRegistry();
  const aliceDetail = { ...auResidentDetail({ auOrdinaryIncomeYTD: 90000 }), taxYear: 2025 };
  const bobDetail   = { ...auResidentDetail({ auOrdinaryIncomeYTD: 40000 }), taxYear: 2025 };
  const entry = {
    date:   new Date(Date.UTC(2026, 0, 1)),
    action: {
      type: 'AU_TAX_SETTLE_APPLY',
      data: {
        taxDetail: null,
        personTaxDetails: [
          { personKey: 'primary', personName: 'Alice', taxDetail: aliceDetail },
          { personKey: 'spouse',  personName: 'Bob',   taxDetail: bobDetail },
        ],
      },
    },
  };
  const docs = registry.generate(entry);
  assert.ok(Array.isArray(docs), 'should return an array');
  // Two people, each with a return and a CGT summary worksheet (both details carry a
  // capital gain). Asserted as a per-person GROUPING rather than a flat length, so
  // adding a form to one person cannot silently pass by shifting the other's index.
  const returns = docs.filter(d => d.title.includes('Tax Return'));
  assert.strictEqual(returns.length, 2);
  assert.strictEqual(returns[0].personKey,  'primary');
  assert.strictEqual(returns[0].personName, 'Alice');
  assert.strictEqual(returns[1].personKey,  'spouse');
  assert.strictEqual(returns[1].personName, 'Bob');
  assert.ok(docs.every(d => d.country === 'AU'));
  // Every supplementary form is attributed to the person whose return it supports —
  // the defect that put one taxpayer's schedule under the other's name.
  for (const key of ['primary', 'spouse']) {
    const forPerson = docs.filter(d => d.personKey === key);
    assert.ok(forPerson.some(d => d.title.includes('CGT Summary Worksheet')),
      `${key} should get their own CGT summary worksheet`);
  }
});

test('TaxDocumentRegistry: AU entry with no CGT activity returns a bare ITR, not an array', () => {
  const registry = new TaxDocumentRegistry();
  // No capital gains and no loss pool ⇒ the CGT summary worksheet has nothing to say,
  // so the common wages-only AU year is still a single document.
  const detail   = { ...auResidentDetail({ auCapitalGainsYTD: 0 }), taxYear: 2025 };
  const entry    = makeEntry('AU', detail);
  const doc      = registry.generate(entry);
  assert.ok(!Array.isArray(doc), 'gainless AU entry should not return array');
  assert.strictEqual(doc.country, 'AU');
});

// ══════════════════════════════════════════════════════════════════════════════
// JournalReportingService
// ══════════════════════════════════════════════════════════════════════════════

test('JournalReportingService: generates US tax document for TAX_SETTLE_APPLY', () => {
  const service = new JournalReportingService();
  const detail  = { ...usDetail(), taxYear: 2025 };
  const entry   = makeEntry('US', detail);
  const doc     = service.generate(entry);
  assert.ok(doc !== null);
  assert.strictEqual(doc.country, 'US');
});

test('JournalReportingService: returns null for unregistered action type', () => {
  const service = new JournalReportingService();
  const entry   = { date: new Date(), action: { type: 'RECORD_BALANCE' } };
  assert.strictEqual(service.generate(entry), null);
});

test('JournalReportingService: returns null for entry with no action', () => {
  const service = new JournalReportingService();
  assert.strictEqual(service.generate({ date: new Date() }), null);
});

test('JournalReportingService: custom reporter can be registered for new action types', () => {
  const service   = new JournalReportingService();
  const fakeReport = { generate: () => ({ type: 'FAKE_REPORT' }) };
  service.register('SOME_FUTURE_ACTION', fakeReport);
  const entry = { date: new Date(), action: { type: 'SOME_FUTURE_ACTION' } };
  assert.deepEqual(service.generate(entry), { type: 'FAKE_REPORT' });
});

// ══════════════════════════════════════════════════════════════════════════════
// AuTaxDocument2026 — capital gain or capital loss worksheet (NAT 4151)
//
// This replaced a "CGT Schedule" tab, which was the wrong form: the CGT schedule is
// an entity lodgment ("Individuals … are not required to complete a CGT schedule"),
// its A$10,000 gate is the entity threshold, and it stated the US gain in USD on an
// AUD document. The tests below hold the replacement to the properties that failure
// taught: AU measure, AUD, and per person.
// ══════════════════════════════════════════════════════════════════════════════

function makeWorksheetRow(overrides = {}) {
  return {
    description:  'AU Stock Account',
    category:     'Listed shares (ASX)',
    dateSold:     new Date(Date.UTC(2026, 5, 1)),
    proceeds:     50_000,
    costBase:     35_000,
    discountGain: 15_000,
    otherGain:    0,
    loss:         0,
    ...overrides,
  };
}

test('CGT worksheet: emitted for a resident with disposals, at ANY size', () => {
  // Deliberately below the old A$10,000 gate. That threshold governs whether an
  // ENTITY lodges a CGT schedule; it has never had anything to say about whether an
  // individual's working paper is worth showing.
  const detail = auResidentDetail({ auCapitalGainsYTD: 5_000 });
  const docs   = new AuTaxDocument2026().generate(detail, 2025, [makeWorksheetRow({ discountGain: 5_000 })]);
  const ws     = docNamed(docs, 'CGT Worksheet');
  assert.ok(ws, 'a A$5,000 gain still deserves a worksheet');
  assert.strictEqual(ws.country, 'AU');
  assert.strictEqual(ws.taxYear, 2025);
  assert.strictEqual(ws.filingStatus, 'Capital Gain or Capital Loss Worksheet');
  assert.ok(ws.title.includes('FY 2025'), `expected FY 2025 in title, got: ${ws.title}`);
});

test('CGT worksheet: no worksheet without disposals, or for a non-resident', () => {
  const resident = new AuTaxDocument2026().generate(
    auResidentDetail({ auCapitalGainsYTD: 50_000 }), 2025, []);
  assert.ok(!docNamed(resident, 'CGT Worksheet'), 'no rows ⇒ no worksheet');

  const nonRes = new AuTaxDocument2026().generate(
    auNrDetail({ auCapitalGainsYTD: 50_000 }), 2025, [makeWorksheetRow()]);
  assert.ok(!docNamed(nonRes, 'CGT Worksheet'), 'non-residents file no resident worksheet');
});

test('CGT worksheet: columns are the NAT 4151 ones — gain by method, and a loss column', () => {
  const ws = docNamed(new AuTaxDocument2026().generate(
    auResidentDetail({ auCapitalGainsYTD: 20_000 }), 2025, [makeWorksheetRow()]), 'CGT Worksheet');
  assert.deepEqual(ws.table.columns, [
    'CGT Asset or Event', 'Category', 'Date of CGT Event',
    'Capital Proceeds', 'Cost Base',
    'Gain: Discount Method', "Gain: 'Other' Method", 'Capital Loss',
  ]);
});

test('CGT worksheet: a loss occupies its own column, not a negative gain', () => {
  // NAT 4151 computes a capital loss in a fourth column of its own, because a loss is
  // measured from the REDUCED cost base rather than the cost base. Reporting it as a
  // negative gain would also let it net against gains a column too early — before the
  // s102-5 Step 1 the summary worksheet performs.
  const ws = docNamed(new AuTaxDocument2026().generate(
    auResidentDetail({ auCapitalGainsYTD: 20_000 }), 2025,
    [makeWorksheetRow({ discountGain: 0, otherGain: 0, loss: 4_000, proceeds: 10_000, costBase: 14_000 })]),
    'CGT Worksheet');
  const [row] = ws.table.rows;
  assert.strictEqual(row[5], 0,     'no discount-method gain');
  assert.strictEqual(row[6], 0,     "no 'other'-method gain");
  assert.strictEqual(row[7], 4_000, 'the loss belongs in the loss column');
});

test('CGT worksheet: totals foot each column', () => {
  const rows = [
    makeWorksheetRow({ proceeds: 50_000, costBase: 35_000, discountGain: 15_000 }),
    makeWorksheetRow({ proceeds: 30_000, costBase: 15_000, discountGain: 0, otherGain: 15_000 }),
  ];
  const ws = docNamed(new AuTaxDocument2026().generate(
    auResidentDetail({ auCapitalGainsYTD: 30_000 }), 2025, rows), 'CGT Worksheet');
  const t = ws.table.totals;
  assert.strictEqual(t[3], 80_000, 'total capital proceeds');
  assert.strictEqual(t[4], 50_000, 'total cost base');
  assert.strictEqual(t[5], 15_000, 'total discount-method gain');
  assert.strictEqual(t[6], 15_000, "total 'other'-method gain");
  // …and the two gain columns together are what the summary worksheet reports at 1J.
  assert.strictEqual(t[5] + t[6], 30_000);
});

test('CGT worksheet: states which cost base it used and why rows carry no acquisition date', () => {
  const ws = docNamed(new AuTaxDocument2026().generate(
    auResidentDetail({ auCapitalGainsYTD: 20_000 }), 2025, [makeWorksheetRow()]), 'CGT Worksheet');
  const notes = ws.notes.join(' ');
  assert.ok(/s855-45/.test(notes), 'the AU cost base is a stepped-up one and must say so');
  assert.ok(/FIFO/.test(notes),    'pooled holdings have no single acquisition date');
});

test('CGT worksheet: unattributed disposals are disclosed, never silently dropped', () => {
  const ws = docNamed(new AuTaxDocument2026().generate(
    auResidentDetail({ auCapitalGainsYTD: 20_000 }), 2025,
    { rows: [makeWorksheetRow()], unattributed: { count: 3, proceeds: 46_854 } }), 'CGT Worksheet');
  const notes = ws.notes.join(' ');
  assert.ok(/3 disposal\(s\)/.test(notes), `expected an exclusion note, got: ${notes}`);
  assert.ok(/46854\.00/.test(notes));
});

test('CGT worksheet FY2027: gain columns follow the reform labels', () => {
  const ws = docNamed(new AuTaxDocument2027().generate(
    au2027Detail(), 2027, [makeWorksheetRow()]), 'CGT Worksheet');
  assert.ok(ws.table.columns.includes('Gain: Held ≥ 12 Months'));
  assert.ok(!ws.table.columns.some(c => /Discount/.test(c)),
    'the reform removed the discount; no column may still name one');
});

test('CGT worksheet reaches the CSV export as a table', () => {
  // The original complaint: the CGT tab had no download button, because
  // `flattenDocument` yields nothing for a table-shaped document. Disposal registers
  // now export in their own columns instead of being suppressed.
  const ws = docNamed(new AuTaxDocument2026().generate(
    auResidentDetail({ auCapitalGainsYTD: 20_000 }), 2025, [makeWorksheetRow()]), 'CGT Worksheet');
  ws.personName = 'Terry';
  const csv   = tableDocumentToCsv(ws);
  const lines = csv.split('\n');
  assert.ok(lines[0].startsWith('Tax Year,Country,Form,Person,CGT Asset or Event'),
    `unexpected header: ${lines[0]}`);
  assert.ok(lines[1].startsWith('2025,AU,'), `unexpected row: ${lines[1]}`);
  assert.ok(lines[1].includes('Terry'), 'the person must ride along for a multi-form pivot');
  assert.ok(lines.some(l => l.startsWith('Totals') || l.includes(',Totals,')), 'totals row exported');
  assert.ok(lines.some(l => l.startsWith('"# ') || l.startsWith('# ')), 'notes exported as comments');
});

test('CGT worksheet: a section-shaped document still exports the worksheet way', () => {
  const summary = docNamed(new AuTaxDocument2026().generate(
    auResidentDetail({ auCapitalGainsYTD: 20_000 }), 2025), 'CGT Summary Worksheet');
  assert.strictEqual(tableDocumentToCsv(summary), '', 'no table ⇒ no table export');
  assert.ok(worksheetRowsFromDocuments(summary).length > 0, 'it exports via the worksheet columns instead');
});

// ══════════════════════════════════════════════════════════════════════════════
// TaxDocumentRegistry — AU CGT worksheet via journal extraction
//
// The attribution seam. A tax document is built from (entry, journal) and no state,
// because state is the WRONG source: by the end of a run people have died and
// accounts have changed hands, so today's `usStockAccount.ownerId` misattributes a
// 2032 disposal with total confidence. The journal already records what the return
// did — `auPersonCapitalGainsYTD.<person>` on the disposal's own state diff — and
// that is what these tests pin.
// ══════════════════════════════════════════════════════════════════════════════

function makeAuSaleJournalEntry(type, data, dateMs = Date.UTC(2026, 3, 1), stateDiff = []) {
  return {
    date:   new Date(dateMs),
    action: { type, data },
    stateDiff,
  };
}

/** The per-person AU gain booking a disposal writes, as it appears in a state diff. */
function auGainDiff(shares) {
  return Object.entries(shares).map(([personKey, delta]) => ({
    field: `auPersonCapitalGainsYTD.${personKey}`, delta,
  }));
}

/** A two-person AU settle entry, the shape `computeAuTaxPerPerson` produces. */
function makePerPersonSettle(details, dateMs = Date.UTC(2026, 6, 1), fxRate = 1.5) {
  return {
    date:   new Date(dateMs),
    action: { type: 'AU_TAX_SETTLE_APPLY', data: { taxDetail: null, fxRate, personTaxDetails: details } },
  };
}

test('CGT worksheet extraction: an AU-native disposal lands whole, in AUD', () => {
  const registry    = new TaxDocumentRegistry();
  const detail      = { ...auResidentDetail({ auCapitalGainsYTD: 20_000 }), taxYear: 2025 };
  const settleEntry = makeEntry('AU', detail, Date.UTC(2026, 6, 1));
  const saleEntry   = makeAuSaleJournalEntry('AU_STOCK_WITHDRAWAL_TAX', {
    gain: 20_000, auGain: 20_000, proceeds: 55_000, costBasis: 35_000,
    description: 'AU Stock Account', stateKey: 'auStockAccount',
  });
  const ws = docNamed(registry.generate(settleEntry, [saleEntry, settleEntry]), 'CGT Worksheet');
  assert.strictEqual(ws.table.rows.length, 1);
  // Cell 0 is KEYED — `{ stateKey, text }` — so the modal can resolve the account's
  // display name (design 70). `cellText` is the no-registry fallback view of it.
  assert.strictEqual(cellText(ws.table.rows[0][0]), 'AU Stock Account');
  assert.strictEqual(ws.table.rows[0][0].stateKey, 'auStockAccount');
  assert.strictEqual(ws.table.rows[0][1], 'Listed shares (ASX)');
  assert.strictEqual(ws.table.rows[0][3], 55_000, 'AUD proceeds pass through unconverted');
  assert.strictEqual(ws.table.rows[0][5] + ws.table.rows[0][6], 20_000);
});

test('CGT worksheet extraction: a US disposal is stated at the AU cost base, in AUD', () => {
  // The two defects this replaces: `d.gain` is the US gain measured from the US
  // basis, and `d.proceeds` is USD. A resident's AU return assesses `auGain` from the
  // s855-45 stepped-up base, converted to AUD.
  const registry    = new TaxDocumentRegistry();
  const detail      = { ...auResidentDetail({ auCapitalGainsYTD: 15_000 }), taxYear: 2025 };
  const settleEntry = makePerPersonSettle(
    [{ personKey: 'primary', personName: 'Terry', taxDetail: detail }]);
  const saleEntry   = makeAuSaleJournalEntry('STOCK_WITHDRAWAL_TAX', {
    // US gain 8,000 but AU gain only 2,000 — the pre-move appreciation is US-only.
    gain: 8_000, auGain: 2_000, auDiscountableGain: 2_000, proceeds: 20_000, costBasis: 12_000,
    description: 'US Stock Account', stateKey: 'usStockAccount', residency: 'AU',
  }, Date.UTC(2026, 3, 1), auGainDiff({ primary: 3_000 }));   // 2,000 USD × 1.5

  const ws  = docNamed(registry.generate(settleEntry, [saleEntry, settleEntry]), 'CGT Worksheet');
  const row = ws.table.rows[0];
  assert.strictEqual(row[1], 'Other shares', 'foreign-listed shares are "Other shares" (NAT 4151 note 5)');
  assert.strictEqual(row[3], 30_000, 'proceeds converted at the rate the booking implies (20,000 × 1.5)');
  assert.strictEqual(row[5] + row[6], 3_000, 'the AU gain, in AUD — not the 8,000 US gain');
  assert.strictEqual(row[4], 27_000, 'cost base = proceeds − AU gain, i.e. the stepped-up base');
});

test('CGT worksheet extraction: each person gets only their own disposals', () => {
  // The reported defect: one unfiltered household list was handed to every person, so
  // Terry's form listed Jeanne's accounts and footed to neither return.
  const registry = new TaxDocumentRegistry();
  const terry    = { ...auResidentDetail({ auCapitalGainsYTD: 3_000 }), taxYear: 2025 };
  const jeanne   = { ...auResidentDetail({ auCapitalGainsYTD: 1_500 }), taxYear: 2025 };
  const settleEntry = makePerPersonSettle([
    { personKey: 'primary', personName: 'Terry',  taxDetail: terry  },
    { personKey: 'spouse',  personName: 'Jeanne', taxDetail: jeanne },
  ]);
  const journal = [
    makeAuSaleJournalEntry('STOCK_WITHDRAWAL_TAX', {
      gain: 2_000, auGain: 2_000, proceeds: 10_000, residency: 'AU',
      description: 'His Brokerage', stateKey: 'usStockAccount',
    }, Date.UTC(2026, 1, 1), auGainDiff({ primary: 3_000 })),
    makeAuSaleJournalEntry('STOCK_WITHDRAWAL_TAX', {
      gain: 1_000, auGain: 1_000, proceeds: 4_000, residency: 'AU',
      description: 'Her Brokerage', stateKey: 'spouseStockAccount',
    }, Date.UTC(2026, 2, 1), auGainDiff({ spouse: 1_500 })),
    settleEntry,
  ];
  const docs = registry.generate(settleEntry, journal);

  const his = docs.find(d => d.personKey === 'primary' && d.title.includes('CGT Worksheet'));
  const hers = docs.find(d => d.personKey === 'spouse' && d.title.includes('CGT Worksheet'));
  assert.deepEqual(his.table.rows.map(r => cellText(r[0])),  ['His Brokerage']);
  assert.deepEqual(hers.table.rows.map(r => cellText(r[0])), ['Her Brokerage']);
  // Each worksheet foots to its OWN return's label H — the property the old schedule
  // could not have, since it stated the household total under one name.
  assert.strictEqual(his.table.totals[5] + his.table.totals[6],  3_000);
  assert.strictEqual(hers.table.totals[5] + hers.table.totals[6], 1_500);
});

test('CGT worksheet extraction: a jointly held account splits between its owners', () => {
  const registry = new TaxDocumentRegistry();
  const terry    = { ...auResidentDetail({ auCapitalGainsYTD: 1_000 }), taxYear: 2025 };
  const jeanne   = { ...auResidentDetail({ auCapitalGainsYTD: 1_000 }), taxYear: 2025 };
  const settleEntry = makePerPersonSettle([
    { personKey: 'primary', personName: 'Terry',  taxDetail: terry  },
    { personKey: 'spouse',  personName: 'Jeanne', taxDetail: jeanne },
  ]);
  const journal = [
    makeAuSaleJournalEntry('STOCK_WITHDRAWAL_TAX', {
      gain: 2_000, auGain: 2_000, proceeds: 10_000, residency: 'AU',
      description: 'Shared Brokerage', stateKey: 'sharedBrokerageAccount',
    }, Date.UTC(2026, 1, 1), auGainDiff({ primary: 1_000, spouse: 1_000 })),
    settleEntry,
  ];
  const docs = registry.generate(settleEntry, journal);
  for (const key of ['primary', 'spouse']) {
    const ws = docs.find(d => d.personKey === key && d.title.includes('CGT Worksheet'));
    assert.deepEqual(ws.table.rows.map(r => cellText(r[0])), ['Shared Brokerage'],
      'a joint disposal appears on BOTH worksheets');
    assert.strictEqual(ws.table.totals[3], 5_000, 'at half the proceeds');
    assert.strictEqual(ws.table.totals[5] + ws.table.totals[6], 1_000, 'and half the gain');
  }
});

test('CGT worksheet extraction: a zero-AU-gain disposal is placed from the account\'s other years', () => {
  // Right after a residency move the s855-45 step-up leaves nothing to tax, so the
  // disposal writes no per-person diff and has no attribution of its own. It is placed
  // from the same account's booked disposals elsewhere in the journal, and contributes
  // zero to every gain column — so a misplacement could not move anyone's tax.
  const registry = new TaxDocumentRegistry();
  const terry    = { ...auResidentDetail({ auCapitalGainsYTD: 3_000 }), taxYear: 2025 };
  const settleEntry = makePerPersonSettle(
    [{ personKey: 'primary', personName: 'Terry', taxDetail: terry }], Date.UTC(2027, 6, 1));
  const priorSettle = makeEntry('AU', terry, Date.UTC(2026, 6, 1));
  const journal = [
    // An earlier year, where the same account DID book a gain — this is what teaches
    // the extractor who owns `usStockAccount`.
    makeAuSaleJournalEntry('STOCK_WITHDRAWAL_TAX', {
      gain: 2_000, auGain: 2_000, proceeds: 10_000, residency: 'AU',
      description: 'US Stock Account', stateKey: 'usStockAccount',
    }, Date.UTC(2026, 1, 1), auGainDiff({ primary: 3_000 })),
    priorSettle,
    // This year: same account, no AU gain at all, therefore no diff.
    makeAuSaleJournalEntry('STOCK_WITHDRAWAL_TAX', {
      gain: 5_000, auGain: 0, proceeds: 12_000, residency: 'AU',
      description: 'US Stock Account', stateKey: 'usStockAccount',
    }, Date.UTC(2027, 1, 1)),
    settleEntry,
  ];
  const ws = docNamed(registry.generate(settleEntry, journal), 'CGT Worksheet');
  assert.strictEqual(ws.table.rows.length, 1, 'the gainless disposal is still disclosed');
  assert.strictEqual(ws.table.totals[5] + ws.table.totals[6], 0, 'and contributes no gain');
  assert.ok(!ws.notes.some(n => /could not be attributed/.test(n)),
    'it WAS attributable, from the account\'s other years');
});

test('CGT worksheet extraction: a disposal nobody can be found for is disclosed, not dropped', () => {
  const registry = new TaxDocumentRegistry();
  const terry    = { ...auResidentDetail({ auCapitalGainsYTD: 0 }), taxYear: 2025 };
  const settleEntry = makePerPersonSettle(
    [{ personKey: 'primary', personName: 'Terry', taxDetail: terry }]);
  const journal = [
    makeAuSaleJournalEntry('STOCK_WITHDRAWAL_TAX', {
      gain: 5_000, auGain: 0, proceeds: 12_000, residency: 'AU',
      description: 'Mystery Account', stateKey: 'neverBooksAGain',
    }, Date.UTC(2026, 1, 1)),
    settleEntry,
  ];
  const ws = docNamed(registry.generate(settleEntry, journal), 'CGT Worksheet');
  assert.ok(!ws || ws.table.rows.length === 0, 'an unplaceable row is not shown under a guessed owner');
  if (ws) {
    assert.ok(ws.notes.some(n => /could not be attributed/.test(n)),
      'and its exclusion is stated on the document');
  }
});

test('CGT worksheet extraction: non-resident disposals stay off the resident worksheet', () => {
  // s855-10 restricts a foreign resident's CGT net to taxable Australian property,
  // which the AU-specific action types already cover.
  const registry    = new TaxDocumentRegistry();
  const detail      = { ...auResidentDetail({ auCapitalGainsYTD: 0 }), taxYear: 2025 };
  const settleEntry = makeEntry('AU', detail, Date.UTC(2026, 6, 1));
  const nonResSale  = makeAuSaleJournalEntry('STOCK_WITHDRAWAL_TAX', {
    gain: 20_000, proceeds: 55_000, costBasis: 35_000,
    description: 'US Stock Account', residency: null,
  });
  const doc = registry.generate(settleEntry, [nonResSale, settleEntry]);
  assert.ok(!docNamed(doc, 'CGT Worksheet'));
});

test('CGT worksheet extraction: an AU house sale lands as Australian real estate', () => {
  const registry    = new TaxDocumentRegistry();
  const detail      = { ...auResidentDetail({ auCapitalGainsYTD: 150_000 }), taxYear: 2025 };
  const settleEntry = makeEntry('AU', detail, Date.UTC(2026, 6, 1));
  const houseSale   = makeAuSaleJournalEntry('AU_HOUSE_SALE_TAX', {
    gain: 150_000, auGain: 150_000, proceeds: 800_000, costBasis: 650_000,
    description: 'Primary Residence',
  });
  const ws = docNamed(registry.generate(settleEntry, [houseSale, settleEntry]), 'CGT Worksheet');
  assert.strictEqual(ws.table.rows.length, 1);
  assert.strictEqual(ws.table.rows[0][0], 'Primary Residence');
  assert.strictEqual(ws.table.rows[0][1], 'Real estate in Australia');
  assert.strictEqual(ws.table.rows[0][3], 800_000);
});

// ══════════════════════════════════════════════════════════════════════════════
// Sale-record extraction — action×reducer fan-out
//
// Every action is journaled once PER CONSUMING REDUCER, and the sale actions have
// three consumers apiece (`dynamic:US:…`, `state:classify:…`, `dynamic:AU:…`), so a
// single disposal appears three times in the raw journal under one shared
// `action.instanceId`. The extractors walk raw entries, so without collapsing on
// that id every figure on Schedule D / Form 8949 / the AU CGT Schedule is tripled —
// while Form 1040 line 6, which reads the YTD accumulator instead, stays correct.
// Measured on CY2034 of the reference plan: 156 raw entries vs 52 distinct actions,
// gain 19,428.45 against a true 6,476.15.
// ══════════════════════════════════════════════════════════════════════════════

/** One disposal as the journal really records it: N entries, one shared instanceId. */
function fanOut(type, data, { instanceId, reducers, dateMs = Date.UTC(2026, 3, 1) }) {
  return reducers.map(name => ({
    date:    new Date(dateMs),
    action:  { type, data, instanceId },
    reducer: { name },
  }));
}

test('Schedule D / 8949 count a fanned-out disposal once, not once per reducer', () => {
  const registry    = new TaxDocumentRegistry();
  const detail      = { ...usDetail({ usCapitalGainsYTD: 20_000 }), taxYear: 2025 };
  const settleEntry = makeEntry('US', detail, Date.UTC(2026, 11, 31));
  const journal     = [
    ...fanOut('STOCK_WITHDRAWAL_TAX',
      { gain: 20_000, proceeds: 55_000, costBasis: 35_000, description: 'Brokerage' },
      { instanceId: 'i-sale-1',
        reducers: ['dynamic:US:STOCK_WITHDRAWAL_TAX', 'state:classify:STOCK_WITHDRAWAL_TAX',
                   'dynamic:AU:STOCK_WITHDRAWAL_TAX'] }),
    settleEntry,
  ];

  const [, schedD, f8949] = registry.generate(settleEntry, journal);
  const amountOf = label => schedD.sections
    .flatMap(s => s.lineItems).find(li => li.label.startsWith(label)).amount;

  assert.strictEqual(f8949.table.rows.length, 1, 'one disposal ⇒ one Form 8949 row');
  assert.strictEqual(amountOf('Net Long-Term Gain'), 20_000, 'gain must not triple');
  assert.strictEqual(amountOf('Total Proceeds'),     55_000, 'proceeds must not triple');
  assert.strictEqual(amountOf('Total Cost Basis'),   35_000, 'cost basis must not triple');
});

test('the AU CGT worksheet collapses the same fan-out', () => {
  const registry    = new TaxDocumentRegistry();
  const detail      = { ...auResidentDetail({ auCapitalGainsYTD: 20_000 }), taxYear: 2025 };
  const settleEntry = makeEntry('AU', detail, Date.UTC(2026, 6, 1));
  const journal     = [
    ...fanOut('AU_STOCK_WITHDRAWAL_TAX',
      { gain: 20_000, auGain: 20_000, proceeds: 55_000, costBasis: 35_000, description: 'AU Stock Account' },
      { instanceId: 'i-au-sale-1',
        reducers: ['dynamic:AU:AU_STOCK_WITHDRAWAL_TAX', 'state:classify:AU_STOCK_WITHDRAWAL_TAX'] }),
    settleEntry,
  ];

  const ws = docNamed(registry.generate(settleEntry, journal), 'CGT Worksheet');
  assert.strictEqual(ws.table.rows.length, 1, 'one disposal ⇒ one worksheet row');
  assert.strictEqual(ws.table.totals[3], 55_000, 'proceeds must not double');
  assert.strictEqual(ws.table.totals[5] + ws.table.totals[6], 20_000, 'nor may the gain');
});

test('distinct disposals are still counted separately when they share a reducer', () => {
  const registry    = new TaxDocumentRegistry();
  const detail      = { ...usDetail({ usCapitalGainsYTD: 30_000 }), taxYear: 2025 };
  const settleEntry = makeEntry('US', detail, Date.UTC(2026, 11, 31));
  const journal     = [
    ...fanOut('STOCK_WITHDRAWAL_TAX', { gain: 20_000, proceeds: 55_000, costBasis: 35_000 },
      { instanceId: 'i-a', reducers: ['dynamic:US:STOCK_WITHDRAWAL_TAX', 'state:classify:STOCK_WITHDRAWAL_TAX'] }),
    ...fanOut('STOCK_WITHDRAWAL_TAX', { gain: 10_000, proceeds: 25_000, costBasis: 15_000 },
      { instanceId: 'i-b', reducers: ['dynamic:US:STOCK_WITHDRAWAL_TAX', 'state:classify:STOCK_WITHDRAWAL_TAX'] }),
    settleEntry,
  ];

  const [, schedD, f8949] = registry.generate(settleEntry, journal);
  const gain = schedD.sections.flatMap(s => s.lineItems)
    .find(li => li.label.startsWith('Net Long-Term Gain')).amount;
  assert.strictEqual(f8949.table.rows.length, 2, 'two distinct disposals ⇒ two rows');
  assert.strictEqual(gain, 30_000);
});

test('a main-home sale reaches Schedule D with the §121 exclusion as a code-H adjustment', () => {
  const registry    = new TaxDocumentRegistry();
  // Sale price 1,150,000 on a 500,000 basis ⇒ 650,000 economic gain; MFJ §121
  // excludes 500,000, so the action reports a TAXABLE gain of 150,000.
  const detail      = { ...usDetail({ usCapitalGainsYTD: 150_000 }), taxYear: 2025 };
  const settleEntry = makeEntry('US', detail, Date.UTC(2026, 11, 31));
  const journal     = [
    ...fanOut('US_HOUSE_SALE_TAX',
      { gain: 150_000, proceeds: 1_150_000, costBasis: 500_000, description: 'usHouse' },
      { instanceId: 'i-house', reducers: ['dynamic:US:US_HOUSE_SALE_TAX', 'state:classify:US_HOUSE_SALE_TAX'] }),
    settleEntry,
  ];

  const [, schedD, f8949] = registry.generate(settleEntry, journal);
  const amountOf = label => schedD.sections
    .flatMap(s => s.lineItems).find(li => li.label.startsWith(label)).amount;

  // Reported GROSS, with the exclusion carried in column (g) — not netted away.
  assert.strictEqual(amountOf('Total Proceeds'),   1_150_000);
  assert.strictEqual(amountOf('Total Cost Basis'),   500_000);
  assert.strictEqual(amountOf('Adjustments to Gain or Loss'), -500_000,
    '§121 exclusion belongs in column (g) as a negative number');
  assert.strictEqual(amountOf('Net Long-Term Gain'), 150_000);

  // Schedule D column (h) identity: (d) − (e) + (g).
  assert.strictEqual(
    amountOf('Total Proceeds') - amountOf('Total Cost Basis') + amountOf('Adjustments to Gain or Loss'),
    amountOf('Net Long-Term Gain'));

  const [row] = f8949.table.rows;
  assert.strictEqual(row[5], 'H',       'main-home exclusion carries Form 8949 code H');
  assert.strictEqual(row[6], -500_000,  'column (g) adjustment is negative');
});

test('an ordinary sale needs no adjustment and carries no code', () => {
  const registry    = new TaxDocumentRegistry();
  const detail      = { ...usDetail({ usCapitalGainsYTD: 20_000 }), taxYear: 2025 };
  const settleEntry = makeEntry('US', detail, Date.UTC(2026, 11, 31));
  const journal     = [
    ...fanOut('STOCK_WITHDRAWAL_TAX', { gain: 20_000, proceeds: 55_000, costBasis: 35_000 },
      { instanceId: 'i-s', reducers: ['dynamic:US:STOCK_WITHDRAWAL_TAX'] }),
    settleEntry,
  ];
  const [, schedD, f8949] = registry.generate(settleEntry, journal);
  const adj = schedD.sections.flatMap(s => s.lineItems)
    .find(li => li.label.startsWith('Adjustments to Gain or Loss')).amount;
  assert.strictEqual(adj, 0);
  assert.strictEqual(f8949.table.rows[0][5], '');
});

test('company-equity disposals reach Schedule D too', () => {
  const registry    = new TaxDocumentRegistry();
  const detail      = { ...usDetail({ usCapitalGainsYTD: 90_000 }), taxYear: 2025 };
  const settleEntry = makeEntry('US', detail, Date.UTC(2026, 11, 31));
  const journal     = [
    ...fanOut('COMPANY_SALE_TAX', { gain: 90_000, proceeds: 120_000, costBasis: 30_000, description: 'MIP units' },
      { instanceId: 'i-co', reducers: ['dynamic:US:COMPANY_SALE_TAX'] }),
    settleEntry,
  ];
  const [, schedD] = registry.generate(settleEntry, journal);
  const gain = schedD.sections.flatMap(s => s.lineItems)
    .find(li => li.label.startsWith('Net Long-Term Gain')).amount;
  assert.strictEqual(gain, 90_000);
});

test('COMPANY_SALE_TAX declares the sale detail Schedule D needs', () => {
  // pickPayload keeps ONLY declared fields, so an undeclared proceeds/costBasis is
  // dropped between the reducer and the journal and the disposal silently vanishes
  // from the schedules while still reaching Form 1040 line 6.
  const reg = buildTypeRegistryForDisposals();
  const payload = reg.pickPayload({
    type: 'COMPANY_SALE_TAX', gain: 300_000, proceeds: 1_200_000,
    costBasis: 900_000, description: 'mipEquity', undeclaredProbe: 'dropped',
  });
  assert.strictEqual(payload.proceeds,  1_200_000);
  assert.strictEqual(payload.costBasis,   900_000);
  assert.strictEqual(payload.description, 'mipEquity');
  assert.strictEqual(payload.undeclaredProbe, undefined,
    'undeclared fields must drop, else this test proves nothing');
});

// ══════════════════════════════════════════════════════════════════════════════
// AuTaxDocument2026 — CGT summary worksheet (ATO parts 1–6, item 18 H/A/V)
//
// The AU return states the gain, the relief and the net gain, and nothing about
// either s102-5 loss step. That makes its capital-gains figure uncheckable: given
// "capital gains 20,000" and "net capital gains 5,000" a reader cannot tell a clean
// year from one where a loss pool ate three quarters of the gain. These tests hold
// the worksheet to the ONE property that fixes that — every intermediate the ATO
// form asks for is stated, and the chain foots end to end.
//
// Reference: docs/au-tax/ato-forms/cgt-summary-worksheet-2025-form.txt (the form),
// item-18-capital-gains-2026.txt (labels H/A/V), and ITAA 1997 s102-5 for ordering.
// ══════════════════════════════════════════════════════════════════════════════

/** The worksheet out of a generate() result, with its lines flattened by label. */
function cgtSummaryLines(result) {
  const doc = docNamed(result, 'CGT Summary Worksheet');
  assert.ok(doc, 'expected a CGT Summary Worksheet document');
  const byLabel = new Map();
  for (const s of doc.sections) {
    for (const li of s.lineItems) byLabel.set(li.label, li.amount);
  }
  return { doc, byLabel, at: (frag) => {
    for (const [label, amount] of byLabel) if (label.includes(frag)) return amount;
    return undefined;
  } };
}

test('CGT summary: the whole chain foots from label H down to label A', () => {
  const detail = auResidentDetail({ auCapitalGainsYTD: 20_000 });
  const result = new AuTaxDocument2026().generate(detail, 2025);
  const { at } = cgtSummaryLines(result);

  const h      = at('H — Total Current Year');
  const after2B = at('Capital Gains after Current Year Losses');
  const after2C = at('Net Capital Gains after All Capital Losses');
  const relief  = at('CGT Discount Applied (4A)');
  const netGain = at('Net Capital Gain (6A)');

  assert.strictEqual(h, 20_000);
  assert.strictEqual(after2B, h + at('Current Year Capital Losses Applied (2B)'));
  assert.strictEqual(after2C, after2B + at('Prior Year Net Capital Losses Applied (2C)'));
  assert.strictEqual(+(after2C + relief).toFixed(2), netGain);
  assert.strictEqual(netGain, at('A — Net Capital Gain'));
  // …and 6A is the figure the RETURN was assessed on, not a parallel derivation.
  assert.strictEqual(netGain, detail.discountedCapitalGains);
});

test('CGT summary: prior-year losses come off BEFORE the discount (s102-5 Steps 2 then 5)', () => {
  // 1,000 of gain, all discount-eligible, against a 400 prior-year pool.
  //   Act order  — (1000 − 400) × 50% = 300
  //   wrong order— (1000 × 50%) − 400 = 100
  // The two differ by 200, so this test fails loudly if the ordering ever inverts.
  const detail = auResidentDetail({
    auOrdinaryIncomeYTD: 80_000, auCapitalGainsYTD: 1_000, auCapitalLossPool: 400,
  });
  const { at } = cgtSummaryLines(new AuTaxDocument2026().generate(detail, 2025));

  assert.strictEqual(at('Prior Year Net Capital Losses Available (Z1)'), 400);
  assert.strictEqual(at('Prior Year Net Capital Losses Applied (2C)'), -400);
  assert.strictEqual(at('Net Capital Gains after All Capital Losses'), 600);
  assert.strictEqual(at('CGT Discount Applied (4A)'), -300);
  assert.strictEqual(at('Net Capital Gain (6A)'), 300);
});

test('CGT summary: losses hit the non-discountable column first (§5.3)', () => {
  // 600 discountable + 400 'other', against a 500 pool. Spending loss on the 'other'
  // column saves a full dollar; on the discount column it saves fifty cents. So the
  // 500 must go 400 → 'other', 100 → discount, leaving 500 discountable ⇒ 250 net.
  const detail = auResidentDetail({
    auOrdinaryIncomeYTD:      80_000,
    auCapitalGainsYTD:        1_000,
    auDiscountableGainsYTD:     600,
    auCapitalLossPool:          500,
  });
  const { at } = cgtSummaryLines(new AuTaxDocument2026().generate(detail, 2025));

  assert.strictEqual(at("Capital Gains: 'Other' Method"), 400);
  assert.strictEqual(at('Capital Gains: Discount Method'), 600);
  assert.strictEqual(at("Applied against 'Other' Method"), -400);
  assert.strictEqual(at('Applied against Discount Method'), -100);
  assert.strictEqual(at('Net Capital Gain (6A)'), 250);
});

test('CGT summary: a loss year reports label V and nothing at label A', () => {
  // s102-10(2) — a net capital loss cannot reduce assessable income; it can only be
  // carried forward. So the return shows no net capital gain and a live label V.
  const detail = auResidentDetail({ auCapitalGainsYTD: -3_000 });
  const { at } = cgtSummaryLines(new AuTaxDocument2026().generate(detail, 2025));

  assert.strictEqual(at('Total Current Year Capital Losses (2A)'), 3_000);
  assert.strictEqual(at('A — Net Capital Gain'), 0);
  assert.strictEqual(at('V — Net Capital Losses Carried Forward'), 3_000);
  assert.strictEqual(at('Unapplied Current Year Capital Losses (K)'), 3_000);
});

test('CGT summary: a partly-absorbed pool splits between applied and carried forward', () => {
  const detail = auResidentDetail({
    auOrdinaryIncomeYTD: 80_000, auCapitalGainsYTD: 1_000, auCapitalLossPool: 2_500,
  });
  const { at } = cgtSummaryLines(new AuTaxDocument2026().generate(detail, 2025));

  assert.strictEqual(at('Prior Year Net Capital Losses Applied (2C)'), -1_000);
  assert.strictEqual(at('Unapplied Prior Year Net Capital Losses (L)'), 1_500);
  assert.strictEqual(at('Net Capital Losses Carried Forward (3B)'), 1_500);
  assert.strictEqual(at('V — Net Capital Losses Carried Forward'), 1_500);
  assert.strictEqual(at('A — Net Capital Gain'), 0);
});

test('CGT summary: Part 3 is omitted when nothing is carried forward', () => {
  const { doc } = cgtSummaryLines(
    new AuTaxDocument2026().generate(auResidentDetail({ auCapitalGainsYTD: 20_000 }), 2025));
  const headings = doc.sections.map(s => s.heading);
  assert.ok(!headings.some(h => h.startsWith('Part 3')),
    'a clean year should not print three zero rows of carried-forward losses');
  assert.ok(headings.some(h => h.startsWith('Part 1')));
  assert.ok(headings.some(h => h.startsWith('Part 6')));
});

test('CGT summary: no worksheet at all when there was no CGT activity', () => {
  const result = new AuTaxDocument2026().generate(auResidentDetail({ auCapitalGainsYTD: 0 }), 2025);
  assert.ok(!Array.isArray(result), 'a wages-only year should stay a single document');
});

test('CGT summary: a gainless year with a live loss pool still files one', () => {
  // The pool is unchanged and nothing is assessed — but label V has a figure to state,
  // and a reader needs to see the pool survived rather than infer it from silence.
  const detail = auResidentDetail({ auCapitalGainsYTD: 0, auCapitalLossPool: 5_000 });
  const { at } = cgtSummaryLines(new AuTaxDocument2026().generate(detail, 2025));
  assert.strictEqual(at('V — Net Capital Losses Carried Forward'), 5_000);
  assert.strictEqual(at('Prior Year Net Capital Losses Applied (2C)'), -0);
});

test('CGT summary: non-residents get no worksheet', () => {
  // s855-10 restricts a foreign resident's CGT net to taxable Australian property and
  // the Division 115 discount is not available, so the resident worksheet does not apply.
  const result = new AuTaxDocument2026().generate(auNrDetail({ auCapitalGainsYTD: 50_000 }), 2025);
  assert.ok(!docNamed(result, 'CGT Summary Worksheet'));
});

test('CGT summary FY2027: names indexation, and its relief base is the WHOLE gain', () => {
  // The reform indexes every gain, not just the ≥12-month slice, so quoting that slice
  // as the base would invite a reader to check the relief against the wrong number.
  const detail = au2027Detail();
  const { at, doc } = cgtSummaryLines(new AuTaxDocument2027().generate(detail, 2027));

  assert.ok(doc.sections.some(s => s.heading.includes('Cost-Base Indexation')));
  assert.strictEqual(at('Cost-Base Indexation Relief (4A)'), -detail.cgtDiscount);
  assert.strictEqual(at('Net Capital Gains before indexation'), detail.nettedCapitalGains);
  assert.strictEqual(at('Net Capital Gain (6A)'), detail.discountedCapitalGains);
  // The reform removed the discount — no line may still call it one.
  const labels = doc.sections.flatMap(s => s.lineItems).map(li => li.label).join(' | ');
  assert.ok(!/Discount/.test(labels), `FY2027 worksheet must not mention a discount: ${labels}`);
});

test('CGT summary is section-shaped, so it reaches the CSV export', () => {
  // The complaint that started this: the CGT Schedule tab has no download button,
  // because `flattenDocument` returns [] for a table-only document. A worksheet built
  // from sections is exportable for free — and that is a property worth pinning, since
  // switching it to a table for layout reasons would silently drop the button again.
  const result = new AuTaxDocument2026().generate(auResidentDetail({ auCapitalGainsYTD: 20_000 }), 2025);
  const doc    = docNamed(result, 'CGT Summary Worksheet');
  const rows   = worksheetRowsFromDocuments(doc);
  assert.ok(rows.length > 0, 'worksheet must produce export rows');
  assert.ok(rows.some(r => r.label.includes('Net Capital Gain (6A)')));
  assert.ok(rows.every(r => r.country === 'AU'));
});

test('CGT worksheet: the asset cell carries its stateKey so a name can be resolved', () => {
  // The document builder cannot resolve display names — it has a journal entry and no
  // StateSchemaRegistry — so it carries the key and the modal resolves it. Without
  // this the row reads `usStockAccount`, because the emitter's `account.name ||
  // stateKey` falls through whenever the account has no explicit name, which is the
  // common case on a generated scenario.
  const ws = docNamed(new AuTaxDocument2026().generate(
    auResidentDetail({ auCapitalGainsYTD: 20_000 }), 2025,
    [makeWorksheetRow({ stateKey: 'usStockAccount', description: 'usStockAccount' })]), 'CGT Worksheet');
  assert.deepEqual(ws.table.rows[0][0], { stateKey: 'usStockAccount', text: 'usStockAccount' });
});

test('CGT worksheet: a row with no stateKey stays a plain string cell', () => {
  const ws = docNamed(new AuTaxDocument2026().generate(
    auResidentDetail({ auCapitalGainsYTD: 20_000 }), 2025,
    [makeWorksheetRow({ stateKey: null, description: 'AU Real Property' })]), 'CGT Worksheet');
  assert.strictEqual(ws.table.rows[0][0], 'AU Real Property');
});

test('table CSV renders a keyed cell as its fallback text when nothing resolved it', () => {
  const ws = docNamed(new AuTaxDocument2026().generate(
    auResidentDetail({ auCapitalGainsYTD: 20_000 }), 2025,
    [makeWorksheetRow({ stateKey: 'usStockAccount', description: 'usStockAccount' })]), 'CGT Worksheet');
  const csv = tableDocumentToCsv(ws);
  assert.ok(csv.includes('usStockAccount'));
  assert.ok(!csv.includes('[object Object]'), 'a keyed cell must never stringify raw');
});
