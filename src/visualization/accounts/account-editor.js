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

const FIXED_COUNTRY    = new Set(['401k', 'roth', 'ira', 'super']);
const INVESTMENT_TYPES = new Set(['brokerage', '401k', 'roth', 'ira', 'super']);
const ALLOCATIONS      = ['EQUITY', 'BOND', 'CASH', 'OTHER'];

/**
 * Default native currency for an account, by type then country. Fixed-country
 * retirement accounts pin their currency (super→AUD; 401k/roth/ira→USD);
 * variable-country accounts follow the selected country.
 */
function _defaultCurrency(type, country) {
  if (type === 'super') return 'AUD';
  if (FIXED_COUNTRY.has(type)) return 'USD';
  return (country === 'AU' || country === 'AUS') ? 'AUD' : 'USD';
}

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
    this._holdings  = [];   // mutable working copy of the holdings array
    this._tbodyEl   = null; // cached tbody reference for refreshes
    this._rootEl    = null;
  }

  render() {
    const el     = this._getTemplate('tpl-account-editor');
    const isEdit = !!(this._node?.id);

    // Initialise working holdings copy before anything touches the DOM
    this._holdings = (this._node?.holdings ?? []).map(h => ({ ...h }));

    // Populate fields
    el.querySelector('[data-id="name"]').value    = this._node?.name ?? '';
    el.querySelector('[data-id="balance"]').value = this._node?.balance ?? 0;

    const typeSelect         = el.querySelector('[data-id="type"]');
    typeSelect.value         = this._node?.type ?? 'checking';
    typeSelect.disabled      = isEdit; // type cannot change after creation

    el.querySelector('[data-id="country"]').value        = this._node?.country ?? 'US';

    // Native currency (design 10 §Phase 5): default by type/country, overridable.
    const curSelect = el.querySelector('[data-id="currency"]');
    curSelect.value = this._node?.currency?.code
      ?? _defaultCurrency(typeSelect.value, this._node?.country ?? 'US');
    // Keep the currency default in sync when the country changes (variable-country
    // accounts only); leaves an explicit user choice for fixed-country types.
    this.listen(el.querySelector('[data-id="country"]'), 'change', (e) => {
      if (!FIXED_COUNTRY.has(typeSelect.value)) {
        curSelect.value = _defaultCurrency(typeSelect.value, e.target.value);
      }
    });

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
    this.listen(typeSelect, 'change', () => {
      this._applyTypeVisibility(el, typeSelect.value);
      curSelect.value = _defaultCurrency(typeSelect.value, el.querySelector('[data-id="country"]').value);
    });

    // Holdings — editable table (design 25 §9 + design 29 taxLossPartner)
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

  // ─── Holdings ───────────────────────────────────────────────────────────────

  _renderHoldings(el) {
    const section = el.querySelector('[data-id="holdingsSection"]');
    const tbody   = el.querySelector('[data-id="holdingsTbody"]');
    const addBtn  = el.querySelector('[data-id="addHoldingBtn"]');
    if (!section || !tbody) return;

    this._tbodyEl = tbody;

    // Visibility: always show for investment account types
    const type = this._node?.type ?? el.querySelector('[data-id="type"]')?.value ?? '';
    section.style.display = (INVESTMENT_TYPES.has(type) || this._holdings.length > 0) ? '' : 'none';

    this._refreshHoldingsTbody();
    this._syncBalance(el);

    if (addBtn) {
      this.listen(addBtn, 'click', () => {
        this._holdings.push({
          id:             `h-${Date.now()}`,
          label:          '',
          allocation:     'EQUITY',
          rateKey:        '',
          marketValue:    0,
          costBasis:      0,
          taxLossPartner: null,
          purchaseDate:   null,
        });
        this._refreshHoldingsTbody();
        this._syncBalance(this._rootEl);
      });
    }
  }

  _refreshHoldingsTbody() {
    const tbody = this._tbodyEl;
    if (!tbody) return;
    tbody.replaceChildren();

    for (let i = 0; i < this._holdings.length; i++) {
      const h = this._holdings[i];

      // Build taxLossPartner options from sibling holdings
      const partnerOpts = ['<option value="">— none —</option>',
        ...this._holdings
          .filter((_, j) => j !== i)
          .map(other => {
            const sel   = h.taxLossPartner === other.id ? ' selected' : '';
            const label = _escape(other.label || other.id || '');
            return `<option value="${_escape(other.id)}"${sel}>${label}</option>`;
          }),
      ].join('');

      const allocOpts = ALLOCATIONS.map(a =>
        `<option value="${a}"${h.allocation === a ? ' selected' : ''}>${a}</option>`
      ).join('');

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><input class="h-input" data-f="label" value="${_escape(h.label ?? '')}" placeholder="Label"/></td>
        <td><select class="h-input" data-f="allocation">${allocOpts}</select></td>
        <td><input class="h-input" data-f="rateKey" value="${_escape(h.rateKey ?? '')}" placeholder="e.g. EQUITY_US"/></td>
        <td><input class="h-input h-num" type="number" data-f="marketValue" value="${h.marketValue ?? 0}"/></td>
        <td><input class="h-input h-num" type="number" data-f="costBasis" value="${h.costBasis ?? 0}"/></td>
        <td><select class="h-input" data-f="taxLossPartner">${partnerOpts}</select></td>
        <td class="h-actions"><button class="btn btn-xs btn-warn h-delete" type="button">✕</button></td>
      `;

      // Wire all inputs
      tr.querySelectorAll('[data-f]').forEach(input => {
        const field   = input.dataset.f;
        const isNum   = input.type === 'number';
        const evtName = input.tagName === 'SELECT' ? 'change' : 'input';

        input.addEventListener(evtName, () => {
          if (field === 'taxLossPartner') {
            this._holdings[i].taxLossPartner = input.value || null;
          } else if (isNum) {
            this._holdings[i][field] = Number(input.value) || 0;
            if (field === 'marketValue') this._syncBalance(this._rootEl);
          } else {
            this._holdings[i][field] = input.value;
          }
        });
      });

      tr.querySelector('.h-delete').addEventListener('click', () => {
        // Null out any taxLossPartner references to this holding
        const removedId = this._holdings[i].id;
        this._holdings.splice(i, 1);
        for (const h2 of this._holdings) {
          if (h2.taxLossPartner === removedId) h2.taxLossPartner = null;
        }
        this._refreshHoldingsTbody();
        this._syncBalance(this._rootEl);
      });

      tbody.appendChild(tr);
    }
  }

  _syncBalance(el) {
    if (!el) return;
    const balInput = el.querySelector('[data-id="balance"]');
    if (!balInput) return;
    if (this._holdings.length > 0) {
      const total = this._holdings.reduce((s, h) => s + (Number(h.marketValue) || 0), 0);
      balInput.value    = total.toFixed(2);
      balInput.disabled = true;
      balInput.title    = 'Computed from holdings — edit holdings to change';
    } else {
      balInput.disabled = false;
      balInput.title    = '';
    }
  }

  // ─── Form read ──────────────────────────────────────────────────────────────

  _readForm(el) {
    const holdings = this._holdings.map(h => ({
      ...h,
      marketValue:    Number(h.marketValue)  || 0,
      costBasis:      Number(h.costBasis)    || 0,
      taxLossPartner: h.taxLossPartner || null,
    }));
    const balance = holdings.length > 0
      ? holdings.reduce((s, h) => s + h.marketValue, 0)
      : (Number(el.querySelector('[data-id="balance"]').value) || 0);

    return {
      id:               this._node?.id ?? null,
      name:             el.querySelector('[data-id="name"]').value.trim(),
      type:             el.querySelector('[data-id="type"]').value,
      balance,
      country:          el.querySelector('[data-id="country"]').value,
      currency:         el.querySelector('[data-id="currency"]').value, // code; mapped to descriptor in the controller
      ownershipType:    el.querySelector('[data-id="ownershipType"]').value,
      ownerId:          el.querySelector('[data-id="ownerId"]').value || null,
      minimumBalance:   el.querySelector('[data-id="minimumBalance"]').value,
      drawdownPriority: el.querySelector('[data-id="drawdownPriority"]').value,
      contributionBasis:el.querySelector('[data-id="contributionBasis"]').value,
      earningsBasis:    el.querySelector('[data-id="earningsBasis"]').value,
      holdings,
    };
  }

  // ─── Visibility ─────────────────────────────────────────────────────────────

  _applyTypeVisibility(el, type) {
    el.querySelector('[data-id="countryRow"]').style.display      = FIXED_COUNTRY.has(type)    ? 'none' : '';
    el.querySelector('[data-id="investmentFields"]').style.display = INVESTMENT_TYPES.has(type) ? ''    : 'none';

    const holdingsSection = el.querySelector('[data-id="holdingsSection"]');
    if (holdingsSection) {
      holdingsSection.style.display = (INVESTMENT_TYPES.has(type) || this._holdings.length > 0) ? '' : 'none';
    }
    this._syncBalance(el);
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
