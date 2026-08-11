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

test('CSV button IS rendered for a table-shaped disposal register', () => {
  // It used to be suppressed: a disposal register has no home in the §5.1 worksheet
  // columns, so `flattenDocument` yields nothing for it and the button was hidden —
  // which is why the AU CGT tab had no download. Registers now export in their own
  // columns instead of being denied an export.
  const modal = new TaxDocumentModal();
  const html  = openHtml(modal, {
    title: 'Form 8949 — 2030', country: 'US', filingStatus: 'Part II',
    table: { heading: 'Sales', columns: ['A'], rows: [['x']], totals: ['Totals'] },
  });
  assert.ok(html.includes('tax-doc-csv-btn'));
});

test('CSV button is omitted for a document with nothing to export', () => {
  const modal = new TaxDocumentModal();
  const html  = openHtml(modal, {
    title: 'Empty — 2030', country: 'US', filingStatus: 'N/A', sections: [],
  });
  assert.ok(!html.includes('tax-doc-csv-btn'),
    'a button that downloads an empty file is worse than no button');
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

// ─── Account display names on table rows (design 70) ─────────────────────────

const disposalDoc = () => ({
  title: 'CGT Worksheet — FY 2031–32', country: 'AU', taxYear: 2031,
  filingStatus: 'Capital Gain or Capital Loss Worksheet',
  table: {
    heading: 'Disposals',
    columns: ['CGT Asset or Event', 'Capital Proceeds'],
    rows: [
      [{ stateKey: 'usStockAccount', text: 'usStockAccount' }, 1000],
      [{ stateKey: 'neverRegistered', text: 'neverRegistered' }, 500],
      ['A plain string cell', 250],
    ],
    totals: ['Totals', 1750],
  },
});

function namedRegistry(names) {
  const reg = wiredRegistry('AUD');
  reg.registerDisplayRecord = () => {};
  reg.displayNameFor = (k) => names[k] ?? null;
  return reg;
}

test('table rows resolve a stateKey cell to the account display name', () => {
  const m = new TaxDocumentModal();
  m.schemaRegistry = namedRegistry({ usStockAccount: 'US Brokerage (Terry)' });
  const html = openHtml(m, disposalDoc());
  assert.ok(html.includes('US Brokerage (Terry)'), 'the name replaces the key');
  assert.ok(!html.includes('>usStockAccount<'), 'the raw key is gone from the row');
});

test('an unregistered key keeps its fallback text, and plain cells are untouched', () => {
  // design 70 contract: `displayNameFor(k) ?? <fallback>`. A key the registry never
  // saw must render exactly as it did before, not as blank or "[object Object]".
  const m = new TaxDocumentModal();
  m.schemaRegistry = namedRegistry({ usStockAccount: 'US Brokerage (Terry)' });
  const html = openHtml(m, disposalDoc());
  assert.ok(html.includes('neverRegistered'));
  assert.ok(html.includes('A plain string cell'));
  assert.ok(!html.includes('[object Object]'));
});

test('with no registry at all the rows still read', () => {
  const m = new TaxDocumentModal();                 // no schemaRegistry
  const html = openHtml(m, disposalDoc());
  assert.ok(html.includes('usStockAccount'));
  assert.ok(!html.includes('[object Object]'));
});

test('the CSV export shows the same names as the table', () => {
  // Resolving per-render instead of at open would leave the download showing raw
  // stateKeys beside a table showing names.
  const m = new TaxDocumentModal();
  m.schemaRegistry = namedRegistry({ usStockAccount: 'US Brokerage (Terry)' });
  m.open(disposalDoc());
  const overlay = document.getElementById('tax-doc-modal-overlay');
  const blobs = [];
  const realBlob = global.Blob;
  const realURL  = global.URL;
  global.Blob = class { constructor(parts) { blobs.push(parts.join('')); } };
  global.URL  = { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} };
  try { overlay.querySelector('.tax-doc-csv-btn').click(); }
  finally { global.Blob = realBlob; global.URL = realURL; overlay.remove(); }

  assert.ok(blobs[0].includes('US Brokerage (Terry)'), 'the CSV carries the name too');
  assert.ok(!blobs[0].includes('[object Object]'));
});

test('resolving names does not mutate the caller\'s document', () => {
  const m = new TaxDocumentModal();
  m.schemaRegistry = namedRegistry({ usStockAccount: 'US Brokerage (Terry)' });
  const doc = disposalDoc();
  openHtml(m, doc);
  assert.deepEqual(doc.table.rows[0][0], { stateKey: 'usStockAccount', text: 'usStockAccount' },
    'the document handed in must be unchanged — it may be shared or re-rendered');
});
