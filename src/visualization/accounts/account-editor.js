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
import { bindParamLinkedField } from '../scenario/param-linked-field.js';
import { defaultCurrencyForCountry } from '../../finance/country-codes.js';
import { RATE_KEYS } from '../../finance/economic-regimes/rate-keys.js';

const FIXED_COUNTRY    = new Set(['401k', 'roth', 'ira', 'super']);
// Cash account types eligible to be flagged the country's transaction account
// (design 55 §7). Only these expose the isTransactionAccount checkbox + param.
const CASH_TYPES       = new Set(['checking', 'savings']);
// Holdings-bearing types (brokerage + retirement) — drive holdings-editor visibility.
const INVESTMENT_TYPES = new Set(['brokerage', '401k', 'roth', 'ira', 'super']);
// Types carrying the contribution/earnings ledger — the only ones that show (and
// persist) the basis fields (design 53 §2). Brokerage is holdings-only.
const RETIREMENT_TYPES = new Set(['401k', 'roth', 'ira', 'super']);
const ALLOCATIONS      = ['EQUITY', 'BOND', 'CASH', 'OTHER'];

// Rate Key choices for the holdings editor, grouped by asset category. A holding's
// rateKey selects which market-return series drives its growth (state.effective*
// Rates[rateKey]) and is the handle shocks/regimes author effects on. The class
// keys (EQUITY_US/AU) and their per-account-type members are all valid override
// targets (see rate-keys.js). Blank = leave unset (the account resolves a default
// at creation). A free-text typo silently fell back to a generic rate — this list
// makes the valid set discoverable and prevents that.
const RATE_KEY_GROUPS = [
  { label: 'Equity — class',         keys: [RATE_KEYS.EQUITY_US, RATE_KEYS.EQUITY_AU] },
  { label: 'Equity — US by account', keys: [RATE_KEYS.EQUITY_US_ROTH, RATE_KEYS.EQUITY_US_IRA, RATE_KEYS.EQUITY_US_K401, RATE_KEYS.EQUITY_US_BROKERAGE] },
  { label: 'Equity — AU by account', keys: [RATE_KEYS.EQUITY_AU_STOCK, RATE_KEYS.EQUITY_AU_SUPER] },
  { label: 'Fixed income',           keys: [RATE_KEYS.FIXED_INCOME_US, RATE_KEYS.FIXED_INCOME_AU] },
  { label: 'Savings',                keys: [RATE_KEYS.SAVINGS_US, RATE_KEYS.SAVINGS_AU] },
  { label: 'Real estate / other',    keys: [RATE_KEYS.REAL_ESTATE_US, RATE_KEYS.REAL_ESTATE_AU, RATE_KEYS.COLLECTIBLE] },
];
// Flat set of known keys, for detecting an out-of-enum (custom/legacy) value so the
// dropdown preserves it instead of silently dropping it on edit.
const KNOWN_RATE_KEYS = new Set(RATE_KEY_GROUPS.flatMap(g => g.keys));

/**
 * Default native currency for an account, by type then country. Fixed-country
 * retirement accounts pin their currency (super→AUD; 401k/roth/ira→USD);
 * variable-country accounts follow the selected country.
 */
function _defaultCurrency(type, country) {
  if (type === 'super') return 'AUD';
  if (FIXED_COUNTRY.has(type)) return 'USD';
  return defaultCurrencyForCountry(country);
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
   *   realProperties: object[],  — RealProperty nodes for the offset property picker
   *   onSave:    function(object): void,
   *   onDelete:  function(string): void,
   *   onHistory: function(object): void,
   * }}
   */
  constructor({ parent, container, node, people = [], realProperties = [], onSave, onDelete, onHistory,
                links = null, onParamChange = null, onOpenParam = null }) {
    super({ parent });
    this._container = container;
    this._node      = node;
    this._people    = people;
    this._realProperties = realProperties;
    this.onSave     = onSave    ?? null;
    this.onDelete   = onDelete  ?? null;
    this.onHistory  = onHistory ?? null;
    this._links     = links;          // ParamFieldLinks — fields backed by a param (design/32)
    this.onParamChange = onParamChange ?? null;
    this.onOpenParam   = onOpenParam   ?? null;
    this._linkedFields = new Set();   // domain fields routed through a param (excluded from save)
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
    el.querySelector('[data-id="isTransactionAccount"]').checked = !!this._node?.isTransactionAccount;

    const dp = this._node?.drawdownPriority;
    el.querySelector('[data-id="drawdownPriority"]').value = dp ?? '';

    // contributionBasis: a NEW account is left blank (placeholder "= balance"), so the
    // derived earningsBasis defaults to 0 — "all principal" (design 53 §8, the chosen
    // default). An existing account shows its stored contributions. earningsBasis is
    // computed read-only from balance − contributionBasis; _syncEarningsBasis owns it.
    el.querySelector('[data-id="contributionBasis"]').value = this._node?.contributionBasis ?? '';

    // Owner dropdown
    this._populateOwnerSelect(el, this._people, this._node?.ownerId ?? null);

    // Offset → property picker (design 53 §3 / 54 P3)
    this._populatePropertySelect(el, this._realProperties, this._node?.offsetsPropertyKey ?? null);

    // Show/hide conditional sections
    this._applyTypeVisibility(el, typeSelect.value);
    this.listen(typeSelect, 'change', () => {
      this._applyTypeVisibility(el, typeSelect.value);
      curSelect.value = _defaultCurrency(typeSelect.value, el.querySelector('[data-id="country"]').value);
    });

    // earningsBasis is derived (design 53 §8): recompute it live whenever either
    // input — a free-scalar balance or the contributions — changes. (Holdings-driven
    // balance edits cascade through _syncBalance, which also calls _syncEarningsBasis.)
    this.listen(el.querySelector('[data-id="balance"]'),          'input', () => this._syncEarningsBasis(el));
    this.listen(el.querySelector('[data-id="contributionBasis"]'), 'input', () => this._syncEarningsBasis(el));

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

    this._bindParamLinks(el);

    this._container.replaceChildren(el);
    this._rootEl = el;
  }

  /**
   * Route fields backed by a scenario param through that param (design/32):
   * show the param value, write the param on change, badge + click-through, and
   * record the field so _readForm omits it from the service payload. Only an
   * existing account (with a stateKey) can match a node-linked param; a brand-new
   * account never does. `balance` is only linked when it is a free scalar — when
   * holdings drive the balance it is computed, so the param-link would mislead.
   */
  _bindParamLinks(el) {
    this._linkedFields = new Set();
    const stateKey = this._node?.stateKey;
    if (!stateKey || !this._links) return;

    // contributionBasis is a generated param (design 55) on retirement accounts;
    // linking it routes edits through the param so the param→record cascade applies
    // the user's value on Rebuild instead of overwriting it with the stale param.
    // getParamFor returns null for account types without the param, so listing it
    // unconditionally is safe.
    const toNumber = (raw) => Number(raw) || 0;
    const candidates = [
      { dataId: 'minimumBalance',      field: 'minimumBalance',      coerce: toNumber },
      { dataId: 'contributionBasis',   field: 'contributionBasis',   coerce: toNumber },
      // Boolean transaction-account flag (§7) — the checkbox passes its `.checked`.
      { dataId: 'isTransactionAccount', field: 'isTransactionAccount', coerce: (raw) => !!raw },
    ];
    // `balance` is param-linked only when it is a free scalar. When holdings drive the
    // balance it is computed (and no balance param is generated), so linking would
    // mislead — see _syncBalance / the generator skip.
    if (this._holdings.length === 0) candidates.push({ dataId: 'balance', field: 'balance', coerce: toNumber });

    for (const { dataId, field, coerce } of candidates) {
      const param = this._links.getParamFor('account', stateKey, field);
      if (!param) continue;
      const input   = el.querySelector(`[data-id="${dataId}"]`);
      const labelEl = input?.closest('.node-field')?.querySelector('label');
      bindParamLinkedField({
        input, labelEl, param, coerce,
        onChange: () => this.onParamChange?.(),
        onOpen:   (p) => this.onOpenParam?.(p),
      });
      this._linkedFields.add(field);
    }
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
          dividendYield:  null,
          couponRate:     null,
          duration:       null,
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

      const alloc = h.allocation ?? 'EQUITY';
      // Per-cell gating by allocation (design 53 §5.2). Fields the allocation
      // doesn't use render an empty cell rather than a stray input.
      const showCostBasis = alloc === 'EQUITY' || alloc === 'OTHER';   // BOND: hidden (=MV); CASH: no CGT
      const showPartner   = alloc === 'EQUITY' || alloc === 'OTHER';   // TLH is equity-oriented
      const showDuration  = alloc === 'BOND';                          // mark-to-market sensitivity
      // The merged "Income Rate" cell binds dividendYield (EQUITY) or couponRate (BOND).
      const incomeField   = alloc === 'EQUITY' ? 'dividendYield'
                          : alloc === 'BOND'   ? 'couponRate'
                          : null;
      const incomeVal     = incomeField ? (h[incomeField] ?? '') : '';
      const incomeTitle   = alloc === 'EQUITY' ? 'Dividend yield' : 'Coupon rate';

      const costBasisCell = showCostBasis
        ? `<td><input class="h-input h-num" type="number" data-f="costBasis" value="${h.costBasis ?? 0}"/></td>`
        : '<td class="h-cell-na"></td>';
      const incomeCell = incomeField
        ? `<td><input class="h-input h-num" type="number" step="0.001" data-f="${incomeField}" value="${incomeVal}" title="${incomeTitle}" placeholder="${incomeTitle}"/></td>`
        : '<td class="h-cell-na"></td>';
      const durationCell = showDuration
        ? `<td><input class="h-input h-num" type="number" step="0.1" data-f="duration" value="${h.duration ?? ''}" title="Modified duration (years)" placeholder="Duration"/></td>`
        : '<td class="h-cell-na"></td>';
      const partnerCell = showPartner
        ? `<td><select class="h-input" data-f="taxLossPartner">${partnerOpts}</select></td>`
        : '<td class="h-cell-na"></td>';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><input class="h-input" data-f="label" value="${_escape(h.label ?? '')}" placeholder="Label"/></td>
        <td><select class="h-input" data-f="allocation">${allocOpts}</select></td>
        <td><select class="h-input" data-f="rateKey">${_rateKeyOptionsHtml(h.rateKey ?? '')}</select></td>
        <td><input class="h-input h-num" type="number" data-f="marketValue" value="${h.marketValue ?? 0}"/></td>
        ${costBasisCell}
        ${incomeCell}
        ${durationCell}
        ${partnerCell}
        <td class="h-actions"><button class="btn btn-xs btn-warn h-delete" type="button">✕</button></td>
      `;

      // Nullable per-holding number fields: an empty input means "unset" (fall back
      // to the account/regime default), not 0.
      const NULLABLE_NUM = new Set(['dividendYield', 'couponRate', 'duration']);

      // Wire all inputs
      tr.querySelectorAll('[data-f]').forEach(input => {
        const field   = input.dataset.f;
        const isNum   = input.type === 'number';
        const evtName = input.tagName === 'SELECT' ? 'change' : 'input';

        input.addEventListener(evtName, () => {
          if (field === 'allocation') {
            this._holdings[i].allocation = input.value;
            // Bond Cost Basis is hidden and defaulted to Market Value (§5.3.4):
            // on switch to BOND, snap basis to MV so no embedded gain is authored.
            if (input.value === 'BOND') {
              this._holdings[i].costBasis = Number(this._holdings[i].marketValue) || 0;
            }
            // Re-render so the row shows exactly this allocation's inputs.
            this._refreshHoldingsTbody();
            this._syncBalance(this._rootEl);
          } else if (field === 'taxLossPartner') {
            this._holdings[i].taxLossPartner = input.value || null;
          } else if (isNum) {
            if (NULLABLE_NUM.has(field)) {
              this._holdings[i][field] = input.value === '' ? null : Number(input.value);
            } else {
              this._holdings[i][field] = Number(input.value) || 0;
            }
            if (field === 'marketValue') {
              // Editor-time MV edit on a BOND keeps costBasis synced to MV (§5.3.4).
              if (this._holdings[i].allocation === 'BOND') {
                this._holdings[i].costBasis = Number(input.value) || 0;
              }
              this._syncBalance(this._rootEl);
            }
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
    // Balance drives the derived earnings; keep it in step (design 53 §8).
    this._syncEarningsBasis(el);
  }

  /**
   * earningsBasis is DERIVED, read-only (design 53 §8): the deferred-tax remainder
   * the user cannot know directly, just as `balance` is the remainder of Σ holdings.
   * Compute `earningsBasis = max(0, balance − contributionBasis)` from the live
   * balance (holdings-computed or free-scalar) and contributions, disable the input,
   * and hint the formula. A blank contributions field means "= balance" → earnings 0
   * ("all principal", the chosen default). No-op for non-retirement types (the field
   * is hidden and omitted from the payload).
   */
  _syncEarningsBasis(el) {
    if (!el) return;
    const earnInput = el.querySelector('[data-id="earningsBasis"]');
    if (!earnInput) return;
    const balance    = Number(el.querySelector('[data-id="balance"]').value) || 0;
    const contribRaw = el.querySelector('[data-id="contributionBasis"]').value;
    const contrib    = contribRaw === '' ? balance : (Number(contribRaw) || 0);
    const earnings   = Math.max(0, balance - contrib);
    earnInput.value    = earnings.toFixed(2);
    earnInput.disabled = true;
    earnInput.title    = 'Computed = balance − contributions';
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

    const data = {
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
      holdings,
    };
    // Basis ledger only exists on retirement accounts (design 53 §2); emitting it for
    // a brokerage would re-add the field via the update path. Gate on type. Only
    // `contributionBasis` is an input — `earningsBasis` is DERIVED (design 53 §8) by
    // the controller/service from balance − contributions, so it is NOT emitted here.
    const type = data.type;
    if (RETIREMENT_TYPES.has(type)) {
      data.contributionBasis = el.querySelector('[data-id="contributionBasis"]').value;
    }
    // Transaction-account flag (design 55 §7) — cash accounts only. When param-linked
    // it is dropped below (owned by the scenario param); a brand-new account has no
    // param yet, so the flag rides the create payload.
    if (CASH_TYPES.has(type)) {
      data.isTransactionAccount = el.querySelector('[data-id="isTransactionAccount"]').checked;
    }
    // Offset link (design 53 §3 / 54 P3) — the property whose loan this offset reduces.
    if (type === 'offset') {
      data.offsetsPropertyKey = el.querySelector('[data-id="offsetsPropertyKey"]').value || null;
    }
    // Param-backed fields are owned by their scenario param (design/32) — drop
    // them so the service update doesn't write a competing value on the account.
    for (const f of this._linkedFields) delete data[f];
    return data;
  }

  // ─── Visibility ─────────────────────────────────────────────────────────────

  _applyTypeVisibility(el, type) {
    el.querySelector('[data-id="countryRow"]').style.display      = FIXED_COUNTRY.has(type)    ? 'none' : '';
    el.querySelector('[data-id="investmentFields"]').style.display = RETIREMENT_TYPES.has(type) ? ''    : 'none';
    // The transaction-account flag only applies to cash accounts (§7).
    const txnRow = el.querySelector('[data-id="transactionAccountRow"]');
    if (txnRow) txnRow.style.display = CASH_TYPES.has(type) ? '' : 'none';
    const offsetFields = el.querySelector('[data-id="offsetFields"]');
    if (offsetFields) offsetFields.style.display = type === 'offset' ? '' : 'none';

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

  /**
   * Populate the offset property picker. Options are keyed by the property's
   * stateKey (what `offsetsPropertyKey` stores); the offset reduces that
   * property's linked loan interest (design 53 §3 / 54 P3).
   */
  _populatePropertySelect(el, properties, selectedKey) {
    const sel = el.querySelector('[data-id="offsetsPropertyKey"]');
    if (!sel) return;
    sel.innerHTML = '<option value="">— none —</option>';
    for (const p of properties) {
      if (!p?.stateKey) continue;
      const opt       = document.createElement('option');
      opt.value       = p.stateKey;
      opt.textContent = p.name || p.stateKey;
      if (p.stateKey === selectedKey) opt.selected = true;
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

/**
 * Build the <option>/<optgroup> markup for a holding's Rate Key select.
 * Blank first (leave unset), then the known keys grouped by category. An
 * out-of-enum current value (custom/legacy) is preserved as a selected option so
 * editing a holding never silently drops it.
 *
 * @param {string} selected - the holding's current rateKey ('' when unset)
 * @returns {string} inner HTML for the <select>
 */
function _rateKeyOptionsHtml(selected) {
  const cur   = selected ?? '';
  const blank = `<option value=""${cur === '' ? ' selected' : ''}>— none —</option>`;
  const groups = RATE_KEY_GROUPS.map(g => {
    const opts = g.keys.map(k =>
      `<option value="${_escape(k)}"${k === cur ? ' selected' : ''}>${_escape(k)}</option>`
    ).join('');
    return `<optgroup label="${_escape(g.label)}">${opts}</optgroup>`;
  }).join('');
  // Preserve an unrecognized current value (never drop what the user had).
  const custom = (cur !== '' && !KNOWN_RATE_KEYS.has(cur))
    ? `<optgroup label="Custom"><option value="${_escape(cur)}" selected>${_escape(cur)}</option></optgroup>`
    : '';
  return blank + groups + custom;
}
