/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

const fmt = n => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export class TimelineController {
  constructor() {
    this.journal         = null;
    this.filterEvents    = new Set(); // selected event types; empty = no filter
    this.filterActions   = new Set(); // selected action types; empty = no filter
    this.filterDateStart = null;      // Date (start of day, inclusive) | null
    this.filterDateEnd   = null;      // Date (end of day, inclusive)   | null
    this.expanded        = new Set();
    this._lastLen        = 0;
    this._lastDate       = null;
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

  // Returns Map<dateStr, Map<evType, Array<{entry, idx, sum}>>>
  groups(formatDate) {
    const map = new Map();
    if (!this.journal) return map;
    this.journal.journal.forEach((entry, idx) => {
      if (!this._passesFilter(entry)) return;
      const d = formatDate(entry.date);
      if (!map.has(d)) map.set(d, new Map());
      const byEv = map.get(d);
      if (!byEv.has(entry.event.type)) byEv.set(entry.event.type, []);
      byEv.get(entry.event.type).push({ entry, idx, sum: this.sum(entry.action) });
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

    for (const entry of this.journal.journal) {
      if (!this._passesFilter(entry)) continue;
      byId.set(entry.action.instanceId, { entry, children: [] });
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
    const d = action.data ?? {};
    const parts = [];
    if (d.amount     != null) parts.push(fmt(d.amount));
    if (d.tax        != null) parts.push('tax ' + fmt(d.tax));
    if (d.isLongTerm != null) parts.push(d.isLongTerm ? 'LT' : 'ST');
    if (d.value      != null && typeof d.value === 'number') parts.push(fmt(d.value));
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
        const d = entry.stateDiff[i];
        row[`diff[${i}].field`]  = d.field;
        row[`diff[${i}].before`] = d.before;
        row[`diff[${i}].after`]  = d.after;
        if (d.delta != null) row[`diff[${i}].delta`] = d.delta;
      }
    }
    return row;
  }
}
