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

import { WorkbenchComponent }          from '../../component.js';
import { WB_EVENTS }                   from '../../workbench-runtime.js';
import { JournalDataSource }           from '../../../../finance/journal-data-source.js';
import { JournalQueryApi }             from '../../../../finance/journal-query-api.js';
import { ReportDefinitionRegistry }    from '../../../../finance/journal-reporting/report-definition-registry.js';
import { ServiceRegistry }             from '../../../../services/service-registry.js';

const _fmt       = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const _fmtN      = (n) => n == null ? '—' : _fmt.format(n);
const _fmtSigned = (n) => n == null ? '—' : (n > 0 ? '+' : '') + _fmt.format(n);
const _signCls   = (n) => n == null ? '' : n >= 0 ? 'jr-amount--pos' : 'jr-amount--neg';

/**
 * JournalReportPlugin — workbench panel for journal-backed aggregate reports.
 *
 * Layout:
 *   ReportPicker  — selects which named report to display
 *   FacetPanel    — cc + period filters built from ReportDefinition.facets
 *   ResultsGrid   — grouped rows with expand-to-entries affordance
 *   RollupBar     — grand total + CSV export (Phase 2)
 *
 * Subscribes to:
 *   SCENARIO_READY        — rebinds to the new sim journal
 *   JOURNAL_REPORT_OPEN   — activates a named report pre-seeded with params
 */
export class JournalReportPlugin extends WorkbenchComponent {
  constructor(runtime) {
    super();
    this._runtime  = runtime;
    this._registry = new ReportDefinitionRegistry();
    this._journal   = null;
    this._api       = null;    // per-entry JournalQueryApi
    this._diffApi   = null;    // per-stateDiff JournalQueryApi (perDiff reports)
    this._personApi = null;    // per-personTaxDetails JournalQueryApi (perPerson reports)

    // Optional override for tests; production uses ServiceRegistry.getInstance() lazily
    this._servicesOverride = null;

    // Current UI state
    this._activeReportId = null;
    this._facetValues    = {};
    this._groups         = [];
    this._grandTotal     = null;
    this._expandedKeys   = new Set();
    this._sortState      = null;   // { field: string, dir: 'asc'|'desc' } | null
    // Cache of period option descriptors built per render. Indexed by `value`,
    // each entry carries `{ value, label, period: { fromEntryId, toEntryId } }`
    // so the select's change handler can resolve back to a period object
    // without re-querying the journal.
    this._periodOptions  = [];
  }

  /**
   * Provide explicit service handles (used by tests). When unset, the plugin
   * resolves services lazily via ServiceRegistry.getInstance() so it always
   * picks up the latest scenario rebuild.
   */
  setServices(services) {
    this._servicesOverride = services ?? null;
    if (this._mounted) this._renderFacets();
  }

  _services() {
    return this._servicesOverride ?? ServiceRegistry.getInstance();
  }

  render() {
    const root = document.createElement('div');
    root.className = 'jr-plugin wb-plugin-fill';
    root.innerHTML = `
      <div class="jr-toolbar">
        <select class="jr-report-picker wb-select" data-jr="picker">
          <option value="">— Select a report —</option>
        </select>
      </div>
      <div class="jr-facets" data-jr="facets"></div>
      <div class="jr-body">
        <div class="jr-placeholder" data-jr="placeholder">
          Run a simulation to populate reports.
        </div>
        <div class="jr-grid-wrap" data-jr="grid-wrap" style="display:none">
          <table class="jr-grid">
            <thead><tr data-jr="thead-row"></tr></thead>
            <tbody data-jr="tbody"></tbody>
          </table>
        </div>
      </div>
      <div class="jr-footer" data-jr="footer" style="display:none">
        <span class="jr-grand-total-label">Grand Total</span>
        <span class="jr-grand-total-value" data-jr="grand-total">—</span>
        <button class="jr-csv-btn" data-jr="csv-btn" title="Download CSV">&#11015; CSV</button>
      </div>
    `;
    return root;
  }

  onInit() {
    this._runtime.bus.subscribe(WB_EVENTS.SCENARIO_READY, ({ scenario }) => {
      this._bindJournal(scenario?.sim?.journal ?? null);
    });

    this._runtime.bus.subscribe(WB_EVENTS.JOURNAL_REPORT_OPEN, ({ reportId, params }) => {
      this._openReport(reportId, params);
    });
  }

  onMount() {
    // Populate picker
    const picker = this._q('picker');
    const defs   = this._registry.getAll();
    picker.innerHTML = `<option value="">— Select a report —</option>` +
      defs.map(d => `<option value="${d.id}">${d.title}</option>`).join('');

    picker.addEventListener('change', () => {
      this._activeReportId = picker.value || null;
      this._facetValues    = {};
      this._expandedKeys   = new Set();
      const def = this._activeReportId ? this._registry.get(this._activeReportId) : null;
      this._sortState = def?.defaultSort?.[0] ? { ...def.defaultSort[0] } : { field: 'total', dir: 'desc' };
      this._renderFacets();
      this._runQuery();
    });

    // Attach the group-row click delegate ONCE — tbody persists across
    // innerHTML rewrites, so we never need to rebind. Re-binding inside
    // _renderResults() stacks handlers and causes every prior listener to
    // re-toggle the same key on each click, freezing the UI after one fold.
    const tbody = this._q('tbody');
    if (tbody && !tbody._jrToggleBound) {
      tbody.addEventListener('click', (e) => this._onGroupRowClick(e));
      tbody._jrToggleBound = true;
    }

    // Column sort delegate on thead — persists across header innerHTML rewrites.
    const thead = this.el.querySelector('thead');
    if (thead && !thead._jrSortBound) {
      thead.addEventListener('click', (e) => this._onHeaderClick(e));
      thead._jrSortBound = true;
    }

    // CSV download
    const csvBtn = this._q('csv-btn');
    if (csvBtn) {
      csvBtn.addEventListener('click', () => this._downloadCsv());
    }

    // Re-render current state
    this._renderFacets();
    this._renderResults();

    // Restore picker selection
    if (this._activeReportId) picker.value = this._activeReportId;
  }

  _onGroupRowClick(e) {
    const row = e.target.closest('.jr-group-row');
    if (!row) return;
    const key = row.dataset.key;
    if (this._expandedKeys.has(key)) {
      this._expandedKeys.delete(key);
    } else {
      this._expandedKeys.add(key);
    }
    this._renderResults();
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  _bindJournal(journal) {
    this._journal   = journal;
    const svc          = this._services();
    const typeRegistry = svc?.typeRegistry  ?? null;
    const periodService = svc?.periodService ?? null;
    this._api       = journal ? new JournalQueryApi(new JournalDataSource(journal),                          typeRegistry, periodService) : null;
    this._diffApi   = journal ? new JournalQueryApi(new JournalDataSource(journal, { perDiff:   true }),     typeRegistry, periodService) : null;
    this._personApi = journal ? new JournalQueryApi(new JournalDataSource(journal, { perPerson: true }),     typeRegistry, periodService) : null;
    this._groups    = [];
    this._grandTotal = null;
    this._expandedKeys.clear();
    // Period entry IDs are journal-specific; drop the stale selection so
    // _renderFacets() can re-default for the new scenario.
    if (this._facetValues.period) this._facetValues.period = null;
    if (this._mounted) {
      this._renderFacets();
      this._renderResults();
    }
  }

  _openReport(reportId, params) {
    this._activeReportId = reportId;
    this._facetValues    = { ...(params ?? {}) };
    this._expandedKeys   = new Set();
    const def = this._registry.get(reportId);
    this._sortState = def?.defaultSort?.[0] ? { ...def.defaultSort[0] } : { field: 'total', dir: 'desc' };

    if (this._mounted) {
      const picker = this._q('picker');
      if (picker) picker.value = reportId ?? '';
      this._renderFacets();
    }

    this._runQuery();
  }

  async _runQuery() {
    if (!this._activeReportId || !this._api) {
      this._groups     = [];
      this._grandTotal = null;
      if (this._mounted) this._renderResults();
      return;
    }

    const def = this._registry.get(this._activeReportId);
    if (!def) return;

    const api    = def.perPerson ? this._personApi
                 : def.perDiff   ? this._diffApi
                 :                 this._api;
    const ast        = def.buildQuery(this._facetValues, api);
    const periodType = def.periodTypeFor?.(this._facetValues) ?? null;
    const result = periodType && api._periodService
      ? await api.aggregateByYear({
          query:      ast,
          periodType,
          aggregates: def.defaultAggregates,
        })
      : await api.aggregate({
          query:      ast,
          groupBy:    def.defaultGroupBy,
          aggregates: def.defaultAggregates,
        });

    this._groups     = def.decorate(result.groups);
    this._grandTotal = result.grandTotal;

    if (this._mounted) this._renderResults();
  }

  _renderFacets() {
    const container = this._q('facets');
    if (!container) return;

    if (!this._activeReportId) { container.innerHTML = ''; this._periodOptions = []; return; }

    const def = this._registry.get(this._activeReportId);
    if (!def) { container.innerHTML = ''; this._periodOptions = []; return; }

    // Build period options up-front so the render branch + the change handler
    // share one source of truth. Period options depend on the active cc, so
    // resolve it before rendering (cc may not be in _facetValues yet — first
    // <option> is the implicit default for unset selects).
    const hasPeriod = def.facets.some(f => f.kind === 'period');
    if (hasPeriod) {
      const ccFacet  = def.facets.find(f => f.name === 'cc' && f.kind === 'select');
      const activeCc = this._facetValues.cc ?? ccFacet?.options?.[0] ?? null;

      this._periodOptions = this._buildPeriodOptions(activeCc);

      // Default selection when no drill seeded a period.
      if (this._facetValues.period == null) {
        this._facetValues.period = this._defaultPeriod(activeCc);
      }

      // Drill-down may have seeded a period that doesn't enumerate (e.g. an
      // older settle from a different cc, or a custom range). Inject a
      // transient option labelled by the toEntry's date so the user sees the
      // active scope rather than a silently-mismatched select.
      const match = this._findPeriodOption(this._facetValues.period, this._periodOptions);
      if (!match) {
        const transient = this._injectTransientPeriodOption(this._facetValues.period);
        if (transient) this._periodOptions.unshift(transient);
      }
    } else {
      this._periodOptions = [];
    }

    container.innerHTML = def.facets.map(f => {
      if (f.kind === 'select') {
        const val  = this._facetValues[f.name] ?? '';
        const opts = f.options.map(o =>
          `<option value="${o}"${o === val ? ' selected' : ''}>${o}</option>`
        ).join('');
        return `
          <label class="jr-facet">
            <span class="jr-facet-label">${_esc(f.label)}</span>
            <select class="wb-select jr-facet-ctrl" data-facet="${f.name}">${opts}</select>
          </label>`;
      }
      if (f.kind === 'multiselect') {
        const options  = this._resolveMultiselectOptions(f);
        const selected = _asArray(this._facetValues[f.name]);
        const summary  = _multiselectSummary(options, selected, f.label);
        const items    = options.map(o => {
          const checked = selected.includes(o.value) ? ' checked' : '';
          return `<label class="jr-ms-item">
            <input type="checkbox" class="jr-ms-cb" data-facet="${f.name}" value="${_esc(o.value)}"${checked}>
            <span>${_esc(o.label)}</span>
          </label>`;
        }).join('');
        return `
          <details class="jr-facet jr-facet--multi" data-facet-host="${f.name}">
            <summary class="jr-multiselect-summary">
              <span class="jr-facet-label">${_esc(f.label)}:</span>
              <span class="jr-ms-summary-text">${_esc(summary)}</span>
            </summary>
            <div class="jr-multiselect-menu">${items || '<div class="jr-ms-empty">No options</div>'}</div>
          </details>`;
      }
      if (f.kind === 'period') {
        const currentOpt = this._findPeriodOption(this._facetValues[f.name], this._periodOptions);
        const currentVal = currentOpt?.value ?? '';
        const opts = this._periodOptions.map(o =>
          `<option value="${_esc(o.value)}"${o.value === currentVal ? ' selected' : ''}>${_esc(o.label)}</option>`
        ).join('');
        return `
          <label class="jr-facet">
            <span class="jr-facet-label">${_esc(f.label)}</span>
            <select class="wb-select jr-facet-period" data-facet="${f.name}">${opts}</select>
          </label>`;
      }
      return '';
    }).join('');

    container.querySelectorAll('.jr-facet-ctrl').forEach(ctrl => {
      ctrl.addEventListener('change', () => {
        const name = ctrl.dataset.facet;
        this._facetValues[name] = ctrl.value || null;

        // cc changes invalidate the period option list (settles are cc-scoped).
        // Preserve the user's selection only if the same toEntryId enumerates
        // for the new cc; otherwise fall back to the default and re-render so
        // the period <select> refreshes with the new options.
        if (name === 'cc') {
          const newOpts = this._buildPeriodOptions(this._facetValues.cc);
          const match   = this._findPeriodOption(this._facetValues.period, newOpts);
          if (!match) this._facetValues.period = this._defaultPeriod(this._facetValues.cc);
          this._renderFacets();
        }

        this._expandedKeys.clear();
        this._runQuery();
      });
    });

    container.querySelectorAll('.jr-facet-period').forEach(ctrl => {
      ctrl.addEventListener('change', () => {
        const opt = this._periodOptions.find(o => o.value === ctrl.value);
        if (opt) this._facetValues[ctrl.dataset.facet] = { ...opt.period };
        this._expandedKeys.clear();
        this._runQuery();
      });
    });

    container.querySelectorAll('.jr-ms-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const name     = cb.dataset.facet;
        const current  = _asArray(this._facetValues[name]);
        const next     = cb.checked
          ? [...current, cb.value]
          : current.filter(v => v !== cb.value);
        this._facetValues[name] = next.length ? next : null;
        this._updateMultiselectSummary(name);
        this._expandedKeys.clear();
        this._runQuery();
      });
    });
  }

  /**
   * Build the period option list for the active `cc`:
   *   - "Current (in progress)" (when post-settle activity exists)
   *   - One entry per settled period (reverse chronological)
   *   - "Whole simulation" (always last; ensures every render has at least
   *     one option even when the journal carries no settles yet)
   *
   * Each option is `{ value, label, period: { fromEntryId, toEntryId } }`.
   * The `value` is what the <select> emits on change; the change handler
   * looks the option up in `this._periodOptions` to recover the period.
   */
  _buildPeriodOptions(cc) {
    const whole = { value: '__all__', label: 'Whole simulation', period: { fromEntryId: null, toEntryId: null } };
    if (!this._api || !this._journal || this._journal.journal.length === 0) {
      return [whole];
    }

    const opts    = [];
    const current = this._api.currentInProgressPeriod(cc);
    if (current) {
      opts.push({
        value: '__current__',
        label: current.label,
        period: { fromEntryId: current.fromEntryId, toEntryId: null },
      });
    }
    for (const p of this._api.listSettledPeriods(cc)) {
      opts.push({
        value: p.toEntryId,
        label: p.label,
        period: { fromEntryId: p.fromEntryId, toEntryId: p.toEntryId },
      });
    }
    opts.push(whole);
    return opts;
  }

  /**
   * Find the option that matches a `{fromEntryId, toEntryId}` period.
   * Whole-simulation and current-in-progress periods are identified by null
   * `toEntryId` (whole sim also has null `fromEntryId`); settled periods
   * match by `toEntryId` equality.
   */
  _findPeriodOption(period, options) {
    if (!period) return null;
    if (period.toEntryId == null && period.fromEntryId == null) {
      return options.find(o => o.value === '__all__') ?? null;
    }
    if (period.toEntryId == null) {
      return options.find(o => o.value === '__current__') ?? null;
    }
    return options.find(o => o.period.toEntryId === period.toEntryId) ?? null;
  }

  /**
   * Build a transient option for a drill-seeded period that no enumerated
   * option matches (e.g. opened against an older scenario's settle entry).
   * Returns null when the toEntryId isn't in the current journal, in which
   * case the drill defaults silently rather than asserting.
   */
  _injectTransientPeriodOption(period) {
    if (!period?.toEntryId) return null;
    const entry = this._journal?.journal.find(e => e.id === period.toEntryId);
    if (!entry) return null;
    return {
      value:  `__transient__:${period.toEntryId}`,
      label:  `Custom (${_fmtDate(entry.date)})`,
      period: { ...period },
    };
  }

  /**
   * Resolve the default period for a given `cc`: the most recent settled
   * period if any exist, otherwise the Whole-simulation period (null/null).
   * The "most recent" comes from `listSettledPeriods` which returns reverse
   * chronological — position 0 is the latest.
   */
  _defaultPeriod(cc) {
    if (!this._api || !this._journal || this._journal.journal.length === 0) {
      return { fromEntryId: null, toEntryId: null };
    }
    const settled = this._api.listSettledPeriods(cc);
    if (!settled.length) return { fromEntryId: null, toEntryId: null };
    const top = settled[0];
    return { fromEntryId: top.fromEntryId, toEntryId: top.toEntryId };
  }

  /**
   * Resolve facet options for a multiselect.
   * - When the facet declares `optionsSource: 'account' | 'person'`, the
   *   plugin enumerates services to build `{ value, label }` options.
   * - When the facet declares `options: [...]` directly, they are used as-is
   *   (strings or `{ value, label }` objects).
   */
  _resolveMultiselectOptions(facet) {
    if (Array.isArray(facet.options)) {
      return facet.options.map(o =>
        typeof o === 'string' ? { value: o, label: o } : { value: o.value, label: o.label ?? o.value }
      );
    }
    const svc = this._services();
    if (!svc) return [];

    if (facet.optionsSource === 'account') {
      const accounts = svc.accountService?.getAll?.() ?? [];
      return accounts
        .filter(a => a.stateKey)
        .map(a => ({
          value: a.stateKey,
          label: _accountLabel(a),
        }));
    }
    if (facet.optionsSource === 'person') {
      const persons = svc.personService?.getAll?.() ?? [];
      return persons.map(p => ({
        value: p.id,
        label: p.name || p.id,
      }));
    }
    return [];
  }

  _updateMultiselectSummary(name) {
    const host = this.el?.querySelector(`[data-facet-host="${name}"]`);
    if (!host) return;
    const def     = this._registry.get(this._activeReportId);
    const facet   = def?.facets.find(f => f.name === name);
    if (!facet) return;
    const options = this._resolveMultiselectOptions(facet);
    const sel     = _asArray(this._facetValues[name]);
    const txt     = host.querySelector('.jr-ms-summary-text');
    if (txt) txt.textContent = _multiselectSummary(options, sel, facet.label);
  }

  _renderResults() {
    if (!this._mounted || !this.el) return;

    const placeholder = this._q('placeholder');
    const gridWrap    = this._q('grid-wrap');
    const footer      = this._q('footer');
    const theadRow    = this._q('thead-row');
    const tbody       = this._q('tbody');

    const empty = !this._journal || this._journal.journal.length === 0;

    if (empty || !this._activeReportId || this._groups.length === 0) {
      placeholder.style.display = '';
      gridWrap.style.display    = 'none';
      footer.style.display      = 'none';
      placeholder.textContent   = empty
        ? 'Run a simulation to populate reports.'
        : (this._activeReportId ? 'No results for the selected filters.' : 'Select a report above.');
      return;
    }

    placeholder.style.display = 'none';
    gridWrap.style.display    = '';
    footer.style.display      = '';

    const def = this._registry.get(this._activeReportId);
    const groupByFields = def?.defaultGroupBy ?? ['actionType'];

    // Header — first group-by column + Count + Total are sortable
    const activeSort  = this._sortState;
    const groupByCols = groupByFields.map((f, i) => {
      if (i === 0) {
        return `<th class="jr-th jr-th--sortable" data-sort-field="${f}">${_titleCase(f)} ${_sortIndicator(f, activeSort)}</th>`;
      }
      return `<th class="jr-th">${_titleCase(f)}</th>`;
    }).join('');
    theadRow.innerHTML = `${groupByCols}` +
      `<th class="jr-th jr-th--num jr-th--sortable" data-sort-field="count">Count ${_sortIndicator('count', activeSort)}</th>` +
      `<th class="jr-th jr-th--num jr-th--sortable" data-sort-field="total">Total ${_sortIndicator('total', activeSort)}</th>`;

    // Body — groups in user-chosen sort order
    const sorted = this._sortedGroups();
    const rows = [];
    for (const g of sorted) {
      const keyStr     = JSON.stringify(g.key);
      const isExpanded = this._expandedKeys.has(keyStr);
      const rowCls     = 'jr-group-row' + (isExpanded ? ' jr-group-row--expanded' : '');

      // Render each group-by key in its own <td> so each column header aligns
      // with actual data.  The expand affordance lives in the first cell only.
      const keyCells = groupByFields.map((f, i) => {
        const v = String(g.key[f] ?? '—');
        if (i === 0) {
          return `<td class="jr-td jr-td--expand"><div class="jr-expand-inner"><button class="jr-expand-btn">${isExpanded ? '▼' : '▶'}</button><span class="jr-group-label">${_esc(v)}</span></div></td>`;
        }
        return `<td class="jr-td">${_esc(v)}</td>`;
      }).join('');

      rows.push(`
        <tr class="${rowCls}" data-key='${_safeAttr(keyStr)}'>
          ${keyCells}
          <td class="jr-td jr-td--num">${g.count ?? '—'}</td>
          <td class="jr-td jr-td--num ${_signCls(g.total ?? g.gain)}">${_fmtSigned(g.total ?? g.gain ?? null)}</td>
        </tr>`);

      if (isExpanded && g.items?.length) {
        // Always show child entries in chronological order regardless of group sort.
        const chronItems = [...g.items].sort((a, b) => {
          const ta = a.ts ?? (a.date ? new Date(a.date).getTime() : 0);
          const tb = b.ts ?? (b.date ? new Date(b.date).getTime() : 0);
          return ta - tb;
        });
        for (const item of chronItems) {
          rows.push(`
            <tr class="jr-child-row">
              <td class="jr-td jr-td--child" colspan="${(def?.defaultGroupBy?.length ?? 1) + 2}">
                <div class="jr-child-inner">
                  <span class="jr-child-date">${_fmtDate(item.date)}</span>
                  <span class="jr-child-type">${item.actionType ?? '—'}</span>
                  <span class="jr-child-desc">${_esc(item.description ?? '')}</span>
                  <span class="jr-child-amount ${_signCls(item.stateDelta ?? item.personTaxAmount ?? item.amount ?? item.proceeds)}">${_fmtSigned(item.stateDelta ?? item.personTaxAmount ?? item.amount ?? item.proceeds ?? null)}</span>
                </div>
              </td>
            </tr>`);
        }
      }
    }
    tbody.innerHTML = rows.join('');

    // Grand total
    const gtEl = this._q('grand-total');
    if (gtEl) {
      gtEl.textContent = _fmtSigned(this._grandTotal);
      gtEl.className   = `jr-grand-total-value ${_signCls(this._grandTotal)}`;
    }
  }

  _onHeaderClick(e) {
    const th = e.target.closest('[data-sort-field]');
    if (!th) return;
    const field = th.dataset.sortField;
    if (this._sortState?.field === field) {
      this._sortState = { field, dir: this._sortState.dir === 'asc' ? 'desc' : 'asc' };
    } else {
      this._sortState = { field, dir: _defaultDirForField(field) };
    }
    this._renderResults();
  }

  _sortedGroups() {
    if (!this._sortState || !this._groups.length) return this._groups;
    const { field, dir } = this._sortState;
    const sign = dir === 'asc' ? 1 : -1;
    return [...this._groups].sort((a, b) => {
      const av = _sortValue(a, field);
      const bv = _sortValue(b, field);
      return av < bv ? -sign : av > bv ? sign : 0;
    });
  }

  _downloadCsv() {
    const def = this._activeReportId ? this._registry.get(this._activeReportId) : null;
    const csv = _generateCsv(this._sortedGroups(), def);
    if (!csv) return;

    const reportTitle = def?.title ?? 'journal-report';
    const filename    = `${reportTitle.toLowerCase().replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 10)}.csv`;
    const blob        = new Blob([csv], { type: 'text/csv' });
    const url         = URL.createObjectURL(blob);
    const a           = document.createElement('a');
    a.href            = url;
    a.download        = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  _q(name) {
    return this.el?.querySelector(`[data-jr="${name}"]`) ?? null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Flatten groups + their child items into an RFC 4180 CSV string.
 * Each child item becomes one row; group key fields are prepended as columns.
 * When a group has no items, the group summary row is emitted instead.
 */
function _generateCsv(groups, def) {
  if (!groups?.length) return '';

  const esc = v => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const groupByFields = def?.defaultGroupBy ?? ['actionType'];

  // Collect rows with dynamic column discovery
  const rows = [];
  for (const g of groups) {
    const keyObj = g.key ?? {};

    if (g.items?.length) {
      const chronItems = [...g.items].sort((a, b) => {
        const ta = a.ts ?? (a.date ? new Date(a.date).getTime() : 0);
        const tb = b.ts ?? (b.date ? new Date(b.date).getTime() : 0);
        return ta - tb;
      });
      for (const item of chronItems) {
        const row = {};
        for (const f of groupByFields) row[f] = keyObj[f] ?? null;
        row.date        = item.date ? new Date(item.date).toISOString().slice(0, 10) : null;
        row.seq         = item.seq         ?? null;
        row.executionId = item.executionId ?? null;
        row.actionType  = item.actionType  ?? null;
        row.description = item.description ?? null;
        row.amount      = item.amount      ?? null;
        row.proceeds    = item.proceeds    ?? null;
        row.gain        = item.gain        ?? null;
        row.stateKey    = item.stateKey    ?? null;
        row.stateDelta  = item.stateDelta  ?? null;
        rows.push(row);
      }
    } else {
      // Group with no children — emit a summary row.
      const row = {};
      for (const f of groupByFields) row[f] = keyObj[f] ?? null;
      row.count = g.count ?? null;
      row.total = g.total ?? null;
      rows.push(row);
    }
  }

  if (!rows.length) return '';

  // Dynamic column union
  const colSet = new Map();
  for (const row of rows) {
    for (const k of Object.keys(row)) if (!colSet.has(k)) colSet.set(k, true);
  }
  const cols = [...colSet.keys()];

  return [
    cols.join(','),
    ...rows.map(row => cols.map(c => esc(row[c])).join(',')),
  ].join('\n');
}

function _sortValue(group, field) {
  if (field === 'total') return group.total ?? group.gain ?? 0;
  if (field === 'count') return group.count ?? 0;
  return String(group.key?.[field] ?? '');
}

function _defaultDirForField(field) {
  return (field === 'total' || field === 'count') ? 'desc' : 'asc';
}

function _sortIndicator(field, sortState) {
  if (!sortState || sortState.field !== field) {
    return '<span class="jr-sort-icon jr-sort-icon--neutral">⇅</span>';
  }
  return sortState.dir === 'asc'
    ? '<span class="jr-sort-icon jr-sort-icon--asc">▲</span>'
    : '<span class="jr-sort-icon jr-sort-icon--desc">▼</span>';
}

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function _asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}
function _multiselectSummary(options, selected, label) {
  if (!selected.length)         return `All ${(label || '').toLowerCase()}`.trim();
  if (selected.length === 1) {
    const hit = options.find(o => o.value === selected[0]);
    return hit ? hit.label : selected[0];
  }
  return `${selected.length} selected`;
}
function _accountLabel(account) {
  const country = account.country ? `${account.country} ` : '';
  const name    = account.name || account.stateKey;
  return `${country}${name}`.trim();
}
function _safeAttr(s) {
  return String(s ?? '').replace(/'/g, '&#39;');
}
function _titleCase(s) {
  return s.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
}
function _fmtDate(d) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return String(d); }
}
