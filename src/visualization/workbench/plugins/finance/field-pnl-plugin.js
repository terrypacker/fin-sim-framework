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
import { priceHistoryBetween, PRICE_HISTORY_LIMITS } from '../../../../finance/farm/farm-price-history.js';
import { FARM_PRICE_HISTORY } from '../../../../finance/farm/farm-price-history-data.js';
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
 * Above the table, ONE CHART PER CROP the scope grows: the crop's cash price through the
 * season against the price its unpriced grain must fetch to break even, with its contracts
 * and planned sales as points and a marker at the run's current date. The scope is the row
 * last clicked: the whole farm (the footer), an operator or crop group, or a field. Crops sell
 * at different prices, so a scope growing two has two breakevens: each chart keeps its own
 * price axis, and they share one date range so the "now" markers line up.
 *
 * The breakeven is the PLANNED season's (`planFarm`: the same farm run to its end on an
 * isolated registry), not the table's season to date, whose breakevens are too low until the
 * grain is sold. So the line stays put as the run steps, and the "now" marker and the price
 * at it are what move.
 *
 * ─── the grain chart ─────────────────────────────────────────────────────────────
 *
 * Under the price charts, one chart per crop of WHERE THE GRAIN IS through the planned
 * season (design 134 §17.10): stacked, the bushels in storage that a later contract will take,
 * the unpriced bushels in storage, and what has gone on contracts and sales. The bands change
 * on each move's date, so storage is the area that rises at harvest and steps down at each
 * delivery out of it. Grain is pooled by operator and crop, so a field's scope shows its
 * operator's pool and says so.
 *
 * ─── the grain value chart ───────────────────────────────────────────────────────
 *
 * Under the grain charts, one chart per crop of WHAT THE GRAIN IS WORTH on each date
 * (design 134 §17.11), stacked from the most certain dollars to the least: paid, delivered or
 * sold but not yet paid, in storage at the price of the later contract that takes it, and in
 * storage unpriced at that day's cash price. Only the top band moves with the market, so the
 * chart steps on price dates as well as on moves and payments. A dashed line is what the
 * pool's grain must earn: the cost of the operator's plans of the crop less their non-grain
 * revenue.
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
    this._plan    = null;                  // { sig, data | reason, reports: { [basis]: report } }
    this._charts  = new Map();             // crop → ECharts instance
    this._chartCrops = '';                 // the crops the chart DOM was built for
    this._grainCharts = new Map();         // crop → ECharts instance (the grain chart)
    this._grainCrops  = '';
    this._valueCharts = new Map();         // crop → ECharts instance (the grain value chart)
    this._valueCrops  = '';
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
          </div>
          <div data-fpl="charts"></div>
        </div>
        <div class="fpl-chart-wrap" data-fpl="grain-wrap" style="display:none">
          <div class="fpl-chart-head">
            <span class="mc-section-label" data-fpl="grain-label">Where the grain is</span>
          </div>
          <div data-fpl="grain-charts"></div>
        </div>
        <div class="fpl-chart-wrap" data-fpl="value-wrap" style="display:none">
          <div class="fpl-chart-head">
            <span class="mc-section-label" data-fpl="value-label">What the grain is worth</span>
          </div>
          <div data-fpl="value-charts"></div>
        </div>
        <table class="sec-grid fpl-split-off" data-fpl="grid" style="display:none">
          <thead><tr>
            <th class="sec-th">Field</th>
            <th class="sec-th">Crop</th>
            <th class="sec-th sec-th--num">Acres</th>
            <th class="sec-th sec-th--num" title="Bushels harvested (tons for alfalfa): planted acres × the realized yield. A row mixing crops shows none, since corn and bean bushels do not add">Bushels</th>
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
    this._render();
  }

  onActivate() {
    // ECharts cannot size itself in a hidden pane.
    this._resizeCharts();
    this._render();
  }

  onAdopt() { this._resizeCharts(); }

  _resizeCharts() {
    for (const c of [...this._charts.values(), ...this._grainCharts.values(), ...this._valueCharts.values()]) c.resize();
  }

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
    for (const c of this._charts.values()) c.dispose();
    this._charts.clear();
    this._chartCrops = '';
    for (const c of this._grainCharts.values()) c.dispose();
    this._grainCharts.clear();
    this._grainCrops = '';
    for (const c of this._valueCharts.values()) c.dispose();
    this._valueCharts.clear();
    this._valueCrops = '';
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
      this._q('grain-wrap').style.display = 'none';
      this._q('value-wrap').style.display = 'none';
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
    return { farm: d.farm, report: this._plan.reports[b], grain: d.grain ?? [], grainSales: d.grainSales ?? [], ledger: d.ledger };
  }

  _renderChart(farm) {
    const wrap = this._q('chart-wrap');
    if (!wrap) return;
    const plan = this._planReport();
    if (plan.reason) {
      wrap.style.display = 'none';
      this._q('grain-wrap').style.display = 'none';
      this._q('value-wrap').style.display = 'none';
      return;
    }
    const now = this._sim?.currentDate ? this._sim.currentDate.toISOString().slice(0, 10) : null;
    const set = breakevenChartSet(plan.farm, plan.report, this._chartScope, now);
    this._renderGrain(farm, plan, now, set);
    this._renderValue(farm, plan, now, set);
    if (!set.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    const basis = this._machineryBasis === 'ACTUAL' ? 'actual machinery' : 'custom rates';
    this._q('chart-label').textContent =
      `${this._scopeLabel(farm, this._chartScope)} — cash price vs breakeven (planned season, ${basis})`;

    // The chart DOM is rebuilt only when the crops change, so the ECharts instances survive
    // the run stepping (a rebuild every step would re-init every chart).
    const host = this._q('charts');
    const key = set.map(d => d.crop).join('|');
    if (key !== this._chartCrops) {
      this._disposeChart();
      host.innerHTML = set.map(d => `
        <div class="fpl-crop-chart" data-crop="${_esc(d.crop)}">
          <div class="fpl-chart" data-fpl-chart="${_esc(d.crop)}"></div>
          <div class="bond-caption" data-fpl-caption="${_esc(d.crop)}"></div>
        </div>`).join('');
      this._chartCrops = key;
    }
    const date = (d) => this._fmtDate(d);
    // The history's limits are said once, under the last chart that draws any history.
    const lastWithHistory = set.map(d => d.history?.length > 0).lastIndexOf(true);
    set.forEach((d, i) => {
      host.querySelector(`[data-fpl-caption="${d.crop}"]`).textContent =
        breakevenCaption(d, { date, label: _cropLabel(d.crop), limits: i === lastWithHistory });
    });
    if (!this._canvasAvailable()) return;
    const colors = this._colors();
    set.forEach((d, i) => {
      const el = host.querySelector(`[data-fpl-chart="${d.crop}"]`);
      let chart = this._charts.get(d.crop);
      if (!chart) {
        chart = echarts.init(el, null, { renderer: 'canvas' });
        this._charts.set(d.crop, chart);
        if (typeof ResizeObserver === 'function') {
          this._ro ??= new ResizeObserver(() => this._resizeCharts());
          this._ro.observe(el);
        }
      }
      chart.setOption(breakevenChartOption(d, {
        colors, title: _cropLabel(d.crop), xLabels: i === set.length - 1,
      }), true);
    });
  }

  /**
   * The grain charts, one per crop, under the price charts and on their date range: where the
   * PLANNED season's grain is on each date (`grainChartSet`). A field's scope shows its
   * operator's pool, since grain is pooled by operator and crop, not tracked by field.
   */
  _renderGrain(farm, plan, now, priceSet) {
    const wrap = this._q('grain-wrap');
    if (!wrap) return;
    const set = grainChartSet(plan.farm, plan.grain, plan.ledger, this._chartScope, now, priceSet.length
      ? { start: priceSet[0].start, end: priceSet[0].end, crops: priceSet.map(d => d.crop) } : {});
    if (!set.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    this._q('grain-label').textContent = `${this._scopeLabel(farm, this._chartScope)} — where the grain is (planned season, bushels)`;
    const host = this._q('grain-charts');
    const key = set.map(d => d.crop).join('|');
    if (key !== this._grainCrops) {
      for (const c of this._grainCharts.values()) c.dispose();
      this._grainCharts.clear();
      host.innerHTML = set.map(d => `
        <div class="fpl-crop-chart" data-crop="${_esc(d.crop)}">
          <div class="fpl-chart fpl-grain-chart" data-fpl-grain="${_esc(d.crop)}"></div>
          <div class="bond-caption" data-fpl-grain-caption="${_esc(d.crop)}"></div>
        </div>`).join('');
      this._grainCrops = key;
    }
    const date = (d) => this._fmtDate(d);
    for (const d of set) {
      host.querySelector(`[data-fpl-grain-caption="${d.crop}"]`).textContent = grainCaption(d, {
        date, label: _cropLabel(d.crop), poolOf: d.pooledFrom ? this._operatorName(farm, d.pooledFrom) : null,
      });
    }
    if (!this._canvasAvailable()) return;
    const colors = this._colors();
    set.forEach((d, i) => {
      const el = host.querySelector(`[data-fpl-grain="${d.crop}"]`);
      let chart = this._grainCharts.get(d.crop);
      if (!chart) {
        chart = echarts.init(el, null, { renderer: 'canvas' });
        this._grainCharts.set(d.crop, chart);
        if (typeof ResizeObserver === 'function') {
          this._ro ??= new ResizeObserver(() => this._resizeCharts());
          this._ro.observe(el);
        }
      }
      chart.setOption(grainChartOption(d, { colors, title: _cropLabel(d.crop), xLabels: i === set.length - 1 }), true);
    });
  }

  /**
   * The grain value charts, one per crop, under the grain charts and on the price charts'
   * date range: what the PLANNED season's grain is worth on each date (`grainValueSet`).
   */
  _renderValue(farm, plan, now, priceSet) {
    const wrap = this._q('value-wrap');
    if (!wrap) return;
    const set = grainValueSet(plan.farm, plan.grain, plan.grainSales, plan.ledger, plan.report, this._chartScope, now,
      priceSet.length ? { start: priceSet[0].start, end: priceSet[0].end, crops: priceSet.map(d => d.crop) } : {});
    if (!set.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    const basis = this._machineryBasis === 'ACTUAL' ? 'actual machinery' : 'custom rates';
    this._q('value-label').textContent =
      `${this._scopeLabel(farm, this._chartScope)} — what the grain is worth (planned season, breakeven on ${basis})`;
    const host = this._q('value-charts');
    const key = set.map(d => d.crop).join('|');
    if (key !== this._valueCrops) {
      for (const c of this._valueCharts.values()) c.dispose();
      this._valueCharts.clear();
      host.innerHTML = set.map(d => `
        <div class="fpl-crop-chart" data-crop="${_esc(d.crop)}">
          <div class="fpl-chart fpl-grain-chart" data-fpl-value="${_esc(d.crop)}"></div>
          <div class="bond-caption" data-fpl-value-caption="${_esc(d.crop)}"></div>
        </div>`).join('');
      this._valueCrops = key;
    }
    const date = (d) => this._fmtDate(d);
    for (const d of set) {
      host.querySelector(`[data-fpl-value-caption="${d.crop}"]`).textContent = grainValueCaption(d, {
        date, label: _cropLabel(d.crop), poolOf: d.pooledFrom ? this._operatorName(farm, d.pooledFrom) : null,
      });
    }
    if (!this._canvasAvailable()) return;
    const colors = this._colors();
    set.forEach((d, i) => {
      const el = host.querySelector(`[data-fpl-value="${d.crop}"]`);
      let chart = this._valueCharts.get(d.crop);
      if (!chart) {
        chart = echarts.init(el, null, { renderer: 'canvas' });
        this._valueCharts.set(d.crop, chart);
        if (typeof ResizeObserver === 'function') {
          this._ro ??= new ResizeObserver(() => this._resizeCharts());
          this._ro.observe(el);
        }
      }
      chart.setOption(grainValueOption(d, { colors, title: _cropLabel(d.crop), xLabels: i === set.length - 1 }), true);
    });
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
        <td class="sec-td fpl-line-name" colspan="4">${_esc(l.label)}${where}${l.note ? ` <span class="sec-td--muted">${_esc(l.note)}</span>` : ''}</td>
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
        <td class="sec-td sec-td--num">${_fmt(fieldPnlBushels(r), 0)}</td>
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
/** A row's harvested bushels, or null where it mixes crops (bushels of two crops do not add). */
export function fieldPnlBushels(r) {
  return r.crop ? r.harvestedBushels ?? null : null;
}

export const FIELD_PNL_CSV_COLUMNS = Object.freeze(['scope', 'operator', 'job', 'field', 'crop', 'tenure',
  'irrigated', 'acres', 'bushels', 'revenue', 'directCost', 'overheadCost', 'machineryCost', 'machineryBasis', 'net',
  'netPerAcre', 'expectedPrice', 'breakevenPrice', 'breakevenUnpricedPrice', 'expectedYield', 'breakevenYield',
  'category', 'scheduleFLine', 'amount']);

/** One FIELD row per job, a LINE row per category on it, OPERATOR and FARM totals. */
export function fieldPnlCsv(report, farm) {
  const out = [];
  const opName = (id) => farm?.operators?.find(o => o.id === id)?.name ?? id;
  const fig = (r) => [r.acres, fieldPnlBushels(r), r.revenue.total, r.directCost, r.overheadCost, r.machineryCost, report.machineryBasis,
    r.net, r.perAcre.net, r.expectedPrice, r.breakevenPrice, r.breakevenUnpricedPrice, r.expectedYield, r.breakevenYield];
  for (const g of fieldPnlGroups(report, 'operator')) {
    out.push(['OPERATOR', opName(g.key), '', '', '', '', '', ...fig(g.row), '', '', '']);
    for (const p of g.plans) {
      out.push(['FIELD', opName(p.operatorId), p.jobId, p.fieldName, p.crop ?? '', p.tenure, p.irrigated, ...fig(p), '', '', '']);
      for (const l of fieldPnlLines(p, report.machineryBasis)) {
        out.push([`LINE_${l.kind.toUpperCase()}`, opName(p.operatorId), p.jobId, p.fieldName, p.crop ?? '', '', '',
          ...new Array(14).fill(''), l.category, l.line ?? '', +l.amount.toFixed(2)]);
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
 * - `priceNow`: the cash price on `now`, null before the window;
 * - `history` and `windows`: the crop's REAL monthly prices published within the window
 *   (`seasonHistory`, design 134 §17.5 step 8b) and the months among them at or above the
 *   breakeven.
 *
 * @param {object} farm normalized farm
 * @param {object} report `jobCostReport` of the planned season
 * @param {{ kind: 'farm'|'operator'|'crop'|'plan', id?: string }} scope
 * @param {string|null} crop wanted crop; the scope's first when null or not grown there
 * @param {string|null} now `YYYY-MM-DD`
 * @param {{ history?: object }} [opts] the price history (default `FARM_PRICE_HISTORY`; tests)
 * @returns {object|null} null when the scope has no priced crop
 */
export function breakevenChartData(farm, report, scope, crop, now, { history = FARM_PRICE_HISTORY } = {}) {
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
  const be = row.breakevenUnpricedPrice ?? row.breakevenPrice ?? null;
  return {
    crop: c, crops, row,
    ...seasonHistory(c, start, end, be, history),
    breakevenUnpricedPrice: row.breakevenUnpricedPrice ?? null,
    breakevenPrice: row.breakevenPrice ?? null,
    expectedPrice: row.expectedPrice ?? null,
    contractedShare: row.expectedBushels > 0 ? row.contractedBushels / row.expectedBushels : 0,
    prices, contracts, sales, start, end,
    now, nowInWindow: inWindow,
    priceNow: now != null && now >= start ? priceOn(farm.prices, c, now, 'realized') : null,
  };
}

/**
 * Every crop's chart data for one scope: `breakevenChartData` per crop the scope grows, all on
 * the widest date range among them, so stacked charts share their time axis and the "now"
 * markers line up.
 *
 * @returns {object[]} one entry per crop, in the order the scope's plans list them; empty
 *   when the scope has no priced crop
 */
export function breakevenChartSet(farm, report, scope, now, { history = FARM_PRICE_HISTORY } = {}) {
  const first = breakevenChartData(farm, report, scope, null, now, { history });
  if (!first) return [];
  const set = first.crops.map(c => (c === first.crop ? first : breakevenChartData(farm, report, scope, c, now, { history })));
  const start = set.map(d => d.start).sort()[0];
  const end = set.map(d => d.end).sort().at(-1);
  return set.map(d => {
    const prices = d.prices.map(p => [...p]);
    if (prices.at(-1)[0] < end) prices.push([end, prices.at(-1)[1]]);
    const be = d.breakevenUnpricedPrice ?? d.breakevenPrice;
    return { ...d, ...seasonHistory(d.crop, start, end, be, history), prices, start, end,
      nowInWindow: now != null && now >= start && now <= end };
  });
}

/**
 * A crop's REAL prices within a chart's window, and its marketing windows (design 134 §17.5,
 * step 8b): the published months at or above the breakeven, when the unpriced grain could
 * have been sold at breakeven.
 *
 * The history is Nebraska's monthly average price received (`FARM_PRICE_HISTORY`), so each
 * month is drawn at its middle and its window spans the whole month. It is shown whatever the
 * run's date: these are published facts, not the plan.
 *
 * @param {string} crop
 * @param {string} start `YYYY-MM-DD`, the window's first day
 * @param {string} end `YYYY-MM-DD`, its last
 * @param {number|null} be the breakeven the chart draws
 * @param {object} [history=FARM_PRICE_HISTORY]
 * @returns {{ history: Array<[string, number]>, windows: { months: string[], first: string|null,
 *   published: number, historyLatest: string|null } }} months are `YYYY-MM`
 */
export function seasonHistory(crop, start, end, be, history = FARM_PRICE_HISTORY) {
  const months = priceHistoryBetween(crop, start.slice(0, 7), end.slice(0, 7), history);
  const above = be == null ? [] : months.filter(([, p]) => p >= be).map(([m]) => m);
  return {
    history: months,
    windows: { months: above, first: above[0] ?? null, published: months.length,
      historyLatest: months.at(-1)?.[0] ?? null },
  };
}

/** The sentence under a crop's chart: its breakeven, and today's price against it. */
export function breakevenCaption(d, { date = (x) => x, label = null, limits = true } = {}) {
  const be = d.breakevenUnpricedPrice ?? d.breakevenPrice;
  const what = d.breakevenUnpricedPrice != null
    ? `the unpriced grain (${(100 * (1 - d.contractedShare)).toFixed(0)}% of the crop) must fetch`
    : 'fully contracted; all of it must average';
  const parts = [`${label ? `${label}: ` : ''}${be == null ? 'no breakeven (no expected bushels).'
    : `${what} ${_perBu(be)}/bu to break even.`}`];
  if (d.priceNow != null && be != null) {
    const diff = d.priceNow - be;
    parts.push(`Cash price on ${date(d.now)}: ${_perBu(d.priceNow)}, ${_perBu(Math.abs(diff))} ${diff >= 0 ? 'above' : 'below'} it.`);
  } else if (d.now != null && !d.nowInWindow) {
    parts.push(`The run is at ${date(d.now)}, before the crop year's prices.`);
  }
  if (d.history?.length && be != null) {
    const w = d.windows;
    const n = `${w.published} published month${w.published === 1 ? '' : 's'}`;
    parts.push(w.first
      ? `Nebraska average so far: at or above it in ${w.months.length} of ${n}, first in ${_monthLabel(w.first)}.`
      : `Nebraska average so far: below it in all ${n}.`);
    if (limits) parts.push(`(${PRICE_HISTORY_LIMITS.join('; ')}.)`);
  }
  return parts.join(' ');
}

/**
 * ECharts option for the breakeven chart. The zone below the breakeven is shaded red, so a
 * price inside it reads as a loss on the unpriced grain. (A visualMap colouring the line red
 * below the breakeven was tried first: ECharts throws while rendering when the whole line is
 * on one side of it, and then draws none of the series.)
 */
export function breakevenChartOption(d, { colors, title = null, xLabels = true }) {
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
  const hist = d.history ?? [];
  const mid = (m) => ts(`${m}-15`);
  const monthStart = (m) => ts(`${m}-01`);
  const monthEnd = (m) => { const [y, mo] = m.split('-').map(Number); return Date.UTC(mo === 12 ? y + 1 : y, mo === 12 ? 0 : mo, 1); };
  const ys = [...d.prices.map(p => p[1]), ...d.contracts.map(k => k.price), ...d.sales.map(k => k.price),
    ...hist.map(h => h[1]), be, d.breakevenPrice]
    .filter(v => v != null && Number.isFinite(v));
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const pad = Math.max(0.05, (hi - lo) * 0.12);
  const yMin = +(lo - pad).toFixed(2);
  return {
    backgroundColor: 'transparent',
    animation: false,
    // A FIXED left margin, not containLabel: stacked charts must put their plot areas at the
    // same x, or their "now" markers drift apart by the width of their price labels.
    grid: { top: title ? 22 : 18, right: 24, bottom: xLabels ? 24 : 8, left: 64, containLabel: false },
    ...(title ? { title: { text: title, left: 4, top: 0, textStyle: { color: colors.dim, fontSize: 10, fontWeight: 600, fontFamily: 'monospace' } } } : {}),
    xAxis: {
      type: 'time', min: ts(d.start), max: ts(d.end),
      axisLabel: { show: xLabels, color: colors.dim, fontSize: 10, fontFamily: 'monospace' },
      splitLine: { show: false }, axisLine: { lineStyle: { color: colors.border } },
    },
    yAxis: {
      type: 'value', min: yMin, max: +(hi + pad).toFixed(2),
      // The max is padded, not a round number, so its label would read like $11.48.
      axisLabel: { color: colors.dim, fontSize: 10, fontFamily: 'monospace', showMaxLabel: false, formatter: (v) => `$${v.toFixed(2)}` },
      splitLine: { lineStyle: { color: colors.border } },
    },
    tooltip: {
      trigger: 'item', backgroundColor: colors.panel, borderColor: colors.borderHi, borderWidth: 1,
      textStyle: { color: colors.text, fontSize: 10, fontFamily: 'monospace' },
      formatter: (p) => {
        const v = p.value ?? [];
        const day = new Date(v[0]).toISOString().slice(0, 10);
        if (p.seriesId === 'contracts') return `Contract ${day}: <b>${_perBu(v[1])}</b>${v[2] != null ? ` × ${Math.round(v[2]).toLocaleString()} bu` : ''}`;
        if (p.seriesId === 'history') {
          const m = new Date(v[0]).toISOString().slice(0, 7);
          return `Nebraska average, ${_monthLabel(m)}: <b>${_perBu(v[1])}</b>${be != null ? `, ${_perBu(Math.abs(v[1] - be))} ${v[1] >= be ? 'above' : 'below'} breakeven` : ''}`
            + `<br/><span style="color:${colors.muted}">monthly average price received; not a local bid</span>`;
        }
        if (p.seriesId === 'now') return `Cash price on ${day}: <b>${_perBu(v[1])}</b>${be != null ? `, ${_perBu(Math.abs(v[1] - be))} ${v[1] >= be ? 'above' : 'below'} breakeven` : ''}`;
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
          data: [[{ yAxis: yMin, name: 'below breakeven' }, { yAxis: be }]], label: { show: false } } }) },
      { id: 'contracts', name: 'Contracts', type: 'scatter', symbol: 'diamond', symbolSize: 10,
        itemStyle: { color: colors.green }, data: d.contracts.map(k => [ts(k.date), k.price, k.bushels]) },
      { id: 'sales', name: 'Planned sales', type: 'scatter', symbol: 'triangle', symbolSize: 9,
        itemStyle: { color: colors.amber }, data: d.sales.map(k => [ts(k.date), k.price, k.share]) },
      // The real monthly prices published so far (step 8b), drawn at mid-month, with each
      // month at or above the breakeven shaded green across its width: a marketing window.
      ...(hist.length ? [{
        id: 'history', name: 'Nebraska average', type: 'line', symbol: 'circle', symbolSize: 5, z: 4,
        lineStyle: { color: colors.text, width: 1, type: 'dotted', opacity: 0.7 }, itemStyle: { color: colors.text },
        data: hist.map(([m, v]) => [mid(m), v]),
        markArea: { silent: true, itemStyle: { color: colors.green + '1f' },
          data: (d.windows?.months ?? []).map(m => [{ xAxis: monthStart(m) }, { xAxis: monthEnd(m) }]) },
      }] : []),
      // Today's cash price: where the "now" marker crosses the price line, labelled, green
      // above the breakeven and red below it.
      ...(d.nowInWindow && d.priceNow != null ? [{
        id: 'now', name: 'Cash price now', type: 'scatter', symbol: 'circle', symbolSize: 9, z: 5,
        itemStyle: { color: be == null || d.priceNow >= be ? colors.green : colors.red, borderColor: colors.text, borderWidth: 1 },
        label: { show: true, position: 'top', distance: 6, formatter: _perBu(d.priceNow), color: colors.text, fontSize: 10, fontWeight: 600 },
        data: [[ts(d.now), d.priceNow]],
      }] : []),
    ],
  };
}

// ─── The grain chart ─────────────────────────────────────────────────────────────

/** The chart's bands, bottom to top: where the scope's harvested and carried-in grain is. */
export const GRAIN_BANDS = Object.freeze([
  { id: 'binContracted', label: 'In storage, contracted' },
  { id: 'binUnpriced',   label: 'In storage, unpriced' },
  { id: 'delivered',     label: 'Delivered on contract' },
  { id: 'sold',          label: 'Sold' },
]);

/**
 * Where one crop's grain is through the season, for one scope (design 134 §17.10): after
 * each day's moves, how many bushels are in storage (split into those a later contract
 * delivery will take and the rest), and how many have left on a contract or a sale.
 *
 * Grain pools are (operator, crop, crop year), so storage is the operator's, never a field's.
 * A field's scope shows its operator's pool of that crop. "In storage" is the pool: grain
 * that goes to a buyer on its harvest day is never in it, because harvest and delivery fall
 * on the same date. Carried-in grain is in storage from the carry-in date.
 *
 * @param {object} farm normalized farm
 * @param {object[]} moves `farmGrainMoves` of the planned season
 * @param {object[]} ledger `farmLedger` of the planned season (its storage cost)
 * @param {{ kind: 'farm'|'operator'|'crop'|'plan', id?: string }} scope
 * @param {string} crop
 * @param {string|null} now `YYYY-MM-DD`
 * @param {{ start?: string, end?: string }} [win] the date range; widened to every move
 * @returns {object|null} null when the scope moves none of that crop
 */
export function grainChartData(farm, moves, ledger, scope, crop, now, win = {}) {
  const { mine, planOp } = _poolScope(farm, scope, crop);
  // Journal order within a day: harvest and carry-in come before the moves out of the pool.
  const ms = moves.filter(mine).map((m, i) => ({ ...m, i }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.i - b.i));
  if (!ms.length) return null;

  const dates = [...new Set(ms.map(m => m.date))];
  const first = ms[0].date, last = ms.at(-1).date;
  const start = win.start && win.start < first ? win.start : _addDays(first, -31);
  const end = win.end && win.end > last ? win.end : _addDays(last, 31);
  const held = new Map();                    // pool → bushels in it
  const out = { delivered: 0, sold: 0 };
  const points = [{ date: start, binContracted: 0, binUnpriced: 0, delivered: 0, sold: 0, moves: [] }];
  for (const day of dates) {
    const today = ms.filter(m => m.date === day);
    for (const m of today) {
      held.set(m.pool, (held.get(m.pool) ?? 0) + m.bushels);
      if (m.kind === 'DELIVER') out.delivered -= m.bushels;
      if (m.kind === 'SELL') out.sold -= m.bushels;
    }
    // What a later contract delivery takes out of each pool is spoken for.
    let contracted = 0, bin = 0;
    for (const [pool, bu] of held) {
      const later = ms.filter(m => m.pool === pool && m.kind === 'DELIVER' && m.date > day)
        .reduce((s, m) => s - m.bushels, 0);
      const b = Math.max(0, bu);
      bin += b;
      contracted += Math.min(b, later);
    }
    points.push({ date: day, binContracted: contracted, binUnpriced: bin - contracted, ...out,
      moves: _dayMoves(farm, today) });
  }
  const tail = points.at(-1);
  points.push({ ...tail, date: end, moves: [] });

  const pools = new Set(ms.map(m => m.pool));
  const ins = (k) => ms.filter(m => m.kind === k).reduce((s, m) => s + m.bushels, 0);
  const harvests = [...new Set(ms.filter(m => m.kind === 'HARVEST').map(m => m.date))];
  const harvestDay = harvests.length === 1 ? harvests[0] : null;
  const leftAtHarvest = harvestDay == null ? 0
    : ms.filter(m => m.date === harvestDay && m.bushels < 0).reduce((s, m) => s - m.bushels, 0);
  const afterHarvest = points.filter(p => harvestDay == null || p.date >= harvestDay);
  const peak = Math.max(0, ...afterHarvest.map(p => p.binContracted + p.binUnpriced));
  const outs = ms.filter(m => m.bushels < 0);
  return {
    crop, start, end, now, nowInWindow: now != null && now >= start && now <= end,
    points,
    harvests,
    pooledFrom: scope.kind === 'plan' ? planOp : null,
    harvested: ins('HARVEST'),
    carriedIn: ins('CARRY_IN'),
    harvestDay,
    leftAtHarvest,
    storedPeak: peak,
    lastOut: outs.at(-1)?.date ?? null,
    endingStock: tail.binContracted + tail.binUnpriced,
    shortBushels: ms.reduce((s, m) => s + (m.shortBushels ?? 0), 0),
    storageCost: (ledger ?? []).filter(r => r.category === 'STORAGE' && pools.has(String(r.jobId).replace(/^pool:/, '')))
      .reduce((s, r) => s + r.amount, 0),
  };
}

/**
 * Which grain pools a scope sees for one crop: an operator's own, a field's operator's (grain
 * is pooled by operator and crop, not tracked by field), or every operator's.
 *
 * @returns {{ mine: (r: { crop: string, operatorId: string }) => boolean, planOp: string|null }}
 */
function _poolScope(farm, scope, crop) {
  const plan = scope.kind === 'plan'
    ? farm.cropPlans.find(p => p.id === scope.id) ?? null : null;
  const planOp = plan ? farm.fields.find(f => f.id === plan.fieldId)?.operatorId ?? null : null;
  const mine = (m) => m.crop === crop && (
    scope.kind === 'operator' ? m.operatorId === scope.id
      : scope.kind === 'plan' ? m.operatorId === planOp
        : true);
  return { mine, planOp };
}

/** One day's moves for the tooltip: the harvest as one line, each move out on its own. */
function _dayMoves(farm, today) {
  const lines = [];
  const harvest = today.filter(m => m.kind === 'HARVEST');
  if (harvest.length) {
    lines.push({ kind: 'HARVEST', bushels: harvest.reduce((s, m) => s + m.bushels, 0),
      label: harvest.length === 1 ? (_fieldOfPlan(farm, harvest[0].planId) ?? 'Harvest') : `Harvest, ${harvest.length} fields` });
  }
  for (const m of today) {
    if (m.kind === 'CARRY_IN') lines.push({ kind: m.kind, bushels: m.bushels, label: `Carried in from ${m.cropYear}` });
    if (m.kind === 'DELIVER') {
      const k = farm.contracts.find(c => c.id === m.sourceId);
      lines.push({ kind: m.kind, bushels: -m.bushels, price: k?.price ?? null, label: k?.name ?? m.sourceId,
        cropYear: m.cropYear, short: m.shortBushels ?? 0 });
    }
    if (m.kind === 'SELL') {
      const s = farm.sales.find(x => x.id === m.sourceId);
      lines.push({ kind: m.kind, bushels: -m.bushels, label: s?.name ?? 'planned sale', cropYear: m.cropYear,
        price: s?.price ?? priceOn(farm.prices, m.crop, m.date, 'realized') });
    }
  }
  return lines;
}

function _fieldOfPlan(farm, planId) {
  const p = farm.cropPlans.find(x => x.id === planId);
  return farm.fields.find(f => f.id === p?.fieldId)?.name ?? null;
}

/**
 * Every crop's grain chart for one scope, on one date range (the price charts' when given),
 * in the order `crops` lists them, then any other crop the scope moves.
 */
export function grainChartSet(farm, moves, ledger, scope, now, { start, end, crops = [] } = {}) {
  const plan = scope.kind === 'plan' ? farm.cropPlans.find(p => p.id === scope.id) : null;
  const all = [...new Set([...crops, ...moves.map(m => m.crop)])]
    .filter(c => (scope.kind === 'crop' ? c === scope.id : plan ? c === plan.crop : true));
  const set = all.map(c => grainChartData(farm, moves, ledger, scope, c, now, { start, end })).filter(Boolean);
  if (!set.length) return [];
  const s = set.map(d => d.start).sort()[0];
  const e = set.map(d => d.end).sort().at(-1);
  return set.map(d => {
    const points = d.points.map(p => ({ ...p }));
    points[0].date = s;
    points.at(-1).date = e;
    return { ...d, points, start: s, end: e, nowInWindow: now != null && now >= s && now <= e };
  });
}

/** The sentence under a crop's grain chart. */
export function grainCaption(d, { date = (x) => x, label = null, poolOf = null } = {}) {
  const bu = (n) => `${Math.round(n).toLocaleString()} bu`;
  const parts = [];
  const head = label ? `${label}: ` : '';
  if (d.harvested > 0) {
    parts.push(`${head}${bu(d.harvested)} harvested${d.harvestDay ? ` on ${date(d.harvestDay)}` : ''}`
      + (d.leftAtHarvest > 0 ? `, ${bu(d.leftAtHarvest)} of it delivered or sold that day.` : '.'));
  } else {
    parts.push(`${head}no harvest in this window.`);
  }
  if (d.carriedIn > 0) parts.push(`${bu(d.carriedIn)} carried in from the year before.`);
  parts.push(d.storedPeak > 0
    ? `Up to ${bu(d.storedPeak)} in storage after harvest${d.lastOut ? `; the last leaves on ${date(d.lastOut)}` : ''}.`
    : 'None of it goes into storage.');
  if (d.endingStock > 0.5) parts.push(`${bu(d.endingStock)} still in storage at the end of the run.`);
  if (d.storageCost > 0) parts.push(`Storage cost ${_money0(d.storageCost)}.`);
  if (d.shortBushels > 0.5) parts.push(`Contracts short by ${bu(d.shortBushels)}, settled at the market.`);
  if (poolOf) parts.push(`This is ${poolOf}'s whole pool of the crop: grain is not tracked by field.`);
  return parts.join(' ');
}

/** ECharts option for a crop's grain chart: the bands stacked, as steps on each move date. */
export function grainChartOption(d, { colors, title = null, xLabels = true }) {
  const ts = (iso) => Date.parse(`${iso}T00:00:00Z`);
  const fill = { binContracted: colors.price, binUnpriced: colors.amber, delivered: colors.green, sold: colors.dim };
  const byTs = new Map(d.points.map(p => [ts(p.date), p]));
  const marks = d.harvests.map(h => ({ xAxis: ts(h), name: 'harvest',
    lineStyle: { color: colors.muted, type: 'dashed', width: 1 },
    label: { formatter: 'harvest', color: colors.muted, fontSize: 9, position: 'end' } }));
  if (d.nowInWindow) {
    marks.push({ xAxis: ts(d.now), name: 'now', lineStyle: { color: colors.amber, type: 'solid', width: 1 },
      label: { formatter: 'now', color: colors.amber, fontSize: 10, position: 'end' } });
  }
  const bu = (n) => Math.round(n).toLocaleString();
  return {
    backgroundColor: 'transparent',
    animation: false,
    // The price charts' fixed left margin, so the two stacks line up on the date axis. The top
    // leaves a row for the marker labels under the legend.
    grid: { top: 34, right: 24, bottom: xLabels ? 24 : 8, left: 64, containLabel: false },
    ...(title ? { title: { text: title, left: 4, top: 0, textStyle: { color: colors.dim, fontSize: 10, fontWeight: 600, fontFamily: 'monospace' } } } : {}),
    legend: { top: 0, right: 24, itemWidth: 10, itemHeight: 8, textStyle: { color: colors.dim, fontSize: 9, fontFamily: 'monospace' },
      data: GRAIN_BANDS.map(b => b.label) },
    xAxis: {
      type: 'time', min: ts(d.start), max: ts(d.end),
      axisLabel: { show: xLabels, color: colors.dim, fontSize: 10, fontFamily: 'monospace' },
      splitLine: { show: false }, axisLine: { lineStyle: { color: colors.border } },
    },
    yAxis: {
      type: 'value', min: 0,
      axisLabel: { color: colors.dim, fontSize: 10, fontFamily: 'monospace', formatter: (v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : `${v}`) },
      splitLine: { lineStyle: { color: colors.border } },
    },
    tooltip: {
      trigger: 'axis', backgroundColor: colors.panel, borderColor: colors.borderHi, borderWidth: 1,
      textStyle: { color: colors.text, fontSize: 10, fontFamily: 'monospace' },
      formatter: (ps) => {
        const p = byTs.get(ps[0]?.value?.[0]);
        if (!p) return '';
        const rows = GRAIN_BANDS.map(b => `${b.label}: <b>${bu(p[b.id])}</b> bu`);
        const moved = p.moves.map(m => {
          const sign = m.kind === 'HARVEST' || m.kind === 'CARRY_IN' ? '+' : '−';
          const price = m.price != null ? ` at ${_perBu(m.price)}` : '';
          const short = m.short > 0.5 ? `, ${bu(m.short)} bu short` : '';
          return `${sign}${bu(m.bushels)} bu ${_esc(m.label)}${price}${short}`;
        });
        return [`<b>${p.date}</b>`, ...rows,
          ...(moved.length ? [`<span style="color:${colors.muted}">moves that day</span>`, ...moved] : [])].join('<br/>');
      },
    },
    series: GRAIN_BANDS.map((b, i) => ({
      id: b.id, name: b.label, type: 'line', step: 'end', stack: 'grain', symbol: 'none',
      lineStyle: { width: _bandEmpty(d.points, b.id) ? 0 : 1, color: fill[b.id] }, itemStyle: { color: fill[b.id] },
      areaStyle: { color: fill[b.id], opacity: b.id.startsWith('bin') ? 0.55 : 0.18 },
      data: d.points.map(p => [ts(p.date), p[b.id]]),
      ...(i === 0 ? { markLine: { silent: true, symbol: 'none', data: marks } } : {}),
    })),
  };
}

// ─── The grain value chart ───────────────────────────────────────────────────────

/** The value chart's bands, bottom to top: from the most certain dollars to the least. */
export const GRAIN_VALUE_BANDS = Object.freeze([
  { id: 'paid',          label: 'Paid' },
  { id: 'owed',          label: 'Delivered or sold, not yet paid' },
  { id: 'binContracted', label: 'In storage, contracted' },
  { id: 'binUnpriced',   label: 'In storage, at the cash price' },
]);

/**
 * What one crop's grain is worth through the season, for one scope (design 134 §17.11): after
 * each day's moves, payments and price changes, in dollars.
 *
 * - **Paid** and **not yet paid**: what each contract delivery or planned sale fetched
 *   (`farmGrainSales`, the amount the ledger books, a shortfall's settlement included), from
 *   its date until it is paid (its `GRAIN_SALES` posting), then paid.
 * - **In storage, contracted**: the bushels a later delivery out of the same pool takes, at
 *   that contract's price, the deliveries taken in date order (the bushels match the grain
 *   chart's contracted band).
 * - **In storage, at the cash price**: the rest of the pool at the crop's realized cash price
 *   on that date. It is the one band that moves with the market.
 *
 * `need` is what the pools' grain must earn: the total cost of the plans that harvest into them
 * (the scope's operator's plans of the crop; a field's operator's, as the pool is) less their
 * non-grain revenue. Storage cost is in it, so the bands are value, never net of storage.
 * Carried-in grain is a past season's: it is in the bands, but `season` (the value of this crop
 * year's grain alone) is what is held against `need`.
 *
 * @param {object} farm normalized farm
 * @param {object[]} moves `farmGrainMoves` of the planned season
 * @param {object[]} sales `farmGrainSales` of the planned season
 * @param {object[]} ledger `farmLedger` of the planned season (the payment dates)
 * @param {object} report `jobCostReport` of the planned season (the cost line)
 * @param {{ kind: 'farm'|'operator'|'crop'|'plan', id?: string }} scope
 * @param {string} crop
 * @param {string|null} now `YYYY-MM-DD`
 * @param {{ start?: string, end?: string }} [win] the date range; widened to every move and payment
 * @returns {object|null} null when the scope moves none of that crop
 */
export function grainValueData(farm, moves, sales, ledger, report, scope, crop, now, win = {}) {
  const { mine, planOp } = _poolScope(farm, scope, crop);
  const y = farm.season.cropYear;
  const ms = moves.filter(mine).map((m, i) => ({ ...m, i }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.i - b.i));
  if (!ms.length) return null;
  const paidOn = new Map(ledger.filter(r => r.receivableId && r.category === 'GRAIN_SALES').map(r => [r.receivableId, r.date]));
  const ss = sales.filter(mine).map(x => ({ ...x, paidDate: paidOn.get(x.receivableId) ?? null }));
  const contractPrice = new Map(farm.contracts.map(k => [k.id, k.price]));
  const priceRows = farm.prices.filter(p => p.crop === crop).map(p => p.date);

  const dated = [...ms.map(m => m.date), ...ss.map(x => x.date), ...ss.map(x => x.paidDate).filter(Boolean)].sort();
  const first = dated[0], last = dated.at(-1);
  const start = win.start && win.start < first ? win.start : _addDays(first, -31);
  const end = win.end && win.end > last ? win.end : _addDays(last, 31);
  const dates = [...new Set([start, ...dated, ...priceRows.filter(d => d > start && d < end), end])].sort();

  const delivers = ms.filter(m => m.kind === 'DELIVER');
  const valueOn = (day, keep) => {
    let paid = 0, owed = 0;
    for (const x of ss) {
      if (!keep(x) || x.date > day) continue;
      if (x.paidDate != null && x.paidDate <= day) paid += x.amount; else owed += x.amount;
    }
    const held = new Map();
    for (const m of ms) if (keep(m) && m.date <= day) held.set(m.pool, (held.get(m.pool) ?? 0) + m.bushels);
    let contracted = 0, contractedBu = 0, bin = 0;
    for (const [pool, bu] of held) {
      let left = Math.max(0, bu);
      bin += left;
      for (const m of delivers) {
        if (m.pool !== pool || m.date <= day || left <= 0) continue;
        const take = Math.min(left, -m.bushels);
        contracted += take * (contractPrice.get(m.sourceId) ?? 0);
        contractedBu += take;
        left -= take;
      }
    }
    const price = priceOn(farm.prices, crop, day, 'realized');
    const unpricedBu = bin - contractedBu;
    return { paid, owed, binContracted: contracted, binUnpriced: unpricedBu * (price ?? 0), unpricedBu, price };
  };
  const all = () => true;
  const thisYear = (r) => r.cropYear === y;
  const carried = ms.some(m => m.cropYear !== y);

  const points = dates.map(day => {
    const v = valueOn(day, all);
    const total = v.paid + v.owed + v.binContracted + v.binUnpriced;
    let season = total;
    if (carried) { const t = valueOn(day, thisYear); season = t.paid + t.owed + t.binContracted + t.binUnpriced; }
    return { date: day, ...v, total, season, events: _dayValueEvents(farm, ms, ss, day) };
  });

  const rows = report.plans.filter(p => p.planId && p.crop === crop && (
    scope.kind === 'operator' ? p.operatorId === scope.id
      : scope.kind === 'plan' ? p.operatorId === planOp
        : true));
  const need = rows.length ? rows.reduce((s, p) => s + p.totalCost - p.revenue.other, 0) : null;
  const tail = points.at(-1);
  const peak = points.reduce((a, p) => (p.total > a.total ? p : a), points[0]);
  const peakUnpriced = points.reduce((a, p) => (p.binUnpriced > a.binUnpriced ? p : a), points[0]);
  // The date from which this season's grain stays at or above what it must earn, to the end.
  let coveredFrom = null;
  if (need != null && tail.season >= need - 0.005) {
    coveredFrom = tail.date;
    for (let i = points.length - 1; i >= 0 && points[i].season >= need - 0.005; i--) coveredFrom = points[i].date;
  }
  const everCovered = need != null && points.some(p => p.season >= need - 0.005);
  return {
    crop, start, end, now, nowInWindow: now != null && now >= start && now <= end,
    points,
    harvests: [...new Set(ms.filter(m => m.kind === 'HARVEST').map(m => m.date))],
    pooledFrom: scope.kind === 'plan' ? planOp : null,
    need,
    carriedIn: carried ? points.reduce((mx, p) => Math.max(mx, p.total - p.season), 0) : 0,
    peak: { date: peak.date, total: peak.total },
    peakUnpriced: { date: peakUnpriced.date, value: peakUnpriced.binUnpriced, share: peakUnpriced.total > 0 ? peakUnpriced.binUnpriced / peakUnpriced.total : 0 },
    ending: { total: tail.total, season: tail.season, paid: tail.paid },
    coveredFrom,
    everCovered,
  };
}

/** One day's events for the value tooltip: the moves out with what they fetched, payments and a new cash price. */
function _dayValueEvents(farm, ms, ss, day) {
  const name = (x) => (x.kind === 'CONTRACT'
    ? farm.contracts.find(c => c.id === x.sourceId)?.name : farm.sales.find(c => c.id === x.sourceId)?.name) ?? x.sourceId ?? x.kind;
  const lines = [];
  const harvest = ms.filter(m => m.date === day && m.kind === 'HARVEST').reduce((s, m) => s + m.bushels, 0);
  if (harvest > 0) lines.push({ kind: 'HARVEST', bushels: harvest, label: 'harvested' });
  const carry = ms.filter(m => m.date === day && m.kind === 'CARRY_IN').reduce((s, m) => s + m.bushels, 0);
  if (carry > 0) lines.push({ kind: 'CARRY_IN', bushels: carry, label: 'carried in' });
  for (const x of ss) {
    if (x.date === day) lines.push({ kind: x.kind, bushels: x.bushels, amount: x.amount, label: name(x), paidDate: x.paidDate });
    if (x.paidDate === day) lines.push({ kind: 'PAID', amount: x.amount, label: name(x) });
  }
  return lines;
}

/**
 * Every crop's value chart for one scope, on one date range (the price charts' when given), in
 * the order `crops` lists them, then any other crop the scope moves.
 */
export function grainValueSet(farm, moves, sales, ledger, report, scope, now, { start, end, crops = [] } = {}) {
  const plan = scope.kind === 'plan' ? farm.cropPlans.find(p => p.id === scope.id) : null;
  const all = [...new Set([...crops, ...moves.map(m => m.crop)])]
    .filter(c => (scope.kind === 'crop' ? c === scope.id : plan ? c === plan.crop : true));
  const run = (win) => all.map(c => grainValueData(farm, moves, sales, ledger, report, scope, c, now, win)).filter(Boolean);
  const first = run({ start, end });
  if (!first.length) return [];
  const s = first.map(d => d.start).sort()[0];
  const e = first.map(d => d.end).sort().at(-1);
  // Again on the shared range, so every chart's first and last points are valued on its dates.
  return first.every(d => d.start === s && d.end === e) ? first : run({ start: s, end: e });
}

/** The sentence under a crop's value chart. */
export function grainValueCaption(d, { date = (x) => x, label = null, poolOf = null } = {}) {
  const parts = [];
  const head = label ? `${label}: ` : '';
  parts.push(`${head}worth up to ${_money0(d.peak.total)} on ${date(d.peak.date)}; ${_money0(d.ending.total)} at the end of the run, ${_money0(d.ending.paid)} of it paid.`);
  if (d.peakUnpriced.value > 0.5) {
    parts.push(`Up to ${_money0(d.peakUnpriced.value)} (${(100 * d.peakUnpriced.share).toFixed(0)}%) rides on the cash price, on ${date(d.peakUnpriced.date)}.`);
  } else {
    parts.push('None of it rides on the cash price.');
  }
  if (d.need != null) {
    const what = `the ${_money0(d.need)} this season's grain must earn`;
    if (d.coveredFrom) parts.push(`It covers ${what} from ${date(d.coveredFrom)}.`);
    else if (d.everCovered) parts.push(`It reaches ${what} but falls below it again; ${_money0(d.need - d.ending.season)} short at the end.`);
    else parts.push(`It never reaches ${what}: ${_money0(d.need - d.ending.season)} short at the end.`);
  }
  if (d.carriedIn > 0.5) parts.push(`Includes up to ${_money0(d.carriedIn)} of grain carried in from the year before, not held against this season's cost.`);
  if (poolOf) parts.push(`This is ${poolOf}'s whole pool of the crop and the cost of all its fields of it.`);
  return parts.join(' ');
}

/** ECharts option for a crop's value chart: the bands stacked as steps, the cost line dashed. */
export function grainValueOption(d, { colors, title = null, xLabels = true }) {
  const ts = (iso) => Date.parse(`${iso}T00:00:00Z`);
  const fill = { paid: colors.green, owed: colors.dim, binContracted: colors.price, binUnpriced: colors.amber };
  const byTs = new Map(d.points.map(p => [ts(p.date), p]));
  const marks = d.harvests.map(h => ({ xAxis: ts(h), name: 'harvest',
    lineStyle: { color: colors.muted, type: 'dashed', width: 1 },
    label: { formatter: 'harvest', color: colors.muted, fontSize: 9, position: 'end' } }));
  if (d.nowInWindow) {
    marks.push({ xAxis: ts(d.now), name: 'now', lineStyle: { color: colors.amber, type: 'solid', width: 1 },
      label: { formatter: 'now', color: colors.amber, fontSize: 10, position: 'end' } });
  }
  if (d.need != null && d.need > 0) {
    marks.push({ yAxis: d.need, name: 'must earn', lineStyle: { color: colors.red, type: 'dashed', width: 1.5 },
      label: { formatter: `must earn ${_moneyK(d.need)}`, color: colors.red, fontSize: 9, position: 'insideStartTop' } });
  }
  return {
    backgroundColor: 'transparent',
    animation: false,
    // The price and grain charts' fixed left margin, so all three line up on the date axis.
    grid: { top: 34, right: 24, bottom: xLabels ? 24 : 8, left: 64, containLabel: false },
    ...(title ? { title: { text: title, left: 4, top: 0, textStyle: { color: colors.dim, fontSize: 10, fontWeight: 600, fontFamily: 'monospace' } } } : {}),
    legend: { top: 0, right: 24, itemWidth: 10, itemHeight: 8, textStyle: { color: colors.dim, fontSize: 9, fontFamily: 'monospace' },
      data: GRAIN_VALUE_BANDS.map(b => b.label) },
    xAxis: {
      type: 'time', min: ts(d.start), max: ts(d.end),
      axisLabel: { show: xLabels, color: colors.dim, fontSize: 10, fontFamily: 'monospace' },
      splitLine: { show: false }, axisLine: { lineStyle: { color: colors.border } },
    },
    yAxis: {
      type: 'value', min: 0,
      axisLabel: { color: colors.dim, fontSize: 10, fontFamily: 'monospace', formatter: _moneyK },
      splitLine: { lineStyle: { color: colors.border } },
    },
    tooltip: {
      trigger: 'axis', backgroundColor: colors.panel, borderColor: colors.borderHi, borderWidth: 1,
      textStyle: { color: colors.text, fontSize: 10, fontFamily: 'monospace' },
      formatter: (ps) => {
        const p = byTs.get(ps[0]?.value?.[0]);
        if (!p) return '';
        const rows = GRAIN_VALUE_BANDS.map(b => `${b.label}: <b>${_money0(p[b.id])}</b>`
          + (b.id === 'binUnpriced' && p.unpricedBu > 0.5 ? ` (${Math.round(p.unpricedBu).toLocaleString()} bu at ${_perBu(p.price)})` : ''));
        rows.push(`Total: <b>${_money0(p.total)}</b>`);
        if (d.need != null) {
          const gap = p.season - d.need;
          rows.push(`${_money0(Math.abs(gap))} ${gap >= 0 ? 'above' : 'below'} what this season's grain must earn`);
        }
        const ev = p.events.map(e => {
          if (e.kind === 'HARVEST' || e.kind === 'CARRY_IN') return `+${Math.round(e.bushels).toLocaleString()} bu ${e.label}`;
          if (e.kind === 'PAID') return `paid: ${_esc(e.label)} ${_money0(e.amount)}`;
          return `${_esc(e.label)}: ${Math.round(e.bushels).toLocaleString()} bu for ${_money0(e.amount)}`
            + (e.paidDate && e.paidDate !== p.date ? `, paid ${e.paidDate}` : e.paidDate ? '' : ', not paid in the run');
        });
        return [`<b>${p.date}</b>`, ...rows,
          ...(ev.length ? [`<span style="color:${colors.muted}">that day</span>`, ...ev] : [])].join('<br/>');
      },
    },
    series: [
      ...GRAIN_VALUE_BANDS.map((b, i) => ({
        id: b.id, name: b.label, type: 'line', step: 'end', stack: 'value', symbol: 'none',
        lineStyle: { width: _bandEmpty(d.points, b.id) ? 0 : 1, color: fill[b.id] }, itemStyle: { color: fill[b.id] },
        areaStyle: { color: fill[b.id], opacity: b.id.startsWith('bin') ? 0.55 : 0.3 },
        data: d.points.map(p => [ts(p.date), p[b.id]]),
        ...(i === 0 ? { markLine: { silent: true, symbol: 'none', data: marks } } : {}),
      })),
      // An unseen point at the cost line, so the auto-scaled axis keeps the line in view (a
      // markLine is not in the axis extent; a fixed max gave a crowded top tick).
      ...(d.need > 0 ? [{ id: 'needExtent', type: 'line', silent: true, symbol: 'none', tooltip: { show: false },
        lineStyle: { opacity: 0 }, data: [[ts(d.start), d.need]] }] : []),
    ],
  };
}

const _moneyK = (v) => (Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : Math.abs(v) >= 1000 ? `$${Math.round(v / 1000)}k` : `$${Math.round(v)}`);

/**
 * A stacked band that is zero on every date draws no outline: its line would run along the top
 * of the bands under it and tint that edge (and every jump in it) with the empty band's colour.
 */
const _bandEmpty = (points, id) => points.every(p => Math.abs(p[id]) < 0.005);

const _money0 = (n) => `$${Math.round(n).toLocaleString()}`;

const _MONTH_NAMES = ['Jan','Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** `2026-03` → `Mar 2026`. */
function _monthLabel(m) {
  const [y, mo] = m.split('-').map(Number);
  return `${_MONTH_NAMES[mo - 1]} ${y}`;
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
