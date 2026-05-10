/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { MapFilterMultiSelect } from '../components/map-filter-multi-select.js';
import { QueryApi }             from '../../query/query-api.js';

export class TimelinePresenter {
  constructor({ controller, view, onDetail, onTaxDocument, onRewind, formatDate }) {
    this._controller = controller;
    this._view       = view;
    this._onDetail   = onDetail;
    this._onRewind   = onRewind ?? null;
    this._formatDate = formatDate ?? (d => d.toDateString());

    this._eventSelectFilter  = null;
    this._actionSelectFilter = null;
    this._availableEvents    = [];
    this._availableActions   = [];

    view.onFilterEvents    = set => { controller.filterEvents  = set; this._render(); };
    view.onFilterActions   = set => { controller.filterActions = set; this._render(); };
    view.onFilterDateStart = dateStr => {
      controller.filterDateStart = dateStr ? this._parseStart(dateStr) : null;
      this._render();
    };
    view.onFilterDateEnd = dateStr => {
      controller.filterDateEnd = dateStr ? this._parseEnd(dateStr) : null;
      this._render();
    };
    view.onClearFilters = () => {
      controller.filterEvents    = new Set();
      controller.filterActions   = new Set();
      controller.filterDateStart = null;
      controller.filterDateEnd   = null;
      this._eventSelectFilter?.clearSelectedItems();
      this._actionSelectFilter?.clearSelectedItems();
      this._render();
    };
    view.onDownloadCsv = () => {
      const csv = controller.generateCsv(this._formatDate);
      if (csv) this._triggerDownload(csv);
    };
    view.onToggle  = key => { controller.toggleExpanded(key); this._render(); };
    view.onDetail  = idx => onDetail(controller.journal.journal[idx]);
    if (onTaxDocument) {
      view.onTaxDocument = idx => onTaxDocument(controller.journal.journal[idx]);
    }
    if (onRewind) {
      view.onRewind = ts => onRewind(new Date(ts));
    }
  }

  attach(journal) {
    this._controller.setJournal(journal);
    this._render();
  }

  reset() {
    this._controller.reset();
    this._render();
  }

  update() {
    if (!this._controller.journal) return;
    const changed = this._controller.update(this._formatDate);
    if (!changed) return;

    // Auto-expand the latest date group when new entries arrive
    const groups = this._controller.groups(this._formatDate);
    if (groups.size > 0) {
      const lastDateKey = [...groups.keys()].at(-1);
      if (lastDateKey && lastDateKey !== this._controller._lastDate) {
        this._controller.expanded.add(lastDateKey);
        this._controller._lastDate = lastDateKey;
      }
    }

    this._render();
  }

  _render() {
    if (!this._controller.journal) return;
    const ctrl    = this._controller;
    const options = ctrl.allOptions();

    this._view.render({
      groups:          ctrl.groups(this._formatDate),
      filterEvents:    ctrl.filterEvents,
      filterActions:   ctrl.filterActions,
      filterDateStart: ctrl.filterDateStart,
      filterDateEnd:   ctrl.filterDateEnd,
      expanded:        ctrl.expanded,
      hasRewind:       !!this._onRewind,
    });

    // Create multi-selects once the filter bar DOM exists (after first render)
    this._ensureMultiSelects();

    // Update options arrays; multi-selects query these lazily on next open
    this._availableEvents.length  = 0;
    this._availableEvents.push(...options.events);
    this._availableActions.length = 0;
    this._availableActions.push(...options.actions);
  }

  _ensureMultiSelects() {
    const filterBarEl = this._view._filterBarEl;
    if (!filterBarEl) return;

    if (!this._eventSelectFilter) {
      this._eventSelectFilter = new MapFilterMultiSelect({
        parent:        this._view,
        container:     filterBarEl.querySelector('#tl-ev-select'),
        selectedItems: [],
        onToggle:      (item, added, selectedItems) => {
          this._view.onFilterEvents?.(new Set([...selectedItems].map(o => o.name)));
        },
        queryApi: new QueryApi({ getAll: () => this._availableEvents }),
      });
    }

    if (!this._actionSelectFilter) {
      this._actionSelectFilter = new MapFilterMultiSelect({
        parent:        this._view,
        container:     filterBarEl.querySelector('#tl-act-select'),
        selectedItems: [],
        onToggle:      (item, added, selectedItems) => {
          this._view.onFilterActions?.(new Set([...selectedItems].map(o => o.name)));
        },
        queryApi: new QueryApi({ getAll: () => this._availableActions }),
      });
    }
  }

  _triggerDownload(csv) {
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `timeline-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Parse a YYYY-MM-DD string to local midnight (start of day)
  _parseStart(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d, 0, 0, 0, 0);
  }

  // Parse a YYYY-MM-DD string to local end-of-day (inclusive upper bound)
  _parseEnd(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d, 23, 59, 59, 999);
  }
}
