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
import { buildSpendingCube, checkClassificationTotal, spendingSummary }
  from '../../../../finance/spending-reporting/spending-cube.js';
import { buildSpendingSeries, bySpendingTier, intentVsRealized }
  from '../../../../finance/spending-reporting/spending-grouping.js';
import { REPORT_CATEGORY, SPEND_TIER }
  from '../../../../finance/spending-reporting/spending-classification.js';
import { checkFlowInvariant }
  from '../../../../finance/spending-reporting/account-flow-tie.js';
import { colorForCategory }
  from '../../../../finance/spending-reporting/spending-palette.js';

/**
 * SpendingPlugin — what the plan actually costs, year by year (design 89 §11 phase 5).
 *
 * The **flow** sibling of `AllocationPlugin`. That panel answers "what shape is the
 * portfolio"; this one answers the question a net-worth line and a withdrawal total both
 * hide: **of everything that left an account, how much was actually a cost?** On the
 * reference plan the answer is about half — the naive "sum every debit" figure overstates
 * the cost of the plan by 99% (design 89 §3).
 *
 * ─── where the numbers come from ─────────────────────────────────────────────
 *
 * Nothing here samples, steps or pivots on its own:
 *
 *   - the classification and the cube are `buildSpendingCube`, the same module the lab
 *     page uses. The pivot is `spending-grouping.js`, likewise. §11's non-negotiable: the
 *     moment a view grows its own pivot the two can disagree about a share with no way to
 *     tell which is right.
 *   - the colours are `spending-palette.js`, shared for the reason design 82 §6.7 gives —
 *     colour is how a band is IDENTIFIED, and someone who learned that amber is tax on the
 *     lab page should not have to relearn it here.
 *   - the §7(b) balances ride the run's own sampler. `buildSim` takes exactly one sampler
 *     and design 82 owns it, so `workbench-app` wraps it in `withBalances` — see that
 *     call site. Without it this panel still works; only its flow-ties-to-stock line
 *     degrades to "not checked", which it says rather than hiding.
 *
 * ─── two things it will not do ───────────────────────────────────────────────
 *
 * **It never stacks the two tiers.** Internal transfers, principal and marks are drawn,
 * because §7(a) is only auditable if every debit is on the panel somewhere — but in their
 * own view, never added to the spending bands. Adding them restates the overstatement the
 * whole design exists to remove.
 *
 * **It states both invariants before it draws.** §7(a) classification is total, and §7(b)
 * the flow ties to the stock. A UI that silently omits a category is worse than a page
 * doing it, because nobody diffs a panel against a CSV.
 */
export class SpendingPlugin extends WorkbenchComponent {
  constructor(runtime) {
    super();
    this._runtime = runtime;
    this._sim     = null;
    this._servicesOverride = null;   // tests

    this._view = 'spending';   // spending | moved | tie
    this._mode = 'real';       // real | nominal | share

    this._chart        = null;
    this._unsubSimBus  = null;
    this._renderQueued = false;
    this._dataSig      = null;
    this._cubeCache    = null;
    this._tieCache     = null;
    this._hidden       = new Set();
  }

  setServices(services) { this._servicesOverride = services ?? null; }
  _services() { return this._servicesOverride ?? ServiceRegistry.getInstance(); }

  render() {
    const root = document.createElement('div');
    root.className = 'spend-plugin wb-plugin-fill';
    root.innerHTML = `
      <div class="spend-toolbar">
        <select class="wb-select spend-view" data-spend="view">
          <option value="spending">What it cost</option>
          <option value="moved">What it merely moved</option>
          <option value="tie">Flow ties to stock</option>
        </select>
        <span class="spend-seg" data-spend="mode">
          <button type="button" data-mode="real" class="on">real</button>
          <button type="button" data-mode="nominal">nominal</button>
          <button type="button" data-mode="share">share</button>
        </span>
        <span class="spend-spacer"></span>
        <span class="spend-asof" data-spend="asof">—</span>
        <button class="spend-csv-btn" data-spend="csv" title="Download the classified cube as CSV">&#11015; CSV</button>
      </div>

      <div class="spend-provenance" data-spend="provenance"></div>

      <div class="spend-body" data-spend="body">
        <div class="spend-placeholder" data-spend="placeholder">
          Step or run the simulation to classify its spending.
        </div>
        <div class="spend-chart" data-spend="chart"></div>
        <div class="spend-grid" data-spend="grid"></div>
      </div>

      <div class="spend-legend" data-spend="legend"></div>
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
    // Late-mount: the scenario is usually built before this panel first mounts.
    if (!this._sim) this._bindSim(this._services()?.simulationRegistry?.getPrimary?.() ?? null);

    this._bindOnce('view', 'change', (el) => { this._view = el.value; this._syncControls(); this._render(); });
    this._bindOnce('csv',  'click',  () => this._downloadCsv());
    this._bindOnce('legend', 'click', null, (e) => this._onLegendClick(e));

    const seg = this._q('mode');
    if (seg && !seg._spendBound) {
      seg.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-mode]');
        if (!btn) return;
        this._mode = btn.dataset.mode;
        seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === btn));
        this._render();
      });
      seg._spendBound = true;
    }

    this._syncControls();
    this._render();
  }

  onActivate() {
    // The chart cannot size itself while the pane is hidden, so a panel activated after a
    // run comes up 0px tall without this.
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
      // `WB_EVENTS.RUNTIME_TICK` is never emitted — per-step updates ride the per-run sim
      // bus. One completed EVENT is one perceived step; coalesce the burst into one rAF
      // render, because the cube is a full journal walk (~9ms on a 45-year run) and doing
      // it per event during playback would be the whole frame budget.
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

  _invalidate() {
    this._dataSig   = null;
    this._cubeCache = null;
    this._tieCache  = null;
  }

  /**
   * Signature of the run's journal. Entry count alone is enough for growth, but a
   * scrub-back leaves the count unchanged while the content differs, so the last entry's
   * seq is in it too.
   */
  _signature() {
    const entries = this._sim?.journal?.journal;
    if (!Array.isArray(entries) || entries.length === 0) return 'empty';
    const last = entries[entries.length - 1];
    return `${entries.length}|${last?.seq ?? 0}|${this._sim?.samples?.length ?? 0}`;
  }

  /** The classified cube, rebuilt only when the run has actually moved. */
  _cube() {
    const sig = this._signature();
    if (sig === this._dataSig && this._cubeCache) return this._cubeCache;
    if (sig === 'empty') { this._cubeCache = null; this._tieCache = null; this._dataSig = sig; return null; }

    this._cubeCache = buildSpendingCube({
      journal:  this._sim.journal,
      state:    this._sim.state,
      services: this._services(),
      currency: 'USD',
    });
    this._tieCache = checkFlowInvariant({
      samples: this._sim.samples, journal: this._sim.journal,
    });
    this._dataSig = sig;
    return this._cubeCache;
  }

  _flowTie() { this._cube(); return this._tieCache; }

  // ─── Render ──────────────────────────────────────────────────────────────

  _syncControls() {
    const view = this._q('view');
    if (view) view.value = this._view;
    // The share view is meaningless on the tie grid, and the real/nominal split does not
    // apply to it either — the identity is per account in its own currency.
    const seg = this._q('mode');
    if (seg) seg.style.display = this._view === 'tie' ? 'none' : '';
  }

  _render() {
    if (!this._mounted) return;

    const cube = this._cube();
    const asof = this._q('asof');
    const years = cube ? [...new Set(cube.rows.map(r => r.year))].sort((a, b) => a - b) : [];
    if (asof) {
      asof.textContent = years.length
        ? `${years[0]}–${years[years.length - 1]} · ${years.length} yr`
        : '—';
    }

    this._renderProvenance(cube);

    const empty = !cube || cube.rows.length === 0;
    this._q('placeholder').style.display = empty ? '' : 'none';
    this._q('chart').style.display = empty || this._view === 'tie' ? 'none' : '';
    this._q('grid').style.display  = !empty && this._view === 'tie' ? '' : 'none';
    if (empty) {
      this._q('legend').innerHTML = '';
      this._q('grid').innerHTML = '';
      this._q('placeholder').textContent = this._sim
        ? 'Step or run the simulation to classify its spending.'
        : 'No simulation is loaded.';
      return;
    }

    if (this._view === 'tie') { this._q('legend').innerHTML = ''; this._renderTieGrid(); return; }

    const tier  = this._view === 'moved' ? SPEND_TIER.NOT_SPENDING : SPEND_TIER.SPENDING;
    const value = this._mode === 'nominal' ? 'amount' : 'amountReal';
    const built = buildSpendingSeries(cube.rows, {
      value, years, normalize: this._mode === 'share', filter: r => r.tier === tier,
    });

    this._drawChart(built, cube, years);
    this._renderLegend(built);
  }

  /**
   * Both invariants, above the chart, before anything is drawn.
   *
   * §7(a) — a classification that loses a debit understates the cost of the plan without
   * leaving a mark. §7(b) — if the flow does not tie to the stock, this panel and the
   * allocation panel are not describing the same run.
   */
  _renderProvenance(cube) {
    const el = this._q('provenance');
    if (!el) return;
    if (!cube) { el.innerHTML = ''; el.className = 'spend-provenance'; return; }

    const total = checkClassificationTotal(cube);
    const tie   = this._flowTie();

    if (!total.ok) {
      el.className = 'spend-provenance spend-provenance--bad';
      el.innerHTML = `<strong>Classification is not total.</strong> Categories sum to
        ${_esc(this._money(total.sum))} against ${_esc(this._money(total.total))} of debits —
        a debit is being dropped or double-counted. Do not quote any band here.`;
      return;
    }
    // `unchecked` is NOT a failure, and must not be painted as one. A sim built without
    // the balance sampler — a test harness, an older saved session, a scenario opened
    // before `withBalances` shipped — has nothing to tie against. Showing "the flow does
    // not tie to the stock" there tells the reader their data is broken when it is not,
    // which is the one thing a provenance strip must never do.
    if (tie && !tie.ok && !tie.tie.unchecked) {
      el.className = 'spend-provenance spend-provenance--bad';
      el.innerHTML = `<strong>The flow does not tie to the stock.</strong> ${_esc(tie.summary)}.
        Either a balance moved without the journal recording it — in which case this panel
        cannot see that money at all — or the two readings disagree.`;
      return;
    }

    const summary = spendingSummary(cube);
    const notes = [];
    notes.push(`<span class="spend-ok">✓</span> classification total`);
    notes.push(tie?.tie?.unchecked
      ? `flow-vs-stock <em>not checked</em> — no year-boundary samples`
      : `<span class="spend-ok">✓</span> ties across ${tie.tie.checked.toLocaleString()} account-years`);
    notes.push(`cost ${_esc(this._money(summary.spendingReal))} real of
                ${_esc(this._money(cube.totalReal))} moved`);
    notes.push(`&ldquo;all debits&rdquo; overstates by ${(summary.overstatement * 100).toFixed(0)}%`);
    if (total.unclassified > 0) {
      notes.push(`<strong>${_esc(this._money(total.unclassified))} UNCLASSIFIED</strong>`);
    }
    if (cube.unconverted > 0) notes.push(`${_esc(this._money(cube.unconverted))} unconverted`);

    el.className = 'spend-provenance';
    el.innerHTML = notes.join(' · ');
  }

  _drawChart(built, cube, years) {
    const host = this._q('chart');
    if (!host || !this._canvasAvailable()) return;
    // ECharts warns to the console when initialised against a 0x0 host, which is what a
    // docked panel is until its tab is first activated. `onActivate` re-renders, so
    // deferring costs nothing and keeps the console clean for whoever debugs near it.
    if (!this._chart && !(host.clientWidth > 0 && host.clientHeight > 0)) return;
    if (!this._chart) {
      this._chart = echarts.init(host, null, { renderer: 'canvas' });
      if (typeof ResizeObserver === 'function') {
        this._ro = new ResizeObserver(() => this._chart?.resize());
        this._ro.observe(host);
      }
    }

    const share = this._mode === 'share';
    const dark  = this._dark();
    const ink   = dark ? '#94a3b8' : '#52514e';
    const line  = dark ? '#334155' : '#e1e0d9';
    const keys  = built.keys.filter(k => !this._hidden.has(k));

    const series = keys.map((key) => ({
      name: key, type: 'bar', stack: 'all', barMaxWidth: 26,
      itemStyle: { color: colorForCategory(key, built.keys.indexOf(key), { dark }) },
      emphasis: { focus: 'series' },
      data: built.series[key],
    }));

    // §5's intent line: what the plan asked for, over what it got. Only on the spending
    // view, and never on the share view — a fraction of realized spending cannot be
    // compared with an intention. It is a LINE, not another band: it is a claim about the
    // same quantity as the stack, and drawing it as a band would say the plan spent more.
    if (this._view === 'spending' && !share) {
      const iv = intentVsRealized(cube.rows, {
        value: this._mode === 'nominal' ? 'amount' : 'amountReal', years,
      });
      series.push({
        name: 'intended', type: 'line', z: 5, step: 'middle',
        showSymbol: false, smooth: false,
        lineStyle: { width: 1.4, type: 'dashed', color: dark ? '#e2e8f0' : '#0b0b0b' },
        itemStyle: { color: dark ? '#e2e8f0' : '#0b0b0b' },
        data: iv.intent,
      });
    }

    this._chart.setOption({
      animation: false,
      backgroundColor: 'transparent',
      textStyle: { color: ink, fontFamily: 'var(--font-mono, monospace)' },
      grid: { left: 56, right: 12, top: 10, bottom: 24 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params) => {
          if (!params?.length) return '';
          const i = params[0].dataIndex;
          const head = `<strong>${params[0].axisValue}</strong>` +
            (share ? '' : ` <span style="opacity:.6">${this._money(built.totals[i])}</span>`);
          // Zero series dropped and sorted descending: a 14-line tooltip where 8 read $0
          // is how a reader stops opening the tooltip at all.
          const lines = params
            .filter(p => Math.abs(p.value) > (share ? 0.0005 : 0.5))
            .sort((a, b) => (a.seriesType === 'line') - (b.seriesType === 'line') ||
                            Math.abs(b.value) - Math.abs(a.value))
            .map(p => `${p.marker} ${p.seriesName} <strong>` +
              (share ? `${(p.value * 100).toFixed(1)}%` : this._money(p.value)) + '</strong>');
          return `${head}<br>${lines.join('<br>')}`;
        },
      },
      xAxis: {
        type: 'category', data: years.map(String),
        axisLine: { lineStyle: { color: line } },
        axisLabel: { color: ink, fontSize: 9, hideOverlap: true },
      },
      yAxis: {
        type: 'value', max: share ? 1 : null,
        splitLine: { lineStyle: { color: line } },
        axisLabel: {
          color: ink, fontSize: 9,
          formatter: v => (share ? `${Math.round(v * 100)}%` : _compact(v)),
        },
      },
      series,
    }, true);
  }

  /**
   * The §7(b) grid: worst residual per account across every year.
   *
   * Shown even when everything ties, because a check that renders nothing on success gives
   * the reader no way to tell it ran.
   */
  _renderTieGrid() {
    const el  = this._q('grid');
    const tie = this._flowTie();
    if (!el) return;

    if (!tie || tie.tie.unchecked) {
      el.innerHTML = `<p class="spend-grid-note">The flow was not tied to the stock: this run
        produced no year-boundary samples, so §7(b) could not be checked at all — which is not
        the same as passing.</p>`;
      return;
    }

    const byAccount = new Map();
    for (const cell of tie.tie.cells) {
      const seen = byAccount.get(cell.stateKey);
      const flow = cell.credits + cell.debits;
      if (!seen) byAccount.set(cell.stateKey, { stateKey: cell.stateKey, years: 1, flow, worst: cell });
      else {
        seen.years++;
        seen.flow += flow;
        if (Math.abs(cell.residual) > Math.abs(seen.worst.residual)) seen.worst = cell;
      }
    }
    const rows = [...byAccount.values()]
      .sort((a, b) => Math.abs(b.worst.residual) - Math.abs(a.worst.residual) || b.flow - a.flow);

    el.innerHTML = `
      <p class="spend-grid-note">
        <code>opening + credits − debits = closing</code>, per account per year — journalled
        flows against balances sampled at the same year boundaries the allocation panel uses.
        Continuity checked over ${tie.continuity.diffCount.toLocaleString()} balance movements.
        Balances are each account's own currency, unconverted: the identity is an accounting
        statement within one account, and converting it would put an FX error into the one
        check whose value is being exact.
      </p>
      <table class="spend-table">
        <thead><tr><th>account</th><th class="num">years</th><th class="num">flow through</th>
          <th class="num">worst residual</th><th class="num">in</th></tr></thead>
        <tbody>${rows.map(a => {
          const bad = Math.abs(a.worst.residual) > 0.01;
          return `<tr class="${bad ? 'spend-row-bad' : ''}">
            <td>${_esc(a.stateKey)}</td>
            <td class="num">${a.years}</td>
            <td class="num">${_esc(this._money(a.flow))}</td>
            <td class="num">${bad ? _esc(this._money(a.worst.residual)) : '0'}</td>
            <td class="num spend-dim">${bad ? a.worst.year : '—'}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
  }

  /** Doubles as the chart's legend, so the chips are clickable (click = hide the band). */
  _renderLegend(built) {
    const el = this._q('legend');
    if (!el) return;
    const dark = this._dark();
    el.innerHTML = built.keys.map((key, i) => {
      const off = this._hidden.has(key);
      const total = built.series[key].reduce((a, v) => a + v, 0);
      const shown = this._mode === 'share'
        ? ''
        : ` <strong>${_esc(this._money(total))}</strong>`;
      return `<span class="spend-legend-item${off ? ' spend-legend-item--off' : ''}" data-key="${_esc(key)}">
        <i style="background:${colorForCategory(key, i, { dark })}"></i>${_esc(key)}${shown}</span>`;
    }).join('');
  }

  _onLegendClick(e) {
    const chip = e.target.closest('[data-key]');
    if (!chip) return;
    const key = chip.dataset.key;
    if (this._hidden.has(key)) this._hidden.delete(key); else this._hidden.add(key);
    this._render();
  }

  // ─── CSV ─────────────────────────────────────────────────────────────────

  _downloadCsv() {
    const cube = this._cube();
    if (!cube?.rows?.length) return;
    const cols = ['date', 'year', 'actionType', 'stateKey', 'currency', 'category', 'tier',
      'amountLocal', 'amount', 'amountReal', 'intent', 'intentReal', 'instanceId'];
    const cell = (v) => {
      if (v == null) return '';
      const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.join(','), ...cube.rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n');
    const blob = new Blob([withBom(csv)], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `spending-cube-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  _dark() {
    const theme = document.documentElement?.dataset?.theme;
    if (theme) return theme !== 'light';
    return true; // the workbench ships dark
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
    if (!el || el._spendBound) return;
    el.addEventListener(event, rawHandler ?? (() => handler(el)));
    el._spendBound = true;
  }

  _q(name) { return this.el?.querySelector(`[data-spend="${name}"]`) ?? null; }
}

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Axis labels: a 45-bar chart has no room for "$1,234,567". */
function _compact(n) {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}m`;
  if (a >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

export { REPORT_CATEGORY };
