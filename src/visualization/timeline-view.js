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

let _tlViewCounter = 0;

export class TimelineView {
  constructor({ container, onDetail, onRewind, formatDate }) {
    this.container  = container;
    this.onDetail   = onDetail;
    this.onRewind   = onRewind ?? null;
    this.formatDate = formatDate ?? (d => d.toDateString());
    this.journal     = null;
    this.expanded    = new Set(); // 'dateStr' or 'dateStr::eventType'
    this._lastLen    = 0;
    this._lastDate   = null;     // date string of last entry seen, for auto-expand
    this.filterEvent  = '';
    this.filterAction = '';
    this._listEl      = null;
    this._filterBarEl = null;
    this._uid         = ++_tlViewCounter;
  }

  attach(journal) {
    this.journal   = journal;
    this._lastLen  = 0;
    this._lastDate = null;
    this.expanded.clear();
    this._render();
  }

  reset() {
    this._lastLen  = 0;
    this._lastDate = null;
    this.expanded.clear();
    this._render();
  }

  update() {
    if (!this.journal) return;
    const len = this.journal.journal.length;
    if (len === this._lastLen) return;
    this._lastLen = len;

    // Auto-expand the latest date group so new activity is always visible
    if (len > 0) {
      const latest  = this.journal.journal[len - 1];
      const dateStr = this.formatDate(latest.date);
      if (dateStr !== this._lastDate) {
        this._lastDate = dateStr;
        this.expanded.add(dateStr);
      }
    }

    this._render();
  }

  // Collect all unique event types and action types from the full (unfiltered) journal
  _allOptions() {
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

  _groups() {
    const evFilter  = this.filterEvent.trim().toLowerCase();
    const actFilter = this.filterAction.trim().toLowerCase();

    const map = new Map(); // dateStr → Map(eventType → [{entry, idx}])
    this.journal.journal.forEach((entry, idx) => {
      // Apply event-type filter
      if (evFilter && !entry.eventType.toLowerCase().includes(evFilter)) return;
      // Apply action-type filter
      if (actFilter && !entry.action.type.toLowerCase().includes(actFilter)) return;

      const d = this.formatDate(entry.date);
      if (!map.has(d)) map.set(d, new Map());
      const byEv = map.get(d);
      if (!byEv.has(entry.eventType)) byEv.set(entry.eventType, []);
      byEv.get(entry.eventType).push({ entry, idx });
    });
    return map;
  }

  _ensureStructure() {
    if (this._listEl) return;

    const uid = this._uid;
    this._filterBarEl = document.createElement('div');
    this._filterBarEl.className = 'tl-filter-bar';
    this._filterBarEl.innerHTML = `
      <div class="tl-filter-group">
        <input class="tl-filter-input" id="tl-ev-input-${uid}" placeholder="Filter by Event…"
               list="tl-ev-opts-${uid}" autocomplete="off" value="${this.filterEvent}">
        <datalist id="tl-ev-opts-${uid}"></datalist>
      </div>
      <div class="tl-filter-group">
        <input class="tl-filter-input" id="tl-act-input-${uid}" placeholder="Filter by Action…"
               list="tl-act-opts-${uid}" autocomplete="off" value="${this.filterAction}">
        <datalist id="tl-act-opts-${uid}"></datalist>
      </div>
      <button class="tl-filter-clear" id="tl-filter-clear-${uid}" title="Clear filters">✕</button>
    `;

    this._listEl = document.createElement('div');
    this._listEl.className = 'tl-list';

    this.container.innerHTML = '';
    this.container.appendChild(this._filterBarEl);
    this.container.appendChild(this._listEl);

    const evInput  = this._filterBarEl.querySelector(`#tl-ev-input-${uid}`);
    const actInput = this._filterBarEl.querySelector(`#tl-act-input-${uid}`);
    const clearBtn = this._filterBarEl.querySelector(`#tl-filter-clear-${uid}`);

    evInput.addEventListener('input', () => {
      this.filterEvent = evInput.value;
      this._renderList();
    });
    actInput.addEventListener('input', () => {
      this.filterAction = actInput.value;
      this._renderList();
    });
    clearBtn.addEventListener('click', () => {
      this.filterEvent  = '';
      this.filterAction = '';
      evInput.value  = '';
      actInput.value = '';
      this._renderList();
    });
  }

  _updateDataLists() {
    const uid = this._uid;
    const { events, actions } = this._allOptions();

    const evDl  = this._filterBarEl.querySelector(`#tl-ev-opts-${uid}`);
    const actDl = this._filterBarEl.querySelector(`#tl-act-opts-${uid}`);

    evDl.innerHTML  = events.map(v => `<option value="${v}">`).join('');
    actDl.innerHTML = actions.map(v => `<option value="${v}">`).join('');

    // Show/hide clear button based on active filters
    const clearBtn = this._filterBarEl.querySelector(`#tl-filter-clear-${uid}`);
    clearBtn.style.display = (this.filterEvent || this.filterAction) ? '' : 'none';
  }

  _render() {
    if (!this.journal) return;
    this._ensureStructure();
    this._updateDataLists();
    this._renderList();
  }

  _renderList() {
    if (!this._listEl) return;

    const atBottom = this.container.scrollHeight - this.container.scrollTop
                     - this.container.clientHeight < 80;

    const groups = this._groups();

    if (!this.journal || groups.size === 0) {
      const hasFilter = this.filterEvent || this.filterAction;
      this._listEl.innerHTML = `<div class="tl-empty">${
        hasFilter
          ? 'No entries match the current filters.'
          : 'Step the simulation forward to see the event timeline.'
      }</div>`;
      return;
    }

    const html = [];

    for (const [dateStr, byEvent] of groups) {
      const dateOpen   = this.expanded.has(dateStr);
      const totalActs  = [...byEvent.values()].reduce((s, a) => s + a.length, 0);
      const evCount    = byEvent.size;
      const firstDate  = [...byEvent.values()][0][0].entry.date;
      const rewindBtn  = this.onRewind
        ? `<button class="tl-rewind" data-date="${firstDate.getTime()}" title="Rewind to ${dateStr}">⏮</button>`
        : '';

      html.push(`<div class="tl-date-group">
        <div class="tl-date-hdr" data-tgl="${dateStr}">
          <span class="tl-chev">${dateOpen ? '▼' : '▶'}</span>
          <span class="tl-date-str">${dateStr}</span>
          <span class="tl-badge">${evCount} event${evCount > 1 ? 's' : ''} · ${totalActs} actions</span>
          ${rewindBtn}
        </div>`);

      if (dateOpen) {
        html.push('<div class="tl-evts">');
        const evList = [...byEvent.entries()];
        evList.forEach(([evType, items], ei) => {
          const lastEv  = ei === evList.length - 1;
          const evKey   = `${dateStr}::${evType}`;
          const evOpen  = this.expanded.has(evKey);

          const evColor = items[0]?.entry?.sourceEvent?.color;
          const evTypeStyle = evColor ? ` style="color:${evColor}"` : '';
          html.push(`<div class="tl-ev-row">
            <span class="tl-pipe">${lastEv ? '└' : '├'}</span>
            <div class="tl-ev-inner">
              <div class="tl-ev-hdr" data-tgl="${evKey}">
                <span class="tl-chev">${evOpen ? '▼' : '▶'}</span>
                <span class="tl-ev-type"${evTypeStyle}>${evType}</span>
                <span class="tl-badge">${items.length} action${items.length !== 1 ? 's' : ''}</span>
              </div>`);

          if (evOpen) {
            html.push('<div class="tl-acts">');
            items.forEach(({ entry, idx }, ai) => {
              const lastA = ai === items.length - 1;
              const sum   = this._sum(entry.action);
              html.push(`<div class="tl-act">
                <span class="tl-pipe" style="color:#1e3a5f">${lastA ? '└' : '├'}</span>
                <span class="tl-act-type">${entry.action.type}</span>
                ${sum ? `<span class="tl-act-val">${sum}</span>` : ''}
                <span class="tl-act-reducer">${entry.reducer.name}</span>
                <button class="tl-det" data-idx="${idx}">detail ↗</button>
              </div>`);
            });
            html.push('</div>'); // tl-acts
          }

          html.push('</div></div>'); // tl-ev-inner, tl-ev-row
        });
        html.push('</div>'); // tl-evts
      }

      html.push('</div>'); // tl-date-group
    }

    this._listEl.innerHTML = html.join('');

    // Toggle expand/collapse on date headers and event headers
    this._listEl.querySelectorAll('[data-tgl]').forEach(el => {
      el.addEventListener('click', () => {
        const k = el.dataset.tgl;
        this.expanded.has(k) ? this.expanded.delete(k) : this.expanded.add(k);
        this._renderList();
      });
    });

    // Detail buttons
    this._listEl.querySelectorAll('.tl-det').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        this.onDetail(this.journal.journal[+btn.dataset.idx]);
      });
    });

    // Rewind buttons
    if (this.onRewind) {
      this._listEl.querySelectorAll('.tl-rewind').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          this.onRewind(new Date(+btn.dataset.date));
        });
      });
    }

    // Keep scroll near the bottom as new events arrive
    if (atBottom) this.container.scrollTop = this.container.scrollHeight;
  }

  // One-line summary of an action's key values
  _sum(action) {
    const parts = [];
    if (action.amount      != null) parts.push(fmt(action.amount));
    if (action.tax         != null) parts.push('tax ' + fmt(action.tax));
    if (action.isLongTerm  != null) parts.push(action.isLongTerm ? 'LT' : 'ST');
    if (action.name        != null) parts.push(action.name);
    if (action.value       != null && typeof action.value === 'number') parts.push(fmt(action.value));
    if (action.value       != null && typeof action.value === 'string') parts.push('"' + action.value + '"');
    return parts.join(' · ');
  }
}
