/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { WorkbenchComponent } from '../../component.js';
import { WB_EVENTS }          from '../../workbench-runtime.js';
import { ServiceRegistry }    from '../../../../services/service-registry.js';

/**
 * CrossActionQueryPlugin — panel for querying how a state field changes across
 * all occurrences of a given action type throughout a simulation run.
 *
 * Promoted from the _showCrossActionModal in StatePanelView.
 * The ActionDetail "Field × Action" button now publishes CROSS_ACTION_QUERY_OPEN
 * to open this panel and pre-seed its selectors.
 */
export class CrossActionQueryPlugin extends WorkbenchComponent {
  constructor(runtime) {
    super();
    this._runtime        = runtime;
    this._journal        = null;
    this._schemaRegistry = null;
    this._pendingField   = null;
    this._pendingAction  = null;
  }

  render() {
    const root = document.createElement('div');
    root.className = 'caq-plugin wb-plugin-fill';
    root.innerHTML = `
      <div class="caq-toolbar">
        <span class="caq-label">Field</span>
        <input class="caq-input" data-caq="field-input" list="caq-field-list" placeholder="type to filter…" autocomplete="off" />
        <datalist data-caq="field-list" id="caq-field-list"></datalist>
        <span class="caq-label">Action</span>
        <input class="caq-input" data-caq="action-input" list="caq-action-list" placeholder="type to filter…" autocomplete="off" />
        <datalist data-caq="action-list" id="caq-action-list"></datalist>
        <button class="btn btn-sm" data-caq="run-btn">Run</button>
      </div>
      <div class="caq-results" data-caq="results">
        <span class="caq-placeholder">Select a field and action type, then click Run.</span>
      </div>
    `;
    return root;
  }

  onInit() {
    this._runtime.bus.subscribe(WB_EVENTS.SCENARIO_READY, ({ scenario }) => {
      this._bindJournal(scenario?.sim?.journal ?? null);
    });

    this._runtime.bus.subscribe(WB_EVENTS.CROSS_ACTION_QUERY_OPEN, ({ field, actionType }) => {
      this._openPreset(field, actionType);
    });

    // Re-run on display-currency change so results reformat in the new currency
    // (design 10 §Phase 4) — only when a query is already showing.
    this._runtime.bus.subscribe(WB_EVENTS.DISPLAY_SETTINGS_CHANGED, () => {
      if (this._mounted && this._q('field-input')?.value.trim() && this._q('action-input')?.value.trim()) {
        this._runQuery();
      }
    });
  }

  onMount() {
    const runBtn = this._q('run-btn');
    if (runBtn && !runBtn._caqBound) {
      runBtn.addEventListener('click', () => this._runQuery());
      runBtn._caqBound = true;
    }

    for (const key of ['field-input', 'action-input']) {
      const input = this._q(key);
      if (input && !input._caqBound) {
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._runQuery(); });
        input._caqBound = true;
      }
    }

    this._rebuildSelects();

    if (this._pendingField !== null || this._pendingAction !== null) {
      const field      = this._pendingField;
      const actionType = this._pendingAction;
      this._pendingField  = null;
      this._pendingAction = null;
      this._applyPreset(field, actionType);
    }
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  _q(name) {
    return this.el?.querySelector(`[data-caq="${name}"]`) ?? null;
  }

  _bindJournal(journal) {
    this._journal        = journal;
    this._schemaRegistry = ServiceRegistry.getInstance()?.schemaRegistry ?? null;
    if (this._mounted) this._rebuildSelects();
  }

  _openPreset(field, actionType) {
    if (this._mounted) {
      this._applyPreset(field, actionType);
    } else {
      this._pendingField  = field;
      this._pendingAction = actionType;
    }
  }

  _applyPreset(field, actionType) {
    this._rebuildSelects();
    const fieldInput  = this._q('field-input');
    const actionInput = this._q('action-input');
    if (fieldInput  && field)      fieldInput.value  = field;
    if (actionInput && actionType) actionInput.value = actionType;
    this._runQuery();
  }

  _rebuildSelects() {
    const fieldList  = this._q('field-list');
    const actionList = this._q('action-list');
    if (!fieldList || !actionList) return;

    if (!this._journal) {
      fieldList.innerHTML  = '';
      actionList.innerHTML = '';
      return;
    }

    const fields      = this._journal.getChangedFields();
    const actionTypes = this._journal.getActionTypes();

    fieldList.innerHTML  = fields.map(f => `<option value="${f}"></option>`).join('');
    actionList.innerHTML = actionTypes.map(t => `<option value="${t}"></option>`).join('');
  }

  _runQuery() {
    this._rebuildSelects();
    const results     = this._q('results');
    const fieldInput  = this._q('field-input');
    const actionInput = this._q('action-input');
    if (!results || !fieldInput || !actionInput) return;

    results.innerHTML = '';

    if (!this._journal) {
      results.innerHTML = '<span class="caq-placeholder">Run a simulation first.</span>';
      return;
    }

    const field      = fieldInput.value.trim();
    const actionType = actionInput.value.trim();
    if (!field || !actionType) return;

    const rows = this._journal.getActions(actionType)
      .map(e => ({ e, diff: e.stateDiff?.find(d => d.field === field) }))
      .filter(({ diff }) => diff != null);

    if (rows.length === 0) {
      results.innerHTML = `<span class="caq-placeholder">No changes to "${field}" in "${actionType}" actions.</span>`;
      return;
    }

    const totalDelta = rows.reduce((s, { diff }) => s + (typeof diff.delta === 'number' ? diff.delta : 0), 0);

    const summary = document.createElement('div');
    summary.className = 'caq-summary';
    const cntSpan = document.createElement('span');
    cntSpan.textContent = `${rows.length} occurrence${rows.length !== 1 ? 's' : ''}`;
    const netSpan = document.createElement('span');
    netSpan.className   = totalDelta >= 0 ? 'caq-delta--pos' : 'caq-delta--neg';
    netSpan.textContent = `Net Δ: ${totalDelta >= 0 ? '+' : ''}${this._fmtChange(field, totalDelta)}`;
    summary.append(cntSpan, netSpan);
    results.appendChild(summary);

    const table = document.createElement('table');
    table.className = 'caq-table';
    const thead = table.createTHead();
    const hrow  = thead.insertRow();
    for (const col of ['Date', 'Event', 'Before', 'After', 'Δ Delta']) {
      const th = document.createElement('th');
      th.textContent = col;
      hrow.appendChild(th);
    }

    const tbody = table.createTBody();
    for (const { e, diff } of rows) {
      const tr = tbody.insertRow();
      tr.className = 'caq-row';
      tr.title     = 'Click to view action detail';
      tr.addEventListener('click', () => {
        this._runtime.bus.publish({ type: WB_EVENTS.ACTION_ENTRY_OPEN, entry: e });
      });

      const dStr  = diff.delta != null ? (diff.delta > 0 ? '+' : '') + this._fmtChange(field, diff.delta) : '—';
      const dCls  = diff.delta > 0 ? 'caq-delta--pos' : diff.delta < 0 ? 'caq-delta--neg' : '';
      const cells = [
        { text: this._fmtDate(e.date),                     cls: '' },
        { text: e.event?.name ?? e.event?.type ?? '—',     cls: 'caq-cell--muted' },
        { text: this._fmtChange(field, diff.before),       cls: 'caq-cell--mono' },
        { text: this._fmtChange(field, diff.after),        cls: 'caq-cell--mono' },
        { text: dStr,                                       cls: `caq-cell--mono ${dCls}` },
      ];
      for (const { text, cls } of cells) {
        const td = tr.insertCell();
        td.textContent = text;
        if (cls) td.className = cls;
      }
    }

    results.appendChild(table);
  }

  // ─── Formatting ────────────────────────────────────────────────────────────

  _fmtChange(field, value) {
    if (this._schemaRegistry) {
      const formatted = this._schemaRegistry.format(field, value);
      if (formatted !== null) return formatted;
    }
    return this._fmtVal(value);
  }

  _fmtVal(v) {
    if (v == null)           return '—';
    if (typeof v === 'number') return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (v instanceof Date)   return this._fmtDate(v);
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }

  _fmtDate(v) {
    if (!v) return '—';
    const d = v instanceof Date ? v : new Date(v);
    return d.toDateString();
  }
}
