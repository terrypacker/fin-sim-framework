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

  // Returns true if new entries arrived; auto-expands the latest date group.
  update(formatDate) {
    if (!this.journal) return false;
    const len = this.journal.journal.length;
    if (len === this._lastLen) return false;
    this._lastLen = len;

    if (len > 0) {
      const latest  = this.journal.journal[len - 1];
      const dateStr = formatDate(latest.date);
      if (dateStr !== this._lastDate) {
        this._lastDate = dateStr;
        this.expanded.add(dateStr);
      }
    }
    return true;
  }

  allOptions() {
    const events  = new Set();
    const actions = new Set();
    if (this.journal) {
      for (const entry of this.journal.journal) {
        events.add(entry.eventType);
        actions.add(entry.action.type);
      }
    }
    return { events: [...events].sort(), actions: [...actions].sort() };
  }

  // Returns Map<dateStr, Map<evType, Array<{entry, idx, sum}>>>
  groups(formatDate) {
    const map = new Map();
    if (!this.journal) return map;
    this.journal.journal.forEach((entry, idx) => {
      if (this.filterEvents.size  > 0 && !this.filterEvents.has(entry.eventType))    return;
      if (this.filterActions.size > 0 && !this.filterActions.has(entry.action.type)) return;
      if (this.filterDateStart && entry.date < this.filterDateStart) return;
      if (this.filterDateEnd   && entry.date > this.filterDateEnd)   return;
      const d = formatDate(entry.date);
      if (!map.has(d)) map.set(d, new Map());
      const byEv = map.get(d);
      if (!byEv.has(entry.eventType)) byEv.set(entry.eventType, []);
      byEv.get(entry.eventType).push({ entry, idx, sum: this.sum(entry.action) });
    });
    return map;
  }

  sum(action) {
    const parts = [];
    if (action.amount     != null) parts.push(fmt(action.amount));
    if (action.tax        != null) parts.push('tax ' + fmt(action.tax));
    if (action.isLongTerm != null) parts.push(action.isLongTerm ? 'LT' : 'ST');
    if (action.name       != null) parts.push(action.name);
    if (action.value      != null && typeof action.value === 'number') parts.push(fmt(action.value));
    if (action.value      != null && typeof action.value === 'string') parts.push('"' + action.value + '"');
    return parts.join(' · ');
  }

  toggleExpanded(key) {
    this.expanded.has(key) ? this.expanded.delete(key) : this.expanded.add(key);
  }
}
