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
import { TaxDocumentRegistry }    from '../../src/finance/tax/tax-document-registry.js';
import { JournalReportingService } from '../../src/finance/journal-reporting-service.js';
import { UsTaxRates2025 }         from '../../src/finance/tax/us/us-tax-rates-2025.js';
import { AuTaxRates2025 }         from '../../src/finance/tax/au/au-tax-rates-2025.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function usDetail(overrides = {}) {
  return new UsTaxRates2025().computeTax({
    usOrdinaryIncomeYTD:   100_000,
    usNegativeIncomeYTD:   5_000,
    usCapitalGainsYTD:     20_000,
    usCollectibleGainsYTD: 0,
    usPenaltyYTD:          0,
    ftcYTD:                0,
    ...overrides,
  });
}

function auResidentDetail(overrides = {}) {
  return new AuTaxRates2025().computeTax({
    isAuResident:                true,
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
    isAuResident:                false,
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
    action: { type: 'TAX_SETTLE_APPLY', cc, taxDetail },
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

test('UsTaxDocument2026: FTC credit line is negative (reduces liability)', () => {
  const detail = usDetail({ ftcYTD: 3_000 });
  const doc    = new UsTaxDocument2026().generate(detail, 2025);
  const credits = doc.sections.find(s => s.heading === 'Credits');
  const ftc     = credits.lineItems.find(li => li.label === 'Foreign Tax Credit');
  assert.ok(ftc.amount <= 0, 'FTC should be <= 0 (reduces tax)');
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
  const entry    = { date: new Date(), action: { type: 'TAX_SETTLE_APPLY', cc: 'US' } };
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
