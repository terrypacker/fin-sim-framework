/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { fmtUTC } from '../ui-utils.js';

// Account types whose country/currency are fixed at construction time.
const FIXED_COUNTRY = new Set(['401k', 'roth', 'ira', 'super']);

// Account types that are investment accounts (show C.Basis / E.Basis fields).
const INVESTMENT_TYPES = new Set(['brokerage', '401k', 'roth', 'ira', 'super']);

// Human-readable type labels.
const TYPE_LABELS = {
  checking:  'Checking',
  savings:   'Savings',
  brokerage: 'Brokerage',
  '401k':    '401(k)',
  roth:      'Roth IRA',
  ira:       'Traditional IRA',
  super:     'Superannuation',
};

/**
 * AccountsView — pure DOM layer for the Accounts sidebar panel.
 *
 * Reads / writes the existing HTML elements in index.html:
 *   #accountsList, #accountForm, #addAccountBtn, #saveAccountBtn, #cancelAccountBtn
 *   and all #accountForm* fields.
 *
 * No business logic.  Communicates outward via callback properties set by
 * AccountsPresenter: onSave, onDelete, onEdit, onCancel.
 */
export class AccountsView {
  constructor() {
    /** @type {function(object)|null} */
    this.onSave    = null;
    /** @type {function(string)|null} */
    this.onDelete  = null;
    /** @type {function(import('../../finance/account.js').Account)|null} */
    this.onEdit    = null;
    /** @type {function()|null} */
    this.onCancel  = null;
    /** @type {function(import('../../finance/account.js').Account)|null} */
    this.onHistory = null;

    this._editingAccount = null;
    this._init();
  }

  // ─── DOM wiring ───────────────────────────────────────────────────────────

  _init() {
    document.getElementById('addAccountBtn')?.addEventListener('click', () => {
      this.showForm(null, this._currentPeople);
    });

    document.getElementById('saveAccountBtn')?.addEventListener('click', () => {
      if (this.onSave) this.onSave(this.readForm());
    });

    document.getElementById('cancelAccountBtn')?.addEventListener('click', () => {
      if (this.onCancel) this.onCancel();
    });

    document.getElementById('historyAccountBtn')?.addEventListener('click', () => {
      if (this.onHistory && this._editingAccount) this.onHistory(this._editingAccount);
    });

    // Show/hide investment fields and country row when type changes.
    document.getElementById('accountFormType')?.addEventListener('change', () => {
      this._applyTypeVisibility();
    });
  }

  // ─── List rendering ───────────────────────────────────────────────────────

  /**
   * Re-render the accounts list.
   * @param {import('../../finance/account.js').Account[]} accounts
   * @param {import('../../finance/person.js').Person[]}  people      — for owner name lookup
   * @param {Map<string, number>}                          balanceMap  — live balances keyed by account id
   */
  renderList(accounts, people = [], balanceMap = new Map()) {
    const list = document.getElementById('accountsList');
    list.innerHTML = '';

    const peopleById = new Map(people.map(p => [p.id, p]));

    for (const account of accounts) {
      const row = document.createElement('div');
      row.style.cssText =
        'display:flex;align-items:center;gap:4px;padding:3px 4px;' +
        'background:var(--node-bg);border-radius:3px;font-size:11px;';

      const label = document.createElement('span');
      label.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      const typeLabel = TYPE_LABELS[account.type] ?? account.type ?? '';
      const owner     = account.ownerId ? (peopleById.get(account.ownerId)?.name ?? '') : '';
      label.textContent = owner
        ? `${account.name} (${typeLabel} · ${owner})`
        : `${account.name} (${typeLabel})`;

      const balField = document.createElement('div');
      balField.className = 'node-field';
      balField.style.cssText = 'flex-shrink:0;min-width:72px;';
      const balLabel = document.createElement('label');
      balLabel.textContent = 'Balance';
      const balValue = document.createElement('span');
      const sym = account.currency?.symbol ?? '$';
      const n = balanceMap.has(account.id) ? balanceMap.get(account.id) : (account.balance ?? 0);
      balValue.textContent = (n < 0 ? '-' + sym : sym) +
        Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (n < 0) balValue.style.color = 'var(--accent-red, #e55)';
      balField.append(balLabel, balValue);

      const editBtn = document.createElement('button');
      editBtn.className   = 'btn btn-sm';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => { if (this.onEdit) this.onEdit(account); });

      const delBtn = document.createElement('button');
      delBtn.className   = 'btn btn-sm';
      delBtn.textContent = '✕';
      delBtn.style.color = 'var(--accent-red, #e55)';
      delBtn.addEventListener('click', () => { if (this.onDelete) this.onDelete(account.id); });

      row.append(label, balField, editBtn, delBtn);
      list.appendChild(row);
    }
  }

  // ─── Form show / hide ─────────────────────────────────────────────────────

  /**
   * Show the inline form, optionally pre-populated for editing.
   * @param {import('../../finance/account.js').Account|null} account
   * @param {import('../../finance/person.js').Person[]} people
   */
  showForm(account, people = []) {
    this._currentPeople  = people;
    this._editingAccount = account ?? null;

    const isEdit = !!account;
    document.getElementById('historyAccountBtn').style.display = isEdit ? '' : 'none';
    document.getElementById('accountFormTitle').textContent = isEdit ? 'Edit Account' : 'New Account';
    document.getElementById('accountFormId').value          = account?.id ?? '';
    document.getElementById('accountFormName').value        = account?.name ?? '';
    document.getElementById('accountFormBalance').value     = account?.balance ?? 0;
    document.getElementById('accountFormMinBalance').value  = account?.minimumBalance ?? 0;
    document.getElementById('accountFormDrawdown').value    = account?.drawdownPriority ?? '';
    document.getElementById('accountFormOwnership').value   = account?.ownershipType ?? 'sole';

    // Type selector: read-only when editing (type cannot change after creation).
    const typeSelect = document.getElementById('accountFormType');
    typeSelect.value    = account?.type ?? 'checking';
    typeSelect.disabled = isEdit;

    // Country
    const country = account?.country ?? 'US';
    document.getElementById('accountFormCountry').value = country;

    // Owner dropdown
    this._populateOwnerSelect(people, account?.ownerId ?? null);

    // Investment fields
    if ('contributionBasis' in (account ?? {})) {
      document.getElementById('accountFormContribBasis').value = account.contributionBasis ?? 0;
      document.getElementById('accountFormEarnBasis').value    = account.earningsBasis     ?? 0;
    } else {
      document.getElementById('accountFormContribBasis').value = 0;
      document.getElementById('accountFormEarnBasis').value    = 0;
    }

    this._applyTypeVisibility();
    document.getElementById('accountForm').style.display = '';
  }

  hideForm() {
    document.getElementById('accountForm').style.display = 'none';
    document.getElementById('accountFormId').value = '';
    // Re-enable type selector for the next "new account" open.
    document.getElementById('accountFormType').disabled = false;
  }

  /**
   * Update only the owner dropdown (called when people list changes while form is open).
   * @param {import('../../finance/person.js').Person[]} people
   */
  updateOwnerOptions(people) {
    this._currentPeople = people;
    const currentOwnerId = document.getElementById('accountFormOwnerId').value || null;
    this._populateOwnerSelect(people, currentOwnerId);
  }

  // ─── Form read ────────────────────────────────────────────────────────────

  readForm() {
    return {
      id:               document.getElementById('accountFormId').value      || null,
      name:             document.getElementById('accountFormName').value.trim(),
      type:             document.getElementById('accountFormType').value,
      balance:          document.getElementById('accountFormBalance').value,
      country:          document.getElementById('accountFormCountry').value,
      ownershipType:    document.getElementById('accountFormOwnership').value,
      ownerId:          document.getElementById('accountFormOwnerId').value  || null,
      minimumBalance:   document.getElementById('accountFormMinBalance').value,
      drawdownPriority: document.getElementById('accountFormDrawdown').value,
      contributionBasis:document.getElementById('accountFormContribBasis').value,
      earningsBasis:    document.getElementById('accountFormEarnBasis').value,
    };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  _applyTypeVisibility() {
    const type = document.getElementById('accountFormType').value;
    document.getElementById('accountFormCountryRow').style.display =
      FIXED_COUNTRY.has(type) ? 'none' : '';
    document.getElementById('accountFormInvestmentFields').style.display =
      INVESTMENT_TYPES.has(type) ? '' : 'none';
  }

  _populateOwnerSelect(people, selectedId) {
    const sel = document.getElementById('accountFormOwnerId');
    sel.innerHTML = '<option value="">— none —</option>';
    for (const p of people) {
      const opt = document.createElement('option');
      opt.value       = p.id;
      opt.textContent = p.name || p.id;
      if (p.id === selectedId) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  // ─── Transaction history modal ────────────────────────────────────────────

  /**
   * Display a modal overlay with the transaction history for an account.
   * @param {{ date: Date, amount: number, eventType: string, reducer: string }[]} entries
   * @param {string} accountName
   * @param {string} [currencySymbol]
   */
  showHistory(entries, accountName, currencySymbol = '$') {
    document.getElementById('accountHistoryModal')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'accountHistoryModal';
    overlay.classList.add('sim-modal-overlay')
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const modal = document.createElement('div');
    modal.classList.add('sim-modal');

    // ── Header ──
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;';
    const title = document.createElement('span');
    title.style.cssText = 'font-size:12px;font-weight:600;';
    title.textContent = `Transaction History — ${accountName}`;
    const closeBtn = document.createElement('button');
    closeBtn.className   = 'btn btn-sm';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => overlay.remove());
    header.append(title, closeBtn);

    // ── Body ──
    const body = document.createElement('div');
    body.style.cssText = 'overflow-y:auto;flex:1;';

    if (!entries || entries.length === 0) {
      const empty = document.createElement('span');
      empty.style.color   = 'var(--text-muted)';
      empty.textContent   = 'No transactions recorded. Run a simulation first.';
      body.appendChild(empty);
    } else {
      const table = document.createElement('table');
      table.style.cssText = 'width:100%;border-collapse:collapse;';

      const thead = table.createTHead();
      const hrow  = thead.insertRow();
      for (const col of ['Date', 'Event', 'Amount', 'Balance']) {
        const th = document.createElement('th');
        th.textContent  = col;
        th.style.cssText =
          'text-align:left;padding:2px 6px;font-size:9px;letter-spacing:0.06em;' +
          'color:var(--text-muted);border-bottom:1px solid var(--border);';
        hrow.appendChild(th);
      }

      const tbody = table.createTBody();
      for (const entry of entries) {
        const tr = tbody.insertRow();
        tr.style.cssText = 'border-bottom:1px solid var(--border-subtle, var(--border));';

        const dateStr = entry.date instanceof Date ? fmtUTC(entry.date) : String(entry.date);
        const sym     = currencySymbol;
        const amt     = entry.amount;
        const bal     = entry.balanceAfter;
        const amtStr  = (amt >= 0 ? '+' + sym : '-' + sym) +
          Math.abs(amt).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const balStr  = bal != null
          ? (bal < 0 ? '-' + sym : sym) + Math.abs(bal).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          : '—';

        const cells = [
          { text: dateStr,                                style: '' },
          { text: entry.eventType ?? entry.reducer ?? '', style: 'color:var(--text-muted);' },
          { text: amtStr, style: `color:${amt >= 0 ? 'var(--accent-green,#4a8)' : 'var(--accent-red,#e55)'};font-family:var(--font-mono);` },
          { text: balStr, style: `font-family:var(--font-mono);${bal != null && bal < 0 ? 'color:var(--accent-red,#e55);' : ''}` },
        ];
        for (const { text, style } of cells) {
          const td = tr.insertCell();
          td.textContent   = text;
          td.style.cssText = 'padding:3px 6px;' + style;
        }
      }
      body.appendChild(table);
    }

    modal.append(header, body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }
}
