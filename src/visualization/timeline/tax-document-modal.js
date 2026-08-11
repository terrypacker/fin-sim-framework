/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { WB_EVENTS } from '../workbench/workbench-runtime.js';
import { worksheetRowsFromDocuments, toCsv, tableDocumentToCsv, cellText } from '../../finance/tax/tax-worksheet-export.js';
import { withBom } from '../../utils/csv.js';

/**
 * TaxDocumentModal — renders a TaxDocument in a native <dialog> modal.
 *
 * Owns a single <dialog> element appended to document.body.  Call open()
 * with a TaxDocument (from JournalReportingService.generate()) to display it.
 *
 * Closes on: close-button click, footer Close button, Escape key (native),
 * or backdrop click.
 *
 * When `runtime` is supplied and a line item carries a `drillReport` descriptor,
 * that line is rendered as a clickable button.  Clicking it publishes
 * WB_EVENTS.JOURNAL_REPORT_OPEN and closes the modal.
 */
export class TaxDocumentModal {
  /**
   * @param {{ runtime?: object }} [opts]
   */
  constructor({ runtime = null } = {}) {
    this._runtime = runtime;
    this._schemaRegistry = null;
  }

  /** Wire (or replace) the WorkbenchRuntime after construction. */
  set runtime(r) { this._runtime = r; }

  /**
   * Inject the StateSchemaRegistry so amounts convert to the active display
   * currency (design 10 §Phase 4). A tax document is denominated in its
   * country's currency (doc.country / doc.currency).
   */
  set schemaRegistry(r) { this._schemaRegistry = r ?? null; }

  /** Native currency code for a tax document. */
  _docCurrency(doc) {
    return COUNTRY_TO_CURRENCY[doc?.country] ?? doc?.currency ?? 'USD';
  }

  /**
   * Format a tax-document amount in the document's native currency, converted
   * to the active display currency. Accounting-style parentheses for negatives.
   */
  _fmtAmt(amount, code) {
    if (amount == null) return '—';
    const abs = Math.abs(amount);
    const str = this._schemaRegistry?.formatAmount?.(abs, code)
      ?? ('$' + abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    return amount < 0 ? `(${str})` : str;
  }

  /** @param {TaxDocument|TaxDocument[]} docOrDocs */
  open(docOrDocs) {
    const docs = (Array.isArray(docOrDocs) ? docOrDocs : [docOrDocs]).map(d => this._withNames(d));
    // Retained so the CSV button can export the document it sits under (design 71
    // §11.1). Indexed by the `data-doc-idx` stamped on each panel's button.
    this._docs = docs;

    this._overlay = document.createElement('div');
    this._overlay.id = 'tax-doc-modal-overlay';
    this._overlay.classList.add('tax-doc-modal-overlay');
    this._overlay.addEventListener('click', (e) => { if (e.target === this._overlay) this._overlay.remove(); });

    this._dialog = document.createElement('div');
    this._dialog.className = 'tax-doc-modal';

    this._overlay.appendChild(this._dialog);

    if (docs.length > 1) {
      this._dialog.innerHTML = this._renderTabs(docs);
      this._dialog.addEventListener('click', (e) => {
        const tab = e.target.closest('.tax-doc-tab');
        if (!tab) return;
        const idx = parseInt(tab.dataset.idx, 10);
        this._dialog.querySelectorAll('.tax-doc-tab').forEach(t =>
          t.classList.toggle('tax-doc-tab--active', parseInt(t.dataset.idx, 10) === idx));
        this._dialog.querySelectorAll('.tax-doc-panel').forEach(p =>
          p.classList.toggle('tax-doc-panel--hidden', parseInt(p.dataset.idx, 10) !== idx));
      });
      this._wireDialogClicks();
    } else {
      this._dialog.innerHTML = this._render(docs[0]);
      this._wireDialogClicks();
    }

    document.body.appendChild(this._overlay);
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  _renderTabs(docs) {
    const headers = docs.map((doc, i) =>
      `<button class="tax-doc-tab${i === 0 ? ' tax-doc-tab--active' : ''}" data-idx="${i}">${doc.personName || doc.title}</button>`
    ).join('');
    const panels = docs.map((doc, i) =>
      `<div class="tax-doc-panel${i === 0 ? '' : ' tax-doc-panel--hidden'}" data-idx="${i}">${this._render(doc, i)}</div>`
    ).join('');
    return `<div class="tax-doc-tab-bar">${headers}</div><div class="tax-doc-tab-content">${panels}</div>`;
  }

  _render(doc, idx = 0) {
    const code = this._docCurrency(doc);
    const body = doc.table
      ? this._renderTable(doc.table, code)
      : doc.sections.map(s => this._renderSection(s, code)).join('') + (doc.summary ? this._renderSummary(doc.summary, code) : '');
    return `
      <div class="tax-doc-header">
        <div class="tax-doc-title-group">
          <div class="tax-doc-title">${doc.title}</div>
          <div class="tax-doc-subtitle">${doc.filingStatus}</div>
          ${_renderFxNote(doc)}
        </div>
      </div>
      <div class="tax-doc-body">
        ${body}
        ${_renderNotes(doc)}
      </div>
      <div class="tax-doc-footer">
        ${this._csvButton(doc, idx)}
      </div>`;
  }

  /**
   * CSV export for the document on screen (design 71 §11.1).
   *
   * Two shapes, two exports. A section-shaped return flattens to the §5.1 worksheet
   * columns; a table-shaped disposal register (Form 8949, the AU CGT worksheet) has
   * columns with no home in that set and exports as itself via `tableDocumentToCsv`.
   * The button used to be suppressed for the second kind entirely, which is why the
   * CGT tab had no download.
   */
  _csvButton(doc, idx) {
    if (!this._csvFor(doc)) return '';
    return `<button class="tax-doc-csv-btn" data-doc-idx="${idx}" title="Download this return as CSV">&#11015; CSV</button>`;
  }

  /**
   * Resolve any `{ stateKey, text }` cells to the account's display name.
   *
   * Done ONCE here, at open, rather than inside the renderer — so the table on screen,
   * the CSV the button downloads and the filename all show the same thing. Resolving
   * per render would leave the export showing raw stateKeys next to a table showing
   * names, which is the state this fixes.
   *
   * It happens in the modal because this is the only layer that has a
   * `StateSchemaRegistry`: `TaxDocumentRegistry` builds documents from a journal
   * entry and nothing else. Copy-on-write — the caller's document is never mutated,
   * and an unresolvable key keeps the fallback text (design 70's stated contract:
   * `displayNameFor(k) ?? <fallback>`), so a document opened without a registry, or
   * one naming an account the registry never saw, reads exactly as it did before.
   */
  _withNames(doc) {
    if (!doc?.table?.rows?.some(r => r.some(c => c && typeof c === 'object'))) return doc;
    const resolve = (cell) => (cell && typeof cell === 'object')
      ? (this._schemaRegistry?.displayNameFor?.(cell.stateKey) ?? cellText(cell))
      : cell;
    return { ...doc, table: { ...doc.table, rows: doc.table.rows.map(r => r.map(resolve)) } };
  }

  /** CSV text for a document, or '' when it has nothing exportable. */
  _csvFor(doc) {
    if (doc?.table) return tableDocumentToCsv(doc);
    const rows = worksheetRowsFromDocuments(doc);
    return rows.length ? toCsv(rows) : '';
  }

  /** Flatten the clicked panel's document and hand the browser a CSV download. */
  _downloadCsv(idx) {
    const doc  = this._docs?.[idx];
    const text = this._csvFor(doc);
    if (!text) return;

    const csv  = withBom(text);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = _csvFilename(doc);
    a.click();
    URL.revokeObjectURL(url);
  }

  _renderTable({ heading, columns, rows, totals }, code) {
    const headerCells = columns.map(c => `<th class="tax-doc-tbl-th">${c}</th>`).join('');
    const dataRows = rows.map(row => {
      const cells = row.map((cell, i) => {
        const isAmt = typeof cell === 'number';
        const cls   = isAmt && cell < 0 ? 'tax-doc-tbl-td tax-doc-tbl-td--neg' : 'tax-doc-tbl-td';
        return `<td class="${cls}">${isAmt ? this._fmtAmt(cell, code) : (cell ?? '—')}</td>`;
      }).join('');
      return `<tr class="tax-doc-tbl-row">${cells}</tr>`;
    }).join('');
    const totalCells = totals.map((cell, i) => {
      const isAmt = typeof cell === 'number';
      const cls   = isAmt && cell < 0 ? 'tax-doc-tbl-td tax-doc-tbl-total tax-doc-tbl-td--neg' : 'tax-doc-tbl-td tax-doc-tbl-total';
      return `<td class="${cls}">${isAmt ? this._fmtAmt(cell, code) : (cell ?? '')}</td>`;
    }).join('');
    return `
      <div class="tax-doc-section">
        <div class="tax-doc-section-hdr">${heading}</div>
        <div class="tax-doc-tbl-wrap">
          <table class="tax-doc-tbl">
            <thead><tr>${headerCells}</tr></thead>
            <tbody>${dataRows}</tbody>
            <tfoot><tr>${totalCells}</tr></tfoot>
          </table>
        </div>
      </div>`;
  }

  _renderSection({ heading, lineItems }, code) {
    return `
      <div class="tax-doc-section">
        <div class="tax-doc-section-hdr">${heading}</div>
        ${lineItems.map(li => {
          let cls = li.amount < 0
            ? 'tax-doc-line tax-doc-line--neg'
            : li.amount === 0
              ? 'tax-doc-line tax-doc-line--zero'
              : 'tax-doc-line';
          if (li.sub) cls += ' tax-doc-line--sub';
          if (li.drillReport && this._runtime) {
            const paramsAttr = JSON.stringify(li.drillReport.params ?? {}).replace(/"/g, '&quot;');
            return `<button class="tax-doc-line-btn ${cls} tax-doc-line-drill"
              data-report-id="${li.drillReport.reportId}"
              data-params="${paramsAttr}">
              <span class="tax-doc-line-label">${li.label} ↗</span>
              <span class="tax-doc-line-amount">${this._fmtAmt(li.amount, code)}</span>
            </button>`;
          }
          return `<div class="${cls}">
            <span class="tax-doc-line-label">${li.label}</span>
            <span class="tax-doc-line-amount">${this._fmtAmt(li.amount, code)}</span>
          </div>`;
        }).join('')}
      </div>`;
  }

  /**
   * One delegated listener for both in-dialog affordances. CSV export is wired
   * unconditionally — unlike drill-down, it needs no WorkbenchRuntime, so gating the
   * whole listener on `_runtime` (as the drill-only version did) would silently
   * disable the button wherever the modal is opened without one.
   */
  _wireDialogClicks() {
    if (!this._dialog) return;
    this._dialog.addEventListener('click', (e) => {
      const csvBtn = e.target.closest('.tax-doc-csv-btn');
      if (csvBtn) {
        this._downloadCsv(parseInt(csvBtn.dataset.docIdx, 10) || 0);
        return;
      }

      const drill = e.target.closest('.tax-doc-line-drill');
      if (!drill || !this._runtime) return;
      const reportId = drill.dataset.reportId;
      const params   = JSON.parse(drill.dataset.params || '{}');
      this._runtime.bus.publish({ type: WB_EVENTS.JOURNAL_REPORT_OPEN, reportId, params });
      this._overlay?.remove();
    });
  }

  _renderSummary({ grossIncome, grossTax, credits, netLiability, effectiveRate, marginalRate }, code) {
    return `
      <div class="tax-doc-summary">
        <div class="tax-doc-net-row">
          <span class="tax-doc-net-label">Net Tax Liability</span>
          <span class="tax-doc-net-amount">${this._fmtAmt(netLiability, code)}</span>
        </div>
        <div class="tax-doc-summary-grid">
          <span class="tax-doc-summary-item">
            <span class="tax-doc-summary-key">Gross Income</span>
            <span class="tax-doc-summary-val">${this._fmtAmt(grossIncome, code)}</span>
          </span>
          <span class="tax-doc-summary-item">
            <span class="tax-doc-summary-key">Gross Tax</span>
            <span class="tax-doc-summary-val">${this._fmtAmt(grossTax, code)}</span>
          </span>
          <span class="tax-doc-summary-item">
            <span class="tax-doc-summary-key">Credits</span>
            <span class="tax-doc-summary-val">${this._fmtAmt(credits, code)}</span>
          </span>
          <span class="tax-doc-summary-item">
            <span class="tax-doc-summary-key">Effective Rate</span>
            <span class="tax-doc-summary-val">${_fmtPct(effectiveRate)}</span>
          </span>
          <span class="tax-doc-summary-item">
            <span class="tax-doc-summary-key">Marginal Rate</span>
            <span class="tax-doc-summary-val">${_fmtPct(marginalRate)}</span>
          </span>
        </div>
      </div>`;
  }
}

// ─── Module-level helpers ─────────────────────────────────────────────────────

const COUNTRY_TO_CURRENCY = { US: 'USD', AU: 'AUD' };

/**
 * The FX rate line under the filing status.
 *
 * A cross-border return converts the other country's income into its own
 * currency, and the reader cannot check a single one of those figures without
 * the rate. Stated as `1 USD = 1.543210 AUD` rather than the raw `USD_AUD` pair
 * id, since the direction is the whole point. Rendered only when the settlement
 * recorded a rate — a single-country run, or a settlement from before the field
 * existed, shows nothing rather than an invented 1.0.
 */
function _renderFxNote(doc) {
  if (doc?.fxRate == null) return '';
  const [from, to] = String(doc.fxPair ?? 'USD_AUD').split('_');
  return `<div class="tax-doc-fx-note" title="Rate in force at settlement; the cross-border figures on this return were converted through it">`
    + `FX at settlement: 1 ${from} = ${doc.fxRate.toFixed(6)} ${to}</div>`;
}

/**
 * Document-level qualifications, printed under the figures they qualify.
 *
 * A disposal register states which cost base it used, why its rows carry no
 * acquisition date, and what it had to exclude. Those are not decoration: a reader
 * comparing our cost base against a broker statement will find it different, and the
 * reason (the s855-45 residency step-up) has to be on the document rather than in a
 * source file. They travel into the CSV export too.
 */
function _renderNotes(doc) {
  if (!doc?.notes?.length) return '';
  const items = doc.notes.map(n => `<li class="tax-doc-note">${n}</li>`).join('');
  return `<ul class="tax-doc-notes">${items}</ul>`;
}

/**
 * `"Form 1040 — 2032"` → `"form-1040-2032.csv"`; a per-person AU return gets the
 * person appended so two tabs saved from the same filing do not collide.
 */
function _csvFilename(doc) {
  const parts = [doc?.title ?? 'tax-document', doc?.personName ?? ''];
  const slug  = parts.join(' ')
    .replace(/[^\w\s-]/g, ' ')     // drop em dashes, §, parentheses
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase();
  return `${slug || 'tax-document'}.csv`;
}

function _fmtPct(r) {
  if (!r) return '0.0%';
  return (r * 100).toFixed(1) + '%';
}
