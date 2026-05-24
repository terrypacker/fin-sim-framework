/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { $ } from '../visualization/ui-utils.js';

/**
 * StatePanelView — pure DOM layer for state/metrics panels and node detail.
 *
 * Owns:
 *  - State panel rendering (updateStatePanel, renderState, createStateDetails)
 *  - Node detail panel (showNodeDetail, showNodeStateChanges, createActionDetail)
 *  - diffStates computation
 *  - All value-formatting helpers (fmtVal, fmtArray, toLabel, isDate, renderObj, renderHeaderRow)
 *
 * formatDate is injected via the setter and defaults to Date.toDateString().
 * BaseApp calls `this._statePanelView.formatDate = currentFmt` on each buildScenario()
 * and when the TZ selector changes.
 */
export class StatePanelView {

  constructor() {
    this._formatDate = d => d.toDateString();
  }

  /** Update the active date-format function (UTC vs local). */
  set formatDate(fn) {
    this._formatDate = fn ?? (d => d.toDateString());
  }

  // ── State panel rendering ─────────────────────────────────────────────────

  updateStatePanel(date, state) {
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
          statRow.querySelector('.stat-value').innerText = typeof sv === 'object' ? this.renderObj(sv) : sv;
          statGrid.appendChild(statRow);
        }
      } else {
        const statRow = document.importNode(statGrid.querySelector('[data-stat-row]'), true);
        statRow.style = '';
        statRow.querySelector('.stat-label').innerText = this.toLabel(k);
        statRow.querySelector('.stat-value').innerText = typeof v === 'object' ? this.renderObj(v) : this.fmtVal(v);
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
    const actionDetail = this.buildActionDetail(entry);
    const { changes, emitted, actionPayload } = actionDetail;
    const newActionDetails = this.createActionDetail('tpl-action-template', { entry, changes, emitted, actionPayload });
    $('actionPanelDetails').replaceChildren(newActionDetails);
  }

  createActionDetail(templateId, content) {
    const templateContent = document.querySelector(`#${templateId}`);
    const clone = document.importNode(templateContent, true).content;

    const overviewGrid = clone.querySelector('[data-overview-grid]');
    const fields = overviewGrid.querySelectorAll('[data-id]');
    for (const field of fields) {
      const value = this.getNestedProperty(content, field.getAttribute('data-id'));
      field.innerText = this.fmtVal(value);
    }

    const stateChangeGridTemplate = document.querySelector('#tpl-node-state-changes');
    const stateChangesGrid = stateChangeGridTemplate.content.firstElementChild.cloneNode(true);
    const prevState = JSON.stringify(content.entry.prevState, null, 2);
    this._populateStateChanges(stateChangesGrid, content.changes, prevState);

    const stateChangesPlaceholder = clone.querySelector('[data-state-change-grid]');
    stateChangesPlaceholder.replaceWith(stateChangesGrid);
    return clone;
  }

  _populateStateChanges(stateChangesGrid, changes, prevState = null) {
    if (changes.length > 0) {
      for (const change of changes) {
        const stateChangeFieldRow = document.importNode(stateChangesGrid.querySelector('[data-state-change-field-row]'), true);
        stateChangeFieldRow.style = '';
        stateChangeFieldRow.querySelector('[data-id="field"]').innerText = change.field;
        stateChangesGrid.appendChild(stateChangeFieldRow);

        const stateChangeBeforeRow = document.importNode(stateChangesGrid.querySelector('[data-state-change-before-row]'), true);
        stateChangeBeforeRow.style = '';
        stateChangeBeforeRow.querySelector('[data-id="before"]').innerHTML = this.fmtVal(change.before, true);
        stateChangesGrid.appendChild(stateChangeBeforeRow);

        const stateChangeAfterRow = document.importNode(stateChangesGrid.querySelector('[data-state-change-after-row]'), true);
        stateChangeAfterRow.style = '';
        if (change.delta != null) {
          const after = stateChangeAfterRow.querySelector('[data-id="after"]');
          const delta = document.createElement('span');
          if (change.delta > 0) {
            delta.classList.add('diff-pos');
            delta.innerText = '+' + this.fmtVal(change.delta);
          } else {
            delta.classList.add('diff-neg');
            delta.innerText = '-' + this.fmtVal(change.delta);
          }
          after.innerHTML = this.fmtVal(change.after, true);
          after.appendChild(delta);
        } else {
          stateChangeAfterRow.querySelector('[data-id="after"]').innerHTML = this.fmtVal(change.after, true);
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

  buildActionDetail(entry) {
    const changes = this.diffStates(entry.prevState, entry.nextState);
    const emitted = entry.emittedActions?.length
      ? entry.emittedActions.map(a => a.type).join(', ')
      : '(none)';
    const actionPayload = JSON.stringify(
      Object.fromEntries(Object.entries(entry.action).filter(([k]) => !k.startsWith('_'))),
      null, 2
    );
    return { changes, emitted, actionPayload };
  }

  getNodeDetail(node) {
    const diff = this.diffStates(node.stateBefore, node.stateAfter);
    return JSON.stringify({ ...node, stateDiff: diff }, null, 2);
  }

  // ── Diff ──────────────────────────────────────────────────────────────────

  /**
   * Compute the difference between two state snapshots.
   * Returns an array of { field, before, after, delta } records.
   */
  diffStates(prev, next) {
    const changes = [];
    if (!prev || !next) return changes;

    // Ledger arrays grow on every transaction — skip them to keep diffs readable.
    const SKIP_KEYS = new Set(['credits', 'debits']);

    const walk = (b, a, prefix) => {
      const leafKey = prefix.split('.').pop();
      if (SKIP_KEYS.has(leafKey)) return;
      const bIsObj = typeof b === 'object' && b !== null && !Array.isArray(b);
      const aIsObj = typeof a === 'object' && a !== null && !Array.isArray(a);
      if (bIsObj && aIsObj) {
        for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
          walk(b[key], a[key], prefix ? `${prefix}.${key}` : key);
        }
      } else if (JSON.stringify(b) !== JSON.stringify(a)) {
        const delta = typeof a === 'number' && typeof b === 'number' ? a - b : null;
        changes.push({ field: prefix, before: b ?? null, after: a ?? null, delta });
      }
    };

    for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
      walk(prev[key], next[key], key);
    }

    return changes;
  }

  // ── Formatting helpers ────────────────────────────────────────────────────

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
