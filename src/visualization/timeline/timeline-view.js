/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

let _tlViewCounter = 0;

// Format a Date to YYYY-MM-DD for <input type="date"> value
function toDateInput(date) {
  if (!date) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export class TimelineView {
  constructor({ container }) {
    this.container    = container;
    this._listEl      = null;
    this._filterBarEl = null;
    this._uid         = ++_tlViewCounter;
    // Callbacks wired by presenter
    this.onFilterEvents    = null;
    this.onFilterActions   = null;
    this.onFilterDateStart = null;
    this.onFilterDateEnd   = null;
    this.onClearFilters    = null;
    this.onToggle          = null;
    this.onDetail          = null;
    this.onRewind          = null;
  }

  // @param {{ groups, options, filterEvents, filterActions, filterDateStart, filterDateEnd, expanded, hasRewind }}
  render({ groups, options, filterEvents, filterActions, filterDateStart, filterDateEnd, expanded, hasRewind }) {
    this._ensureStructure();
    this._syncFilters(options, filterEvents, filterActions, filterDateStart, filterDateEnd);
    this._renderList({ groups, expanded, filterEvents, filterActions, filterDateStart, filterDateEnd, hasRewind });
  }

  _ensureStructure() {
    if (this._listEl) return;
    const uid = this._uid;
    this._filterBarEl = document.createElement('div');
    this._filterBarEl.className = 'tl-filter-bar';
    this._filterBarEl.innerHTML = `
      <div class="tl-filter-group">
        <label class="tl-filter-label" for="tl-ev-select-${uid}">Event</label>
        <select class="tl-filter-select" id="tl-ev-select-${uid}" multiple></select>
      </div>
      <div class="tl-filter-group">
        <label class="tl-filter-label" for="tl-act-select-${uid}">Action</label>
        <select class="tl-filter-select" id="tl-act-select-${uid}" multiple></select>
      </div>
      <div class="tl-filter-group">
        <label class="tl-filter-label" for="tl-date-start-${uid}">From</label>
        <input class="tl-filter-date" type="date" id="tl-date-start-${uid}">
      </div>
      <div class="tl-filter-group">
        <label class="tl-filter-label" for="tl-date-end-${uid}">To</label>
        <input class="tl-filter-date" type="date" id="tl-date-end-${uid}">
      </div>
      <button class="tl-filter-clear" id="tl-filter-clear-${uid}" title="Clear all filters">✕</button>
    `;
    this._listEl = document.createElement('div');
    this._listEl.className = 'tl-list';

    this.container.innerHTML = '';
    this.container.appendChild(this._filterBarEl);
    this.container.appendChild(this._listEl);

    const evSel    = this._filterBarEl.querySelector(`#tl-ev-select-${uid}`);
    const actSel   = this._filterBarEl.querySelector(`#tl-act-select-${uid}`);
    const startIn  = this._filterBarEl.querySelector(`#tl-date-start-${uid}`);
    const endIn    = this._filterBarEl.querySelector(`#tl-date-end-${uid}`);
    const clearBtn = this._filterBarEl.querySelector(`#tl-filter-clear-${uid}`);

    evSel.addEventListener('change', () => {
      this.onFilterEvents?.(new Set([...evSel.selectedOptions].map(o => o.value)));
    });
    actSel.addEventListener('change', () => {
      this.onFilterActions?.(new Set([...actSel.selectedOptions].map(o => o.value)));
    });
    startIn.addEventListener('change', () => this.onFilterDateStart?.(startIn.value));
    endIn.addEventListener('change',   () => this.onFilterDateEnd?.(endIn.value));
    clearBtn.addEventListener('click', () => this.onClearFilters?.());
  }

  _syncFilters(options, filterEvents, filterActions, filterDateStart, filterDateEnd) {
    const uid = this._uid;
    const evSel    = this._filterBarEl.querySelector(`#tl-ev-select-${uid}`);
    const actSel   = this._filterBarEl.querySelector(`#tl-act-select-${uid}`);
    const startIn  = this._filterBarEl.querySelector(`#tl-date-start-${uid}`);
    const endIn    = this._filterBarEl.querySelector(`#tl-date-end-${uid}`);
    const clearBtn = this._filterBarEl.querySelector(`#tl-filter-clear-${uid}`);

    // Repopulate options, restoring current selections from controller state
    evSel.innerHTML  = options.events.map(v =>
      `<option value="${v}"${filterEvents.has(v)  ? ' selected' : ''}>${v}</option>`).join('');
    actSel.innerHTML = options.actions.map(v =>
      `<option value="${v}"${filterActions.has(v) ? ' selected' : ''}>${v}</option>`).join('');

    const startStr = toDateInput(filterDateStart);
    const endStr   = toDateInput(filterDateEnd);
    if (startIn.value !== startStr) startIn.value = startStr;
    if (endIn.value   !== endStr)   endIn.value   = endStr;

    const hasFilter = filterEvents.size > 0 || filterActions.size > 0 || filterDateStart || filterDateEnd;
    clearBtn.style.display = hasFilter ? '' : 'none';
  }

  _renderList({ groups, expanded, filterEvents, filterActions, filterDateStart, filterDateEnd, hasRewind }) {
    if (!this._listEl) return;

    const atBottom = this.container.scrollHeight - this.container.scrollTop
                     - this.container.clientHeight < 80;

    if (groups.size === 0) {
      const hasFilter = filterEvents.size > 0 || filterActions.size > 0 || filterDateStart || filterDateEnd;
      this._listEl.innerHTML = `<div class="tl-empty">${
        hasFilter
          ? 'No entries match the current filters.'
          : 'Step the simulation forward to see the event timeline.'
      }</div>`;
      return;
    }

    const html = [];

    for (const [dateStr, byEvent] of groups) {
      const dateOpen  = expanded.has(dateStr);
      const totalActs = [...byEvent.values()].reduce((s, a) => s + a.length, 0);
      const evCount   = byEvent.size;
      const firstDate = [...byEvent.values()][0][0].entry.date;
      const rewindBtn = hasRewind
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
          const evOpen  = expanded.has(evKey);

          const evColor     = items[0]?.entry?.sourceEvent?.color;
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
            items.forEach(({ entry, idx, sum }, ai) => {
              const lastA = ai === items.length - 1;
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

    this._listEl.querySelectorAll('[data-tgl]').forEach(el => {
      el.addEventListener('click', () => this.onToggle?.(el.dataset.tgl));
    });

    this._listEl.querySelectorAll('.tl-det').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        this.onDetail?.(+btn.dataset.idx);
      });
    });

    if (hasRewind) {
      this._listEl.querySelectorAll('.tl-rewind').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          this.onRewind?.(+btn.dataset.date);
        });
      });
    }

    if (atBottom) this.container.scrollTop = this.container.scrollHeight;
  }
}
