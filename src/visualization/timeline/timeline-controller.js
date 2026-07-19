/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { primaryTaxSettleEntries } from '../../finance/tax/tax-settle-entries.js';

const COUNTRY_TO_CURRENCY = { AU: 'AUD', US: 'USD' };

function fmtNative(n, currency) {
  if (!currency) return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);
}

export class TimelineController {
  constructor() {
    this.journal         = null;
    this.schemaRegistry  = null;      // StateSchemaRegistry | null — for diff formatting in CSV
    this.filterEvents    = new Set(); // selected event types; empty = no filter
    this.filterActions   = new Set(); // selected action types; empty = no filter
    this.filterDateStart = null;      // Date (start of day, inclusive) | null
    this.filterDateEnd   = null;      // Date (end of day, inclusive)   | null
    this.expanded        = new Set();
    this._lastLen        = 0;
    this._lastDate       = null;

    // Display-currency conversion (design 10 §Phase 4). Injected by the presenter.
    this.currencyConverter = null;
    this.displaySettings   = null;
    this.rateStateProvider = null;
    this.typeRegistry      = null;
  }

  /**
   * Resolve an action-payload field's native currency code. The authoritative
   * source is the TypeRegistry's registered field type (e.g. `amount` →
   * ValueType.currency('AUD')); falls back to the action's country code
   * (`data.cc` or the registered entry `cc`). Returns null when unknown.
   */
  _nativeCode(action, fieldName) {
    const entry   = this.typeRegistry?.getAction?.(action?.type) ?? null;
    const fieldVt = entry?.fields?.[fieldName];
    if (fieldVt?.kind === 'currency' && fieldVt.opts?.code) return fieldVt.opts.code;
    const d  = action?.data ?? {};
    const cc = d.cc ?? entry?.cc ?? null;
    if (cc) return COUNTRY_TO_CURRENCY[cc] ?? cc;
    // Fall back to the currency of the account the action operates on. Covers
    // amounts typed ValueType.number() (e.g. EXPENSE_DEBIT) that still target a
    // known account whose balance currency is registered.
    const acctKey = d.targetKey ?? d.destinationKey ?? d.stateKey ?? null;
    if (acctKey && this.schemaRegistry) {
      const code = this.schemaRegistry.resolve(`${acctKey}.balance`)?.currencyCode;
      if (code) return code;
    }
    return null;
  }

  /**
   * Format an action-payload amount given its native currency code, converting
   * to the active display currency when one is set and a rate is available
   * (design 10 §Phase 4). Falls back to the native currency when there is no
   * display preference, no converter, or no recorded rate.
   */
  _fmtCurrency(n, native) {
    const display = this.displaySettings?.displayCurrency;
    if (native && display && display !== native && this.currencyConverter) {
      const state     = this.rateStateProvider?.() ?? null;
      const converted = this.currencyConverter.convert(n, native, display, state);
      if (converted != null) return fmtNative(converted, display);
    }
    return fmtNative(n, native);
  }

  setJournal(journal) {
    this.journal   = journal;
    this._lastLen  = 0;
    this._lastDate = null;
    this.expanded.clear();
  }

  reset() {
    this._lastLen  = 0;
    this._lastDate = null;
    this.expanded.clear();
  }

  update(_formatDate) {
    if (!this.journal) return false;
    const len = this.journal.journal.length;
    if (len === this._lastLen) return false;
    this._lastLen = len;
    return true;
  }

  dateBounds() {
    const journal = this.journal?.journal;
    if (!journal?.length) return { min: null, max: null };
    let min = journal[0].date;
    let max = journal[0].date;
    for (const entry of journal) {
      if (entry.date < min) min = entry.date;
      if (entry.date > max) max = entry.date;
    }
    return { min, max };
  }

  allOptions() {
    const events  = new Map();
    const actions = new Map();
    if (this.journal) {
      for (const entry of this.journal.journal) {
        if (!events.has(entry.event.type)) {
          events.set(entry.event.type, {
            id:   entry.event.type,
            name: entry.event.type,  // filter set uses name; keep as type for compat
          });
        }
        if (!actions.has(entry.action.type)) {
          actions.set(entry.action.type, {
            id:   entry.action.type,
            name: entry.action.type, // filter set uses name; keep as type for compat
          });
        }
      }
    }
    return {
      events:  [...events.values()].sort((a, b) => a.name.localeCompare(b.name)),
      actions: [...actions.values()].sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  _passesFilter(entry) {
    if (this.filterEvents.size  > 0 && !this.filterEvents.has(entry.event.type))   return false;
    if (this.filterActions.size > 0 && !this.filterActions.has(entry.action.type)) return false;
    if (this.filterDateStart && entry.date < this.filterDateStart) return false;
    if (this.filterDateEnd   && entry.date > this.filterDateEnd)   return false;
    return true;
  }

  /**
   * The journal entries that should offer a "Tax Doc ↗" link — one per settlement,
   * never one per reducer. Computed once per render rather than re-derived per row.
   * See `tax-settle-entries.js` for why the first entry of a fan-out is the one that
   * carries working drill-down links.
   */
  _primaryTaxSettles() {
    return primaryTaxSettleEntries(this.journal?.journal ?? []);
  }

  // Returns Map<dateStr, Map<evType, Array<{entry, idx, sum, taxDoc}>>>
  groups(formatDate) {
    const map = new Map();
    if (!this.journal) return map;
    const taxDocs = this._primaryTaxSettles();
    this.journal.journal.forEach((entry, idx) => {
      if (!this._passesFilter(entry)) return;
      const d = formatDate(entry.date);
      if (!map.has(d)) map.set(d, new Map());
      const byEv = map.get(d);
      if (!byEv.has(entry.event.type)) byEv.set(entry.event.type, []);
      byEv.get(entry.event.type).push({
        entry, idx, sum: this.sum(entry.action), taxDoc: taxDocs.has(entry),
      });
    });
    return map;
  }

  /**
   * Returns Map<dateStr, Map<evType, rootNode[]>>
   * where rootNode = { entry, children: rootNode[] }
   * Children are sorted by siblingIndex (temporal order among siblings).
   * parentId is the causal parent — siblings share the same parentId.
   */
  causalGroups(formatDate) {
    if (!this.journal) return new Map();

    const byId  = new Map(); // instanceId → { entry, children: [] }
    const roots = new Map(); // dateStr → Map<evType, node[]>
    const taxDocs = this._primaryTaxSettles();

    for (const entry of this.journal.journal) {
      if (!this._passesFilter(entry)) continue;
      // One action journaled by N reducers collapses to ONE tree node. Keep the
      // FIRST entry rather than letting the last overwrite it: for a tax settle the
      // second entry ("Accumulate Taxes Paid") carries a degenerate drill-down
      // period, so the node would offer a Tax Doc link with broken drill-downs.
      if (byId.has(entry.action.instanceId)) continue;
      byId.set(entry.action.instanceId, {
        entry, children: [], taxDoc: taxDocs.has(entry),
      });
    }

    for (const [, node] of byId) {
      const { entry } = node;
      const parentNode = entry.action.parentId ? byId.get(entry.action.parentId) : null;
      if (parentNode) {
        parentNode.children.push(node);
      } else {
        const d = formatDate(entry.date);
        if (!roots.has(d)) roots.set(d, new Map());
        const byEv = roots.get(d);
        if (!byEv.has(entry.event.type)) byEv.set(entry.event.type, []);
        byEv.get(entry.event.type).push(node);
      }
    }

    // Sort children by siblingIndex within each parent
    for (const [, node] of byId) {
      node.children.sort((a, b) => a.entry.action.siblingIndex - b.entry.action.siblingIndex);
    }

    return roots;
  }

  sum(action) {
    const d  = action.data ?? {};
    const parts = [];
    if (d.amount     != null) parts.push(this._fmtCurrency(d.amount, this._nativeCode(action, 'amount')));
    if (d.tax        != null) parts.push('tax ' + this._fmtCurrency(d.tax, this._nativeCode(action, 'tax')));
    if (d.isLongTerm != null) parts.push(d.isLongTerm ? 'LT' : 'ST');
    if (d.value      != null && typeof d.value === 'number') parts.push(this._fmtCurrency(d.value, this._nativeCode(action, 'value')));
    if (d.value      != null && typeof d.value === 'string') parts.push('"' + d.value + '"');
    return parts.join(' · ');
  }

  toggleExpanded(key) {
    this.expanded.has(key) ? this.expanded.delete(key) : this.expanded.add(key);
  }

  generateCsv(formatDate) {
    const groups = this.groups(formatDate);
    const rows = [];
    for (const byEvent of groups.values()) {
      for (const items of byEvent.values()) {
        for (const { entry } of items) {
          rows.push(this._flattenEntry(entry, formatDate));
        }
      }
    }
    if (rows.length === 0) return '';

    const colMap = new Map();
    for (const row of rows) {
      for (const k of Object.keys(row)) {
        if (!colMap.has(k)) colMap.set(k, true);
      }
    }
    const cols = [...colMap.keys()];

    const esc = v => {
      if (v == null) return '';
      const s = String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    return [
      cols.join(','),
      ...rows.map(row => cols.map(c => esc(row[c])).join(',')),
    ].join('\n');
  }

  _flattenEntry(entry, formatDate) {
    const row = {
      date:           formatDate(entry.date),
      seq:            entry.seq,
      executionId:    entry.executionId ?? '',
      eventType:      entry.event.type,
      eventName:      entry.event.name,
      actionType:     entry.action.type,
      actionName:     entry.action.name,
      actionInstance: entry.action.instanceId,
      parentInstance: entry.action.parentId     ?? '',
      siblingIndex:   entry.action.siblingIndex,
      reducerName:    entry.reducer.name,
    };
    const data = entry.action.data ?? {};
    for (const [k, v] of Object.entries(data)) {
      if (v === null || typeof v !== 'object') {
        row[`action.data.${k}`] = v;
      } else {
        try {
          row[`action.data.${k}`] = JSON.stringify(v);
        } catch {
          row[`action.data.${k}`] = '[circular]';
        }
      }
    }
    if (entry.stateDiff) {
      for (let i = 0; i < entry.stateDiff.length; i++) {
        const d    = entry.stateDiff[i];
        const fmtD = v => this.schemaRegistry ? (this.schemaRegistry.format(d.field, v) ?? v) : v;
        row[`diff[${i}].field`]  = d.field;
        row[`diff[${i}].before`] = fmtD(d.before);
        row[`diff[${i}].after`]  = fmtD(d.after);
        if (d.delta != null) row[`diff[${i}].delta`] = fmtD(d.delta);
      }
    }
    return row;
  }
}
