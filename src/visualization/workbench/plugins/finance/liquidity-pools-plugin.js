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
import { WB_EVENTS }          from '../../workbench-runtime.js';
import { ServiceRegistry }    from '../../../../services/service-registry.js';
import { withBom }            from '../../../../utils/csv.js';
import { EXECUTION_KINDS, EXECUTION_PHASES } from '../../../../simulation-framework/bus-messages.js';
import { buildPoolHistory, poolHistoryRows, poolSeries, reserveSeries, tiePoolHistory, POOL_EVENT_KIND }
  from '../../../../finance/pools/pool-history.js';
import { colorForSeriesKey } from '../../../../finance/allocation-reporting/allocation-palette.js';

/** The CSV's columns, in order. The fact table's contract — see `poolHistoryRows`. */
export const POOL_CSV_COLUMNS = Object.freeze([
  'date', 'year', 'pool', 'label',
  'balance', 'capacity', 'utilised', 'target', 'yearsOfCover', 'high',
  'marketReturn', 'priorYearReturn', 'inflow', 'outflow',
  'headroom', 'shortfall', 'drawdown', 'gated', 'vetoed',
  // Per-PERIOD figures, repeated on every pool's row (§22.3 extended). Last, so a reader
  // scanning the per-pool columns is not interrupted by three that do not vary with `pool`.
  'reserveAccessible', 'reserveLocked', 'reserveYears',
]);

/**
 * LiquidityPoolsPlugin — what the design-97 pool graph actually did, period by period.
 *
 * §20.11 left exactly one thing open and named it the one worth doing: *"nothing in the
 * workbench reads `state.liquidityPools`. The graph can be authored and cannot be observed."*
 * The argument for this panel is that section's own history — §20.2's clairvoyant gate,
 * §20.4b's identically-zero headroom and §20.3's unwired knob were all visible in that cube
 * from the first period of the first run, and each took a study to find instead.
 *
 * ─── the view it is built around ─────────────────────────────────────────────
 *
 * **The interesting event is nearly always a flow that did NOT fire**, and nothing else in
 * the run records a non-event (`PoolFlowReducer`'s own docstring). So the gated flow is not a
 * footnote on this panel: it is a marked point on the flows chart, a row in the log with the
 * gate's own reason string beside it, and a column in the CSV. The rebalance VETO is there
 * too — a gate that stops the explicit refill while the drift band keeps selling the same
 * sleeve for the same reason has changed nothing (§12.4), and only the two together say
 * which happened.
 *
 * ─── where the numbers come from ─────────────────────────────────────────────
 *
 *   - `buildPoolHistory` replays the journal's `liquidityPools` diffs, so the series is
 *     PER PERIOD rather than per year — this reducer fires on both the US and the AU advance
 *     and `gatedFlows` is overwritten on each, so a year-boundary sampler would drop half of
 *     them. That module is shared, and the pivot is `poolSeries`: the moment a view grows
 *     its own pivot, it and any lab page over the same cube can disagree with no way to tell
 *     which is right.
 *   - the GRAPH — labels, spend order, the flow list — is read off the live `PoolFlowReducer`
 *     in the pipeline, not from config. What ran is the only authority on what is drawn
 *     (`config-field-in-state-is-not-read`), and it is also how the panel knows whether
 *     `poolFlowsEnabled` was off, which otherwise looks exactly like a graph that never
 *     triggered.
 *
 * ─── it states its tie before it draws ───────────────────────────────────────
 *
 * The history is a reconstruction, and a reconstruction that has drifted draws a believable
 * picture of a run that did not happen. `tiePoolHistory` compares the last replayed period
 * against live `state.liquidityPools`, field for field, and the strip says so.
 */
export class LiquidityPoolsPlugin extends WorkbenchComponent {
  constructor(runtime) {
    super();
    this._runtime = runtime;
    this._sim     = null;
    this._servicesOverride = null;   // tests

    this._view = 'cover';            // cover | stock | flows | log
    this._logFilter = 'all';         // all | gated — the log's own scope

    this._chart        = null;
    this._unsubSimBus  = null;
    this._renderQueued = false;
    this._dataSig      = null;
    this._histCache    = null;
    this._tieCache     = null;
    this._hidden       = new Set();  // pools switched off from the legend
    // Panel-local and deliberately not persisted: the hover popup is the useful half
    // and the cluttering half at once, so this is a mood rather than a preference.
    this._tips         = true;
  }

  setServices(services) { this._servicesOverride = services ?? null; }
  _services() { return this._servicesOverride ?? ServiceRegistry.getInstance(); }

  render() {
    const root = document.createElement('div');
    root.className = 'pool-plugin wb-plugin-fill';
    root.innerHTML = `
      <div class="pool-toolbar">
        <select class="wb-select pool-view" data-pool="view">
          <option value="cover">Years of cover</option>
          <option value="stock">Balance vs target vs capacity</option>
          <option value="flows">Flows in and out</option>
          <option value="log">Flow log</option>
        </select>
        <span class="pool-seg" data-pool="logscope" style="display:none">
          <button type="button" data-scope="all" class="on">everything</button>
          <button type="button" data-scope="gated">only what did not fire</button>
        </span>
        <span class="pool-spacer"></span>
        <span class="pool-asof" data-pool="asof">—</span>
        <button class="pool-csv-btn pool-tip-btn on" data-pool="tips"
                title="Show or hide the hover popup">&#9678; values</button>
        <button class="pool-csv-btn" data-pool="csv" title="Download the per-pool cube as CSV">&#11015; CSV</button>
      </div>

      <div class="pool-provenance" data-pool="provenance"></div>

      <div class="pool-body" data-pool="body">
        <div class="pool-placeholder" data-pool="placeholder">
          Step or run a simulation whose scenario authors a liquidity graph.
        </div>
        <div class="pool-chart" data-pool="chart"></div>
        <div class="pool-grid" data-pool="grid"></div>
      </div>

      <div class="pool-legend" data-pool="legend"></div>
    `;
    return root;
  }

  onInit() {
    this._runtime.bus.subscribe(WB_EVENTS.SCENARIO_READY, ({ scenario }) => {
      this._bindSim(scenario?.sim ?? null);
    });
    this._runtime.bus.subscribe(WB_EVENTS.DISPLAY_SETTINGS_CHANGED, () => this._render());
    this._onResize = () => this._chart?.resize();
    window.addEventListener('resize', this._onResize);
  }

  onMount() {
    if (!this._sim) this._bindSim(this._services()?.simulationRegistry?.getPrimary?.() ?? null);

    this._bindOnce('view', 'change', (el) => { this._view = el.value; this._syncControls(); this._render(); });
    this._bindOnce('csv',  'click',  () => this._downloadCsv());
    this._bindOnce('tips', 'click',  () => {
      this._tips = !this._tips;
      this._chart?.dispatchAction({ type: 'hideTip' });
      this._syncControls();
      this._render();   // only the flows view needs it, but the redraw is cheap
    });
    this._bindOnce('legend', 'click', null, (e) => this._onLegendClick(e));

    const seg = this._q('logscope');
    if (seg && !seg._poolBound) {
      seg.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-scope]');
        if (!btn) return;
        this._logFilter = btn.dataset.scope;
        seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === btn));
        this._render();
      });
      seg._poolBound = true;
    }

    this._syncControls();
    this._render();
  }

  onActivate() {
    // The chart cannot size itself while the pane is hidden: a panel activated after a run
    // comes up 0px tall without this.
    this._chart?.resize();
    this._render();
  }

  onAdopt() { this._chart?.resize(); }

  onUnmount() { this._disposeChart(); }

  destroy() {
    window.removeEventListener('resize', this._onResize);
    this._unsubSimBus?.();
    this._unsubSimBus = null;
    this._disposeChart();
    super.destroy?.();
  }

  _disposeChart() {
    this._ro?.disconnect();
    this._ro = null;
    this._io?.disconnect();
    this._io = null;
    this._chart?.dispose();
    this._chart = null;
  }

  // ─── Binding ─────────────────────────────────────────────────────────────

  _bindSim(sim) {
    this._unsubSimBus?.();
    this._unsubSimBus = null;
    this._sim = sim ?? null;
    this._invalidate();

    if (sim?.bus) {
      this._unsubSimBus = sim.bus.subscribe(
        `EXECUTION_${EXECUTION_PHASES.END}`,
        { kind: EXECUTION_KINDS.EVENT },
        () => this._scheduleRender(),
      );
    }
    if (this._mounted) { this._syncControls(); this._render(); }
  }

  _scheduleRender() {
    if (!this._mounted || this._renderQueued) return;
    this._renderQueued = true;
    const run = () => { this._renderQueued = false; if (this._mounted) this._render(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else run();
  }

  _invalidate() { this._dataSig = null; this._histCache = null; this._tieCache = null; }

  _signature() {
    const entries = this._sim?.journal?.journal;
    if (!Array.isArray(entries) || entries.length === 0) return 'empty';
    const last = entries[entries.length - 1];
    return `${entries.length}|${last?.seq ?? 0}`;
  }

  /**
   * The live `PoolFlowReducer`, or null.
   *
   * Found in the pipeline rather than read from config: a graph in `cfg.parameters` that
   * never reached a reducer is precisely the failure this panel exists to make visible, and
   * a panel that drew it from config would report it as working.
   */
  _reducer() {
    const map = this._sim?.reducers?.map;
    if (!map) return null;
    for (const entries of map.values()) {
      for (const e of entries) {
        if (e?.reducer?.constructor?.type === 'PoolFlowReducer') return e.reducer;
      }
    }
    return null;
  }

  _history() {
    const sig = this._signature();
    if (sig === this._dataSig && this._histCache) return this._histCache;
    if (sig === 'empty') { this._histCache = null; this._tieCache = null; this._dataSig = sig; return null; }

    const hist = buildPoolHistory({ journal: this._sim.journal, graph: this._reducer()?.graph ?? null });
    this._histCache = hist.hasCube ? hist : null;
    this._tieCache  = hist.hasCube ? tiePoolHistory(hist, this._sim.state) : null;
    this._dataSig   = sig;
    return this._histCache;
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  _syncControls() {
    const view = this._q('view');
    if (view) view.value = this._view;
    const seg = this._q('logscope');
    if (seg) seg.style.display = this._view === 'log' ? '' : 'none';
    const tips = this._q('tips');
    if (tips) {
      tips.classList.toggle('on', this._tips);
      tips.style.display = this._view === 'log' ? 'none' : '';
    }
  }

  _render() {
    if (!this._mounted) return;

    const hist = this._history();
    const asof = this._q('asof');
    if (asof) {
      const n = hist?.periods?.length ?? 0;
      asof.textContent = n
        ? `${hist.periods[0].at.toISOString().slice(0, 10)}–${hist.periods[n - 1].at.toISOString().slice(0, 10)} · ${n} periods`
        : '—';
    }

    this._renderProvenance(hist);

    const empty = !hist || hist.periods.length === 0;
    const isLog = this._view === 'log';
    this._q('placeholder').style.display = empty ? '' : 'none';
    this._q('chart').style.display = empty || isLog ? 'none' : '';
    this._q('grid').style.display  = !empty && isLog ? '' : 'none';
    if (empty) {
      this._q('legend').innerHTML = '';
      this._q('grid').innerHTML   = '';
      this._q('placeholder').textContent = !this._sim
        ? 'No simulation is loaded.'
        : this._reducer()
          ? 'The graph is wired but has stamped no pool yet — step or run the simulation.'
          : 'This scenario authors no liquidity graph, or it is switched off '
            + '(liquidityGraphEnabled: false), or the LIQUIDITY_POOLS strategy is not selected — '
            + 'note that the last of those stops only the refill flows.';
      return;
    }

    this._renderLegend(hist);
    if (isLog) { this._renderLog(hist); return; }
    this._drawChart(hist);
  }

  /**
   * What the reader has to know before reading a line, in this order: is the graph live at
   * all, are its flows switched on, and does the replay tie to the run.
   *
   * `poolFlowsEnabled: false` is the arm-vs-control switch (§16.3) and it is the one state
   * that looks identical to a working graph whose triggers never tripped — so it is stated
   * loudly rather than left to be inferred from an empty flow log.
   */
  _renderProvenance(hist) {
    const el = this._q('provenance');
    if (!el) return;
    if (!hist) { el.innerHTML = ''; el.className = 'pool-provenance'; return; }

    const reducer = this._reducer();
    const tie     = this._tieCache;
    const notes   = [];

    if (tie && !tie.ok && !tie.unchecked) {
      el.className = 'pool-provenance pool-provenance--bad';
      const m = tie.mismatches[0];
      el.innerHTML = `<strong>The journal replay does not tie to the run's state.</strong>
        ${_esc(String(tie.mismatches.length))} field(s) differ — e.g. <code>${_esc(m.pool)}.${_esc(m.field)}</code>
        live ${_esc(String(m.live))} against ${_esc(String(m.replayed))} replayed. Every series on this
        panel is reconstructed from those diffs, so none of it is quotable.`;
      return;
    }

    if (reducer && reducer.flowsEnabled === false) {
      notes.push(`<strong class="pool-warn">flows are OFF</strong> (<code>poolFlowsEnabled: false</code>) —
                  pools, targets and the spend order are live; no refill edge can fire`);
    }
    notes.push(tie?.unchecked
      ? 'replay <em>not tied</em> — no live cube to check against'
      : `<span class="pool-ok">✓</span> replay ties across ${tie.checked} fields`);
    notes.push(`${hist.poolIds.length} pools · ${hist.flowIds.length} flows`);

    const fired  = hist.events.filter(e => e.kind === POOL_EVENT_KIND.FIRED);
    const gated  = hist.events.filter(e => e.kind === POOL_EVENT_KIND.GATED);
    const vetoed = hist.events.filter(e => e.kind === POOL_EVENT_KIND.VETOED);
    // §12.4's two executors, counted apart. A cross-account edge is a TRANSACTION; an
    // in-portfolio edge is a VETO on a rebalance leg, which the rebalancer executes and which
    // emits no per-edge action. Both are on the cube's `firedFlows` now, but they are not the
    // same event and a reader chasing a number in the journal will only find the first kind.
    const transfers = fired.filter(e => e.executor === 'TRANSFER');
    notes.push(`<strong>${fired.length} fired</strong> (${transfers.length} cross-account,
                ${fired.length - transfers.length} in-portfolio) ·
                <strong>${gated.length} gated</strong> · ${vetoed.length} rebalance vetoes`);
    if (!hist.firedFromCube && (reducer?.graph?.flows ?? []).some(f => f.executor !== 'TRANSFER')) {
      // The pre-`firedFlows` fallback. Saying nothing here would let a zero read as "this
      // in-portfolio edge never fired" when the truth is that this run cannot record it.
      notes.push(`<span class="pool-warn">this run predates per-edge firing records</span> —
                  in-portfolio firings are not counted; re-run to see them`);
    }
    if (!fired.length && !gated.length && reducer?.flowsEnabled !== false) {
      notes.push(`<span class="pool-warn">no edge ever fired or was gated</span> — check the triggers`);
    }

    el.className = 'pool-provenance';
    el.innerHTML = notes.join(' · ');
  }

  _visiblePools(hist) { return hist.poolIds.filter(id => !this._hidden.has(id)); }

  _drawChart(hist) {
    const host = this._q('chart');
    if (!host || !this._canvasAvailable()) return;
    // ECharts warns when initialised against a 0x0 host, which is what a docked panel is
    // until its tab is first activated; `onActivate` re-renders, so deferring costs nothing.
    if (!this._chart && !(host.clientWidth > 0 && host.clientHeight > 0)) return;
    if (!this._chart) {
      this._chart = echarts.init(host, null, { renderer: 'canvas' });
      if (typeof ResizeObserver === 'function') {
        this._ro = new ResizeObserver(() => this._chart?.resize());
        this._ro.observe(host);
      }
      // The tooltip is parented to <body> (see `appendTo` below), so it outlives the
      // chart going away: switching tabs while the cursor sits on the plot hides the
      // canvas without ever firing a mouseout, and the popup is left stranded on the
      // next panel. Dismiss it whenever the pointer or the panel leaves.
      host.addEventListener('mouseleave', () => this._chart?.dispatchAction({ type: 'hideTip' }));
      if (typeof IntersectionObserver === 'function') {
        this._io = new IntersectionObserver((entries) => {
          if (!entries.some(e => e.isIntersecting)) this._chart?.dispatchAction({ type: 'hideTip' });
        });
        this._io.observe(host);
      }
    }

    const dark = this._dark();
    const ink  = dark ? '#94a3b8' : '#52514e';
    const line = dark ? '#334155' : '#e1e0d9';
    const ids  = this._visiblePools(hist);
    const axis = poolSeries(hist, 'balance', ids).labels;
    const colorOf = (id) => colorForSeriesKey(id, hist.poolIds.indexOf(id), { dark });

    const series = [];
    let yFormat = (v) => _compact(v);

    if (this._view === 'cover') {
      // The headline question: is the reserve actually there, in the unit a household
      // thinks in. Unit-free, so pools of very different sizes are comparable on one axis.
      const cover = poolSeries(hist, 'yearsOfCover', ids);
      for (const id of ids) {
        series.push({
          name: hist.labels[id], type: 'line', showSymbol: false, smooth: false,
          lineStyle: { width: 1.6, color: colorOf(id) }, itemStyle: { color: colorOf(id) },
          connectNulls: false, data: cover.series[id],
        });
      }
      // The household reserve, across the WHOLE book — including accounts no pool claims.
      // Drawn on this view because it answers the same question the per-pool lines do and
      // frequently disagrees with all of them: once the taxable accounts drain, the graph's
      // bond target is realised inside the age-gated wrappers, which no pool can claim
      // (§22.6), so every pool line falls to zero while the household's cover is unchanged.
      // Measured on the reference plan: pools 4.8y -> 0.0y while this line held 4.9-5.4y.
      // Dashed and un-coloured so it never reads as one more pool.
      if (hist.hasReserve) {
        const res = reserveSeries(hist);
        series.push({
          name: 'Household reserve (all accounts)', type: 'line', showSymbol: false,
          lineStyle: { width: 2, type: 'dashed', color: ink }, itemStyle: { color: ink },
          connectNulls: false, z: 3, data: res.yearsOfCover,
        });
      }
      yFormat = (v) => `${v}y`;
    } else if (this._view === 'stock') {
      // Three lines per pool, and the pairing is the point: a balance without its target is
      // a number, and a balance without its CEILING hides §20.4b — an offset sitting exactly
      // at a capacity that was defined as its own balance looks correct and can never be
      // refilled.
      const bal = poolSeries(hist, 'balance',  ids);
      const tgt = poolSeries(hist, 'target',   ids);
      const cap = poolSeries(hist, 'capacity', ids);
      for (const id of ids) {
        const c = colorOf(id);
        series.push({ name: `${hist.labels[id]}`, type: 'line', showSymbol: false,
                      lineStyle: { width: 1.6, color: c }, itemStyle: { color: c }, data: bal.series[id] });
        if (tgt.series[id].some(v => v != null)) {
          series.push({ name: `${hist.labels[id]} · target`, type: 'line', showSymbol: false,
                        lineStyle: { width: 1, type: 'dashed', color: c }, itemStyle: { color: c },
                        data: tgt.series[id] });
        }
        series.push({ name: `${hist.labels[id]} · capacity`, type: 'line', showSymbol: false,
                      lineStyle: { width: 1, type: 'dotted', color: c }, itemStyle: { color: c },
                      data: cap.series[id] });
      }
    } else {
      // Flows: in above the line, out below, and the NON-events marked on the zero line.
      const inflow  = poolSeries(hist, 'inflow',  ids);
      const outflow = poolSeries(hist, 'outflow', ids);
      for (const id of ids) {
        const c = colorOf(id);
        series.push({ name: `${hist.labels[id]} · in`, type: 'bar', stack: 'in', barMaxWidth: 18,
                      itemStyle: { color: c }, data: inflow.series[id] });
        series.push({ name: `${hist.labels[id]} · out`, type: 'bar', stack: 'out', barMaxWidth: 18,
                      itemStyle: { color: c, opacity: 0.45 },
                      data: outflow.series[id].map(v => (v == null ? null : -v)) });
      }
      const marks = this._gateMarks(hist, ids, axis);
      if (marks.length) {
        series.push({
          name: 'gated', type: 'scatter', symbol: 'triangle', symbolSize: 9, z: 6,
          itemStyle: { color: dark ? '#fbbf24' : '#b45309' },
          data: marks.map(m => [m.x, 0]),
          tooltip: { formatter: (p) => (this._tips ? _esc(marks[p.dataIndex].text) : '') },
        });
      }
    }

    this._chart.setOption({
      animation: false,
      backgroundColor: 'transparent',
      textStyle: { color: ink, fontFamily: 'var(--font-mono, monospace)' },
      grid: { left: 60, right: 12, top: 10, bottom: 24 },
      tooltip: {
        // Bars carry no hover highlight worth keeping, so the flows view switches the
        // tooltip off outright; the line views return empty content instead, which
        // keeps the axis pointer and the circles on the lines (the popup is the clutter).
        show:    this._view !== 'flows' || this._tips,
        trigger: this._view === 'flows' ? 'item' : 'axis',
        // The panel clips its overflow and the plot is only a couple of hundred pixels
        // tall, so a tooltip parented to the chart gets cut off — worst in the stock
        // view, which reports three lines per pool. Hang it off <body> and confine it
        // to the viewport so it can grow past the panel and still stay on screen.
        appendTo: () => document.body,
        confine: true,
        axisPointer: { type: 'line' },
        formatter: this._view === 'flows' ? undefined : (params) => {
          if (!this._tips || !params?.length) return '';
          const head = `<strong>${params[0].axisValue}</strong>`;
          const lines = params
            .filter(p => p.value != null)
            .map(p => `${p.marker} ${p.seriesName} <strong>` +
              (this._view === 'cover' ? `${Number(p.value).toFixed(2)}y` : this._money(p.value)) + '</strong>');
          return `${head}<br>${lines.join('<br>')}`;
        },
      },
      xAxis: {
        type: 'category', data: axis,
        axisLine: { lineStyle: { color: line } },
        axisLabel: { color: ink, fontSize: 9, hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: line } },
        axisLabel: { color: ink, fontSize: 9, formatter: yFormat },
      },
      series,
    }, true);
  }

  /**
   * The gated (non-)flows as points on the flows chart.
   *
   * On the zero line rather than at the amount they wanted, because a gated flow moved
   * nothing — drawing it at its `wanted` height would put a bar-shaped claim on the chart
   * for money that never left.
   */
  _gateMarks(hist, ids, axis) {
    const idx = new Map(axis.map((label, i) => [label, i]));
    const out = [];
    const seen = new Set();
    for (const e of hist.events) {
      if (e.kind !== POOL_EVENT_KIND.GATED) continue;
      if (!ids.includes(e.from) && !ids.includes(e.to)) continue;
      const label = e.at.toISOString().slice(0, 10);
      const x = idx.get(label);
      if (x == null) continue;
      const key = `${x}|${e.flowId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ x, text: `${label} — ${e.flowId}: ${e.reason} (wanted ${this._money(e.wanted)})` });
    }
    return out;
  }

  /**
   * The log — one row per event, fired and not-fired in one list.
   *
   * Deliberately NOT two tables. The question a reader brings here is "what happened in
   * 2033", and the answer is usually a firing that stopped being a firing; splitting the
   * two apart makes that a comparison between two lists ordered the same way.
   */
  _renderLog(hist) {
    const el = this._q('grid');
    if (!el) return;
    const unrecorded = !hist.firedFromCube
      && (this._reducer()?.graph?.flows ?? []).filter(f => f.executor !== 'TRANSFER');
    const ids = this._visiblePools(hist);
    const rows = hist.events
      .filter(e => this._logFilter !== 'gated' || e.kind !== POOL_EVENT_KIND.FIRED)
      .filter(e => ids.includes(e.from) || ids.includes(e.to) || (e.from == null && e.to == null));

    if (!rows.length) {
      el.innerHTML = `<p class="pool-grid-note">No flow fired and none was gated in
        the periods on record. With flows enabled that means no trigger ever tripped — a pool that
        never falls below its trigger is a pool the refill rule cannot be measured on.
        ${unrecorded && unrecorded.length ? 'This run also predates per-edge firing records, so in-portfolio edges cannot appear here at all: check the flows view for pool inflow.' : ''}</p>`;
      return;
    }

    const kindCell = (e) => {
      if (e.kind === POOL_EVENT_KIND.FIRED) {
        // The executor is part of what happened, not a footnote: one of these left a journal
        // entry behind and the other did not.
        const how = e.executor && e.executor !== 'TRANSFER' ? ' <span class="pool-dim">in-portfolio</span>' : '';
        return `<span class="pool-kind pool-kind--fired">fired</span>${how}`;
      }
      if (e.kind === POOL_EVENT_KIND.GATED)  return '<span class="pool-kind pool-kind--gated">gated</span>';
      return '<span class="pool-kind pool-kind--vetoed">veto</span>';
    };

    el.innerHTML = `
      <p class="pool-grid-note">
        Every edge evaluation the run recorded. <strong>gated</strong> is a refill that wanted to
        fire and was stopped by its gate — the only record of a non-event anywhere in the run.
        <strong>veto</strong> is the same decision on the rebalancer's side (§12.4): without it a
        gate can stop the explicit refill while the drift band sells the same sleeve for the same
        reason, and nothing has changed.
        A <strong>fired</strong> row marked <em>in-portfolio</em> was executed by the
        rebalancer rather than as a transfer, so it moved value without emitting an action of
        its own — it is on this list because the pool cube records it, not because the journal
        does.
        ${unrecorded && unrecorded.length ? `<br><strong>This run predates that record.</strong>
        ${_esc(unrecorded.map(f => f.id).join(', '))} ${unrecorded.length === 1 ? 'is' : 'are'}
        in-portfolio and cannot be listed here at all — their firings show only as the
        destination pool's <em>inflow</em> on the flows view. A gated row against no fired row
        does not mean the edge never fired. Re-run to record them.` : ''}
      </p>
      <table class="pool-table">
        <thead><tr><th>date</th><th></th><th>flow</th><th>from → to</th>
          <th class="num">moved</th><th class="num">wanted</th><th>why not</th></tr></thead>
        <tbody>${rows.map(e => `
          <tr class="${e.kind === POOL_EVENT_KIND.FIRED ? '' : 'pool-row-gated'}">
            <td>${_esc(e.at.toISOString().slice(0, 10))}</td>
            <td>${kindCell(e)}</td>
            <td>${_esc(e.flowId ?? '—')}</td>
            <td>${_esc(e.from ?? '—')} → ${_esc(e.to ?? '—')}</td>
            <td class="num">${e.amount == null ? '—' : _esc(this._money(e.amount))}</td>
            <td class="num pool-dim">${e.wanted == null ? '—' : _esc(this._money(e.wanted))}</td>
            <td class="pool-reason">${_esc(e.reason ?? '')}</td>
          </tr>`).join('')}</tbody>
      </table>`;
  }

  /** Doubles as the pool filter: a chip click switches that pool off everywhere. */
  _renderLegend(hist) {
    const el = this._q('legend');
    if (!el) return;
    const dark = this._dark();
    const last = hist.periods[hist.periods.length - 1];
    el.innerHTML = hist.poolIds.map((id, i) => {
      const off = this._hidden.has(id);
      const m   = last.pools[id];
      const tail = m
        ? ` <strong>${_esc(this._money(m.balance))}</strong>` +
          (m.yearsOfCover != null ? ` <span class="pool-dim">${m.yearsOfCover.toFixed(1)}y</span>` : '')
        : '';
      // The title says what the chip DOES, not just what it is: this strip is the panel's
      // only pool filter, and a legend that looks like a legend is one nobody clicks.
      return `<span class="pool-legend-item${off ? ' pool-legend-item--off' : ''}" data-key="${_esc(id)}"
        title="${_esc(id)} — click to show or hide this pool"><i style="background:${colorForSeriesKey(id, i, { dark })}"></i>${_esc(hist.labels[id])}${tail}</span>`;
    }).join('');

    // The household reserve gets a chip too, but NOT a filter chip: it is not a pool and
    // hiding it would imply it is one of them. It sits last and reads as the total the pool
    // chips should — and often do not — add up to.
    if (hist.hasReserve) {
      const r = last.reserve ?? {};
      if (r.accessible != null) {
        const lock = r.locked > 0 ? ` <span class="pool-dim">+${_esc(this._money(r.locked))} locked</span>` : '';
        el.insertAdjacentHTML('beforeend',
          `<span class="pool-legend-item pool-legend-item--static"
             title="Accessible CASH + BOND across every account, whether or not a pool claims it. The age gate is the same one the drawdown chain uses.">
             <i style="background:${dark ? '#94a3b8' : '#52514e'}"></i>Household reserve` +
          ` <strong>${_esc(this._money(r.accessible))}</strong>` +
          (r.yearsOfCover != null ? ` <span class="pool-dim">${r.yearsOfCover.toFixed(1)}y</span>` : '') +
          `${lock}</span>`);
      }
    }
  }

  _onLegendClick(e) {
    // The reserve chip carries no `data-key`, so it is not selectable here — which is what
    // keeps it out of `_hidden` and therefore out of `_visiblePools`.
    const chip = e.target.closest('[data-key]');
    if (!chip) return;
    const key = chip.dataset.key;
    if (this._hidden.has(key)) this._hidden.delete(key); else this._hidden.add(key);
    this._render();
  }

  // ─── CSV ─────────────────────────────────────────────────────────────────

  _downloadCsv() {
    const hist = this._history();
    if (!hist) return;
    const rows = poolHistoryRows(hist);
    if (!rows.length) return;
    const cell = (v) => {
      if (v == null) return '';
      const s = String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    // Reserve columns ride on every row: they are a per-PERIOD figure, not a per-pool one, so
    // repeating them is the only shape that survives a filter or a sort in a spreadsheet.
    const csv = [POOL_CSV_COLUMNS.join(','),
      ...rows.map(r => POOL_CSV_COLUMNS.map(c => cell(r[c])).join(','))].join('\n');
    const blob = new Blob([withBom(csv)], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `liquidity-pools-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  _dark() {
    const theme = document.documentElement?.dataset?.theme;
    if (theme) return theme !== 'light';
    return true;   // the workbench ships dark
  }

  _canvasAvailable() {
    if (this._hasCanvas === undefined) {
      try {
        const probe = document.createElement('canvas');
        this._hasCanvas = typeof probe.getContext === 'function' && !!probe.getContext('2d');
      } catch { this._hasCanvas = false; }
    }
    return this._hasCanvas;
  }

  _money(n) {
    if (n == null) return '—';
    const reg = this._services()?.schemaRegistry;
    return reg?.formatAmount?.(n, 'USD') ?? `$${Math.round(n).toLocaleString()}`;
  }

  _bindOnce(name, event, handler, rawHandler = null) {
    const el = this._q(name);
    if (!el || el._poolBound) return;
    el.addEventListener(event, rawHandler ?? (() => handler(el)));
    el._poolBound = true;
  }

  _q(name) { return this.el?.querySelector(`[data-pool="${name}"]`) ?? null; }
}

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Axis labels: a 60-period chart has no room for "$1,234,567". */
function _compact(n) {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}m`;
  if (a >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}
