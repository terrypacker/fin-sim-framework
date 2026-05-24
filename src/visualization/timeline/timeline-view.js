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

export class TimelineView {
  constructor({ container }) {
    this.container    = container;
    this._listEl      = null;
    this._filterBarEl = null;
    this._uid         = ++_tlViewCounter;
    // Callbacks wired by presenter
    this.onFilterEvent  = null;
    this.onFilterAction = null;
    this.onClearFilters = null;
    this.onToggle       = null;
    this.onDetail       = null;
    this.onRewind       = null;
  }

  // @param {{ groups, options, filterEvent, filterAction, expanded, hasRewind }}
  render({ groups, options, filterEvent, filterAction, expanded, hasRewind }) {
    this._ensureStructure(filterEvent, filterAction);
    this._updateDataLists(options, filterEvent, filterAction);
    this._renderList({ groups, expanded, filterEvent, filterAction, hasRewind });
  }

  _ensureStructure(filterEvent = '', filterAction = '') {
    if (this._listEl) return;
    const uid = this._uid;
    this._filterBarEl = document.createElement('div');
    this._filterBarEl.className = 'tl-filter-bar';
    this._filterBarEl.innerHTML = `
      <div class="tl-filter-group">
        <input class="tl-filter-input" id="tl-ev-input-${uid}" placeholder="Filter by Event…"
               list="tl-ev-opts-${uid}" autocomplete="off" value="${filterEvent}">
        <datalist id="tl-ev-opts-${uid}"></datalist>
      </div>
      <div class="tl-filter-group">
        <input class="tl-filter-input" id="tl-act-input-${uid}" placeholder="Filter by Action…"
               list="tl-act-opts-${uid}" autocomplete="off" value="${filterAction}">
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

    evInput.addEventListener('input',  () => this.onFilterEvent?.(evInput.value));
    actInput.addEventListener('input', () => this.onFilterAction?.(actInput.value));
    clearBtn.addEventListener('click', () => {
      evInput.value  = '';
      actInput.value = '';
      this.onClearFilters?.();
    });
  }

  _updateDataLists(options, filterEvent, filterAction) {
    const uid = this._uid;
    const evDl  = this._filterBarEl.querySelector(`#tl-ev-opts-${uid}`);
    const actDl = this._filterBarEl.querySelector(`#tl-act-opts-${uid}`);
    evDl.innerHTML  = options.events.map(v  => `<option value="${v}">`).join('');
    actDl.innerHTML = options.actions.map(v => `<option value="${v}">`).join('');
    const clearBtn = this._filterBarEl.querySelector(`#tl-filter-clear-${uid}`);
    clearBtn.style.display = (filterEvent || filterAction) ? '' : 'none';
  }

  _renderList({ groups, expanded, filterEvent, filterAction, hasRewind }) {
    if (!this._listEl) return;

    const atBottom = this.container.scrollHeight - this.container.scrollTop
                     - this.container.clientHeight < 80;

    if (groups.size === 0) {
      const hasFilter = filterEvent || filterAction;
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
