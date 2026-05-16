/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import {BaseComponent} from "../components/base-component.js";

// Format a Date to YYYY-MM-DD for <input type="date"> value
function toDateInput(date) {
  if (!date) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export class TimelineView extends BaseComponent {
  constructor({ container }) {
    super();

    this.container    = container;
    this._listEl      = null;
    this._filterBarEl = null;
    this._treeMode    = false; // false = flat timeline, true = causal tree

    // Callbacks wired by presenter
    this.onFilterEvents    = null;
    this.onFilterActions   = null;
    this.onFilterDateStart = null;
    this.onFilterDateEnd   = null;
    this.onClearFilters    = null;
    this.onDownloadCsv     = null;
    this.onToggle          = null;
    this.onDetail          = null;
    this.onTaxDocument     = null;
    this.onRewind          = null;
    this.onNavigateToNode  = null; // (nodeId: string) => void
  }

  // @param {{ groups, causalGroups, filterEvents, filterActions, filterDateStart, filterDateEnd, expanded, hasRewind }}
  render({ groups, causalGroups, filterEvents, filterActions, filterDateStart, filterDateEnd, expanded, hasRewind }) {
    this._ensureStructure();
    this._syncFilters(filterEvents, filterActions, filterDateStart, filterDateEnd);
    if (this._treeMode) {
      this._renderList({ groups: causalGroups, expanded, filterEvents, filterActions, filterDateStart, filterDateEnd, hasRewind, treeMode: true });
    } else {
      this._renderList({ groups, expanded, filterEvents, filterActions, filterDateStart, filterDateEnd, hasRewind, treeMode: false });
    }
  }

  _ensureStructure() {
    if (this._listEl) return;
    this._filterBarEl = this._getTemplate('tpl-timeline-filter-bar');

    this._listEl = document.createElement('div');
    this._listEl.className = 'tl-list';

    this.container.innerHTML = '';
    this.container.appendChild(this._filterBarEl);
    this.container.appendChild(this._listEl);

    const startIn  = this._filterBarEl.querySelector(`#tl-date-start`);
    const endIn    = this._filterBarEl.querySelector(`#tl-date-end`);
    const clearBtn = this._filterBarEl.querySelector(`#tl-filter-clear`);

    startIn.addEventListener('change', () => this.onFilterDateStart?.(startIn.value));
    endIn.addEventListener('change',   () => this.onFilterDateEnd?.(endIn.value));
    clearBtn.addEventListener('click', () => this.onClearFilters?.());

    const csvBtn = this._filterBarEl.querySelector(`#tl-download-csv`);
    csvBtn.addEventListener('click', () => this.onDownloadCsv?.());

    // Tree/Timeline mode toggle
    const modeBtn = document.createElement('button');
    modeBtn.id        = 'tl-mode-toggle';
    modeBtn.className = 'btn btn-sm';
    modeBtn.title     = 'Switch between flat timeline and causal tree view';
    modeBtn.textContent = 'Tree';
    modeBtn.addEventListener('click', () => {
      this._treeMode = !this._treeMode;
      modeBtn.textContent = this._treeMode ? 'Timeline' : 'Tree';
      modeBtn.classList.toggle('btn-primary', this._treeMode);
      // Trigger a re-render via the toggle callback (null = mode change, not a group key)
      this.onToggle?.(null);
    });
    csvBtn.insertAdjacentElement('afterend', modeBtn);
  }

  _syncFilters(filterEvents, filterActions, filterDateStart, filterDateEnd) {
    const startIn  = this._filterBarEl.querySelector(`#tl-date-start`);
    const endIn    = this._filterBarEl.querySelector(`#tl-date-end`);
    const clearBtn = this._filterBarEl.querySelector(`#tl-filter-clear`);

    const startStr = toDateInput(filterDateStart);
    const endStr   = toDateInput(filterDateEnd);
    if (startIn.value !== startStr) startIn.value = startStr;
    if (endIn.value   !== endStr)   endIn.value   = endStr;

    const hasFilter = filterEvents.size > 0 || filterActions.size > 0 || filterDateStart || filterDateEnd;
    clearBtn.style.display = hasFilter ? '' : 'none';
  }

  _renderList({ groups, expanded, filterEvents, filterActions, filterDateStart, filterDateEnd, hasRewind, treeMode }) {
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
      const evList    = [...byEvent.entries()];

      // Count total items — in tree mode items are nodes, in flat mode they're {entry,idx,sum}
      const totalActs = treeMode
        ? evList.reduce((s, [, nodes]) => s + this._countNodes(nodes), 0)
        : evList.reduce((s, [, items]) => s + items.length, 0);
      const evCount   = byEvent.size;

      // Get the first date for the rewind button
      const firstEntry = treeMode
        ? evList[0]?.[1][0]?.entry
        : evList[0]?.[1][0]?.entry;
      const rewindBtn = hasRewind && firstEntry
        ? `<button class="tl-rewind" data-date="${firstEntry.date.getTime()}" title="Rewind to ${dateStr}">⏮</button>`
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
        evList.forEach(([evType, items], ei) => {
          const lastEv  = ei === evList.length - 1;
          const evKey   = `${dateStr}::${evType}`;
          const evOpen  = expanded.has(evKey);

          // Get event metadata from first item
          const firstItem   = treeMode ? items[0] : items[0];
          const firstEntry2 = treeMode ? firstItem?.entry : firstItem?.entry;
          const evColor     = firstEntry2?.event?.color ?? null;
          const evName      = firstEntry2?.event?.name ?? evType;
          const evNodeId    = firstEntry2?.event?.nodeId ?? null;
          const evTypeStyle = evColor ? ` style="color:${evColor}"` : '';
          const evCfgBtn    = evNodeId
            ? `<button class="tl-cfg-link" data-nodeid="${evNodeId}" title="Open in configuration">⚙</button>`
            : '';

          html.push(`<div class="tl-ev-row">
            <span class="tl-pipe">${lastEv ? '└' : '├'}</span>
            <div class="tl-ev-inner">
              <div class="tl-ev-hdr" data-tgl="${evKey}">
                <span class="tl-chev">${evOpen ? '▼' : '▶'}</span>
                <span class="tl-ev-type"${evTypeStyle}>${evName}</span>
                ${evCfgBtn}
                <span class="tl-badge">${treeMode ? this._countNodes(items) : items.length} action${(treeMode ? this._countNodes(items) : items.length) !== 1 ? 's' : ''}</span>
              </div>`);

          if (evOpen) {
            html.push('<div class="tl-acts">');
            if (treeMode) {
              html.push(...this._renderTreeNodes(items, 0));
            } else {
              items.forEach(({ entry, idx, sum }, ai) => {
                html.push(...this._renderFlatAction(entry, idx, sum, ai === items.length - 1));
              });
            }
            html.push('</div>'); // tl-acts
          }

          html.push('</div></div>'); // tl-ev-inner, tl-ev-row
        });
        html.push('</div>'); // tl-evts
      }

      html.push('</div>'); // tl-date-group
    }

    this._listEl.innerHTML = html.join('');
    this._wireListeners(hasRewind);

    if (atBottom) this.container.scrollTop = this.container.scrollHeight;
  }

  _renderFlatAction(entry, idx, sum, isLast) {
    const hasTaxDoc = entry.action.type === 'TAX_SETTLE_APPLY' &&
      (entry.action.data?.taxDetail != null || entry.action.data?.personTaxDetails?.length > 0);
    const cfgBtn = entry.action.nodeId
      ? `<button class="tl-cfg-link" data-nodeid="${entry.action.nodeId}" title="Open in configuration">⚙</button>`
      : '';
    return [`<div class="tl-act">
      <span class="tl-pipe" style="color:#1e3a5f">${isLast ? '└' : '├'}</span>
      <span class="tl-act-name">${entry.action.name}</span>
      ${sum ? `<span class="tl-act-val">${sum}</span>` : ''}
      <span class="tl-act-reducer">${entry.reducer.name}</span>
      ${cfgBtn}
      <button class="tl-det" data-idx="${idx}">detail ↗</button>
      ${hasTaxDoc ? `<button class="tl-taxdoc" data-idx="${idx}">Tax Doc ↗</button>` : ''}
    </div>`];
  }

  _renderTreeNodes(nodes, depth) {
    const html = [];
    nodes.forEach((node, i) => {
      const { entry } = node;
      const isLast    = i === nodes.length - 1;
      const indent    = depth * 16;
      const hasTaxDoc = entry.action.type === 'TAX_SETTLE_APPLY' &&
        (entry.action.data?.taxDetail != null || entry.action.data?.personTaxDetails?.length > 0);
      const cfgBtn = entry.action.nodeId
        ? `<button class="tl-cfg-link" data-nodeid="${entry.action.nodeId}" title="Open in configuration">⚙</button>`
        : '';
      const childBadge = node.children.length
        ? ` <span class="tl-badge">${node.children.length}</span>`
        : '';
      html.push(`<div class="tl-act tl-act--tree" style="padding-left:${indent}px">
        <span class="tl-pipe" style="color:#1e3a5f">${isLast ? '└' : '├'}</span>
        <span class="tl-act-name">${entry.action.name}</span>${childBadge}
        <span class="tl-act-reducer">${entry.reducer.name}</span>
        ${cfgBtn}
        <button class="tl-det" data-idx="${entry.seq}">detail ↗</button>
        ${hasTaxDoc ? `<button class="tl-taxdoc" data-idx="${entry.seq}">Tax Doc ↗</button>` : ''}
      </div>`);
      if (node.children.length) {
        html.push(...this._renderTreeNodes(node.children, depth + 1));
      }
    });
    return html;
  }

  _countNodes(nodes) {
    let count = 0;
    const stack = [...nodes];
    while (stack.length) {
      const n = stack.pop();
      count++;
      if (n.children?.length) stack.push(...n.children);
    }
    return count;
  }

  _wireListeners(hasRewind) {
    this._listEl.querySelectorAll('[data-tgl]').forEach(el => {
      el.addEventListener('click', e => {
        e.stopPropagation();
        this.onToggle?.(el.dataset.tgl);
      });
    });

    this._listEl.querySelectorAll('.tl-det').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        this.onDetail?.(+btn.dataset.idx);
      });
    });

    this._listEl.querySelectorAll('.tl-taxdoc').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        this.onTaxDocument?.(+btn.dataset.idx);
      });
    });

    this._listEl.querySelectorAll('.tl-cfg-link').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        this.onNavigateToNode?.(btn.dataset.nodeid);
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
  }
}
