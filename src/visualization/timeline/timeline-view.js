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

// Estimated heights per item type (px) — used for virtual scroll offset calculation.
const VH = { DATE: 36, EV: 32, ACT: 28 };

// Number of extra date groups to render above and below the visible window.
const OVERSCAN = 3;

function _estimateGroupHeightExact(dateStr, byEvent, expanded, treeMode, countNodes) {
  let h = VH.DATE;
  if (!expanded.has(dateStr)) return h;
  for (const [evType, items] of byEvent) {
    h += VH.EV;
    const evKey = `${dateStr}::${evType}`;
    if (expanded.has(evKey)) {
      const n = treeMode ? countNodes(items) : items.length;
      h += n * VH.ACT;
    }
  }
  return h;
}

export class TimelineView extends BaseComponent {
  constructor({ container }) {
    super();

    this.container    = container;
    this._listEl      = null;
    this._filterBarEl = null;
    this._treeMode    = false; // false = flat timeline, true = causal tree

    // Virtual scroll state
    this._virtualGroups  = [];  // [{ dateStr, byEvent }]
    this._virtualParams  = null;
    this._scrollBound    = false;

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

    const atBottom = this._listEl.scrollHeight - this._listEl.scrollTop
                     - this._listEl.clientHeight < 80;

    if (groups.size === 0) {
      const hasFilter = filterEvents.size > 0 || filterActions.size > 0 || filterDateStart || filterDateEnd;
      this._listEl.style.paddingTop    = '';
      this._listEl.style.paddingBottom = '';
      this._listEl.innerHTML = `<div class="tl-empty">${
        hasFilter
          ? 'No entries match the current filters.'
          : 'Step the simulation forward to see the event timeline.'
      }</div>`;
      return;
    }

    // Build flat virtual groups list
    this._virtualGroups = [];
    for (const [dateStr, byEvent] of groups) {
      this._virtualGroups.push({ dateStr, byEvent });
    }
    this._virtualParams = { expanded, hasRewind, treeMode };

    // Attach passive scroll listener once
    if (!this._scrollBound) {
      this._scrollBound = true;
      this._listEl.addEventListener('scroll', () => this._virtualRender(), { passive: true });
    }

    this._virtualRender();

    if (atBottom) this._listEl.scrollTop = this._listEl.scrollHeight;
  }

  _virtualRender() {
    if (!this._listEl || !this._virtualGroups.length || !this._virtualParams) return;

    const { expanded, hasRewind, treeMode } = this._virtualParams;
    const groups = this._virtualGroups;
    const scrollTop     = this._listEl.scrollTop;
    const viewportH     = this._listEl.clientHeight || 400;

    // Compute per-group estimated heights and cumulative offsets
    const heights = groups.map(({ dateStr, byEvent }) =>
      _estimateGroupHeightExact(dateStr, byEvent, expanded, treeMode, this._countNodes.bind(this))
    );
    const offsets = new Array(groups.length + 1);
    offsets[0] = 0;
    for (let i = 0; i < groups.length; i++) offsets[i + 1] = offsets[i] + heights[i];
    const totalH = offsets[groups.length];

    // Find visible range with overscan
    let startIdx = 0;
    while (startIdx < groups.length && offsets[startIdx + 1] < scrollTop) startIdx++;
    startIdx = Math.max(0, startIdx - OVERSCAN);

    let endIdx = startIdx;
    while (endIdx < groups.length && offsets[endIdx] < scrollTop + viewportH) endIdx++;
    endIdx = Math.min(groups.length - 1, endIdx + OVERSCAN);

    const paddingTop    = offsets[startIdx];
    const paddingBottom = totalH - offsets[endIdx + 1];

    // Render visible groups
    const html = [];
    for (let i = startIdx; i <= endIdx; i++) {
      const { dateStr, byEvent } = groups[i];
      html.push(this._renderDateGroup(dateStr, byEvent, expanded, hasRewind, treeMode));
    }

    // Use spacer divs rather than padding so the list element never expands
    // beyond its flex-allocated height (border-box: large padding would force
    // the element to grow, overflowing the parent and triggering a second scrollbar).
    const topSpacer    = paddingTop    > 0 ? `<div style="height:${paddingTop}px"    aria-hidden="true"></div>` : '';
    const bottomSpacer = paddingBottom > 0 ? `<div style="height:${paddingBottom}px" aria-hidden="true"></div>` : '';
    this._listEl.style.paddingTop    = '';
    this._listEl.style.paddingBottom = '';
    this._listEl.innerHTML = topSpacer + html.join('') + bottomSpacer;
    this._wireListeners(hasRewind);
  }

  _renderDateGroup(dateStr, byEvent, expanded, hasRewind, treeMode) {
    const dateOpen = expanded.has(dateStr);
    const evList   = [...byEvent.entries()];

    const totalActs = treeMode
      ? evList.reduce((s, [, nodes]) => s + this._countNodes(nodes), 0)
      : evList.reduce((s, [, items]) => s + items.length, 0);
    const evCount = byEvent.size;

    const firstEntry = evList[0]?.[1][0]?.entry;
    const rewindBtn = hasRewind && firstEntry
      ? `<button class="tl-rewind" data-date="${firstEntry.date.getTime()}" title="Rewind to ${dateStr}">⏮</button>`
      : '';

    const html = [];
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

        const firstItem   = items[0];
        const firstEntry2 = treeMode ? firstItem?.entry : firstItem?.entry;
        const evColor     = firstEntry2?.event?.color ?? null;
        const evName      = firstEntry2?.event?.name ?? evType;
        const evNodeId    = firstEntry2?.event?.nodeId ?? null;
        const evTypeStyle = evColor ? ` style="color:${evColor}"` : '';
        const evCfgBtn    = evNodeId
          ? `<button class="tl-cfg-link" data-nodeid="${evNodeId}" title="Open in configuration">⚙</button>`
          : '';
        const actCount = treeMode ? this._countNodes(items) : items.length;

        html.push(`<div class="tl-ev-row">
          <span class="tl-pipe">${lastEv ? '└' : '├'}</span>
          <div class="tl-ev-inner">
            <div class="tl-ev-hdr" data-tgl="${evKey}">
              <span class="tl-chev">${evOpen ? '▼' : '▶'}</span>
              <span class="tl-ev-type"${evTypeStyle}>${evName}</span>
              ${evCfgBtn}
              <span class="tl-badge">${actCount} action${actCount !== 1 ? 's' : ''}</span>
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
    return html.join('');
  }

  _renderFlatAction(entry, idx, sum, isLast) {
    const hasTaxDoc = (entry.action.type === 'US_TAX_SETTLE_APPLY' || entry.action.type === 'AU_TAX_SETTLE_APPLY') &&
      (entry.action.data?.taxDetail != null || entry.action.data?.personTaxDetails?.length > 0);
    const cfgBtn = entry.action.nodeId
      ? `<button class="tl-cfg-link" data-nodeid="${entry.action.nodeId}" title="Open in configuration">⚙</button>`
      : '';
    return [`<div class="tl-act" data-seq="${entry.seq}">
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
      const hasTaxDoc = (entry.action.type === 'US_TAX_SETTLE_APPLY' || entry.action.type === 'AU_TAX_SETTLE_APPLY') &&
        (entry.action.data?.taxDetail != null || entry.action.data?.personTaxDetails?.length > 0);
      const cfgBtn = entry.action.nodeId
        ? `<button class="tl-cfg-link" data-nodeid="${entry.action.nodeId}" title="Open in configuration">⚙</button>`
        : '';
      const childBadge = node.children.length
        ? ` <span class="tl-badge">${node.children.length}</span>`
        : '';
      html.push(`<div class="tl-act tl-act--tree" style="padding-left:${indent}px" data-seq="${entry.seq}">
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

  /**
   * Highlight the action row with the given journal seq number and scroll it into view.
   * Called by TimelinePlugin when a breakpoint pause is received.
   * @param {number} seq
   */
  highlightBreakpoint(seq) {
    // Remove previous highlights
    this._listEl?.querySelectorAll('.tl-act--bp').forEach(el => el.classList.remove('tl-act--bp'));
    const row = this._listEl?.querySelector(`.tl-act[data-seq="${seq}"]`);
    if (row) {
      row.classList.add('tl-act--bp');
      row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
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
