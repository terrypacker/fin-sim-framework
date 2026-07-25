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
  const doc     = new AuTaxDocument2026().generate(detail, 2025);
  const credits = doc.sections.find(s => s.heading === 'Credits');
  const fito    = credits.lineItems.find(li => li.label.includes('Foreign Income Tax Offset'));
  assert.ok(fito != null && fito.amount < 0, 'FITO line present and negative');
});

// ══════════════════════════════════════════════════════════════════════════════
// AuTaxDocument2026 — resident path
// ══════════════════════════════════════════════════════════════════════════════

test('AuTaxDocument2026 resident: title includes FY label', () => {
  const doc = new AuTaxDocument2026().generate(auResidentDetail(), 2025);
  assert.ok(doc.title.includes('FY 2025'), `expected FY label, got: ${doc.title}`);
});

test('AuTaxDocument2026 resident: filingStatus is Individual Resident', () => {
  const doc = new AuTaxDocument2026().generate(auResidentDetail(), 2025);
  assert.strictEqual(doc.filingStatus, 'Individual Resident');
});

test('AuTaxDocument2026 resident: has Income, Tax Computation, Credits sections', () => {
  const doc      = new AuTaxDocument2026().generate(auResidentDetail(), 2025);
  const headings = doc.sections.map(s => s.heading);
  assert.ok(headings.includes('Income'));
  assert.ok(headings.includes('Tax Computation'));
  assert.ok(headings.includes('Credits'));
});

test('AuTaxDocument2026 resident: CGT Discount line is negative', () => {
  const detail  = auResidentDetail({ auCapitalGainsYTD: 40_000 });
  const doc     = new AuTaxDocument2026().generate(detail, 2025);
  const income  = doc.sections.find(s => s.heading === 'Income');
  const discount = income.lineItems.find(li => li.label === 'CGT 50% Discount');
  assert.ok(discount, 'CGT Discount line not found');
  assert.ok(discount.amount <= 0, 'CGT Discount should be <= 0');
});

test('AuTaxDocument2026 resident: summary netLiability matches taxDetail', () => {
  const detail = auResidentDetail();
  const doc    = new AuTaxDocument2026().generate(detail, 2025);
  assert.strictEqual(doc.summary.netLiability, detail.netLiability);
});

test('AuTaxDocument2026 resident: Franking Credits line is negative', () => {
  const detail  = auResidentDetail({ auFrankingCreditYTD: 5_000 });
  const doc     = new AuTaxDocument2026().generate(detail, 2025);
  const credits = doc.sections.find(s => s.heading === 'Credits');
  const fc      = credits.lineItems.find(li => li.label === 'Franking Credits');
  assert.ok(fc.amount <= 0, 'Franking Credits should be <= 0 (reduces tax)');
});

test('AuTaxDocument2026 resident: Tax on Income splits into ordinary + capital gains sub-rows summing to the total', () => {
  const doc  = new AuTaxDocument2026().generate(auResidentDetail(), 2025);
  const comp = doc.sections.find(s => s.heading === 'Tax Computation');
  const total = comp.lineItems.find(li => li.label === 'Tax on Income').amount;
  const ord   = comp.lineItems.find(li => li.label === 'Tax on Ordinary Income');
  const cg    = comp.lineItems.find(li => li.label === 'Tax on Capital Gains');
  assert.ok(ord?.sub && cg?.sub, 'both breakdown rows present and flagged sub');
  assert.ok(Math.abs((ord.amount + cg.amount) - total) < 1e-6, 'sub-rows sum to Tax on Income');
  assert.ok(cg.amount > 0, 'a positive capital gain adds incremental bracket tax');
});

test('AuTaxDocument2026 resident: no breakdown sub-rows when there are no capital gains', () => {
  const doc  = new AuTaxDocument2026().generate(auResidentDetail({ auCapitalGainsYTD: 0 }), 2025);
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
  const doc    = new AuTaxDocument2027().generate(au2027Detail(), 2027);
  const income = doc.sections.find(s => s.heading === 'Income');
  assert.ok(income.lineItems.some(li => li.label === 'Cost-Base Indexation Relief'),
    'expected a Cost-Base Indexation Relief line');
  assert.ok(!income.lineItems.some(li => li.label === 'CGT 50% Discount'),
    'must not show the removed 50% discount label for FY2027+');
});

test('AuTaxDocument2027 resident: relief = gross − indexed real gain, and it is negative', () => {
  const detail = au2027Detail();
  const doc    = new AuTaxDocument2027().generate(detail, 2027);
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
  const doc  = new AuTaxDocument2027().generate(detail, 2027);
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
  const doc  = new AuTaxDocument2027().generate(au2027Detail(), 2027);
  const comp = doc.sections.find(s => s.heading === 'Tax Computation');
  assert.ok(!comp.lineItems.some(li => li.label === 'CGT Minimum Tax Top-up (30%)'),
    'no top-up when marginal rate on the gain already >= 30%');
});

test('AuTaxDocument2027 resident: Tax on Income breakdown sub-rows sum to the total (top-up excluded)', () => {
  // Low-ordinary case: baseTax split still sums to Tax on Income; the 30% top-up
  // is a separate line and must NOT be folded into the capital-gains sub-row.
  const detail = au2027Detail({ auOrdinaryIncomeYTD: 0, auCapitalGainsYTD: 30_000, auRealCapitalGainsYTD: 30_000, auFrankingCreditYTD: 0 });
  const doc    = new AuTaxDocument2027().generate(detail, 2027);
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
  const doc   = new TaxDocumentRegistry().generate(entry);
  const income = doc.sections.find(s => s.heading === 'Income');
  assert.ok(income.lineItems.some(li => li.label === 'Cost-Base Indexation Relief'),
    'registry should pick AuTaxDocument2027 (reform labels), not the 2026 fallback');
});

// ══════════════════════════════════════════════════════════════════════════════
// AuTaxDocument2026 — non-resident path
// ══════════════════════════════════════════════════════════════════════════════

test('AuTaxDocument2026 non-resident: title includes Non-Resident', () => {
  const doc = new AuTaxDocument2026().generate(auNrDetail(), 2025);
  assert.ok(doc.title.includes('Non-Resident'), `expected Non-Resident in title, got: ${doc.title}`);
});

test('AuTaxDocument2026 non-resident: filingStatus is Individual Non-Resident', () => {
  const doc = new AuTaxDocument2026().generate(auNrDetail(), 2025);
  assert.strictEqual(doc.filingStatus, 'Individual Non-Resident');
});

test('AuTaxDocument2026 non-resident: no Credits section', () => {
  const doc      = new AuTaxDocument2026().generate(auNrDetail(), 2025);
  const headings = doc.sections.map(s => s.heading);
  assert.ok(!headings.includes('Credits'), 'Non-resident should not have a Credits section');
});

test('AuTaxDocument2026 non-resident: NR withholding tax line present', () => {
  const detail = auNrDetail({ auNonResidentWithholdingYTD: 10_000 });
  const doc    = new AuTaxDocument2026().generate(detail, 2025);
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
  const doc      = registry.generate(entry);
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
  assert.strictEqual(docs.length, 2);
  assert.strictEqual(docs[0].personKey,  'primary');
  assert.strictEqual(docs[0].personName, 'Alice');
  assert.strictEqual(docs[1].personKey,  'spouse');
  assert.strictEqual(docs[1].personName, 'Bob');
  assert.strictEqual(docs[0].country, 'AU');
  assert.strictEqual(docs[1].country, 'AU');
});

test('TaxDocumentRegistry: single-document AU entry still returns non-array', () => {
  const registry = new TaxDocumentRegistry();
  const detail   = { ...auResidentDetail(), taxYear: 2025 };
  const entry    = makeEntry('AU', detail);
  const doc      = registry.generate(entry);
  assert.ok(!Array.isArray(doc), 'single AU entry should not return array');
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
// AuTaxDocument2026 — CGT Schedule
// ══════════════════════════════════════════════════════════════════════════════

function makeSaleRecord(overrides = {}) {
  return {
    description:  'AU Stock Account',
    dateAcquired: 'Various',
    dateSold:     new Date(Date.UTC(2026, 5, 1)),
    proceeds:     50_000,
    costBasis:    35_000,
    gain:         15_000,
    ...overrides,
  };
}

test('AuTaxDocument2026 CGT: no schedule when capital gains <= $10,000', () => {
  const detail = auResidentDetail({ auCapitalGainsYTD: 5_000 });
  const doc    = new AuTaxDocument2026().generate(detail, 2025, [makeSaleRecord({ gain: 5_000, proceeds: 40_000, costBasis: 35_000 })]);
  assert.ok(!Array.isArray(doc), 'should return single ITR when CG <= $10,000');
  assert.strictEqual(doc.country, 'AU');
});

test('AuTaxDocument2026 CGT: returns [ITR, CGT Schedule] when resident with CG > $10,000', () => {
  const detail = auResidentDetail({ auCapitalGainsYTD: 20_000 });
  const docs   = new AuTaxDocument2026().generate(detail, 2025, [makeSaleRecord()]);
  assert.ok(Array.isArray(docs), 'should return array when CG > $10,000');
  assert.strictEqual(docs.length, 2);
  assert.ok(docs[0].title.includes('Tax Return'), 'first doc should be the ITR');
  assert.ok(docs[1].title.includes('CGT Schedule'), 'second doc should be CGT Schedule');
});

test('AuTaxDocument2026 CGT: no schedule for non-resident even with CG records', () => {
  const detail = auNrDetail({ auCapitalGainsYTD: 50_000 });
  const doc    = new AuTaxDocument2026().generate(detail, 2025, [makeSaleRecord()]);
  assert.ok(!Array.isArray(doc), 'non-resident should never get CGT schedule');
});

test('AuTaxDocument2026 CGT: no schedule when no sale records regardless of CG', () => {
  const detail = auResidentDetail({ auCapitalGainsYTD: 50_000 });
  const doc    = new AuTaxDocument2026().generate(detail, 2025, []);
  assert.ok(!Array.isArray(doc), 'no schedule without sale records');
});

test('AuTaxDocument2026 CGT: schedule country is AU and taxYear matches', () => {
  const detail = auResidentDetail({ auCapitalGainsYTD: 20_000 });
  const [, cgt] = new AuTaxDocument2026().generate(detail, 2025, [makeSaleRecord()]);
  assert.strictEqual(cgt.country, 'AU');
  assert.strictEqual(cgt.taxYear, 2025);
});

test('AuTaxDocument2026 CGT: schedule filingStatus is Capital Gains Tax Schedule', () => {
  const detail = auResidentDetail({ auCapitalGainsYTD: 20_000 });
  const [, cgt] = new AuTaxDocument2026().generate(detail, 2025, [makeSaleRecord()]);
  assert.strictEqual(cgt.filingStatus, 'Capital Gains Tax Schedule');
});

test('AuTaxDocument2026 CGT: schedule table has correct columns', () => {
  const detail = auResidentDetail({ auCapitalGainsYTD: 20_000 });
  const [, cgt] = new AuTaxDocument2026().generate(detail, 2025, [makeSaleRecord()]);
  assert.ok(cgt.table, 'CGT schedule should have a table');
  assert.deepEqual(cgt.table.columns, ['Description', 'Date Acquired', 'Date Sold', 'Proceeds', 'Cost Basis', 'Gain / (Loss)']);
});

test('AuTaxDocument2026 CGT: schedule table rows match sale records', () => {
  const detail  = auResidentDetail({ auCapitalGainsYTD: 20_000 });
  const records = [makeSaleRecord(), makeSaleRecord({ description: 'AU Real Property', proceeds: 600_000, costBasis: 400_000, gain: 200_000 })];
  const [, cgt] = new AuTaxDocument2026().generate(detail, 2025, records);
  assert.strictEqual(cgt.table.rows.length, 2);
  assert.strictEqual(cgt.table.rows[0][0], 'AU Stock Account');
  assert.strictEqual(cgt.table.rows[1][0], 'AU Real Property');
});

test('AuTaxDocument2026 CGT: schedule table totals sum correctly', () => {
  const detail  = auResidentDetail({ auCapitalGainsYTD: 30_000 });
  const r1 = makeSaleRecord({ proceeds: 50_000, costBasis: 35_000, gain: 15_000 });
  const r2 = makeSaleRecord({ proceeds: 30_000, costBasis: 15_000, gain: 15_000 });
  const [, cgt] = new AuTaxDocument2026().generate(detail, 2025, [r1, r2]);
  const totals = cgt.table.totals;
  assert.strictEqual(totals[3], 80_000,  'total proceeds');
  assert.strictEqual(totals[4], 50_000,  'total cost basis');
  assert.strictEqual(totals[5], 30_000,  'total gain');
});

test('AuTaxDocument2026 CGT: FY label in schedule title matches taxYear', () => {
  const detail = auResidentDetail({ auCapitalGainsYTD: 20_000 });
  const [, cgt] = new AuTaxDocument2026().generate(detail, 2025, [makeSaleRecord()]);
  assert.ok(cgt.title.includes('FY 2025'), `expected FY 2025 in title, got: ${cgt.title}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// TaxDocumentRegistry — AU CGT Schedule via journal extraction
// ══════════════════════════════════════════════════════════════════════════════

function makeAuSaleJournalEntry(type, data, dateMs = Date.UTC(2026, 3, 1)) {
  return {
    date:   new Date(dateMs),
    action: { type, data },
  };
}

test('TaxDocumentRegistry: AU entry with CG > $10,000 returns [ITR, CGT Schedule]', () => {
  const registry   = new TaxDocumentRegistry();
  const detail     = { ...auResidentDetail({ auCapitalGainsYTD: 20_000 }), taxYear: 2025 };
  const settleEntry = makeEntry('AU', detail, Date.UTC(2026, 6, 1));
  const saleEntry   = makeAuSaleJournalEntry('AU_STOCK_WITHDRAWAL_TAX', {
    gain: 20_000, proceeds: 55_000, costBasis: 35_000, description: 'AU Stock Account',
  });
  const journal = [saleEntry, settleEntry];
  const docs    = registry.generate(settleEntry, journal);
  assert.ok(Array.isArray(docs), 'should return array when CG > $10,000 with sale records');
  assert.strictEqual(docs.length, 2);
  assert.ok(docs[0].country === 'AU');
  assert.ok(docs[1].table, 'second doc should have a table');
});

test('TaxDocumentRegistry: AU entry with CG <= $10,000 returns single ITR', () => {
  const registry    = new TaxDocumentRegistry();
  const detail      = { ...auResidentDetail({ auCapitalGainsYTD: 5_000 }), taxYear: 2025 };
  const settleEntry = makeEntry('AU', detail, Date.UTC(2026, 6, 1));
  const saleEntry   = makeAuSaleJournalEntry('AU_STOCK_WITHDRAWAL_TAX', {
    gain: 5_000, proceeds: 40_000, costBasis: 35_000, description: 'AU Stock Account',
  });
  const journal = [saleEntry, settleEntry];
  const doc     = registry.generate(settleEntry, journal);
  assert.ok(!Array.isArray(doc), 'single ITR expected when CG <= $10,000');
  assert.strictEqual(doc.country, 'AU');
});

test('TaxDocumentRegistry: STOCK_WITHDRAWAL_TAX with residency=AU included in AU CGT schedule', () => {
  const registry    = new TaxDocumentRegistry();
  const detail      = { ...auResidentDetail({ auCapitalGainsYTD: 20_000 }), taxYear: 2025 };
  const settleEntry = makeEntry('AU', detail, Date.UTC(2026, 6, 1));
  // replenishSavings emits STOCK_WITHDRAWAL_TAX (not AU_STOCK_WITHDRAWAL_TAX)
  const replenishSale = makeAuSaleJournalEntry('STOCK_WITHDRAWAL_TAX', {
    gain: 20_000, proceeds: 55_000, costBasis: 35_000,
    description: 'AU Stock Account', residency: 'AU',
  });
  const journal = [replenishSale, settleEntry];
  const docs    = registry.generate(settleEntry, journal);
  assert.ok(Array.isArray(docs), 'should return array when CG > $10,000');
  assert.strictEqual(docs.length, 2);
  assert.strictEqual(docs[1].table.rows.length, 1);
  assert.strictEqual(docs[1].table.rows[0][0], 'AU Stock Account');
});

test('TaxDocumentRegistry: STOCK_WITHDRAWAL_TAX with isAuResident=false NOT included in AU CGT schedule', () => {
  const registry    = new TaxDocumentRegistry();
  const detail      = { ...auResidentDetail({ auCapitalGainsYTD: 0 }), taxYear: 2025 };
  const settleEntry = makeEntry('AU', detail, Date.UTC(2026, 6, 1));
  const nonResSale  = makeAuSaleJournalEntry('STOCK_WITHDRAWAL_TAX', {
    gain: 20_000, proceeds: 55_000, costBasis: 35_000,
    description: 'US Stock Account', residency: null,
  });
  const journal = [nonResSale, settleEntry];
  const doc     = registry.generate(settleEntry, journal);
  assert.ok(!Array.isArray(doc), 'non-resident STOCK_WITHDRAWAL_TAX should not trigger AU CGT schedule');
});

test('TaxDocumentRegistry: AU house sale journal entry included in CGT schedule', () => {
  const registry    = new TaxDocumentRegistry();
  const detail      = { ...auResidentDetail({ auCapitalGainsYTD: 150_000 }), taxYear: 2025 };
  const settleEntry = makeEntry('AU', detail, Date.UTC(2026, 6, 1));
  const houseSale   = makeAuSaleJournalEntry('AU_HOUSE_SALE_TAX', {
    gain: 150_000, proceeds: 800_000, costBasis: 650_000, description: 'Primary Residence',
  });
  const journal = [houseSale, settleEntry];
  const docs    = registry.generate(settleEntry, journal);
  assert.ok(Array.isArray(docs));
  const cgt = docs[1];
  assert.strictEqual(cgt.table.rows.length, 1);
  assert.strictEqual(cgt.table.rows[0][0], 'Primary Residence');
  assert.strictEqual(cgt.table.rows[0][3], 800_000);
});
