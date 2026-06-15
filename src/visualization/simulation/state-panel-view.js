/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { $ } from '../ui-utils.js';
import { BaseComponent } from '../components/base-component.js';
import { EXECUTION_KINDS, EXECUTION_PHASES } from '../../simulation-framework/bus-messages.js';
import { EXECUTION_EDGE_TYPES } from '../../simulation-framework/execution-graph.js';
import { readThemeColor } from '../theme.js';
import { APP_EVENTS } from '../app-display-settings.js';

/**
 * StatePanelView — pure DOM layer for state/metrics panels and node detail.
 *
 * Owns:
 *  - State panel rendering (updateStatePanel, renderState, createStateDetails)
 *  - Node detail panel (showNodeDetail, showNodeStateChanges, createActionDetail)
 *
 * formatDate is injected via the setter and defaults to Date.toDateString().
 * WorkbenchApp calls `this._statePanelView.formatDate = currentFmt` on each buildScenario()
 * and when the TZ selector changes.
 */
export class StatePanelView extends BaseComponent {

  constructor({ displaySettings, appBus } = {}) {
    super();
    this._formatDate        = displaySettings?.formatDate ?? (d => d.toDateString());
    this._schemaRegistry    = null;
    this._pendingDate       = null;
    this._pendingState      = null;
    this._drainExecEndMsgs  = () => [];
    this._chartPresenter    = null;
    this._lastOutOfFundsDate = null;
    this._onOpenNode        = null;
    this._onShowActionDetail = null;
    this._journal           = null;
    this._executionGraph    = null;
    this._metricHistory     = new Map();
    this._fieldSeriesStore  = null;
    this._isPathCharted     = () => false;
    this._onChartToggle     = null;
    this._stateCollapsed    = true;
    this._filterText        = '';
    this._expandedSections  = new Set();  // sectionPath → expanded; default (absent) = collapsed

    if (appBus) {
      appBus.subscribe(APP_EVENTS.DISPLAY_SETTINGS_CHANGED, ({ formatDate }) => {
        this._formatDate = formatDate;
        // Re-render so currency-formatted rows pick up the new display currency
        // (design 10 §Phase 4). No scenario rebuild — values reformat in place.
        this.refresh();
        // Also reformat an open Action Detail (state changes + payload) in place,
        // without re-activating its tab.
        if (this._lastDetailEntry) this.showNodeDetail(this._lastDetailEntry, { reveal: false });
      });
    }
  }

  /** Update the active date-format function (UTC vs local). */
  set formatDate(fn) {
    this._formatDate = fn ?? (d => d.toDateString());
  }

  /** Inject the StateSchemaRegistry for context-aware value formatting. */
  set schemaRegistry(r) {
    this._schemaRegistry = r ?? null;
  }

  /** Inject the TypeRegistry, used to resolve action-payload field currencies. */
  set typeRegistry(r) {
    this._typeRegistry = r ?? null;
  }

  /** Inject a callback to open a config-graph node in the edit modal. */
  set onOpenNode(fn) {
    this._onOpenNode = fn ?? null;
  }

  /** Inject a callback to reveal the action-detail panel (e.g. activate a tab). */
  set onShowActionDetail(fn) {
    this._onShowActionDetail = fn ?? null;
  }

  /** Inject the current journal for parent lookup and field history. */
  set journal(j) {
    this._journal = j ?? null;
  }

  /** Inject the ExecutionGraph for the Execution Graph tab in metric modals. */
  set executionGraph(eg) {
    this._executionGraph = eg ?? null;
  }

  /** Inject a FieldSeriesStore for path-keyed backfill on non-metrics row clicks. */
  set fieldSeriesStore(store) {
    this._fieldSeriesStore = store ?? null;
  }

  /** Inject a predicate (path) → bool telling whether a path is currently charted. */
  set isPathCharted(fn) {
    this._isPathCharted = fn ?? (() => false);
  }

  /** Callback (path, shouldBeActive) when a row/header chart checkbox is toggled. */
  set onChartToggle(fn) {
    this._onChartToggle = fn ?? null;
  }

  // ── Simulation bus ────────────────────────────────────────────────────────────

  /**
   * Subscribe to EXECUTION_END(EVENT) directly so the state panel and failure
   * banner update themselves without being driven by SimulationAnimator.
   * Call once per scenario after scenario.buildSim().
   * @param {EventBus} simBus
   * @param {{ chartPresenter?: object }} [opts]
   */
  wireSimBus(simBus, { chartPresenter } = {}) {
    this._chartPresenter = chartPresenter ?? null;
    // simBus is the per-run sim bus; the prior subscription is discarded with the
    // previous sim's bus on Rebuild, so no manual unsubscribe is needed here.
    this._drainExecEndMsgs = this.busQueue(
      simBus,
      `EXECUTION_${EXECUTION_PHASES.END}`,
      () => this.render(),
      { kind: EXECUTION_KINDS.EVENT }
    );
  }

  // ── State panel rendering ─────────────────────────────────────────────────

  /** Public API: direct update (e.g. from reset callback). */
  updateStatePanel(date, state) {
    this._pendingDate  = date;
    this._pendingState = state;
    this.render();
  }

  render() {
    this.scheduleRender(() => this._doRender());
  }

  _doRender() {
    const msgs = this._drainExecEndMsgs();
    const last = msgs[msgs.length - 1];
    if (last) {
      this._pendingDate  = new Date(last.date);
      this._pendingState = last.stateSnapshot;
    }
    if (this._pendingState) {
      this._bufferMetrics(this._pendingDate, this._pendingState.metrics);
      this._renderStatePanel(this._pendingDate, this._pendingState);
      this._updateFailureBanner(this._pendingState);
    }
  }

  _bufferMetrics(date, metrics) {
    if (!metrics || !date) return;
    for (const [key, value] of Object.entries(metrics)) {
      if (typeof value !== 'number' || !isFinite(value)) continue;
      if (!this._metricHistory.has(key)) this._metricHistory.set(key, []);
      this._metricHistory.get(key).push({ date: new Date(date), value });  // unbounded (R10.2)
    }
  }

  /** Set the row filter substring (case-insensitive, matches full path). Re-renders. */
  setFilter(text) {
    this._filterText = (text ?? '').trim().toLowerCase();
    if (this._pendingState) this._renderStatePanel(this._pendingDate, this._pendingState);
  }

  clearMetricHistory() {
    this._metricHistory.clear();
    this._fieldSeriesStore?.clear();
  }

  /** Wire the collapse toggle for the State section. Called once from WorkbenchApp.initView(). */
  initLiveState() {
    const filter = document.getElementById('lsp-panel-filter');
    if (filter) filter.addEventListener('input', e => this.setFilter(e.target.value));

    // R9.2: chart a path by name (lets you arm paths not present at t0, e.g. a
    // holding bought mid-sim — it buffers live once it first appears).
    const addInput = document.getElementById('lsp-add-path');
    const addBtn   = document.getElementById('lsp-add-path-btn');
    const addPath = () => {
      const path = (addInput?.value ?? '').trim();
      if (!path) return;
      this._onChartToggle?.(path, true);
      this._refreshRows();
      if (addInput) addInput.value = '';
    };
    if (addBtn)   addBtn.addEventListener('click', addPath);
    if (addInput) addInput.addEventListener('keydown', e => { if (e.key === 'Enter') addPath(); });

    const header  = document.getElementById('stateSectionHeader');
    const content = document.getElementById('currentStateContent');
    if (!header || !content) return;
    header.addEventListener('click', () => {
      this._stateCollapsed = !this._stateCollapsed;
      content.style.display = this._stateCollapsed ? 'none' : '';
      const icon = header.querySelector('.lsp-collapse-icon');
      if (icon) icon.textContent = this._stateCollapsed ? '▶' : '▼';
    });
  }

  // ── Failure banner ────────────────────────────────────────────────────────

  _updateFailureBanner(stateSnapshot) {
    const oofDate = stateSnapshot?.outOfFundsDate ?? null;

    if (oofDate !== this._lastOutOfFundsDate) {
      const banner   = $('failureBanner');
      const dateSpan = $('failureBannerDate');

      if (oofDate && !this._lastOutOfFundsDate) {
        if (banner)   banner.style.display = '';
        if (dateSpan) dateSpan.textContent = this.fmtVal(oofDate);
        this._chartPresenter?.addAnnotation('out_of_funds', {
          label:    'OUT OF FUNDS',
          date:     oofDate,
          color:    '#f87171',
          position: 'start',
        });
      } else if (!oofDate && this._lastOutOfFundsDate) {
        if (banner) banner.style.display = 'none';
        this._chartPresenter?.removeAnnotation('out_of_funds');
      }

      this._lastOutOfFundsDate = oofDate;
    }

    if (oofDate) {
      const defSpan    = $('failureBannerDeficit');
      const monthsSpan = $('failureBannerMonths');
      if (defSpan)    defSpan.textContent    = this._fmtChange('cumulativeDeficit', stateSnapshot.cumulativeDeficit ?? 0);
      if (monthsSpan) monthsSpan.textContent = stateSnapshot.deficitMonths ?? 0;
    }
  }

  _renderStatePanel(date, state) {
    if (!state) return;
    const { metrics, ...rest } = state;

    this._renderMetricsPanel(metrics, $('cumulativeMetricsContent'));

    const newStateDetails = this.createStateDetails('tpl-state-details', date, rest);
    const stateDetails = $('currentStateContent');
    stateDetails.replaceChildren(newStateDetails);
    stateDetails.style.display = this._stateCollapsed ? 'none' : '';
  }

  _renderMetricsPanel(metrics, container) {
    if (!metrics) { container.replaceChildren(); return; }
    const frag = document.createDocumentFragment();

    for (const [k, v] of Object.entries(metrics)) {
      const path = `metrics.${k}`;
      if (typeof v === 'number' && isFinite(v)) {
        if (!this._matchesFilter(path)) continue;
        const hist = this._metricHistory.get(k);
        frag.appendChild(this._buildFieldRow({
          path,
          value:   v,
          label:   this.toLabel(k),
          history: hist,
          onClick: () => this._showFieldHistoryModal(path, this._metricHistory.get(k) ?? [], false, this.toLabel(k)),
        }));
      } else {
        // Non-numeric metric (object/array): render its leaves like state.
        this.renderState({ [k]: v }, frag, 'metrics');
      }
    }
    container.replaceChildren(frag);
  }

  _renderMetricSparkline(history) {
    const values = history.map(e => e.value);
    if (values.length < 2) return null;

    const W = 56, H = 14, P = 1;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;

    const pts = values.map((v, i) => {
      const x = P + (i / (values.length - 1)) * (W - P * 2);
      const y = P + (H - P * 2) - ((v - min) / range) * (H - P * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');

    const trend = values[values.length - 1] - values[0];
    const color = trend > 0 ? '#34d399' : trend < 0 ? '#f87171' : '#6b7280';

    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.style.cssText = 'flex-shrink:0;vertical-align:middle;';

    const poly = document.createElementNS(NS, 'polyline');
    poly.setAttribute('points', pts);
    poly.setAttribute('fill', 'none');
    poly.setAttribute('stroke', color);
    poly.setAttribute('stroke-width', '1.5');
    poly.setAttribute('stroke-linejoin', 'round');
    poly.setAttribute('stroke-linecap', 'round');
    svg.appendChild(poly);

    const lastPt = pts.split(' ').at(-1).split(',');
    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('cx', lastPt[0]);
    dot.setAttribute('cy', lastPt[1]);
    dot.setAttribute('r', '2');
    dot.setAttribute('fill', color);
    svg.appendChild(dot);

    return svg;
  }

  createStateDetails(_templateId, date, state) {
    if (!state) return null;
    const container = document.createElement('div');
    container.className = 'lsp-state-grid';
    this.renderState(state, container);
    return container;
  }

  /**
   * Render an object's leaves into `container` as unified field rows (lsp-metric-row)
   * with section headers. Recurses objects and arrays-of-objects (the latter via
   * stable id-addressed paths, R11.3). Returns the list of numeric leaf paths
   * rendered (so a parent header can drive a tri-state "select all", R5).
   */
  renderState(obj, container, prefix = '') {
    const paths = [];
    for (const [k, v] of Object.entries(obj)) {
      const topPath = prefix ? `${prefix}.${k}` : k;
      const isObjArray = Array.isArray(v) && v.length > 0 && v[0] !== null && typeof v[0] === 'object';
      const isObject   = v !== null && typeof v === 'object' && !Array.isArray(v) && !this.isDate(v);

      if (isObjArray || isObject) {
        const subPaths = this._collectLeafPaths(v, topPath);
        paths.push(...subPaths);
        this._appendCollapsibleSection(container, {
          label: k, sectionPath: topPath, subPaths,
          renderBody: (body) => isObjArray ? this._renderObjectArray(v, topPath, body)
                                           : this.renderState(v, body, topPath),
        });

      } else if (typeof v === 'number' && isFinite(v)) {
        if (!this._matchesFilter(topPath)) continue;
        container.appendChild(this._buildFieldRow({ path: topPath, value: v, label: this.toLabel(k) }));
        paths.push(topPath);

      } else {
        if (!this._matchesFilter(topPath)) continue;
        container.appendChild(this._buildStaticRow(this.toLabel(k),
          typeof v === 'object' ? this.renderObj(v) : this._fmtChange(topPath, v)));
      }
    }
    return paths;
  }

  /** Render each object element of an array as its own collapsible section (stable id prefix). */
  _renderObjectArray(arr, basePath, container) {
    arr.forEach((item, idx) => {
      if (item === null || typeof item !== 'object' || this.isDate(item)) return;
      const id    = item.id;
      const seg   = (id != null) ? `${basePath}[id=${id}]` : `${basePath}.${idx}`;
      const label = item.label ?? item.rateKey ?? item.name ?? (id != null ? String(id) : `[${idx}]`);
      this._appendCollapsibleSection(container, {
        label, sectionPath: seg, subPaths: this._collectLeafPaths(item, seg), alreadyLabel: true,
        renderBody: (body) => this.renderState(item, body, seg),
      });
    });
  }

  /**
   * Append a foldable section: a header (caret + tri-state checkbox + label) and,
   * when expanded, a body built lazily by `renderBody`. Sections are collapsed by
   * default (D17-style) and auto-expanded while a filter is active. A section with
   * no filter-matching descendant is omitted entirely.
   */
  _appendCollapsibleSection(container, { label, sectionPath, subPaths, renderBody, alreadyLabel = false }) {
    if (this._filterText && !subPaths.some(p => this._matchesFilter(p))) return;
    const expanded = this._filterText !== '' || this._expandedSections.has(sectionPath);
    container.appendChild(this.renderHeaderRow(label, subPaths, alreadyLabel, sectionPath, expanded));
    if (expanded) {
      const body = document.createElement('div');
      body.className = 'lsp-section-body';
      renderBody(body);
      container.appendChild(body);
    }
  }

  /** Toggle a section's expanded state and re-render. */
  _toggleSection(sectionPath) {
    if (this._expandedSections.has(sectionPath)) this._expandedSections.delete(sectionPath);
    else this._expandedSections.add(sectionPath);
    this._refreshRows();
  }

  /** Re-render the panel from the last state so checkbox/tri-state/fold reflect current chart. */
  _refreshRows() {
    if (this._pendingState) this._renderStatePanel(this._pendingDate, this._pendingState);
  }

  /** Public: re-sync rows/checkboxes with the chart (e.g. after a chip removal). */
  refresh() { this._refreshRows(); }

  /**
   * Collect numeric leaf paths under `node` (rooted at `prefix`) without building DOM,
   * mirroring renderState's leaf rules incl. stable `[id=..]` array addressing.
   * Used for header tri-state, filter section-matching, and select-all batches.
   */
  _collectLeafPaths(node, prefix) {
    const out = [];
    const walk = (n, p) => {
      if (Array.isArray(n)) {
        if (n.length > 0 && n[0] !== null && typeof n[0] === 'object') {
          n.forEach((item, idx) => {
            if (item === null || typeof item !== 'object' || this.isDate(item)) return;
            walk(item, item.id != null ? `${p}[id=${item.id}]` : `${p}.${idx}`);
          });
        }
        return;
      }
      if (n !== null && typeof n === 'object' && !this.isDate(n)) {
        for (const [k, v] of Object.entries(n)) walk(v, p ? `${p}.${k}` : k);
        return;
      }
      if (typeof n === 'number' && isFinite(n)) out.push(p);
    };
    walk(node, prefix);
    return out;
  }

  /** Case-insensitive substring match of the filter against the full path. */
  _matchesFilter(path) {
    return !this._filterText || path.toLowerCase().includes(this._filterText);
  }

  /**
   * Build a unified numeric-field row: [chart checkbox][label][sparkline][value].
   * The checkbox reflects/drives the chart active set; row-click opens history.
   */
  _buildFieldRow({ path, value, label = null, history = null, onClick = null }) {
    const row = document.createElement('div');
    row.className = 'lsp-metric-row lsp-clickable-row';

    row.appendChild(this._buildChartToggle(path));

    const lbl = document.createElement('span');
    lbl.className = 'lsp-metric-label';
    lbl.textContent = label ?? this.toLabel(path.split('.').pop().replace(/\[.*?\]/g, ''));
    lbl.title = path;
    row.appendChild(lbl);

    const spark = (history && history.length >= 2) ? this._renderMetricSparkline(history) : null;
    const sparkCell = document.createElement('span');
    sparkCell.className = 'lsp-metric-spark';
    if (spark) sparkCell.appendChild(spark);
    row.appendChild(sparkCell);

    const val = document.createElement('span');
    val.className = 'lsp-metric-value';
    val.textContent = this._fmtChange(path, value);
    row.appendChild(val);

    const click = onClick ?? (() => this._onFieldRowClick(path));
    row.addEventListener('click', click);
    return row;
  }

  /** A non-numeric leaf row (label + value), no chart toggle. */
  _buildStaticRow(label, valueText) {
    const row = document.createElement('div');
    row.className = 'lsp-metric-row lsp-static-row';
    row.appendChild(document.createElement('span')); // checkbox column spacer
    const lbl = document.createElement('span');
    lbl.className = 'lsp-metric-label';
    lbl.textContent = label;
    const spark = document.createElement('span');
    spark.className = 'lsp-metric-spark';
    const val = document.createElement('span');
    val.className = 'lsp-metric-value';
    val.textContent = valueText;
    row.append(lbl, spark, val);
    return row;
  }

  /** A checkbox bound to the chart active set for a single path. */
  _buildChartToggle(path) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'lsp-chart-toggle';
    cb.title = 'Show on chart';
    cb.checked = this._isPathCharted(path);
    cb.addEventListener('click', e => e.stopPropagation());
    cb.addEventListener('change', () => {
      this._onChartToggle?.(path, cb.checked);
      this._refreshRows();   // keep parent tri-state + chart in sync
    });
    return cb;
  }

  _onFieldRowClick(path) {
    if (!this._fieldSeriesStore) return;
    const { series, backfilled } = this._fieldSeriesStore.getOrBackfill(path);
    this._showFieldHistoryModal(path, series, backfilled);
  }

  // ── Node detail panel ─────────────────────────────────────────────────────

  showNodeStateChanges(changes) {
    const templateContent = document.querySelector('#tpl-node-state-changes');
    const clone = templateContent.content.firstElementChild.cloneNode(true);
    const stateChangesGrid = clone.querySelector('[data-state-change-grid]');
    this._populateStateChanges(stateChangesGrid, changes);
    const actionDetails = $('actionPanelDetails');
    clone.appendChild(stateChangesGrid);
    actionDetails.replaceChildren(clone);
  }

  showNodeDetail(entry, { reveal = true } = {}) {
    this._lastDetailEntry = entry;
    const { changes, emitted, actionPayload } = this.buildActionDetail(entry);
    const parentInfo = this._getParentInfo(entry);
    const el = this._buildActionDetailEl({ entry, changes, emitted, actionPayload, parentInfo });
    if (reveal) this._onShowActionDetail?.();
    $('actionPanelDetails')?.replaceChildren(el);
  }

  _buildActionDetailEl({ entry, changes, emitted, actionPayload, parentInfo }) {
    const tmpl  = document.querySelector('#tpl-action-template');
    const clone = document.importNode(tmpl, true).content;

    // ── Action name / type / edit button ──────────────────────────────────
    clone.querySelector('[data-id="action-name"]').innerText  = entry.action.name ?? '—';
    clone.querySelector('[data-id="action-type"]').innerText  = entry.action.type ?? '—';

    const actionBtn = clone.querySelector('[data-action-btn="open-action"]');
    if (entry.action.nodeId && this._onOpenNode) {
      actionBtn.style.display = '';
      this.listen(actionBtn, 'click', () => this._onOpenNode(entry.action.nodeId));
    }

    // ── Date / Event / Parent / Reducer / Emitted ─────────────────────────
    clone.querySelector('[data-id="entry-date"]').innerText   = this.fmtVal(entry.date);
    clone.querySelector('[data-id="event-name"]').innerText   = entry.event?.name ?? entry.event?.type ?? '—';

    const parentInfoSpan = clone.querySelector('[data-id="parent-info"]');
    if (entry.action?.parentId && this._journal) {
      parentInfoSpan.style.cssText = 'display:flex;align-items:center;gap:6px;';
      const parentText = document.createElement('span');
      parentText.textContent = parentInfo;
      parentInfoSpan.appendChild(parentText);
      const chainBtn = document.createElement('button');
      chainBtn.className = 'ad-history-btn';
      chainBtn.textContent = 'Show Chain';
      chainBtn.title = 'Trace causal ancestor chain from root action';
      this.listen(chainBtn, 'click', () => this._showCausalChain(entry));
      parentInfoSpan.appendChild(chainBtn);
    } else {
      parentInfoSpan.innerText = parentInfo;
    }

    clone.querySelector('[data-id="reducer-name"]').innerText = entry.reducer?.name ?? '—';

    const reducerBtn = clone.querySelector('[data-action-btn="open-reducer"]');
    if (entry.reducer?.nodeId && this._onOpenNode) {
      reducerBtn.style.display = '';
      this.listen(reducerBtn, 'click', () => this._onOpenNode(entry.reducer.nodeId));
    }

    clone.querySelector('[data-id="emitted"]').innerText = emitted;

    // ── Payload collapse ──────────────────────────────────────────────────
    const payloadPre     = clone.querySelector('[data-id="action-payload"]');
    payloadPre.innerText = actionPayload;

    const collapseHeader  = clone.querySelector('[data-collapse-toggle]');
    const collapseContent = clone.querySelector('[data-collapse-content]');
    this.listen(collapseHeader, 'click', () => {
      const open = collapseContent.style.display !== 'none';
      collapseContent.style.display = open ? 'none' : '';
      collapseHeader.querySelector('.ad-collapse-icon').classList.toggle('open', !open);
    });

    // ── Analytics toolbar ─────────────────────────────────────────────────
    if (this._journal && changes.length > 0) {
      const toolbar = document.createElement('div');
      toolbar.className = 'ad-analytics-toolbar';
      const queryBtn = document.createElement('button');
      queryBtn.className = 'ad-history-btn';
      queryBtn.textContent = '⊞ Field × Action';
      queryBtn.title = 'Query how a state field changes across all instances of an action type';
      this.listen(queryBtn, 'click', () => {
        const field      = changes[0]?.field ?? null;
        const actionType = entry.action.type;
        if (this.onOpenCrossActionQuery) {
          this.onOpenCrossActionQuery(field, actionType);
        } else {
          this._showCrossActionModal(field, actionType);
        }
      });
      toolbar.appendChild(queryBtn);
      collapseHeader.parentNode.insertBefore(toolbar, collapseHeader);
    }

    // ── State changes ─────────────────────────────────────────────────────
    const scTmpl  = document.querySelector('#tpl-node-state-changes');
    const scClone = scTmpl.content.firstElementChild.cloneNode(true);
    this._populateStateChanges(scClone, changes, null, entry);
    clone.querySelector('[data-state-change-grid]').replaceWith(scClone);

    return clone;
  }

  _getParentInfo(entry) {
    if (!entry.action?.parentId || !this._journal) return '—';
    const parent = this._journal.getByInstanceId(entry.action.parentId);
    if (!parent) return `(id: ${entry.action.parentId.slice(0, 8)})`;
    return `${parent.action.name} (${parent.action.type})`;
  }

  _populateStateChanges(stateChangesGrid, changes, prevState = null, entry = null) {
    if (changes.length > 0) {
      for (const change of changes) {
        const stateChangeFieldRow = document.importNode(stateChangesGrid.querySelector('[data-state-change-field-row]'), true);
        stateChangeFieldRow.style = '';

        // Field name cell — add History button inline when journal context exists.
        const fieldCell = stateChangeFieldRow.querySelector('[data-id="field"]');
        fieldCell.style.cssText = 'display:flex;align-items:center;gap:6px;';
        const nameSpan = document.createElement('span');
        nameSpan.innerText = change.field;
        fieldCell.appendChild(nameSpan);
        if (entry && this._journal) {
          const histBtn = document.createElement('button');
          histBtn.className = 'ad-history-btn';
          histBtn.textContent = 'History';
          histBtn.title = `View history for ${change.field}`;
          this.listen(histBtn, 'click', () => {
            const timeline = this._journal.getStateTimelineUpTo(change.field, entry.seq);
            this._showFieldHistory(change.field, timeline);
          });
          fieldCell.appendChild(histBtn);
          const sparkline = this._renderSparkline(change.field, entry.seq);
          if (sparkline) fieldCell.appendChild(sparkline);
        }

        stateChangesGrid.appendChild(stateChangeFieldRow);

        const stateChangeBeforeRow = document.importNode(stateChangesGrid.querySelector('[data-state-change-before-row]'), true);
        stateChangeBeforeRow.style = '';
        stateChangeBeforeRow.querySelector('[data-id="before"]').innerHTML = this._fmtChange(change.field, change.before, true);
        stateChangesGrid.appendChild(stateChangeBeforeRow);

        const stateChangeAfterRow = document.importNode(stateChangesGrid.querySelector('[data-state-change-after-row]'), true);
        stateChangeAfterRow.style = '';
        if (change.delta != null) {
          const after = stateChangeAfterRow.querySelector('[data-id="after"]');
          const delta = document.createElement('span');
          if (change.delta > 0) {
            delta.classList.add('diff-pos');
            delta.innerText = '+' + this._fmtChange(change.field, change.delta);
          } else {
            delta.classList.add('diff-neg');
            delta.innerText = this._fmtChange(change.field, change.delta);
          }
          after.innerHTML = this._fmtChange(change.field, change.after, true);
          after.appendChild(delta);
        } else {
          stateChangeAfterRow.querySelector('[data-id="after"]').innerHTML = this._fmtChange(change.field, change.after, true);
        }
        stateChangesGrid.appendChild(stateChangeAfterRow);
      }
    } else {
      stateChangesGrid.querySelector('[data-id="noChangeRow"]').style = '';
      const noChangeState = stateChangesGrid.querySelector('[data-id="noChangeState"]');
      noChangeState.style = '';
      if (prevState != null) {
        noChangeState.innerHTML = `<pre>${prevState}</pre>`;
      } else {
        noChangeState.innerText = 'No changes';
      }
    }
  }

  /**
   * Show the field history modal for any numeric state path.
   * @param {string}  path       - dot-separated state path (used as key for formatting/label)
   * @param {Array}   history    - [{date, value}] array
   * @param {boolean} backfilled - true when series came from snapshot backfill (coarser resolution)
   */
  _showFieldHistoryModal(path, history, backfilled = false, label = null) {
    document.getElementById('metricHistoryModal')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'metricHistoryModal';
    overlay.className = 'sim-modal-overlay';
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    const modal = document.createElement('div');
    modal.className = 'sim-modal';
    modal.style.width = '620px';

    const hdr = document.createElement('div');
    hdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;';
    const title = document.createElement('span');
    title.style.cssText = 'font-size:12px;font-weight:600;';
    const backfilledNote = backfilled ? ' · snapshot resolution' : '';
    title.textContent = `Field History — ${label ?? this.toLabel(path)}${backfilledNote}`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn-sm';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => overlay.remove());
    hdr.append(title, closeBtn);

    const body = document.createElement('div');
    body.style.cssText = 'overflow-y:auto;flex:1;';

    if (!history || history.length === 0) {
      const empty = document.createElement('span');
      empty.style.color = 'var(--text-muted)';
      empty.textContent = 'No history recorded yet — run the simulation first.';
      body.appendChild(empty);
      modal.append(hdr, body);
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      return;
    }

    // ── Shared date-range filter ───────────────────────────────────────────
    const inputStyle = 'font-size:10px;padding:1px 4px;background:var(--bg-panel2,#111);color:var(--text-primary,#e5e7eb);border:1px solid var(--border);border-radius:2px;';
    const filterRow = document.createElement('div');
    filterRow.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:10px;padding:6px 0;border-bottom:1px solid var(--border);flex-wrap:wrap;';

    const fromLbl = document.createElement('span');
    fromLbl.style.color = 'var(--text-muted)';
    fromLbl.textContent = 'Range:';

    const fromInput = document.createElement('input');
    fromInput.type = 'date';
    fromInput.style.cssText = inputStyle;
    fromInput.value = this._toDateInputVal(history[0].date);

    const arrow = document.createElement('span');
    arrow.style.color = 'var(--text-muted)';
    arrow.textContent = '→';

    const toInput = document.createElement('input');
    toInput.type = 'date';
    toInput.style.cssText = inputStyle;
    toInput.value = this._toDateInputVal(history[history.length - 1].date);

    const ptSpan = document.createElement('span');
    ptSpan.style.cssText = 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);margin-left:4px;';

    filterRow.append(fromLbl, fromInput, arrow, toInput, ptSpan);

    const getFiltered = () => {
      const from = fromInput.value ? new Date(fromInput.value) : null;
      const to   = toInput.value   ? new Date(new Date(toInput.value).getTime() + 86399999) : null;
      return history.filter(e => {
        const d = e.date instanceof Date ? e.date : new Date(e.date);
        if (from && d < from) return false;
        if (to   && d > to)   return false;
        return true;
      });
    };

    // ── Tab bar ────────────────────────────────────────────────────────────
    const tabBar = document.createElement('div');
    tabBar.style.cssText = 'display:flex;gap:0;border-bottom:1px solid var(--border);margin-top:6px;';

    const mkTabBtn = (label) => {
      const btn = document.createElement('button');
      btn.style.cssText = 'font-size:11px;padding:5px 14px;border:none;border-bottom:2px solid transparent;background:none;color:var(--text-muted);cursor:pointer;transition:color 0.1s;';
      btn.textContent = label;
      return btn;
    };

    const chartTabBtn = mkTabBtn('Chart');
    const execTabBtn  = mkTabBtn('Execution Graph');
    tabBar.append(chartTabBtn, execTabBtn);

    // ── Chart pane ─────────────────────────────────────────────────────────
    const chartPane = document.createElement('div');
    chartPane.style.cssText = 'padding-top:8px;';

    const mkStat = (label, val, color) => {
      const s = document.createElement('span');
      s.style.cssText = 'display:flex;flex-direction:column;gap:1px;';
      const l = document.createElement('span');
      l.style.cssText = 'color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;';
      l.textContent = label;
      const v = document.createElement('span');
      v.style.cssText = `font-family:var(--font-mono);font-size:11px;${color ? 'color:' + color + ';' : ''}`;
      v.textContent = val;
      s.append(l, v);
      return s;
    };

    const statsEl = document.createElement('div');
    statsEl.style.cssText = 'display:flex;gap:16px;padding:6px 0 8px;font-size:10px;border-bottom:1px solid var(--border);margin-bottom:8px;flex-wrap:wrap;';
    const chartEl = document.createElement('div');
    chartPane.append(statsEl, chartEl);

    // ── Execution pane ──────────────────────────────────────────────────────
    const execPane = document.createElement('div');
    execPane.style.cssText = 'padding-top:8px;display:none;';

    // ── Tab switching ───────────────────────────────────────────────────────
    let activeTab = 'chart';
    const activateTab = (tab) => {
      activeTab = tab;
      const isChart = tab === 'chart';
      chartPane.style.display = isChart ? '' : 'none';
      execPane.style.display  = isChart ? 'none' : '';
      const active   = 'font-size:11px;padding:5px 14px;border:none;border-bottom:2px solid var(--accent-blue,#60a5fa);background:none;color:var(--accent-blue,#60a5fa);cursor:pointer;';
      const inactive = 'font-size:11px;padding:5px 14px;border:none;border-bottom:2px solid transparent;background:none;color:var(--text-muted);cursor:pointer;';
      chartTabBtn.style.cssText = isChart ? active : inactive;
      execTabBtn.style.cssText  = isChart ? inactive : active;
      if (!isChart) this._renderExecGraphPane(execPane, getFiltered(), path);
    };

    chartTabBtn.addEventListener('click', () => activateTab('chart'));
    execTabBtn.addEventListener('click',  () => activateTab('exec'));
    activateTab('chart');

    // ── Refresh chart on filter change ──────────────────────────────────────
    const refreshChart = () => {
      const filtered = getFiltered();
      ptSpan.textContent = `${filtered.length} / ${history.length} pts`;
      statsEl.replaceChildren();
      chartEl.replaceChildren();

      if (filtered.length === 0) {
        const empty = document.createElement('span');
        empty.style.cssText = 'color:var(--text-muted);font-size:11px;';
        empty.textContent = 'No data in selected range.';
        chartEl.appendChild(empty);
      } else {
        const values = filtered.map(e => e.value);
        const min    = Math.min(...values);
        const max    = Math.max(...values);
        const latest = values[values.length - 1];
        const net    = latest - values[0];
        statsEl.append(
          mkStat('Points',  String(filtered.length), ''),
          mkStat('Current', this._fmtChange(path, latest), ''),
          mkStat('Min',     this._fmtChange(path, min), '#f87171'),
          mkStat('Max',     this._fmtChange(path, max), '#34d399'),
          mkStat('Net Δ',   (net >= 0 ? '+' : '') + this._fmtChange(path, net), net > 0 ? '#34d399' : net < 0 ? '#f87171' : ''),
        );
        chartEl.appendChild(this._renderMetricChartSvg(filtered, path));
      }

      if (activeTab === 'exec') this._renderExecGraphPane(execPane, filtered, path);
    };

    fromInput.addEventListener('change', refreshChart);
    fromInput.addEventListener('input',  refreshChart);
    toInput.addEventListener('change',   refreshChart);
    toInput.addEventListener('input',    refreshChart);

    body.append(filterRow, tabBar, chartPane, execPane);
    modal.append(hdr, body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    refreshChart();
  }

  _renderMetricChartSvg(history, key) {
    const W = 480, H = 110, PL = 8, PR = 8, PT = 8, PB = 20;
    const values = history.map(e => e.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;

    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.style.cssText = 'display:block;';

    const bg = document.createElementNS(NS, 'rect');
    bg.setAttribute('width', W); bg.setAttribute('height', H);
    bg.setAttribute('fill', 'var(--bg-well, #0f172a)');
    svg.appendChild(bg);

    const toX = i => values.length === 1 ? W / 2 : PL + (i / (values.length - 1)) * (W - PL - PR);
    const toY = v => PT + (H - PT - PB) - ((v - min) / range) * (H - PT - PB);
    const pts = values.map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');

    const trend = values[values.length - 1] - values[0];
    const color = trend > 0 ? '#34d399' : trend < 0 ? '#f87171' : '#6b7280';

    const ptsArr = pts.split(' ');
    const firstPt = ptsArr[0].split(',');
    const lastPt  = ptsArr.at(-1).split(',');

    const fill = document.createElementNS(NS, 'polygon');
    fill.setAttribute('points', `${pts} ${lastPt[0]},${H - PB} ${firstPt[0]},${H - PB}`);
    fill.setAttribute('fill', color);
    fill.setAttribute('opacity', '0.1');
    svg.appendChild(fill);

    const poly = document.createElementNS(NS, 'polyline');
    poly.setAttribute('points', pts);
    poly.setAttribute('fill', 'none');
    poly.setAttribute('stroke', color);
    poly.setAttribute('stroke-width', '1.5');
    poly.setAttribute('stroke-linejoin', 'round');
    poly.setAttribute('stroke-linecap', 'round');
    svg.appendChild(poly);

    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('cx', lastPt[0]);
    dot.setAttribute('cy', lastPt[1]);
    dot.setAttribute('r', '3');
    dot.setAttribute('fill', color);
    svg.appendChild(dot);

    if (history.length >= 2) {
      const mkLabel = (x, text, anchor) => {
        const t = document.createElementNS(NS, 'text');
        t.setAttribute('x', x); t.setAttribute('y', H - 4);
        t.setAttribute('text-anchor', anchor);
        t.setAttribute('fill', 'var(--text-muted, #64748b)');
        t.setAttribute('font-size', '9');
        t.setAttribute('font-family', 'monospace');
        t.textContent = text;
        return t;
      };
      const fmtD = d => d instanceof Date ? this._formatDate(d) : String(d);
      svg.appendChild(mkLabel(PL,     fmtD(history[0].date),                 'start'));
      svg.appendChild(mkLabel(W - PR, fmtD(history[history.length - 1].date), 'end'));
    }

    return svg;
  }

  // ── Feature: execution graph pane (metric history modal tab) ─────────────

  _renderExecGraphPane(pane, filteredHistory, fieldPath = null) {
    pane.replaceChildren();

    if (!this._executionGraph) {
      const msg = document.createElement('span');
      msg.style.cssText = 'color:var(--text-muted);font-size:11px;';
      msg.textContent = 'Execution graph not available — enable journaling and rerun.';
      pane.appendChild(msg);
      return;
    }

    if (filteredHistory.length === 0) {
      const msg = document.createElement('span');
      msg.style.cssText = 'color:var(--text-muted);font-size:11px;';
      msg.textContent = 'No data in selected range.';
      pane.appendChild(msg);
      return;
    }

    const toMs = d => (d instanceof Date ? d : new Date(d)).getTime();
    const minT = toMs(filteredHistory[0].date);
    const maxT = toMs(filteredHistory[filteredHistory.length - 1].date) + 86399999;

    const eg = this._executionGraph;

    // Find root event nodes (kind='event', no EXECUTES parent) in the date range.
    let eventNodes = eg.getExecutionNodes()
      .filter(n => n.kind === 'event' && n.timestamp != null)
      .filter(n => { const t = toMs(n.timestamp); return t >= minT && t <= maxT; })
      .filter(n => eg.getParent(n.id) == null)
      .sort((a, b) => toMs(a.timestamp) - toMs(b.timestamp));

    // When a specific field path is provided, keep only events whose subtree
    // contains a reducer that wrote to that field.
    const totalInRange = eventNodes.length;
    if (fieldPath && eventNodes.length > 0) {
      const pathFiltered = eventNodes.filter(n => this._subtreeTouchedPath(n, fieldPath, eg));
      // Fall back to unfiltered if no nodes match (no diff data available).
      if (pathFiltered.length > 0) {
        eventNodes = pathFiltered;
      }
    }

    if (eventNodes.length === 0) {
      const msg = document.createElement('span');
      msg.style.cssText = 'color:var(--text-muted);font-size:11px;';
      msg.textContent = 'No execution nodes found in the selected date range.';
      pane.appendChild(msg);
      return;
    }

    const MAX_EVENTS = 30;
    const shown = eventNodes.length > MAX_EVENTS ? eventNodes.slice(-MAX_EVENTS) : eventNodes;

    const infoBar = document.createElement('div');
    infoBar.style.cssText = 'font-size:10px;color:var(--text-muted);padding:2px 0 6px;border-bottom:1px solid var(--border);margin-bottom:4px;';
    const filteredNote = (fieldPath && eventNodes.length < totalInRange)
      ? ` (filtered to ${eventNodes.length} that wrote ${fieldPath.split('.').pop()})`
      : '';
    infoBar.textContent = eventNodes.length > MAX_EVENTS
      ? `Showing last ${MAX_EVENTS} of ${eventNodes.length} events in range${filteredNote}`
      : `${eventNodes.length} event${eventNodes.length !== 1 ? 's' : ''} in range${filteredNote}`;
    pane.appendChild(infoBar);

    const seen = new Set();
    for (const evNode of shown) {
      this._renderExecTreeNode(pane, evNode, 0, eg, seen);
    }
  }

  /**
   * Returns true if `node` or any descendant reducer in the execution tree
   * has a stateDiff entry touching `fieldPath`.
   */
  _subtreeTouchedPath(node, fieldPath, eg) {
    if (node.kind === 'reducer') {
      return (node.meta?.stateDiff ?? []).some(d => d.field === fieldPath);
    }
    for (const child of (eg.getChildren?.(node.id) ?? [])) {
      if (this._subtreeTouchedPath(child, fieldPath, eg)) return true;
    }
    return false;
  }

  _renderExecTreeNode(container, node, depth, eg, seen) {
    if (seen.has(node.id)) return;
    seen.add(node.id);

    const kindColor = {
      event:   readThemeColor('--kind-event')   || '#3b82f6',
      handler: readThemeColor('--kind-handler') || '#10b981',
      action:  readThemeColor('--kind-action')  || '#8b5cf6',
      reducer: readThemeColor('--kind-reducer') || '#f59e0b',
    };
    const color  = kindColor[node.kind] ?? 'var(--text-primary)';
    const isRoot = depth === 0;

    const row = document.createElement('div');
    row.style.cssText = `display:flex;align-items:flex-start;gap:6px;padding:3px 4px 3px ${isRoot ? 4 : 6 + (depth - 1) * 14}px;border-bottom:1px solid var(--border-subtle,var(--border));`;

    const connector = document.createElement('span');
    connector.style.cssText = 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);flex-shrink:0;padding-top:2px;min-width:14px;';
    connector.textContent = isRoot ? '◆' : '└─';

    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;';

    const nameRow = document.createElement('div');
    nameRow.style.cssText = 'display:flex;align-items:center;gap:5px;flex-wrap:wrap;';

    const kindBadge = document.createElement('span');
    kindBadge.style.cssText = `font-size:8px;padding:0 4px;border-radius:2px;background:${color}22;color:${color};font-weight:600;text-transform:uppercase;letter-spacing:0.05em;flex-shrink:0;`;
    kindBadge.textContent = node.kind;

    const nameSpan = document.createElement('span');
    nameSpan.style.cssText = `color:${color};font-size:11px;font-weight:${isRoot ? '600' : '400'};`;
    nameSpan.textContent = node.name;

    nameRow.append(kindBadge, nameSpan);

    if (node.definitionId && this._onOpenNode) {
      const openBtn = document.createElement('button');
      openBtn.className = 'ad-history-btn';
      openBtn.textContent = '↗';
      openBtn.title = `Open ${node.kind} definition`;
      openBtn.addEventListener('click', () => this._onOpenNode(node.definitionId));
      nameRow.appendChild(openBtn);
    }

    if (node.kind === 'action' && this._journal) {
      const detailBtn = document.createElement('button');
      detailBtn.className = 'ad-history-btn';
      detailBtn.textContent = 'Detail';
      detailBtn.title = 'Show journal entry detail';
      detailBtn.addEventListener('click', () => {
        const entry = this._journal.getByInstanceId(node.id);
        if (entry) { document.getElementById('metricHistoryModal')?.remove(); this.showNodeDetail(entry); }
      });
      nameRow.appendChild(detailBtn);
    }

    info.appendChild(nameRow);

    // Annotate emitted-by for action nodes (incoming EMITS edge)
    if (node.kind === 'action') {
      const emittedByEdges = eg.graph.getIncoming(node.id, EXECUTION_EDGE_TYPES.EMITS);
      if (emittedByEdges.length > 0) {
        const emittedFrom = eg.getNode(emittedByEdges[0].from);
        const meta = document.createElement('div');
        meta.style.cssText = 'font-size:9px;color:var(--text-muted);margin-top:1px;';
        meta.textContent = `emitted by: ${emittedFrom?.name ?? '?'}`;
        info.appendChild(meta);
      }
    }

    // Show state-diff summary on reducer nodes
    if (node.kind === 'reducer' && node.meta?.stateDiff?.length > 0) {
      const diffRow = document.createElement('div');
      diffRow.style.cssText = 'font-size:9px;color:#34d399;margin-top:1px;';
      diffRow.textContent = `${node.meta.stateDiff.length} change${node.meta.stateDiff.length !== 1 ? 's' : ''}: ${node.meta.stateDiff.map(d => d.field).join(', ')}`;
      info.appendChild(diffRow);

      // Show what was emitted (outgoing EMITS edges)
      const emitsEdges = eg.graph.getOutgoing(node.id, EXECUTION_EDGE_TYPES.EMITS);
      if (emitsEdges.length > 0) {
        const emitRow = document.createElement('div');
        emitRow.style.cssText = 'font-size:9px;color:var(--text-muted);margin-top:1px;';
        emitRow.textContent = `→ emits: ${emitsEdges.map(e => eg.getNode(e.to)?.name ?? '?').join(', ')}`;
        info.appendChild(emitRow);
      }
    }

    // Show timestamp on root event nodes
    if (isRoot && node.timestamp) {
      const tsRow = document.createElement('div');
      tsRow.style.cssText = 'font-size:9px;color:var(--text-muted);margin-top:1px;';
      tsRow.textContent = this._formatDate(node.timestamp instanceof Date ? node.timestamp : new Date(node.timestamp));
      info.appendChild(tsRow);
    }

    row.append(connector, info);
    container.appendChild(row);

    // Recurse into EXECUTES children
    const children = eg.getChildren(node.id);
    for (const child of children) {
      this._renderExecTreeNode(container, child, depth + 1, eg, seen);
    }
  }

  _showFieldHistory(field, entries) {
    document.getElementById('stateFieldHistoryModal')?.remove();

    const overlay = document.createElement('div');
    overlay.id        = 'stateFieldHistoryModal';
    overlay.className = 'sim-modal-overlay';
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    const modal = document.createElement('div');
    modal.className   = 'sim-modal';
    modal.style.width = '580px';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;';

    const title       = document.createElement('span');
    title.style.cssText = 'font-size:12px;font-weight:600;';
    title.textContent = `Field History — ${field}`;

    const closeBtn       = document.createElement('button');
    closeBtn.className   = 'btn btn-sm';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => overlay.remove());
    header.append(title, closeBtn);

    const body             = document.createElement('div');
    body.style.cssText     = 'overflow-y:auto;flex:1;';

    if (!entries || entries.length === 0) {
      const empty       = document.createElement('span');
      empty.style.color = 'var(--text-muted)';
      empty.textContent = 'No changes recorded for this field.';
      body.appendChild(empty);
    } else {
      // ── Period analytics ──────────────────────────────────────────────────
      const periodRow = document.createElement('div');
      periodRow.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:10px;padding:4px 0;border-bottom:1px solid var(--border);margin-bottom:4px;flex-wrap:wrap;';
      const inputStyle = 'font-size:10px;padding:1px 4px;background:var(--bg-panel2,#111);color:var(--text-primary,#e5e7eb);border:1px solid var(--border);border-radius:2px;';

      const fromLbl = document.createElement('span');
      fromLbl.style.color = 'var(--text-muted)';
      fromLbl.textContent = 'Period:';

      const fromInput = document.createElement('input');
      fromInput.type = 'date';
      fromInput.style.cssText = inputStyle;
      fromInput.value = this._toDateInputVal(entries[0].date);

      const toArrow = document.createElement('span');
      toArrow.style.color = 'var(--text-muted)';
      toArrow.textContent = '→';

      const toInput = document.createElement('input');
      toInput.type = 'date';
      toInput.style.cssText = inputStyle;
      toInput.value = this._toDateInputVal(entries[entries.length - 1].date);

      const netSpan = document.createElement('span');
      netSpan.style.cssText = 'font-family:var(--font-mono);font-size:11px;margin-left:4px;';

      const updateNet = () => {
        const from = fromInput.value ? new Date(fromInput.value) : null;
        const to   = toInput.value   ? new Date(new Date(toInput.value).getTime() + 86399999) : null;
        const filtered = entries.filter(e => {
          const d = e.date instanceof Date ? e.date : new Date(e.date);
          if (from && d < from) return false;
          if (to   && d > to)   return false;
          return true;
        });
        const net = filtered.reduce((s, e) => s + (typeof e.delta === 'number' ? e.delta : 0), 0);
        netSpan.style.color = net > 0 ? '#34d399' : net < 0 ? '#f87171' : 'var(--text-muted)';
        netSpan.textContent = `Net Δ: ${net >= 0 ? '+' : ''}${this._fmtChange(field, net)}  (${filtered.length}/${entries.length})`;
      };

      fromInput.addEventListener('change', updateNet);
      fromInput.addEventListener('input',  updateNet);
      toInput.addEventListener('change',   updateNet);
      toInput.addEventListener('input',    updateNet);
      periodRow.append(fromLbl, fromInput, toArrow, toInput, netSpan);
      body.appendChild(periodRow);
      updateNet();

      // ── History table ─────────────────────────────────────────────────────
      const table         = document.createElement('table');
      table.style.cssText = 'width:100%;border-collapse:collapse;';
      const thead = table.createTHead();
      const hrow  = thead.insertRow();
      const thStyle = 'text-align:left;padding:2px 6px;font-size:9px;letter-spacing:0.06em;color:var(--text-muted);border-bottom:1px solid var(--border);';
      for (const col of ['Date', 'Event', 'Action', 'Before', 'After', 'Δ Delta']) {
        const th       = document.createElement('th');
        th.textContent = col;
        th.style.cssText = thStyle;
        hrow.appendChild(th);
      }
      const tbody = table.createTBody();
      for (const e of entries) {
        const tr       = tbody.insertRow();
        tr.style.cssText = 'border-bottom:1px solid var(--border-subtle,var(--border));';
        const dateStr  = e.date instanceof Date ? this._formatDate(e.date) : String(e.date);
        const deltaStr = e.delta != null
          ? (e.delta > 0 ? '+' : '') + this._fmtChange(field, e.delta)
          : '—';
        const deltaColor = e.delta > 0
          ? 'var(--accent-green,#4a8)'
          : e.delta < 0 ? 'var(--accent-red,#e55)' : '';
        const cells = [
          { text: dateStr,                          style: '' },
          { text: e.eventType  ?? '—',              style: 'color:var(--text-muted);' },
          { text: e.actionType ?? '—',              style: 'color:var(--text-muted);' },
          { text: this._fmtChange(field, e.before), style: 'font-family:var(--font-mono);' },
          { text: this._fmtChange(field, e.after),  style: 'font-family:var(--font-mono);' },
          { text: deltaStr, style: `font-family:var(--font-mono);${deltaColor ? 'color:' + deltaColor + ';' : ''}` },
        ];
        for (const { text, style } of cells) {
          const td         = tr.insertCell();
          td.textContent   = text;
          td.style.cssText = 'padding:3px 6px;font-size:11px;' + style;
        }
      }
      body.appendChild(table);
    }

    modal.append(header, body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  // ── Feature: sparkline ───────────────────────────────────────────────────

  _renderSparkline(field, seq) {
    if (!this._journal) return null;
    const timeline = this._journal.getStateTimelineUpTo(field, seq);
    const values = timeline.map(e => e.after).filter(v => typeof v === 'number' && isFinite(v));
    if (values.length < 2) return null;

    const W = 56, H = 14, P = 1;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;

    const pts = values.map((v, i) => {
      const x = P + (i / (values.length - 1)) * (W - P * 2);
      const y = P + (H - P * 2) - ((v - min) / range) * (H - P * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');

    const trend = values[values.length - 1] - values[0];
    const color = trend > 0 ? '#34d399' : trend < 0 ? '#f87171' : '#6b7280';

    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.style.cssText = 'flex-shrink:0;vertical-align:middle;';
    svg.setAttribute('title', `Trend over ${values.length} points: ${trend >= 0 ? '+' : ''}${trend.toFixed(2)}`);

    const poly = document.createElementNS(NS, 'polyline');
    poly.setAttribute('points', pts);
    poly.setAttribute('fill', 'none');
    poly.setAttribute('stroke', color);
    poly.setAttribute('stroke-width', '1.5');
    poly.setAttribute('stroke-linejoin', 'round');
    poly.setAttribute('stroke-linecap', 'round');
    svg.appendChild(poly);

    const lastPt = pts.split(' ').at(-1).split(',');
    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('cx', lastPt[0]);
    dot.setAttribute('cy', lastPt[1]);
    dot.setAttribute('r', '2');
    dot.setAttribute('fill', color);
    svg.appendChild(dot);

    return svg;
  }

  // ── Feature: causal chain view ───────────────────────────────────────────

  _showCausalChain(entry) {
    const chain = [entry];
    const seen  = new Set([entry.action.instanceId]);
    let cur = entry;
    while (cur.action?.parentId && this._journal) {
      const parent = this._journal.getByInstanceId(cur.action.parentId);
      if (!parent || seen.has(parent.action.instanceId)) break;
      seen.add(parent.action.instanceId);
      chain.unshift(parent);
      cur = parent;
    }

    document.getElementById('causalChainModal')?.remove();
    const overlay = document.createElement('div');
    overlay.id        = 'causalChainModal';
    overlay.className = 'sim-modal-overlay';
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    const modal = document.createElement('div');
    modal.className   = 'sim-modal';
    modal.style.width = '520px';

    const hdr = document.createElement('div');
    hdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;';
    const hdrTitle = document.createElement('span');
    hdrTitle.style.cssText = 'font-size:12px;font-weight:600;';
    hdrTitle.textContent   = `Causal Chain — ${chain.length} action${chain.length !== 1 ? 's' : ''}`;
    const closeBtn = document.createElement('button');
    closeBtn.className   = 'btn btn-sm';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => overlay.remove());
    hdr.append(hdrTitle, closeBtn);

    const body = document.createElement('div');
    body.style.cssText = 'overflow-y:auto;flex:1;';

    for (let i = 0; i < chain.length; i++) {
      const node      = chain[i];
      const isCurrent = node === entry;

      const row = document.createElement('div');
      row.style.cssText = `display:flex;align-items:flex-start;gap:6px;padding:6px 6px 6px ${6 + i * 16}px;border-bottom:1px solid var(--border-subtle,var(--border));${isCurrent ? 'background:var(--bg-panel2,#1a1a1a);' : ''}`;

      const connector = document.createElement('span');
      connector.style.cssText = 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);flex-shrink:0;padding-top:1px;';
      connector.textContent   = i === 0 ? '◆' : '└─';

      const info = document.createElement('div');
      info.style.cssText = 'flex:1;';

      const nameRow = document.createElement('div');
      nameRow.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11px;';

      const name = document.createElement('span');
      name.style.cssText = 'color:var(--accent-blue,#60a5fa);font-weight:500;';
      name.textContent   = node.action.name ?? node.action.type;

      const badge = document.createElement('span');
      badge.className   = 'ad-type-badge';
      badge.textContent = node.action.type;

      nameRow.append(name, badge);

      if (isCurrent) {
        const curBadge = document.createElement('span');
        curBadge.style.cssText = 'font-size:9px;padding:1px 5px;background:var(--amber,#f59e0b);color:#000;border-radius:2px;';
        curBadge.textContent   = 'current';
        nameRow.appendChild(curBadge);
      } else {
        const detailBtn = document.createElement('button');
        detailBtn.className   = 'ad-history-btn';
        detailBtn.textContent = 'Detail ↗';
        detailBtn.addEventListener('click', () => { overlay.remove(); this.showNodeDetail(node); });
        nameRow.appendChild(detailBtn);
      }

      const meta = document.createElement('div');
      meta.style.cssText = 'font-size:9px;color:var(--text-muted);margin-top:2px;';
      meta.textContent   = `${this.fmtVal(node.date)}  ·  ${node.event?.name ?? node.event?.type ?? '—'}  ·  sibling ${node.action.siblingIndex ?? 0}`;

      info.append(nameRow, meta);
      row.append(connector, info);
      body.appendChild(row);
    }

    modal.append(hdr, body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  // ── Feature: cross-action pattern query ──────────────────────────────────

  _showCrossActionModal(defaultField, defaultActionType) {
    if (!this._journal) return;
    const actionTypes = this._journal.getActionTypes();
    const allFields   = this._journal.getChangedFields();

    document.getElementById('crossActionModal')?.remove();
    const overlay = document.createElement('div');
    overlay.id        = 'crossActionModal';
    overlay.className = 'sim-modal-overlay';
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    const modal = document.createElement('div');
    modal.className   = 'sim-modal';
    modal.style.width = '640px';

    const hdr = document.createElement('div');
    hdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;';
    const hdrTitle = document.createElement('span');
    hdrTitle.style.cssText = 'font-size:12px;font-weight:600;';
    hdrTitle.textContent   = 'Field × Action Query';
    const closeBtn = document.createElement('button');
    closeBtn.className   = 'btn btn-sm';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => overlay.remove());
    hdr.append(hdrTitle, closeBtn);

    const selStyle = 'font-size:11px;padding:2px 6px;background:var(--bg-panel2,#111);color:var(--text-primary,#e5e7eb);border:1px solid var(--border);border-radius:3px;flex:1;min-width:140px;';

    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';

    const fieldSel = document.createElement('select');
    fieldSel.style.cssText = selStyle;
    for (const f of allFields) {
      const o = document.createElement('option');
      o.value = f; o.textContent = f;
      if (f === defaultField) o.selected = true;
      fieldSel.appendChild(o);
    }

    const actionSel = document.createElement('select');
    actionSel.style.cssText = selStyle;
    for (const t of actionTypes) {
      const o = document.createElement('option');
      o.value = t; o.textContent = t;
      if (t === defaultActionType) o.selected = true;
      actionSel.appendChild(o);
    }

    const runBtn = document.createElement('button');
    runBtn.className   = 'btn btn-sm';
    runBtn.textContent = 'Run';

    const mkLabel = text => {
      const l = document.createElement('span');
      l.style.cssText = 'font-size:10px;color:var(--text-muted);flex-shrink:0;';
      l.textContent = text;
      return l;
    };
    controls.append(mkLabel('Field:'), fieldSel, mkLabel('Action:'), actionSel, runBtn);

    const results = document.createElement('div');
    results.style.cssText = 'overflow-y:auto;flex:1;';

    const runQuery = () => {
      const field      = fieldSel.value;
      const actionType = actionSel.value;
      results.innerHTML = '';

      const rows = this._journal.getActions(actionType)
        .map(e => ({ e, diff: e.stateDiff?.find(d => d.field === field) }))
        .filter(({ diff }) => diff != null);

      if (rows.length === 0) {
        const empty = document.createElement('span');
        empty.style.cssText = 'color:var(--text-muted);font-size:11px;';
        empty.textContent   = `No changes to "${field}" found in "${actionType}" actions.`;
        results.appendChild(empty);
        return;
      }

      const totalDelta = rows.reduce((s, { diff }) => s + (typeof diff.delta === 'number' ? diff.delta : 0), 0);
      const summary = document.createElement('div');
      summary.style.cssText = 'font-size:10px;color:var(--text-muted);padding:4px 0;border-bottom:1px solid var(--border);margin-bottom:6px;display:flex;gap:12px;';
      const cntSpan = document.createElement('span');
      cntSpan.textContent = `${rows.length} occurrence${rows.length !== 1 ? 's' : ''}`;
      const netSpan = document.createElement('span');
      netSpan.style.color = totalDelta >= 0 ? '#34d399' : '#f87171';
      netSpan.textContent = `Net Δ: ${totalDelta >= 0 ? '+' : ''}${this._fmtChange(field, totalDelta)}`;
      summary.append(cntSpan, netSpan);
      results.appendChild(summary);

      const table = document.createElement('table');
      table.style.cssText = 'width:100%;border-collapse:collapse;';
      const thead = table.createTHead();
      const hrow  = thead.insertRow();
      const thStyle = 'text-align:left;padding:2px 6px;font-size:9px;letter-spacing:0.06em;color:var(--text-muted);border-bottom:1px solid var(--border);';
      for (const col of ['Date', 'Event', 'Before', 'After', 'Δ Delta']) {
        const th = document.createElement('th');
        th.textContent   = col;
        th.style.cssText = thStyle;
        hrow.appendChild(th);
      }
      const tbody = table.createTBody();
      for (const { e, diff } of rows) {
        const tr = tbody.insertRow();
        tr.style.cssText = 'border-bottom:1px solid var(--border-subtle,var(--border));cursor:pointer;';
        tr.title = 'Click to view action detail';
        tr.addEventListener('click', () => { overlay.remove(); this.showNodeDetail(e); });
        const dStr = diff.delta != null ? (diff.delta > 0 ? '+' : '') + this._fmtChange(field, diff.delta) : '—';
        const dCol = diff.delta > 0 ? '#34d399' : diff.delta < 0 ? '#f87171' : '';
        const cells = [
          { text: this.fmtVal(e.date),                  style: '' },
          { text: e.event?.name ?? e.event?.type ?? '—', style: 'color:var(--text-muted);' },
          { text: this._fmtChange(field, diff.before),   style: 'font-family:var(--font-mono);' },
          { text: this._fmtChange(field, diff.after),    style: 'font-family:var(--font-mono);' },
          { text: dStr, style: `font-family:var(--font-mono);${dCol ? 'color:' + dCol + ';' : ''}` },
        ];
        for (const { text, style } of cells) {
          const td = tr.insertCell();
          td.textContent   = text;
          td.style.cssText = 'padding:3px 6px;font-size:11px;' + style;
        }
      }
      results.appendChild(table);
    };

    runBtn.addEventListener('click', runQuery);
    modal.append(hdr, controls, results);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    if (defaultField && defaultActionType) runQuery();
  }

  // ── Feature: date-input helper ────────────────────────────────────────────

  _toDateInputVal(date) {
    if (!date) return '';
    const d = date instanceof Date ? date : new Date(date);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  buildActionDetail(entry) {
    const changes = entry.stateDiff ?? [];
    const emitted = entry.emittedTypes?.length
      ? entry.emittedTypes.join(', ')
      : '(none)';
    const actionPayload = this._formatActionPayload(entry.action);
    return { changes, emitted, actionPayload };
  }

  /**
   * Serialize an action for the payload view, annotating currency-typed data
   * fields (per the TypeRegistry) with their display-currency value so money is
   * legible in the active currency (design 10 §Phase 4). Non-money fields and
   * the action structure are rendered verbatim. Falls back to a plain dump when
   * no TypeRegistry/converter is wired.
   */
  _formatActionPayload(action) {
    const fields  = this._typeRegistry?.getAction?.(action.type)?.fields ?? {};
    const display = this._schemaRegistry?.displayCurrencyCode?.() ?? null;
    const replacer = (key, val) => {
      const vt = fields[key];
      if (vt?.kind === 'currency' && vt.opts?.code && typeof val === 'number'
          && display && display !== vt.opts.code) {
        const disp = this._schemaRegistry.formatAmount(val, vt.opts.code);
        if (disp) return `${val} ${vt.opts.code} → ${disp}`;
      }
      return val;
    };
    return JSON.stringify({ ...action, data: action.data }, replacer, 2);
  }

  getNodeDetail(node) {
    return JSON.stringify({ type: node.type, date: node.date, stateDiff: node.stateDiff ?? [] }, null, 2);
  }

  // ── Formatting helpers ────────────────────────────────────────────────────
  //TODO Extract to shared UI class #139

  /**
   * Format a state-diff value using the schema registry when available,
   * falling back to fmtVal for types the registry returns null for
   * (arrays, objects, unregistered non-numeric fields).
   */
  _fmtChange(field, value, objAsCode = false) {
    if (this._schemaRegistry) {
      const formatted = this._schemaRegistry.format(field, value);
      if (formatted !== null) return formatted;
    }
    return this.fmtVal(value, objAsCode);
  }

  fmtVal(v, objAsCode = false) {
    if (v == null) return '—';
    if (typeof v === 'number') return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (Array.isArray(v)) return this.fmtArray(v, objAsCode);
    if (this.isDate(v)) return this._formatDate(v);
    if (typeof v === 'object') {
      if (objAsCode) return `<pre class="text-wrap:auto">${JSON.stringify(v, null, 2)}</pre>`;
      return JSON.stringify(v);
    }
    return String(v);
  }

  fmtArray(v, objAsCode = false) {
    if (!Array.isArray(v)) return '';
    const limit = 10;
    const sliced = v.slice(0, limit).map(x => this.fmtVal(x, objAsCode)).join(', ') || '—';
    return v.length > limit ? `${sliced}, ...` : sliced;
  }

  getNestedProperty(obj, path) {
    return path.split('.').reduce((acc, part) => acc && acc[part], obj);
  }

  isDate(obj) {
    return Object.prototype.toString.call(obj) === '[object Date]';
  }

  toLabel(key) {
    return key.replace(/([A-Z])/g, ' $1')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase())
      .trim();
  }

  renderObj(v) {
    if (v == null) return '—';
    if (Array.isArray(v)) {
      if (v.length === 0) return '—';
      if (v.every(x => typeof x === 'number')) return this.fmtArray(v);
      return v.map(x => (typeof x === 'object' ? this.renderObj(x) : String(x))).join(', ');
    }
    if (typeof v === 'object') {
      if (v instanceof Date) return this._formatDate(v);
      let result = '{ ';
      for (const f in v) {
        result += f + ': ' + this.renderObj(v[f]) + ' }';
      }
      return result;
    }
    return String(v);
  }

  /**
   * Section header row: a single flex line of [caret][tri-state checkbox][label].
   * Clicking the row (not the checkbox) folds/unfolds the section; the checkbox
   * (R5) is tri-state: checked = all descendants charted, indeterminate = some.
   * @param {string}   label
   * @param {string[]} [descendantPaths]
   * @param {boolean}  [alreadyLabel] - true when label is already human-readable
   * @param {string}   [sectionPath]  - stable key for fold state (enables the caret)
   * @param {boolean}  [expanded]
   */
  renderHeaderRow(label, descendantPaths = null, alreadyLabel = false, sectionPath = null, expanded = false) {
    const headerRow = document.createElement('div');
    headerRow.className = 'lsp-section-header';

    if (sectionPath != null) {
      const caret = document.createElement('span');
      caret.className = 'lsp-section-caret';
      caret.textContent = expanded ? '▼' : '▶';
      headerRow.appendChild(caret);
    }

    if (this._onChartToggle && Array.isArray(descendantPaths) && descendantPaths.length > 0) {
      headerRow.appendChild(this._buildSectionToggle(descendantPaths));
    }

    const header = document.createElement('span');
    header.className = 'lsp-section-label';
    header.textContent = alreadyLabel ? label : this.toLabel(label);
    headerRow.appendChild(header);

    if (sectionPath != null) {
      headerRow.addEventListener('click', (e) => {
        if (e.target.classList.contains('lsp-chart-toggle')) return; // checkbox handles itself
        this._toggleSection(sectionPath);
      });
    }
    return headerRow;
  }

  /** Tri-state checkbox that activates/deactivates every descendant path (R5). */
  _buildSectionToggle(descendantPaths) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'lsp-chart-toggle lsp-section-toggle';
    cb.title = 'Show all of these on chart';

    const charted = descendantPaths.filter(p => this._isPathCharted(p)).length;
    cb.checked       = charted === descendantPaths.length;
    cb.indeterminate = charted > 0 && charted < descendantPaths.length;

    cb.addEventListener('click', e => e.stopPropagation()); // don't fold the section
    cb.addEventListener('change', () => {
      const activate = cb.checked;
      // Soft warning past a threshold — many mixed-type series hurt readability (D18).
      if (activate && descendantPaths.length > 25 &&
          !window.confirm(`Charting ${descendantPaths.length} series may be hard to read. Continue?`)) {
        cb.checked = false;
        return;
      }
      for (const p of descendantPaths) this._onChartToggle?.(p, activate);
      this._refreshRows();   // reflect child checkboxes + tri-state after the batch
    });
    return cb;
  }
}
