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
import { APP_EVENTS }           from '../app-display-settings.js';
import { withBom }              from '../../utils/csv.js';
import { RenderScheduler }      from '../components/render-scheduler.js';

export class TimelinePresenter {
  constructor({ controller, view, onDetail, onTaxDocument, onRewind, onNavigateToNode, displaySettings, appBus }) {
    this._controller = controller;
    this._view       = view;
    this._onRewind   = onRewind ?? null;
    this._formatDate = displaySettings?.formatDate ?? (d => d.toDateString());
    this._unsubscribeSettings = null;

    // Playback render throttling. The timeline is a presenter, not a
    // BaseComponent, which is the only reason it was left out of the animator's
    // throttle list while the graph, state panel, chart, accounts and dash cards
    // were all in it — so during playback it re-rendered on every frame and
    // became 70% of the wall time (design 78 §6).
    //
    // `immediate: 'sync'` because this presenter's contract is that a step has
    // repainted by the time update() returns; `flushOnRelease` because playback
    // ends by dropping the throttle to 0, and without a flush the last coalesced
    // frame is lost with nothing following to correct it.
    this._scheduler = new RenderScheduler({ immediate: 'sync', flushOnRelease: true });

    // Display-currency conversion of action-payload amounts (design 10 §Phase 4).
    this._controller.displaySettings = displaySettings ?? null;

    if (onNavigateToNode) {
      view.onNavigateToNode = onNavigateToNode;
    }

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
    view.onToggle  = key => { if (key !== null) controller.toggleExpanded(key); this._render(); };
    view.onDetail  = idx => onDetail(controller.journal.journal[idx]);
    if (onTaxDocument) {
      view.onTaxDocument = idx => onTaxDocument(controller.journal.journal[idx], controller.journal.journal);
    }
    if (onRewind) {
      view.onRewind = ts => onRewind(new Date(ts));
    }

    if (appBus) {
      this._unsubscribeSettings = appBus.subscribe(APP_EVENTS.DISPLAY_SETTINGS_CHANGED, ({ formatDate }) => {
        this._formatDate = formatDate;
        if (this._controller?.journal) this._render();
      });
    }
  }

  set schemaRegistry(r) {
    this._controller.schemaRegistry = r ?? null;
  }

  /** CurrencyConverter for converting action-payload amounts to display currency. */
  set currencyConverter(c) {
    this._controller.currencyConverter = c ?? null;
  }

  /** Provider returning the state snapshot whose recorded rate drives conversion. */
  set rateStateProvider(fn) {
    this._controller.rateStateProvider = fn ?? null;
  }

  /** TypeRegistry for resolving each action-payload field's native currency. */
  set typeRegistry(r) {
    this._controller.typeRegistry = r ?? null;
  }

  attach(journal) {
    this._controller.setJournal(journal);
    this._render();
  }

  reset() {
    this._controller.reset();
    this._render();
  }

  /**
   * Throttle playback-driven renders. `ms > 0` coalesces them onto a timer;
   * `0` restores immediate rendering AND flushes any pending render, so the
   * timeline is never left showing a stale frame when playback stops.
   *
   * @param {number} ms
   */
  setRenderThrottle(ms) {
    this._scheduler.setThrottle(ms);
  }

  /** Render now, or coalesce onto the throttle timer when one is set. */
  _scheduleRender() {
    this._scheduler.schedule(() => this._render());
  }

  update() {
    if (!this._controller.journal) return;
    const changed = this._controller.update(this._formatDate);
    if (!changed) return;

    // Auto-expand the latest date group when new entries arrive. Reads the key
    // directly rather than grouping the whole journal to look at its last key —
    // _render() below does the one grouping pass this update needs.
    const lastDateKey = this._controller.latestDateKey(this._formatDate);
    if (lastDateKey && lastDateKey !== this._controller._lastDate) {
      if (this._controller._lastDate) {
        this._controller.expanded.delete(this._controller._lastDate);
      }
      this._controller.expanded.add(lastDateKey);
      this._controller._lastDate = lastDateKey;
    }

    this._scheduleRender();
  }

  _render() {
    if (!this._controller.journal) return;
    const ctrl    = this._controller;
    const options = ctrl.allOptions();

    const bounds = ctrl.dateBounds();
    this._view.render({
      groups:           ctrl.groups(this._formatDate),
      causalGroups:     ctrl.causalGroups(this._formatDate),
      filterEvents:     ctrl.filterEvents,
      filterActions:    ctrl.filterActions,
      filterDateStart:  ctrl.filterDateStart,
      filterDateEnd:    ctrl.filterDateEnd,
      dateBoundsStart:  bounds.min,
      dateBoundsEnd:    bounds.max,
      expanded:         ctrl.expanded,
      hasRewind:        !!this._onRewind,
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
    const blob = new Blob([withBom(csv)], { type: 'text/csv' });
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

  destroy() {
    this._unsubscribeSettings?.();
    // Drop any coalesced render still on the timer, or it fires against a
    // destroyed view after a scenario Rebuild.
    this._scheduler.cancel();
    this._view.destroy();
  }
}
