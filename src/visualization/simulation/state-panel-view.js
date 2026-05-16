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

/**
 * StatePanelView — pure DOM layer for state/metrics panels and node detail.
 *
 * Owns:
 *  - State panel rendering (updateStatePanel, renderState, createStateDetails)
 *  - Node detail panel (showNodeDetail, showNodeStateChanges, createActionDetail)
 *
 * formatDate is injected via the setter and defaults to Date.toDateString().
 * BaseApp calls `this._statePanelView.formatDate = currentFmt` on each buildScenario()
 * and when the TZ selector changes.
 */
export class StatePanelView extends BaseComponent {

  constructor() {
    super();
    this._formatDate        = d => d.toDateString();
    this._schemaRegistry    = null;
    this._pendingDate       = null;
    this._pendingState      = null;
    this._drainExecEndMsgs  = () => [];
    this._chartPresenter    = null;
    this._lastOutOfFundsDate = null;
    this._onOpenNode        = null;
    this._journal           = null;
  }

  /** Update the active date-format function (UTC vs local). */
  set formatDate(fn) {
    this._formatDate = fn ?? (d => d.toDateString());
  }

  /** Inject the StateSchemaRegistry for context-aware value formatting. */
  set schemaRegistry(r) {
    this._schemaRegistry = r ?? null;
  }

  /** Inject a callback to open a config-graph node in the edit modal. */
  set onOpenNode(fn) {
    this._onOpenNode = fn ?? null;
  }

  /** Inject the current journal for parent lookup and field history. */
  set journal(j) {
    this._journal = j ?? null;
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
      this._renderStatePanel(this._pendingDate, this._pendingState);
      this._updateFailureBanner(this._pendingState);
    }
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
      if (defSpan)    defSpan.textContent    = '$' + Math.round(stateSnapshot.cumulativeDeficit ?? 0).toLocaleString();
      if (monthsSpan) monthsSpan.textContent = stateSnapshot.deficitMonths ?? 0;
    }
  }

  _renderStatePanel(date, state) {
    if (!state) return;
    const { metrics, ...rest } = state;
    const newStateDetails = this.createStateDetails('tpl-state-details', date, rest);
    const stateDetails = $('currentStateContent');
    stateDetails.replaceChildren(newStateDetails);

    const newMetricDetails = this.createStateDetails('tpl-state-details', date, metrics);
    const metricDetails = $('cumulativeMetricsContent');
    metricDetails.replaceChildren(newMetricDetails);
  }

  createStateDetails(templateId, date, state) {
    if (!state) return;
    const templateContent = document.querySelector(`#${templateId}`);
    const clone = document.importNode(templateContent, true).content;
    const statGrid = clone.querySelector('[data-stat-grid]');
    this.renderState(state, statGrid);
    return clone;
  }

  renderState(obj, statGrid) {
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v) && v.length > 0 && v[0] !== null && typeof v[0] === 'object') {
        const arrayHeaderRow = this.renderHeaderRow(k);
        statGrid.appendChild(arrayHeaderRow);

        let index = 0;
        for (const item of v) {
          let name, value;
          if (this.isDate(item)) {
            name  = '[' + index + ']';
            value = this._formatDate(item);
          } else {
            name  = item.name ?? JSON.stringify(item);
            value = item.value != null ? item.value : '';
          }
          const arrayRow = document.importNode(statGrid.querySelector('[data-stat-row]'), true);
          arrayRow.style = '';
          arrayRow.querySelector('.stat-label').innerText = name;
          arrayRow.querySelector('.stat-value').innerText = value;
          statGrid.appendChild(arrayRow);
          index++;
        }
      } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        const objectHeaderRow = this.renderHeaderRow(k);
        statGrid.appendChild(objectHeaderRow);
        for (const [sk, sv] of Object.entries(v)) {
          if (Array.isArray(sv) && sv.length > 0 && typeof sv[0] === 'object') continue;
          const statRow = document.importNode(statGrid.querySelector('[data-stat-row]'), true);
          statRow.style = '';
          statRow.querySelector('.stat-label').innerText = this.toLabel(sk);
          statRow.querySelector('.stat-value').innerText = typeof sv === 'object' ? this.renderObj(sv) : this._fmtChange(`${k}.${sk}`, sv);
          statGrid.appendChild(statRow);
        }
      } else {
        const statRow = document.importNode(statGrid.querySelector('[data-stat-row]'), true);
        statRow.style = '';
        statRow.querySelector('.stat-label').innerText = this.toLabel(k);
        statRow.querySelector('.stat-value').innerText = typeof v === 'object' ? this.renderObj(v) : this._fmtChange(k, v);
        statGrid.appendChild(statRow);
      }
    }
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

  showNodeDetail(entry) {
    const { changes, emitted, actionPayload } = this.buildActionDetail(entry);
    const parentInfo = this._getParentInfo(entry);
    const el = this._buildActionDetailEl({ entry, changes, emitted, actionPayload, parentInfo });
    $('actionPanelDetails').replaceChildren(el);
    // Auto-switch right column to the action detail tab.
    document.querySelector('.tab-header[data-dest-tab="right-action-detail"]')?.click();
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
    clone.querySelector('[data-id="parent-info"]').innerText  = parentInfo;
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

  buildActionDetail(entry) {
    const changes = entry.stateDiff ?? [];
    const emitted = entry.emittedTypes?.length
      ? entry.emittedTypes.join(', ')
      : '(none)';
    const actionPayload = JSON.stringify(
      { ...entry.action, data: entry.action.data },
      null, 2
    );
    return { changes, emitted, actionPayload };
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

  renderHeaderRow(label) {
    const headerRow = document.createElement('div');
    headerRow.classList.add('data-row-header');
    const header = document.createElement('span');
    header.classList.add('single-row');
    header.innerText = this.toLabel(label);
    headerRow.appendChild(header);
    return headerRow;
  }
}
