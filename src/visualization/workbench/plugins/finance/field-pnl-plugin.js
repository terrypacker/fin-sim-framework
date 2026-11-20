/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import * as echarts from 'echarts';
import { WorkbenchComponent } from '../../component.js';
import { readThemeColor }     from '../../../theme.js';
import { WB_EVENTS }          from '../../workbench-runtime.js';
import { ServiceRegistry }    from '../../../../services/service-registry.js';
import { withBom }            from '../../../../utils/csv.js';
import { EXECUTION_KINDS, EXECUTION_PHASES } from '../../../../simulation-framework/bus-messages.js';
import { normalizeFarm, CROPS, priceOn, harvestDateFor } from '../../../../finance/farm/farm-records.js';
import { farmLedger, jobCostReport, sumPlanRows } from '../../../../finance/farm/farm-reports.js';
import { planFarm } from '../../../../finance/farm/farm-run.js';
import { compileFarmEvents } from '../../../../finance/farm/farm-postings.js';
import { categoryLabel, categoryLine } from '../../../../finance/farm/schedule-f.js';

/**
 * FieldPnlPlugin — the farm season's job-cost P&L per field, with its breakevens (design 134
 * §5.3–§5.4, phase 1).
 *
 * ─── what it reads ───────────────────────────────────────────────────────────────
 *
 * The farm records (`cfg.farm` of the active scenario) and the run's journal, through the
 * same `jobCostReport` the CLI and the acceptance test use, so the panel can never disagree
 * with them. The report is rebuilt from the journal as the run steps: mid-run it is the
 * season TO DATE (costs posted, grain not yet paid for), and the toolbar says so.
 *
 * ─── layout ──────────────────────────────────────────────────────────────────────
 *
 * Operator (or crop) ▸ field ▸ the field's lines. A field's lines are every revenue and cost
 * category with its Schedule F line, so a total traces to its parts. The breakeven price
 * goes red where it is above the price the field's unpriced grain is expected to fetch.
 *
 * Machinery is charged at custom-hire rates or at the operator's real machinery figure
 * (§5.3); the switch changes the net and the breakevens, not the ledger.
 *
 * ─── the chart ───────────────────────────────────────────────────────────────────
 *
 * Above the table, one crop's cash price through the season against the price the scope's
 * unpriced grain must fetch to break even, with its contracts and planned sales as points and
 * a marker at the run's current date. The scope is the row last clicked: the whole farm (the
 * footer), an operator or crop group, or a field.
 *
 * The breakeven is the PLANNED season's (`planFarm`: the same farm run to its end on an
 * isolated registry), not the table's season to date, whose breakevens are too low until the
 * grain is sold. So the line stays put as the run steps, and the "now" marker and the price
 * at it are what move.
 */
export class FieldPnlPlugin extends WorkbenchComponent {
  constructor(runtime) {
    super();
    this._runtime  = runtime;
    this._sim      = null;
    this._servicesOverride = null;   // tests
    this._cfgOverride      = null;   // tests
    this._unsubSimBus  = null;
    this._renderQueued = false;
    this._expanded     = new Set();  // `g:<key>` and `p:<jobId>`
    this._groupBy      = 'operator';
    this._machineryBasis = 'CUSTOM';
    this._cache = null;
    this._sig   = null;
    this._chartScope = { kind: 'farm' };   // or { kind: 'operator'|'crop'|'plan', id }
    this._chartCrop  = null;               // null = the scope's first crop
    this._plan    = null;                  // { sig, data | reason, reports: { [basis]: report } }
    this._chart   = null;
    this._ro      = null;
  }

  setServices(services) { this._servicesOverride = services ?? null; }
  _services() { return this._servicesOverride ?? ServiceRegistry.getInstance(); }
  /** Tests: the scenario cfg, instead of the active one. */
  setConfig(cfg) { this._cfgOverride = cfg ?? null; this._sig = null; }
  _cfg() { return this._cfgOverride ?? this._services()?.scenarioService?.getActive?.() ?? null; }

  render() {
    const root = document.createElement('div');
    root.className = 'fpl-plugin sec-plugin wb-plugin-fill';
    root.innerHTML = `
      <div class="sec-toolbar">
        <span class="bond-seg" data-fpl="group" title="What the top rows group the fields by">
          <button data-v="operator" class="on">by operator</button><button data-v="crop">by crop</button>
        </span>
        <span class="bond-seg" data-fpl="basis" title="Machinery in the net: custom-hire rates for the work done, or the operator's real machinery cost (design 134 §5.3)">
          <button data-v="CUSTOM" class="on">custom rates</button><button data-v="ACTUAL">actual machinery</button>
        </span>
        <label class="sec-toggle" title="Show the cost as direct, overhead and machinery columns">
          <input type="checkbox" data-fpl="split"> cost split
        </label>
        <span class="sec-spacer"></span>
        <span class="sec-asof" data-fpl="asof">—</span>
        <button class="sec-csv-btn" data-fpl="csv" title="Download the field P&amp;L as CSV">&#11015; CSV</button>
      </div>
      <div class="sec-body" data-fpl="body">
        <div class="bond-warn" data-fpl="warn" style="display:none"></div>
        <div class="sec-placeholder" data-fpl="placeholder">Run a simulation to cost the farm season.</div>
        <div class="fpl-chart-wrap" data-fpl="chart-wrap" style="display:none">
          <div class="fpl-chart-head">
            <span class="mc-section-label" data-fpl="chart-label">Cash price vs breakeven</span>
            <span class="bond-seg" data-fpl="crop" title="Which crop the chart shows"></span>
          </div>
          <div class="fpl-chart" data-fpl="chart"></div>
          <div class="bond-caption" data-fpl="caption"></div>
        </div>
        <table class="sec-grid fpl-split-off" data-fpl="grid" style="display:none">
          <thead><tr>
            <th class="sec-th">Field</th>
            <th class="sec-th">Crop</th>
            <th class="sec-th sec-th--num">Acres</th>
            <th class="sec-th sec-th--num" title="Grain paid for, grain still owed or in the bin at its last price, and other income (program payments, insurance proceeds)">Revenue</th>
            <th class="sec-th sec-th--num" title="Direct + overhead + machinery (on the basis the switch picks)">Cost</th>
            <th class="sec-th sec-th--num">Net</th>
            <th class="sec-th sec-th--num">Net / ac</th>
            <th class="sec-th sec-th--num" title="What the unpriced grain is expected to fetch: the planned sales' prices, else the cash price at harvest">Exp. \$/bu</th>
            <th class="sec-th sec-th--num" title="(Total cost − non-grain revenue) ÷ expected bushels">BE \$/bu</th>
            <th class="sec-th sec-th--num" title="The price the bushels NOT under contract must fetch, with the contracted ones at their contract price">BE unpriced</th>
            <th class="sec-th sec-th--num" title="Expected yield, bushels per acre (tons for alfalfa)">Exp. yield</th>
            <th class="sec-th sec-th--num" title="The yield that covers cost, contracted bushels at their price and the rest at the expected price">BE yield</th>
            <th class="sec-th sec-th--num fpl-split" title="Costs posted to the field itself: inputs, rent, tax, insurance, electricity, storage">Direct</th>
            <th class="sec-th sec-th--num fpl-split" title="Operator costs allocated by acres (or owned acres, or a named set of fields)">Overhead</th>
            <th class="sec-th sec-th--num fpl-split" data-fpl="mach-head">Machinery</th>
          </tr></thead>
          <tbody data-fpl="rows"></tbody>
          <tfoot data-fpl="foot"></tfoot>
        </table>
      </div>
    `;
    return root;
  }

  onInit() {
    this._runtime.bus.subscribe(WB_EVENTS.SCENARIO_READY, ({ scenario }) => this._bindSim(scenario?.sim ?? null));
    this._runtime.bus.subscribe(WB_EVENTS.DISPLAY_SETTINGS_CHANGED, () => this._render());
  }

  onMount() {
    if (!this._sim) this._bindSim(this._services()?.simulationRegistry?.getPrimary?.() ?? null);
    this._bindSeg('group', (v) => { this._groupBy = v; this._expanded.clear(); });
    this._bindSeg('basis', (v) => { this._machineryBasis = v; this._sig = null; });
    const split = this._q('split');
    if (split && !split._fplBound) {
      split.addEventListener('change', () => this._q('grid').classList.toggle('fpl-split-off', !split.checked));
      split._fplBound = true;
    }
    const csv = this._q('csv');
    if (csv && !csv._fplBound) { csv.addEventListener('click', () => this._downloadCsv()); csv._fplBound = true; }
    const rows = this._q('rows');
    if (rows && !rows._fplBound) {
      // Delegated: rows are re-rendered every step, and a per-row listener would leak.
      // A click opens or closes the row and points the chart at it.
      rows.addEventListener('click', (e) => {
        const tr = e.target.closest('tr[data-key]');
        if (!tr) return;
        const key = tr.dataset.key;
        if (this._expanded.has(key)) this._expanded.delete(key); else this._expanded.add(key);
        const id = key.slice(2);
        this._chartScope = key.startsWith('p:') ? { kind: 'plan', id }
          : { kind: this._groupBy === 'crop' ? 'crop' : 'operator', id };
        this._render();
      });
      rows._fplBound = true;
    }
    const foot = this._q('foot');
    if (foot && !foot._fplBound) {
      foot.addEventListener('click', () => { this._chartScope = { kind: 'farm' }; this._render(); });
      foot._fplBound = true;
    }
    const crop = this._q('crop');
    if (crop && !crop._fplBound) {
      crop.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-v]');
        if (!btn) return;
        this._chartCrop = btn.dataset.v;
        this._render();
      });
      crop._fplBound = true;
    }
    this._render();
  }

  onActivate() {
    // ECharts cannot size itself in a hidden pane.
    this._chart?.resize();
    this._render();
  }

  onAdopt() { this._chart?.resize(); }

  onUnmount() { this._disposeChart(); }

  destroy() {
    this._unsubSimBus?.();
    this._unsubSimBus = null;
    this._disposeChart();
    super.destroy?.();
  }

  _disposeChart() {
    this._ro?.disconnect();
    this._ro = null;
    this._chart?.dispose();
    this._chart = null;
  }

  _bindSeg(name, apply) {
    const seg = this._q(name);
    if (!seg || seg._fplBound) return;
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-v]');
      if (!btn) return;
      apply(btn.dataset.v);
      seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === btn));
      this._render();
    });
    seg._fplBound = true;
  }

  // ─── Binding ─────────────────────────────────────────────────────────────

  _bindSim(sim) {
    this._unsubSimBus?.();
    this._unsubSimBus = null;
    this._sim = sim ?? null;
    this._sig = null;
    if (sim?.bus) {
      this._unsubSimBus = sim.bus.subscribe(
        `EXECUTION_${EXECUTION_PHASES.END}`, { kind: EXECUTION_KINDS.EVENT },
        () => this._scheduleRender());
    }
    if (this._mounted) this._render();
  }

  _scheduleRender() {
    if (!this._mounted || this._renderQueued) return;
    this._renderQueued = true;
    const run = () => { this._renderQueued = false; if (this._mounted) this._render(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else run();
  }

  // ─── Data ────────────────────────────────────────────────────────────────

  /** `{ farm, report }`, or `{ reason }` when there is nothing to cost. Cached on run progress. */
  _report() {
    const cfg = this._cfg();
    const sim = this._sim;
    if (!cfg?.farm) return { reason: 'This scenario has no farm records. The Field P&L reads a farm scenario (US Farm).' };
    if (!sim) return { reason: 'Run a simulation to cost the farm season.' };
    const journal = sim.journal?.journal ?? [];
    const sig = `${journal.length}|${sim.currentDate?.getTime?.() ?? 0}|${this._machineryBasis}`;
    if (sig === this._sig && this._cache) return this._cache;
    try {
      const farm = normalizeFarm(cfg.farm);
      const report = jobCostReport(farm, farmLedger(journal), {
        machineryBasis: this._machineryBasis,
        pools:          sim.state?.farm?.pools ?? {},
        receivables:    sim.state?.farm?.receivables ?? {},
      });
      const posted = journal.some(e => e?.action?.type === 'FARM_LEDGER_POST');
      // The season is complete once its LAST farm event has run. Not the sim's end: the
      // sim's clock stops at its last event, which is that farm event, short of simEnd.
      const lastEvent = compileFarmEvents(farm).reduce((m, e) => (e.date > m ? e.date : m), '');
      const now = sim.currentDate ? sim.currentDate.toISOString().slice(0, 10) : '';
      this._cache = { farm, report, posted, done: !lastEvent || now >= lastEvent, lastEvent };
    } catch (e) {
      console.warn('[FieldPnlPlugin] could not build the job-cost report', e);
      this._cache = { reason: `The job-cost report failed: ${e.message}` };
    }
    this._sig = sig;
    return this._cache;
  }

  // ─── Rendering ───────────────────────────────────────────────────────────

  _render() {
    if (!this._mounted) return;
    const r = this._report();
    const asof = this._q('asof');
    const mach = this._q('mach-head');
    if (mach) mach.textContent = this._machineryBasis === 'CUSTOM' ? 'Machinery (custom)' : 'Machinery (actual)';
    const empty = !!r.reason || !r.posted;
    this._q('placeholder').style.display = empty ? '' : 'none';
    this._q('grid').style.display = empty ? 'none' : '';
    if (empty) {
      this._q('placeholder').textContent = r.reason ?? 'Nothing posted yet: step the run into the season.';
      this._q('rows').innerHTML = '';
      this._q('foot').innerHTML = '';
      this._q('chart-wrap').style.display = 'none';
      this._renderWarn([]);
      if (asof) asof.textContent = r.report ? `crop year ${r.report.cropYear}` : '—';
      return;
    }
    const { report, farm } = r;
    const { done } = r;
    if (asof) {
      asof.textContent = `crop year ${report.cropYear} · ${done ? 'season complete'
        : `to date, ${this._fmtDate(this._sim.currentDate)}`}`;
    }
    const warn = [];
    if (!done) warn.push('The run has not finished: costs and revenue are the season to date, so grain not yet sold is missing and the breakevens are too low.');
    for (const [op, u] of Object.entries(report.unallocated ?? {})) {
      warn.push(`${_esc(this._operatorName(farm, op))}: ${this._money(u.cost)} cost and ${this._money(u.revenue)} revenue had no crop plan to allocate to.`);
    }
    for (const a of report.advisories ?? []) warn.push(_esc(a.message));
    this._renderWarn(warn);

    const groups = fieldPnlGroups(report, this._groupBy);
    this._q('rows').innerHTML = groups.map(g => this._groupHtml(farm, g)).join('');
    this._q('foot').innerHTML = this._rowHtml(report.farm, {
      cls: 'sec-total-row fpl-clickable', label: `Whole farm — ${report.plans.length} job${report.plans.length === 1 ? '' : 's'}`,
    });
    this._renderChart(farm);
  }

  // ─── Chart ───────────────────────────────────────────────────────────────

  /** The planned season's job-cost report on the current basis, or `{ reason }`. Cached on the cfg. */
  _planReport() {
    const cfg = this._cfg();
    if (!cfg?.farm) return { reason: 'no farm' };
    let sig;
    try { sig = JSON.stringify([cfg.farm, cfg.params ?? null, cfg.parameters ?? null, cfg.simStart, cfg.simEnd]); }
    catch { sig = null; }
    if (!this._plan || sig == null || this._plan.sig !== sig) {
      try { this._plan = { sig, data: planFarm(cfg), reports: {} }; }
      catch (e) {
        console.warn('[FieldPnlPlugin] could not run the planned season', e);
        this._plan = { sig, reason: `The planned season failed: ${e.message}`, reports: {} };
      }
    }
    if (this._plan.reason) return { reason: this._plan.reason };
    const b = this._machineryBasis;
    const d = this._plan.data;
    this._plan.reports[b] ??= jobCostReport(d.farm, d.ledger, { machineryBasis: b, pools: d.pools, receivables: d.receivables });
    return { farm: d.farm, report: this._plan.reports[b] };
  }

  _renderChart(farm) {
    const wrap = this._q('chart-wrap');
    if (!wrap) return;
    const plan = this._planReport();
    if (plan.reason) { wrap.style.display = 'none'; return; }
    const now = this._sim?.currentDate ? this._sim.currentDate.toISOString().slice(0, 10) : null;
    const data = breakevenChartData(plan.farm, plan.report, this._chartScope, this._chartCrop, now);
    if (!data) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    this._q('crop').innerHTML = data.crops.map(c =>
      `<button data-v="${_esc(c)}" class="${c === data.crop ? 'on' : ''}">${_esc(_cropLabel(c))}</button>`).join('');
    const scopeLabel = this._scopeLabel(farm, this._chartScope);
    this._q('chart-label').textContent = `${_cropLabel(data.crop)} · ${scopeLabel} — cash price vs breakeven`;
    this._q('caption').textContent = breakevenCaption(data, {
      basis: this._machineryBasis === 'ACTUAL' ? 'actual machinery' : 'custom rates', date: (d) => this._fmtDate(d),
    });
    if (!this._canvasAvailable()) return;
    const host = this._q('chart');
    if (!this._chart) {
      this._chart = echarts.init(host, null, { renderer: 'canvas' });
      if (typeof ResizeObserver === 'function') {
        this._ro = new ResizeObserver(() => this._chart?.resize());
        this._ro.observe(host);
      }
    }
    this._chart.setOption(breakevenChartOption(data, { colors: this._colors() }), true);
  }

  _scopeLabel(farm, scope) {
    if (scope.kind === 'operator') return this._operatorName(farm, scope.id);
    if (scope.kind === 'crop') return `all ${_cropLabel(scope.id).toLowerCase()}`;
    if (scope.kind === 'plan') {
      const plan = farm.cropPlans.find(p => p.id === scope.id);
      const f = farm.fields.find(x => x.id === (plan?.fieldId ?? scope.id));
      return f?.name ?? scope.id;
    }
    return 'Whole farm';
  }

  _colors() {
    const c = (name, fallback) => {
      const v = typeof document !== 'undefined' ? readThemeColor(name) : '';
      return /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
    };
    return {
      price: c('--blue-muted', '#60a5fa'), red: c('--red', '#ff4455'), green: c('--green', '#34d399'),
      amber: c('--warning', '#f59e0b'), dim: c('--text-dim', '#94a3b8'), border: c('--border', '#334155'),
      borderHi: c('--border-hi', '#475569'), text: c('--text-primary', '#e2e8f0'), muted: c('--text-muted', '#64748b'),
      panel: c('--bg-panel2', '#1e293b'),
    };
  }

  /** jsdom has no 2D canvas, and ECharts fails inside setOption rather than init. */
  _canvasAvailable() {
    if (this._hasCanvas === undefined) {
      try {
        const probe = document.createElement('canvas');
        this._hasCanvas = typeof probe.getContext === 'function' && !!probe.getContext('2d');
      } catch { this._hasCanvas = false; }
    }
    return this._hasCanvas;
  }

  _renderWarn(items) {
    const el = this._q('warn');
    if (!el) return;
    if (!items.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
    el.innerHTML = items.map(s => `<div>⚠ ${s}</div>`).join('');
    el.style.display = '';
  }

  _groupHtml(farm, g) {
    const key = `g:${g.key}`;
    const open = this._expanded.has(key);
    const label = this._groupBy === 'operator' ? this._operatorName(farm, g.key) : _cropLabel(g.key);
    const head = this._rowHtml(g.row, {
      key, cls: `fpl-group-row${open ? ' is-open' : ''}`, caret: open ? '▾' : '▸',
      label: `${label} <span class="sec-td--muted">(${g.plans.length})</span>`, raw: true,
    });
    if (!open) return head;
    return head + g.plans.map(p => this._planHtml(p)).join('');
  }

  _planHtml(p) {
    const key = `p:${p.jobId}`;
    const open = this._expanded.has(key);
    // Tenure and water ride in the tooltip: inline they widened the Field column enough to
    // push the breakevens out of view.
    const tags = `${p.tenure === 'OWN' ? 'owned' : 'cash rented'}, ${p.irrigated ? 'irrigated' : 'dryland'}`;
    const head = this._rowHtml(p, {
      key, cls: `sec-detail-row fpl-plan-row${open ? ' is-open' : ''}`, caret: open ? '▾' : '▸',
      label: _esc(p.fieldName), nameCls: 'sec-detail-name', title: `${p.fieldName} — ${tags}`,
    });
    if (!open) return head;
    const cell = (on, v, memo = false, split = false) =>
      `<td class="sec-td sec-td--num${memo ? ' sec-td--muted' : ''}${split ? ' fpl-split' : ''}">${on ? v : ''}</td>`;
    return head + fieldPnlLines(p, this._machineryBasis).map(l => {
      const memo = l.kind === 'memo';
      const isCost = l.kind === 'direct' || l.kind === 'overhead' || l.kind === 'machinery' || memo;
      const where = l.line ? ` <span class="sec-td--muted">Sch F ${_esc(l.line === 'MIXED_MACHINERY' ? 'several lines' : l.line)}</span>` : '';
      return `
      <tr class="fpl-line-row">
        <td class="sec-td fpl-line-name" colspan="3">${_esc(l.label)}${where}${l.note ? ` <span class="sec-td--muted">${_esc(l.note)}</span>` : ''}</td>
        ${cell(l.kind === 'revenue', this._money(l.amount))}
        ${cell(isCost, this._money(l.amount), memo)}
        <td class="sec-td"></td>
        ${cell(p.acres > 0, p.acres > 0 ? this._money(l.amount / p.acres, 2) : '', memo)}
        <td class="sec-td" colspan="5"></td>
        ${cell(l.kind === 'direct', this._money(l.amount), false, true)}
        ${cell(l.kind === 'overhead', this._money(l.amount), false, true)}
        ${cell(l.kind === 'machinery' || memo, this._money(l.amount), memo, true)}
      </tr>`;
    }).join('');
  }

  _rowHtml(r, { key = null, cls = '', caret = '', label, raw = false, nameCls = '', title = null }) {
    const beHigh = r.breakevenUnpricedPrice != null && r.expectedPrice != null && r.breakevenUnpricedPrice > r.expectedPrice;
    const beCls = beHigh ? 'sec-neg' : '';   // red only: green on every healthy field is noise
    const yieldHigh = r.breakevenYield != null && r.expectedYield != null && r.breakevenYield > r.expectedYield;
    return `
      <tr${key ? ` data-key="${_esc(key)}"` : ''} class="sec-row ${cls}">
        <td class="sec-td sec-name ${nameCls}"${title ? ` title="${_esc(title)}"` : ''}>${caret ? `<span class="sec-caret">${caret}</span>` : ''}${raw ? label : _esc(label)}</td>
        <td class="sec-td">${r.crop ? _esc(_cropLabel(r.crop)) : '—'}</td>
        <td class="sec-td sec-td--num">${_fmt(r.acres, 1)}</td>
        <td class="sec-td sec-td--num">${this._money(r.revenue.total)}</td>
        <td class="sec-td sec-td--num">${this._money(r.totalCost)}</td>
        <td class="sec-td sec-td--num ${_signCls(r.net)}">${this._money(r.net)}</td>
        <td class="sec-td sec-td--num ${_signCls(r.perAcre.net)}">${r.perAcre.net == null ? '—' : this._money(r.perAcre.net)}</td>
        <td class="sec-td sec-td--num">${_perBu(r.expectedPrice)}</td>
        <td class="sec-td sec-td--num">${_perBu(r.breakevenPrice)}</td>
        <td class="sec-td sec-td--num ${beCls}">${_perBu(r.breakevenUnpricedPrice)}</td>
        <td class="sec-td sec-td--num">${_fmt(r.expectedYield, 1)}</td>
        <td class="sec-td sec-td--num ${yieldHigh ? 'sec-neg' : ''}">${_fmt(r.breakevenYield, 1)}</td>
        <td class="sec-td sec-td--num fpl-split">${this._money(r.directCost)}</td>
        <td class="sec-td sec-td--num fpl-split">${this._money(r.overheadCost)}</td>
        <td class="sec-td sec-td--num fpl-split">${this._money(r.machineryCost)}</td>
      </tr>`;
  }

  // ─── CSV ─────────────────────────────────────────────────────────────────

  _downloadCsv() {
    const r = this._report();
    if (r.reason) return;
    const blob = new Blob([withBom(fieldPnlCsv(r.report, r.farm))], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `field-pnl-${r.report.cropYear}-${r.report.machineryBasis.toLowerCase()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  _operatorName(farm, id) { return farm.operators.find(o => o.id === id)?.name ?? id; }

  _money(n, decimals = 0) {
    if (n == null) return '—';
    const formatted = this._services()?.schemaRegistry?.formatAmount?.(n, 'USD', { maximumFractionDigits: decimals });
    if (formatted != null) return formatted;
    return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
  }

  _fmtDate(d) {
    return this._runtime?.displaySettings?.formatDate?.(d) ?? new Date(d).toISOString().slice(0, 10);
  }

  _q(name) { return this.el?.querySelector(`[data-fpl="${name}"]`) ?? null; }
}

// ─── Pure helpers (tested without a DOM) ─────────────────────────────────────────

/**
 * The report's rows grouped for the panel: one group per operator (or crop), each with its
 * summed row from the report and its fields, the biggest acreage first.
 *
 * @param {ReturnType<typeof jobCostReport>} report
 * @param {'operator'|'crop'} by
 * @returns {{ key: string, row: object, plans: object[] }[]}
 */
export function fieldPnlGroups(report, by = 'operator') {
  const sums = by === 'operator' ? report.byOperator : report.byCrop;
  const keyOf = (r) => (by === 'operator' ? r.operatorId : (r.crop ?? '—'));
  return sums.map(row => ({
    key:   keyOf(row),
    row,
    plans: report.plans.filter(p => keyOf(p) === keyOf(row)).sort((a, b) => b.acres - a.acres || a.jobId.localeCompare(b.jobId)),
  })).sort((a, b) => b.row.acres - a.row.acres);
}

/**
 * One field's P&L lines: every revenue and cost category it carries, with its Schedule F
 * line. The lines of a kind sum to the row's column of that kind.
 *
 * The machinery basis NOT in the net is listed too, as kind `memo`, so the margin between the
 * two is visible on the field.
 *
 * @returns {{ kind: 'revenue'|'direct'|'overhead'|'machinery'|'memo', category: string, label: string,
 *   line: string|null, amount: number, note?: string }[]}
 */
export function fieldPnlLines(p, machineryBasis = 'CUSTOM') {
  const out = [];
  const line = (c) => { try { return categoryLine(c); } catch { return null; } };
  if (p.revenue.grain - p.revenue.grainOnHand !== 0) {
    out.push({ kind: 'revenue', category: 'GRAIN_SALES', label: 'Grain sold', line: '2', amount: p.revenue.grain - p.revenue.grainOnHand });
  }
  if (p.revenue.grainOnHand !== 0) {
    out.push({ kind: 'revenue', category: 'GRAIN_ON_HAND', label: 'Grain owed or in the bin', line: null,
      amount: p.revenue.grainOnHand, note: 'at contract or last price; not yet income' });
  }
  // Non-grain revenue, one line per category: crop insurance (6a), ARC-County and other
  // program payments (4a), other income. ARC is this crop's but paid the next October.
  const NOTE = {
    CROP_INSURANCE_PROCEEDS: 'indemnity on this field\'s shortfall',
    PROGRAM_PAYMENT: 'on base acres; paid the October after harvest',
  };
  const byCat = p.revenue.otherByCategory ?? {};
  const listed = Object.values(byCat).reduce((s, v) => s + v, 0);
  for (const [c, v] of _byAmount(byCat)) {
    out.push({ kind: 'revenue', category: c, label: categoryLabel(c), line: line(c), amount: v, ...(NOTE[c] ? { note: NOTE[c] } : {}) });
  }
  if (Math.abs(p.revenue.other - listed) > 1e-9) {
    out.push({ kind: 'revenue', category: 'OTHER', label: 'Other income', line: null, amount: p.revenue.other - listed });
  }
  for (const [c, v] of _byAmount(p.cost)) out.push({ kind: 'direct', category: c, label: categoryLabel(c), line: line(c), amount: v });
  if (p.storage) out.push({ kind: 'direct', category: 'STORAGE', label: categoryLabel('STORAGE'), line: line('STORAGE'), amount: p.storage });
  for (const [c, v] of _byAmount(p.overhead)) {
    out.push({ kind: 'overhead', category: c, label: categoryLabel(c), line: line(c), amount: v, note: 'allocated' });
  }
  const custom = { kind: 'machinery', category: 'CUSTOM_RATE', label: 'Machinery at custom rates', line: null, amount: p.machinery.custom };
  const actual = { kind: 'machinery', category: 'MACHINERY', label: 'Machinery, actual (allocated)', line: line('MACHINERY'), amount: p.machinery.actual };
  const used = machineryBasis === 'ACTUAL' ? actual : custom;
  const other = machineryBasis === 'ACTUAL' ? custom : actual;
  if (used.amount) out.push(used);
  if (other.amount) out.push({ ...other, kind: 'memo', note: 'not in the net' });
  return out;
}

/** The CSV columns, in order. Money is USD. */
export const FIELD_PNL_CSV_COLUMNS = Object.freeze(['scope', 'operator', 'job', 'field', 'crop', 'tenure',
  'irrigated', 'acres', 'revenue', 'directCost', 'overheadCost', 'machineryCost', 'machineryBasis', 'net',
  'netPerAcre', 'expectedPrice', 'breakevenPrice', 'breakevenUnpricedPrice', 'expectedYield', 'breakevenYield',
  'category', 'scheduleFLine', 'amount']);

/** One FIELD row per job, a LINE row per category on it, OPERATOR and FARM totals. */
export function fieldPnlCsv(report, farm) {
  const out = [];
  const opName = (id) => farm?.operators?.find(o => o.id === id)?.name ?? id;
  const fig = (r) => [r.acres, r.revenue.total, r.directCost, r.overheadCost, r.machineryCost, report.machineryBasis,
    r.net, r.perAcre.net, r.expectedPrice, r.breakevenPrice, r.breakevenUnpricedPrice, r.expectedYield, r.breakevenYield];
  for (const g of fieldPnlGroups(report, 'operator')) {
    out.push(['OPERATOR', opName(g.key), '', '', '', '', '', ...fig(g.row), '', '', '']);
    for (const p of g.plans) {
      out.push(['FIELD', opName(p.operatorId), p.jobId, p.fieldName, p.crop ?? '', p.tenure, p.irrigated, ...fig(p), '', '', '']);
      for (const l of fieldPnlLines(p, report.machineryBasis)) {
        out.push([`LINE_${l.kind.toUpperCase()}`, opName(p.operatorId), p.jobId, p.fieldName, p.crop ?? '', '', '',
          ...new Array(13).fill(''), l.category, l.line ?? '', +l.amount.toFixed(2)]);
      }
    }
  }
  out.push(['FARM', '', '', '', '', '', '', ...fig(report.farm), '', '', '']);
  const cell = (v) => {
    if (v == null) return '';
    const s = typeof v === 'number' ? String(+v.toFixed(6)) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [FIELD_PNL_CSV_COLUMNS.join(','), ...out.map(row => row.map(cell).join(','))].join('\n');
}

/**
 * What the breakeven chart draws for one scope and crop, from the PLANNED season's report.
 *
 * - `row`: the scope's plans of that crop summed (a field's own row for a field), so the
 *   breakevens are that crop's even where the scope grows two;
 * - `prices`: the crop's cash price table as a step series (`realized`, which is the table's
 *   price in a deterministic run), from the plan date to after the last dated point;
 * - `contracts` and `sales`: the season's points for the scope's operators;
 * - `priceNow`: the cash price on `now`, null before the window.
 *
 * @param {object} farm normalized farm
 * @param {object} report `jobCostReport` of the planned season
 * @param {{ kind: 'farm'|'operator'|'crop'|'plan', id?: string }} scope
 * @param {string|null} crop wanted crop; the scope's first when null or not grown there
 * @param {string|null} now `YYYY-MM-DD`
 * @returns {object|null} null when the scope has no priced crop
 */
export function breakevenChartData(farm, report, scope, crop, now) {
  const y = farm.season.cropYear;
  const plans = report.plans.filter(p => p.planId && p.crop && (
    scope.kind === 'operator' ? p.operatorId === scope.id
      : scope.kind === 'crop' ? p.crop === scope.id
        : scope.kind === 'plan' ? p.jobId === scope.id || p.planId === scope.id
          : true));
  const priced = new Set(farm.prices.map(p => p.crop));
  const crops = [...new Set(plans.map(p => p.crop))].filter(c => priced.has(c));
  if (!crops.length) return null;
  const c = crops.includes(crop) ? crop : crops[0];
  const ofCrop = plans.filter(p => p.crop === c);
  const row = scope.kind === 'plan' && ofCrop.length === 1 ? ofCrop[0] : sumPlanRows(ofCrop, {}, report.machineryBasis);
  const ops = new Set(ofCrop.map(p => p.operatorId));
  const table = farm.prices.filter(p => p.crop === c).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const contracts = farm.contracts.filter(k => k.crop === c && k.cropYear === y && ops.has(k.operatorId))
    .map(k => ({ date: k.deliveryDate, price: k.price, bushels: k.bushels, operatorId: k.operatorId }));
  const sales = farm.sales.filter(k => k.crop === c && k.cropYear === y && ops.has(k.operatorId))
    .map(k => ({ date: k.saleDate, price: k.price ?? priceOn(farm.prices, c, k.saleDate, 'realized'), share: k.share, operatorId: k.operatorId }));
  const start = `${y}-01-01`;
  const dated = [harvestDateFor(farm.season.calendar, c), ...table.map(p => p.date), ...contracts.map(k => k.date), ...sales.map(k => k.date)]
    .filter(Boolean).sort();
  const end = _addDays(dated.at(-1) ?? `${y}-12-31`, 31);
  const prices = [[start, priceOn(farm.prices, c, start, 'realized')]];
  for (const p of table) if (p.date > start && p.date <= end) prices.push([p.date, p.realized ?? p.price]);
  prices.push([end, priceOn(farm.prices, c, end, 'realized')]);
  const inWindow = now != null && now >= start && now <= end;
  return {
    crop: c, crops, row,
    breakevenUnpricedPrice: row.breakevenUnpricedPrice ?? null,
    breakevenPrice: row.breakevenPrice ?? null,
    expectedPrice: row.expectedPrice ?? null,
    contractedShare: row.expectedBushels > 0 ? row.contractedBushels / row.expectedBushels : 0,
    prices, contracts, sales, start, end,
    now, nowInWindow: inWindow,
    priceNow: now != null && now >= start ? priceOn(farm.prices, c, now, 'realized') : null,
  };
}

/** The sentence under the chart: the breakeven, and today's price against it. */
export function breakevenCaption(d, { basis = 'custom rates', date = (x) => x } = {}) {
  const be = d.breakevenUnpricedPrice ?? d.breakevenPrice;
  const what = d.breakevenUnpricedPrice != null
    ? `the unpriced grain (${(100 * (1 - d.contractedShare)).toFixed(0)}% of the crop) must fetch`
    : 'the crop is fully contracted; all of it must average';
  const parts = [be == null ? 'No breakeven: no expected bushels.'
    : `Planned season, ${basis}: ${what} ${_perBu(be)}/bu to break even.`];
  if (d.priceNow != null && be != null) {
    const diff = d.priceNow - be;
    parts.push(`Cash price on ${date(d.now)}: ${_perBu(d.priceNow)}, ${_perBu(Math.abs(diff))} ${diff >= 0 ? 'above' : 'below'} it.`);
  } else if (d.now != null && !d.nowInWindow) {
    parts.push(`The run is at ${date(d.now)}, before the crop year's prices.`);
  }
  return parts.join(' ');
}

/**
 * ECharts option for the breakeven chart. The zone below the breakeven is shaded red, so a
 * price inside it reads as a loss on the unpriced grain. (A visualMap colouring the line red
 * below the breakeven was tried first: ECharts throws while rendering when the whole line is
 * on one side of it, and then draws none of the series.)
 */
export function breakevenChartOption(d, { colors }) {
  const be = d.breakevenUnpricedPrice ?? d.breakevenPrice;
  const ts = (iso) => Date.parse(`${iso}T00:00:00Z`);
  const marks = [];
  if (be != null) {
    marks.push({ yAxis: be, name: 'breakeven', lineStyle: { color: colors.red, type: 'dashed', width: 1.5 },
      label: { formatter: `BE ${_perBu(be)}`, color: colors.red, fontSize: 10, position: 'insideEndTop' } });
  }
  if (d.breakevenUnpricedPrice != null && d.breakevenPrice != null && Math.abs(d.breakevenPrice - d.breakevenUnpricedPrice) > 0.005) {
    marks.push({ yAxis: d.breakevenPrice, name: 'breakeven, all bushels', lineStyle: { color: colors.muted, type: 'dotted', width: 1 },
      label: { formatter: `BE all bu ${_perBu(d.breakevenPrice)}`, color: colors.muted, fontSize: 9, position: 'insideStartTop' } });
  }
  if (d.nowInWindow) {
    marks.push({ xAxis: ts(d.now), name: 'now', lineStyle: { color: colors.amber, type: 'solid', width: 1 },
      label: { formatter: 'now', color: colors.amber, fontSize: 10, position: 'end' } });
  }
  const ys = [...d.prices.map(p => p[1]), ...d.contracts.map(k => k.price), ...d.sales.map(k => k.price), be, d.breakevenPrice]
    .filter(v => v != null && Number.isFinite(v));
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const pad = Math.max(0.05, (hi - lo) * 0.12);
  const yMin = +(lo - pad).toFixed(2);
  return {
    backgroundColor: 'transparent',
    animation: false,
    grid: { top: 18, right: 24, bottom: 24, left: 16, containLabel: true },
    xAxis: {
      type: 'time', min: ts(d.start), max: ts(d.end),
      axisLabel: { color: colors.dim, fontSize: 10, fontFamily: 'monospace' },
      splitLine: { show: false }, axisLine: { lineStyle: { color: colors.border } },
    },
    yAxis: {
      type: 'value', min: yMin, max: +(hi + pad).toFixed(2),
      axisLabel: { color: colors.dim, fontSize: 10, fontFamily: 'monospace', formatter: (v) => `$${v.toFixed(2)}` },
      splitLine: { lineStyle: { color: colors.border } },
    },
    tooltip: {
      trigger: 'item', backgroundColor: colors.panel, borderColor: colors.borderHi, borderWidth: 1,
      textStyle: { color: colors.text, fontSize: 10, fontFamily: 'monospace' },
      formatter: (p) => {
        const v = p.value ?? [];
        const day = new Date(v[0]).toISOString().slice(0, 10);
        if (p.seriesId === 'contracts') return `Contract ${day}: <b>${_perBu(v[1])}</b>${v[2] != null ? ` × ${Math.round(v[2]).toLocaleString()} bu` : ''}`;
        if (p.seriesId === 'sales') return `Planned sale ${day}: <b>${_perBu(v[1])}</b>${v[2] != null ? `, ${(100 * v[2]).toFixed(0)}% of unpriced` : ''}`;
        return `Cash price from ${day}: <b>${_perBu(v[1])}</b>`;
      },
    },
    series: [
      { id: 'price', name: 'Cash price', type: 'line', step: 'end', symbol: 'circle', symbolSize: 4,
        data: d.prices.map(([day, v]) => [ts(day), v]), lineStyle: { width: 2, color: colors.price },
        itemStyle: { color: colors.price },
        markLine: { silent: true, symbol: 'none', data: marks },
        ...(be == null ? {} : { markArea: { silent: true, itemStyle: { color: colors.red + '14' },
          data: [[{ yAxis: yMin, name: 'below breakeven' }, { yAxis: be }]],
          label: { show: true, position: 'insideBottomLeft', color: colors.red, fontSize: 9, formatter: 'below breakeven' } } }) },
      { id: 'contracts', name: 'Contracts', type: 'scatter', symbol: 'diamond', symbolSize: 10,
        itemStyle: { color: colors.green }, data: d.contracts.map(k => [ts(k.date), k.price, k.bushels]) },
      { id: 'sales', name: 'Planned sales', type: 'scatter', symbol: 'triangle', symbolSize: 9,
        itemStyle: { color: colors.amber }, data: d.sales.map(k => [ts(k.date), k.price, k.share]) },
    ],
  };
}

function _addDays(iso, n) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

const _byAmount = (o) => Object.entries(o).filter(([, v]) => v !== 0).sort((a, b) => b[1] - a[1]);
const _cropLabel = (c) => (CROPS[c]?.label ?? (c ? c.charAt(0) + c.slice(1).toLowerCase() : '—'));
const _perBu = (n) => (n == null ? '—' : `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`);
const _fmt = (n, d) => (n == null ? '—' : n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));

function _signCls(n) {
  if (n == null || n === 0) return '';
  return n > 0 ? 'sec-pos' : 'sec-neg';
}

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
