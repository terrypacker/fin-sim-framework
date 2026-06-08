/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseComponent } from '../components/base-component.js';

const FIXED_COUNTRY   = new Set(['401k', 'roth', 'ira', 'super']);
const INVESTMENT_TYPES = new Set(['brokerage', '401k', 'roth', 'ira', 'super']);

/**
 * AccountEditor — renders the account edit form from tpl-account-editor into
 * a given container (typically a modal body).
 *
 * Communicates outward via callbacks:
 *   onSave(data)         — user clicked Save
 *   onDelete(id)         — user clicked Delete
 *   onHistory(node)      — user clicked History
 */
export class AccountEditor extends BaseComponent {
  /**
   * @param {{
   *   parent?:   BaseComponent,
   *   container: HTMLElement,
   *   node:      object|null,    — Account graph node, or null for a new account
   *   people:    object[],       — Person graph nodes for owner dropdown
   *   onSave:    function(object): void,
   *   onDelete:  function(string): void,
   *   onHistory: function(object): void,
   * }}
   */
  constructor({ parent, container, node, people = [], onSave, onDelete, onHistory }) {
    super({ parent });
    this._container = container;
    this._node      = node;
    this._people    = people;
    this.onSave     = onSave    ?? null;
    this.onDelete   = onDelete  ?? null;
    this.onHistory  = onHistory ?? null;
  }

  render() {
    const el     = this._getTemplate('tpl-account-editor');
    const isEdit = !!(this._node?.id);

    // Populate fields
    el.querySelector('[data-id="name"]').value    = this._node?.name ?? '';
    el.querySelector('[data-id="balance"]').value = this._node?.balance ?? 0;

    const typeSelect         = el.querySelector('[data-id="type"]');
    typeSelect.value         = this._node?.type ?? 'checking';
    typeSelect.disabled      = isEdit; // type cannot change after creation

    el.querySelector('[data-id="country"]').value        = this._node?.country ?? 'US';
    el.querySelector('[data-id="ownershipType"]').value  = this._node?.ownershipType ?? 'sole';
    el.querySelector('[data-id="minimumBalance"]').value = this._node?.minimumBalance ?? 0;

    const dp = this._node?.drawdownPriority;
    el.querySelector('[data-id="drawdownPriority"]').value = dp ?? '';

    el.querySelector('[data-id="contributionBasis"]').value = this._node?.contributionBasis ?? 0;
    el.querySelector('[data-id="earningsBasis"]').value     = this._node?.earningsBasis     ?? 0;

    // Owner dropdown
    this._populateOwnerSelect(el, this._people, this._node?.ownerId ?? null);

    // Show/hide conditional sections
    this._applyTypeVisibility(el, typeSelect.value);
    this.listen(typeSelect, 'change', () => this._applyTypeVisibility(el, typeSelect.value));

    // Holdings table (read-only, design 25 §9). Editing flows ship later
    // alongside per-holding appreciation schedules (design 28).
    this._renderHoldings(el);

    // Delete / History buttons (edit only)
    const deleteBtn  = el.querySelector('[data-id="deleteBtn"]');
    const historyBtn = el.querySelector('[data-id="historyBtn"]');
    deleteBtn.style.display  = isEdit ? '' : 'none';
    historyBtn.style.display = isEdit ? '' : 'none';

    this.listen(el.querySelector('[data-id="saveBtn"]'), 'click', () => {
      if (this.onSave) this.onSave(this._readForm(el));
    });

    this.listen(deleteBtn, 'click', () => {
      if (this.onDelete && this._node?.id) this.onDelete(this._node.id);
    });

    this.listen(historyBtn, 'click', () => {
      if (this.onHistory) this.onHistory(this._node);
    });

    this._container.replaceChildren(el);
    this._rootEl = el;
  }

  _readForm(el) {
    return {
      id:               this._node?.id ?? null,
      name:             el.querySelector('[data-id="name"]').value.trim(),
      type:             el.querySelector('[data-id="type"]').value,
      balance:          el.querySelector('[data-id="balance"]').value,
      country:          el.querySelector('[data-id="country"]').value,
      ownershipType:    el.querySelector('[data-id="ownershipType"]').value,
      ownerId:          el.querySelector('[data-id="ownerId"]').value || null,
      minimumBalance:   el.querySelector('[data-id="minimumBalance"]').value,
      drawdownPriority: el.querySelector('[data-id="drawdownPriority"]').value,
      contributionBasis:el.querySelector('[data-id="contributionBasis"]').value,
      earningsBasis:    el.querySelector('[data-id="earningsBasis"]').value,
    };
  }

  _applyTypeVisibility(el, type) {
    el.querySelector('[data-id="countryRow"]').style.display      = FIXED_COUNTRY.has(type)    ? 'none' : '';
    el.querySelector('[data-id="investmentFields"]').style.display = INVESTMENT_TYPES.has(type) ? ''    : 'none';
  }

  _renderHoldings(el) {
    const section = el.querySelector('[data-id="holdingsSection"]');
    const tbody   = el.querySelector('[data-id="holdingsTbody"]');
    if (!section || !tbody) return;
    const holdings = Array.isArray(this._node?.holdings) ? this._node.holdings : [];
    if (holdings.length === 0) {
      section.style.display = 'none';
      return;
    }
    section.style.display = '';
    tbody.replaceChildren();
    const currency = this._node?.currency?.symbol ?? '$';
    for (const h of holdings) {
      const tr  = document.createElement('tr');
      const ugl = (h.marketValue ?? 0) - (h.costBasis ?? 0);
      tr.innerHTML = `
        <td>${_escape(h.label || h.id || '')}</td>
        <td>${_escape(h.allocation ?? '')}</td>
        <td>${_escape(h.rateKey ?? '')}</td>
        <td class="num">${_money(currency, h.marketValue)}</td>
        <td class="num">${_money(currency, h.costBasis)}</td>
        <td class="num ${ugl >= 0 ? 'pos' : 'neg'}">${_money(currency, ugl)}</td>
        <td>${_date(h.purchaseDate)}</td>
      `;
      tbody.appendChild(tr);
    }
  }

  _populateOwnerSelect(el, people, selectedId) {
    const sel = el.querySelector('[data-id="ownerId"]');
    sel.innerHTML = '<option value="">— none —</option>';
    for (const p of people) {
      const opt       = document.createElement('option');
      opt.value       = p.id;
      opt.textContent = p.name || p.id;
      if (p.id === selectedId) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  destroy() {
    this._rootEl?.remove();
    super.destroy();
  }
}

function _escape(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

function _money(symbol, n) {
  const v = Number(n ?? 0);
  return `${symbol}${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function _date(d) {
  if (!d) return '—';
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toISOString().slice(0, 10);
}
