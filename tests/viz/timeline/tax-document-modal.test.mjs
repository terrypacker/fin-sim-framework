/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import assert from 'node:assert/strict';
import { TaxDocumentModal }     from '../../../src/visualization/timeline/tax-document-modal.js';
import { StateSchemaRegistry }  from '../../../src/finance/services/state-schema-registry.js';
import { CurrencyConverter }    from '../../../src/finance/fx/currency-converter.js';

function wiredRegistry(displayCurrency, rate = 1.5) {
  const reg = new StateSchemaRegistry();
  reg.currencyConverter = new CurrencyConverter();
  reg.displaySettings   = { displayCurrency };
  reg.rateStateProvider = () => ({ effectiveExchangeRates: { USD_AUD: rate } });
  return reg;
}

const usDoc = () => ({
  title: 'Form 1040 — 2030', country: 'US', filingStatus: 'Single',
  sections: [{ heading: 'Income', lineItems: [
    { label: 'Wages', amount: 100000 },
    { label: 'Withholding', amount: -20000 },
  ] }],
  summary: { grossIncome: 100000, grossTax: 18000, credits: 0, netLiability: 18000, effectiveRate: 0.18, marginalRate: 0.22 },
});

const auDoc = () => ({
  title: 'AU Notice 2030', country: 'AU', filingStatus: 'Resident',
  sections: [{ heading: 'Income', lineItems: [{ label: 'Super', amount: 50000 }] }],
});

function openHtml(modal, doc) {
  modal.open(doc);
  const html = document.getElementById('tax-doc-modal-overlay').innerHTML;
  document.getElementById('tax-doc-modal-overlay').remove();
  return html;
}

test('US doc in USD display: shows $ amounts, no conversion', () => {
  const m = new TaxDocumentModal(); m.schemaRegistry = wiredRegistry('USD');
  const html = openHtml(m, usDoc());
  assert.ok(html.includes('$100,000.00'), 'wages in USD');
  assert.ok(html.includes('($20,000.00)'), 'negative in accounting parens');
});

test('US doc in AUD display: converts USD → AUD with A$ symbol', () => {
  const m = new TaxDocumentModal(); m.schemaRegistry = wiredRegistry('AUD', 1.5);
  const html = openHtml(m, usDoc());
  assert.ok(html.includes('A$150,000.00'), '100000 USD × 1.5 → A$150,000');
  assert.ok(html.includes('(A$30,000.00)'), 'negative converted + parens');
  assert.ok(html.includes('A$27,000.00'), 'net liability 18000 × 1.5');
});

test('AU doc in USD display: converts AUD → USD', () => {
  const m = new TaxDocumentModal(); m.schemaRegistry = wiredRegistry('USD', 1.5);
  const html = openHtml(m, auDoc());
  assert.ok(html.includes('$33,333.33'), '50000 AUD / 1.5 → $33,333.33');
});

test('AU doc in AUD display: native A$, no conversion', () => {
  const m = new TaxDocumentModal(); m.schemaRegistry = wiredRegistry('AUD');
  const html = openHtml(m, auDoc());
  assert.ok(html.includes('A$50,000.00'));
});

test('no schemaRegistry: falls back to plain $ formatting', () => {
  const m = new TaxDocumentModal();
  const html = openHtml(m, usDoc());
  assert.ok(html.includes('$100,000.00'));
});

// ─── CSV export (design 71 §11.1) ────────────────────────────────────────────

/** Capture the anchor the modal creates for the download, without navigating. */
function captureDownload(fn) {
  const captured = [];
  const realCreate = document.createElement.bind(document);
  const realBlob   = global.Blob;
  const realURL    = global.URL;

  global.Blob = class { constructor(parts) { this.parts = parts; } };
  global.URL  = { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} };
  document.createElement = (tag) => {
    const el = realCreate(tag);
    if (tag === 'a') {
      el.click = () => captured.push({ download: el.download, href: el.href });
    }
    return el;
  };
  try { fn(); }
  finally {
    document.createElement = realCreate;
    global.Blob = realBlob;
    global.URL  = realURL;
  }
  return captured;
}

test('CSV button is rendered for a sections-shaped return', () => {
  const modal = new TaxDocumentModal();
  const html  = openHtml(modal, usDoc());
  assert.ok(html.includes('tax-doc-csv-btn'), 'the footer offers a CSV download');
  assert.ok(html.includes('data-doc-idx="0"'));
});

test('CSV button is omitted for a table-shaped form that flattens to nothing', () => {
  // Form 8949 is a disposal register — no home in the worksheet columns (§5.4), so
  // a button here would download an empty file.
  const modal = new TaxDocumentModal();
  const html  = openHtml(modal, {
    title: 'Form 8949 — 2030', country: 'US', filingStatus: 'Part II',
    table: { heading: 'Sales', columns: ['A'], rows: [['x']], totals: ['Totals'] },
  });
  assert.ok(!html.includes('tax-doc-csv-btn'));
});

test('clicking CSV downloads a worksheet named after the document', () => {
  const modal = new TaxDocumentModal();
  modal.open(usDoc());
  const overlay = document.getElementById('tax-doc-modal-overlay');

  const hits = captureDownload(() => {
    overlay.querySelector('.tax-doc-csv-btn').click();
  });
  overlay.remove();

  assert.equal(hits.length, 1, 'exactly one download was triggered');
  assert.equal(hits[0].download, 'form-1040-2030.csv');
});

test('CSV export works without a WorkbenchRuntime', () => {
  // Drill-down needs a runtime; CSV does not. The shared click listener must not be
  // gated on the runtime, or the button silently dies wherever one is absent.
  const modal = new TaxDocumentModal();          // no runtime
  modal.open(usDoc());
  const overlay = document.getElementById('tax-doc-modal-overlay');
  const hits = captureDownload(() => overlay.querySelector('.tax-doc-csv-btn').click());
  overlay.remove();
  assert.equal(hits.length, 1);
});

test('each tab of a per-person filing exports its own document', () => {
  const modal = new TaxDocumentModal();
  const a = { ...usDoc(), personName: 'Marge' };
  const b = { ...usDoc(), personName: 'Homer' };
  modal.open([a, b]);
  const overlay = document.getElementById('tax-doc-modal-overlay');

  const btns = overlay.querySelectorAll('.tax-doc-csv-btn');
  assert.equal(btns.length, 2, 'one button per panel');

  const hits = captureDownload(() => btns[1].click());
  overlay.remove();
  assert.equal(hits[0].download, 'form-1040-2030-homer.csv', 'the second tab exports Homer');
});
