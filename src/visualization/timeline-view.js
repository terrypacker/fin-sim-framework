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

export class TimelineView {
  constructor({ container, onDetail, eventColors = new Map(), formatDate }) {
    this.container   = container;
    this.onDetail    = onDetail;
    this.eventColors = eventColors;
    this.formatDate  = formatDate ?? (d => d.toDateString());
    this.journal     = null;
    this.expanded    = new Set(); // 'dateStr' or 'dateStr::eventType'
    this._lastLen    = 0;
    this._lastDate   = null;     // date string of last entry seen, for auto-expand
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

  _groups() {
    const map = new Map(); // dateStr → Map(eventType → [{entry, idx}])
    this.journal.journal.forEach((entry, idx) => {
      const d = this.formatDate(entry.date);
      if (!map.has(d)) map.set(d, new Map());
      const byEv = map.get(d);
      if (!byEv.has(entry.eventType)) byEv.set(entry.eventType, []);
      byEv.get(entry.eventType).push({ entry, idx });
    });
    return map;
  }

  _render() {
    if (!this.journal) return;

    const atBottom = this.container.scrollHeight - this.container.scrollTop
                     - this.container.clientHeight < 80;

    const groups = this._groups();

    if (groups.size === 0) {
      this.container.innerHTML =
        '<div class="tl-empty">Step the simulation forward to see the event timeline.</div>';
      return;
    }

    const html = [];

    for (const [dateStr, byEvent] of groups) {
      const dateOpen   = this.expanded.has(dateStr);
      const totalActs  = [...byEvent.values()].reduce((s, a) => s + a.length, 0);
      const evCount    = byEvent.size;

      html.push(`<div class="tl-date-group">
        <div class="tl-date-hdr" data-tgl="${dateStr}">
          <span class="tl-chev">${dateOpen ? '▼' : '▶'}</span>
          <span class="tl-date-str">${dateStr}</span>
          <span class="tl-badge">${evCount} event${evCount > 1 ? 's' : ''} · ${totalActs} actions</span>
        </div>`);

      if (dateOpen) {
        html.push('<div class="tl-evts">');
        const evList = [...byEvent.entries()];
        evList.forEach(([evType, items], ei) => {
          const lastEv  = ei === evList.length - 1;
          const evKey   = `${dateStr}::${evType}`;
          const evOpen  = this.expanded.has(evKey);

          const evColor = this.eventColors.get(evType);
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
                <span class="tl-act-reducer">${entry.reducer}</span>
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

    this.container.innerHTML = html.join('');

    // Toggle expand/collapse on date headers and event headers
    this.container.querySelectorAll('[data-tgl]').forEach(el => {
      el.addEventListener('click', () => {
        const k = el.dataset.tgl;
        this.expanded.has(k) ? this.expanded.delete(k) : this.expanded.add(k);
        this._render();
      });
    });

    // Detail buttons
    this.container.querySelectorAll('.tl-det').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        this.onDetail(this.journal.journal[+btn.dataset.idx]);
      });
    });

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
