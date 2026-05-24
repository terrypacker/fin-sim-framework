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
 * TaxDocumentModal — renders a TaxDocument in a native <dialog> modal.
 *
 * Owns a single <dialog> element appended to document.body.  Call open()
 * with a TaxDocument (from JournalReportingService.generate()) to display it.
 *
 * Closes on: close-button click, footer Close button, Escape key (native),
 * or backdrop click.
 */
export class TaxDocumentModal {
  constructor() {
  }

  /** @param {TaxDocument|TaxDocument[]} docOrDocs */
  open(docOrDocs) {
    const docs = Array.isArray(docOrDocs) ? docOrDocs : [docOrDocs];

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
    } else {
      this._dialog.innerHTML = this._render(docs[0]);
    }

    document.body.appendChild(this._overlay);
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  _renderTabs(docs) {
    const headers = docs.map((doc, i) =>
      `<button class="tax-doc-tab${i === 0 ? ' tax-doc-tab--active' : ''}" data-idx="${i}">${doc.personName || doc.title}</button>`
    ).join('');
    const panels = docs.map((doc, i) =>
      `<div class="tax-doc-panel${i === 0 ? '' : ' tax-doc-panel--hidden'}" data-idx="${i}">${this._render(doc)}</div>`
    ).join('');
    return `<div class="tax-doc-tab-bar">${headers}</div><div class="tax-doc-tab-content">${panels}</div>`;
  }

  _render(doc) {
    return `
      <div class="tax-doc-header">
        <div class="tax-doc-title-group">
          <div class="tax-doc-title">${doc.title}</div>
          <div class="tax-doc-subtitle">${doc.filingStatus}</div>
        </div>
      </div>
      <div class="tax-doc-body">
        ${doc.sections.map(s => this._renderSection(s)).join('')}
        ${this._renderSummary(doc.summary)}
      </div>
      <div class="tax-doc-footer">
      </div>`;
  }

  _renderSection({ heading, lineItems }) {
    return `
      <div class="tax-doc-section">
        <div class="tax-doc-section-hdr">${heading}</div>
        ${lineItems.map(li => {
          const cls = li.amount < 0
            ? 'tax-doc-line tax-doc-line--neg'
            : li.amount === 0
              ? 'tax-doc-line tax-doc-line--zero'
              : 'tax-doc-line';
          return `<div class="${cls}">
            <span class="tax-doc-line-label">${li.label}</span>
            <span class="tax-doc-line-amount">${_fmtAmt(li.amount)}</span>
          </div>`;
        }).join('')}
      </div>`;
  }

  _renderSummary({ grossIncome, grossTax, credits, netLiability, effectiveRate, marginalRate }) {
    return `
      <div class="tax-doc-summary">
        <div class="tax-doc-net-row">
          <span class="tax-doc-net-label">Net Tax Liability</span>
          <span class="tax-doc-net-amount">${_fmtAmt(netLiability)}</span>
        </div>
        <div class="tax-doc-summary-grid">
          <span class="tax-doc-summary-item">
            <span class="tax-doc-summary-key">Gross Income</span>
            <span class="tax-doc-summary-val">${_fmtAmt(grossIncome)}</span>
          </span>
          <span class="tax-doc-summary-item">
            <span class="tax-doc-summary-key">Gross Tax</span>
            <span class="tax-doc-summary-val">${_fmtAmt(grossTax)}</span>
          </span>
          <span class="tax-doc-summary-item">
            <span class="tax-doc-summary-key">Credits</span>
            <span class="tax-doc-summary-val">${_fmtAmt(credits)}</span>
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

function _fmtAmt(amount) {
  if (amount == null) return '—';
  const abs = Math.abs(amount);
  const str = '$' + abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return amount < 0 ? `(${str})` : str;
}

function _fmtPct(r) {
  if (!r) return '0.0%';
  return (r * 100).toFixed(1) + '%';
}
