/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import * as echarts             from 'echarts';
import { WorkbenchComponent } from '../../component.js';
import { WB_EVENTS }          from '../../workbench-runtime.js';
import { ServiceRegistry }    from '../../../../services/service-registry.js';
import { withBom }            from '../../../../utils/csv.js';
import { EXECUTION_KINDS, EXECUTION_PHASES } from '../../../../simulation-framework/bus-messages.js';
import { colorForSeriesKey }  from '../../../../finance/allocation-reporting/allocation-palette.js';
import {
  snapshotHoldings,
  totalSnapshot,
  groupSnapshotByAllocation,
  buildHoldingActivity,
  HOLDING_ACTIVITY_KIND,
} from '../../../../finance/holdings/holding-activity.js';

const _fallbackFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/**
 * HoldingsPlugin — workbench panel for per-account holdings over time.
 *
 * Three stacked views, all scoped to a picked account and the current sim date:
 *   Mix      — two charts of the same allocation-class rollup: a donut of market
 *              value (what you hold) beside diverging bars of unrealized G/L (how
 *              it has done). Same class order and same hue in both, so the pair
 *              reads as one picture rather than two.
 *   Snapshot — current per-holding marketValue / costBasis / unrealized G/L,
 *              read live from sim.state so it scrubs as the animator advances.
 *   Activity — chronological buy/sell ledger derived from the journal's
 *              `<stateKey>.holdings` diffs (sales, conversions, contributions,
 *              and — when toggled on — market moves / dividends).
 *
 * Subscribes to SCENARIO_READY (rebind sim) and RUNTIME_TICK (re-render on step).
 */
export class HoldingsPlugin extends WorkbenchComponent {
  constructor(runtime) {
    super();
    this._runtime       = runtime;
    this._sim           = null;
    this._stateKey      = null;    // selected account
    this._includeGrowth = false;   // ledger: show appreciation/dividend rows
    this._servicesOverride = null; // tests
    this._unsubSimBus   = null;    // teardown for the per-run sim-bus subscription
    this._renderQueued  = false;   // rAF debounce flag for step-driven re-renders
    this._pickerSig     = null;    // membership signature of the account <select>
    this._charts        = null;    // Map<hostName, echarts instance>, lazily built
    this._ros           = null;    // Map<hostName, ResizeObserver>, one per chart host
  }

  setServices(services) { this._servicesOverride = services ?? null; }
  _services() { return this._servicesOverride ?? ServiceRegistry.getInstance(); }

  render() {
    const root = document.createElement('div');
    root.className = 'hld-plugin wb-plugin-fill';
    root.innerHTML = `
      <div class="hld-toolbar">
        <select class="wb-select hld-account" data-hld="account"></select>
        <span class="hld-asof" data-hld="asof">—</span>
      </div>
      <div class="hld-body" data-hld="body">
        <div class="hld-placeholder" data-hld="placeholder">Run a simulation to populate holdings.</div>

        <div class="hld-section hld-charts" data-hld="chart-section" style="display:none">
          <figure class="hld-chart-cell">
            <figcaption class="hld-chart-title">Market value</figcaption>
            <div class="hld-chart" data-hld="mix-chart"></div>
          </figure>
          <figure class="hld-chart-cell">
            <figcaption class="hld-chart-title">Unrealized G/L</figcaption>
            <div class="hld-chart" data-hld="gl-chart"></div>
          </figure>
        </div>

        <div class="hld-section" data-hld="snap-section" style="display:none">
          <table class="hld-grid">
            <thead><tr>
              <th class="hld-th">Holding</th>
              <th class="hld-th">Alloc</th>
              <th class="hld-th hld-th--num">Market Value</th>
              <th class="hld-th hld-th--num">Cost Basis</th>
              <th class="hld-th hld-th--num">Unrealized G/L</th>
            </tr></thead>
            <tbody data-hld="snap-body"></tbody>
            <tfoot data-hld="snap-foot"></tfoot>
          </table>
        </div>

        <div class="hld-section" data-hld="act-section" style="display:none">
          <div class="hld-section-head">
            <span class="hld-section-title">Activity</span>
            <label class="hld-toggle">
              <input type="checkbox" data-hld="growth"> show market moves
            </label>
            <button class="hld-csv-btn" data-hld="csv" title="Download CSV">&#11015; CSV</button>
          </div>
          <table class="hld-grid">
            <thead><tr>
              <th class="hld-th">Date</th>
              <th class="hld-th">Type</th>
              <th class="hld-th">Holding</th>
              <th class="hld-th hld-th--num">&Delta; Market Value</th>
              <th class="hld-th hld-th--num">&Delta; Basis</th>
            </tr></thead>
            <tbody data-hld="act-body"></tbody>
          </table>
        </div>
      </div>
    `;
    return root;
  }

  onInit() {
    this._runtime.bus.subscribe(WB_EVENTS.SCENARIO_READY, ({ scenario }) => {
      this._bindSim(scenario?.sim ?? null);
    });
    this._runtime.bus.subscribe(WB_EVENTS.DISPLAY_SETTINGS_CHANGED, () => this._render());
    this._onResize = () => this._resizeCharts();
    window.addEventListener('resize', this._onResize);
  }

  onMount() {
    // Late-mount: the scenario may already be built before this panel first mounts.
    if (!this._sim) this._bindSim(this._services()?.simulationRegistry?.getPrimary?.() ?? null);

    const accSel = this._q('account');
    if (accSel && !accSel._hldBound) {
      accSel.addEventListener('change', () => { this._stateKey = accSel.value || null; this._render(); });
      accSel._hldBound = true;
    }

    const growth = this._q('growth');
    if (growth && !growth._hldBound) {
      growth.addEventListener('change', () => { this._includeGrowth = growth.checked; this._renderActivity(); });
      growth._hldBound = true;
    }

    const csv = this._q('csv');
    if (csv && !csv._hldBound) {
      csv.addEventListener('click', () => this._downloadCsv());
      csv._hldBound = true;
    }

    this._renderAccountPicker();
    this._render();
  }

  onActivate() {
    // ECharts cannot size a canvas inside a hidden pane, so a panel first activated
    // after the run comes up 0px tall without this.
    this._resizeCharts();
    this._render();
  }

  onAdopt() { this._resizeCharts(); }

  onUnmount() {
    // A docked panel is unmounted and remounted many times a session; leaking a canvas
    // and a ResizeObserver per remount is how a long session turns slow.
    this._disposeCharts();
  }

  destroy() {
    window.removeEventListener('resize', this._onResize);
    this._unsubSimBus?.();
    this._unsubSimBus = null;
    this._disposeCharts();
    super.destroy?.();
  }

  // ─── Binding ─────────────────────────────────────────────────────────────

  _bindSim(sim) {
    // The runtime never emits a per-step tick (RUNTIME_TICK is unused); live
    // updates ride the per-run sim bus instead. Re-subscribe whenever the sim
    // changes (every Rebuild swaps in a fresh sim + bus).
    this._unsubSimBus?.();
    this._unsubSimBus = null;

    this._sim = sim ?? null;

    if (sim?.bus) {
      // One completed EVENT = one step the user perceives; coalesce the burst
      // of per-event messages into a single rAF-debounced render.
      this._unsubSimBus = sim.bus.subscribe(
        `EXECUTION_${EXECUTION_PHASES.END}`,
        { kind: EXECUTION_KINDS.EVENT },
        () => this._scheduleRender(),
      );
    }

    // Reset selection if the bound account is gone; keep it across steps otherwise.
    if (this._stateKey && !this._accountByKey(this._stateKey)) this._stateKey = null;
    this._resetActivityRender();   // new sim ⇒ new journal ⇒ rebuild the ledger from scratch
    if (this._mounted) { this._renderAccountPicker(); this._render(); }
  }

  /** Coalesce step-driven re-renders to one per animation frame. */
  _scheduleRender() {
    // Skip entirely when the panel isn't visible — a backgrounded tab must not
    // pay any per-step cost.
    if (!this._mounted || this._renderQueued) return;
    this._renderQueued = true;
    const run = () => { this._renderQueued = false; if (this._mounted) this._render(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else run();
  }

  /** Reset the incremental-activity render cursor so the next render rebuilds in full. */
  _resetActivityRender() {
    this._actScanned = null;
    this._actKey     = null;
    this._actAsOf    = null;
  }

  /** Accounts that currently hold a holdings array, as { stateKey, label, currency }. */
  _holdingAccounts() {
    const state = this._sim?.state;
    if (!state) return [];
    const accounts = this._services()?.accountService?.getAll?.() ?? [];
    return accounts
      .filter(a => a.stateKey && Array.isArray(state[a.stateKey]?.holdings) && state[a.stateKey].holdings.length > 0)
      .map(a => ({
        stateKey: a.stateKey,
        label:    `${a.country ? a.country + ' ' : ''}${a.name || a.stateKey}`.trim(),
        // account.currency is a Currency descriptor ({ code, symbol }); formatAmount
        // needs the ISO string code, not the object.
        currency: a.currency?.code ?? (a.country === 'AU' ? 'AUD' : 'USD'),
      }));
  }

  _accountByKey(key) {
    return this._holdingAccounts().find(a => a.stateKey === key) ?? null;
  }

  _currency() {
    return this._accountByKey(this._stateKey)?.currency ?? 'USD';
  }

  _fmt(n) {
    if (n == null) return '—';
    // Use the per-render cached currency code; _currency() rebuilds the account
    // list on each call, which is too costly to do once per formatted cell.
    const code = this._activeCurrency ?? this._currency();
    const reg  = this._services()?.schemaRegistry;
    return reg?.formatAmount?.(n, code) ?? _fallbackFmt.format(n);
  }

  _fmtSigned(n) {
    if (n == null) return '—';
    const body = this._fmt(Math.abs(n));
    return (n > 0 ? '+' : n < 0 ? '-' : '') + body;
  }

  // ─── Rendering ───────────────────────────────────────────────────────────

  _renderAccountPicker() {
    const sel = this._q('account');
    if (!sel) return;
    const accounts = this._holdingAccounts();
    this._pickerSig = accounts.map(a => a.stateKey).join('|');
    if (!this._stateKey && accounts.length) this._stateKey = accounts[0].stateKey;

    sel.innerHTML = accounts.length
      ? accounts.map(a => `<option value="${a.stateKey}"${a.stateKey === this._stateKey ? ' selected' : ''}>${_esc(a.label)}</option>`).join('')
      : `<option value="">— no holding accounts —</option>`;
    if (this._stateKey) sel.value = this._stateKey;
  }

  _render() {
    if (!this._mounted) return;

    // The holding-account set can change mid-run: an inherited account gains its
    // holdings when funded at the inheritance date, and a fully drawn-down account
    // loses its last holding. The picker is otherwise only built at bind/mount, so
    // rebuild it whenever that membership changes — cheap (a joined-key compare),
    // and only actually rebuilds the <select> on the rare step where the set moves.
    // Without this, a mid-sim-funded inherited account never appears in the picker.
    if (this._holdingAccounts().map(a => a.stateKey).join('|') !== this._pickerSig) {
      this._renderAccountPicker();
    }

    const asof = this._q('asof');
    if (asof) asof.textContent = this._sim?.currentDate ? `as of ${this._fmtDate(this._sim.currentDate)}` : '—';

    const account = this._stateKey ? this._sim?.state?.[this._stateKey] : null;
    const empty   = !this._sim || !this._stateKey || !account;

    this._q('placeholder').style.display    = empty ? '' : 'none';
    this._q('chart-section').style.display  = empty ? 'none' : '';
    this._q('snap-section').style.display   = empty ? 'none' : '';
    this._q('act-section').style.display    = empty ? 'none' : '';
    if (empty) {
      this._q('placeholder').textContent = this._sim ? 'No holding-capable accounts in this scenario.' : 'Run a simulation to populate holdings.';
      return;
    }

    this._activeCurrency = this._currency();   // resolve once per render
    const rows = snapshotHoldings(account);   // one read, shared by the charts and the table
    this._renderCharts(rows);
    this._renderSnapshot(rows);
    this._renderActivity();
  }

  _renderSnapshot(rows) {
    const body = this._q('snap-body');
    const foot = this._q('snap-foot');

    body.innerHTML = rows.map(r => `
      <tr>
        <td class="hld-td">${_esc(r.label)}</td>
        <td class="hld-td hld-alloc">${_esc(r.allocation ?? '—')}</td>
        <td class="hld-td hld-td--num">${this._fmt(r.marketValue)}</td>
        <td class="hld-td hld-td--num">${this._fmt(r.costBasis)}</td>
        <td class="hld-td hld-td--num ${_signCls(r.unrealized)}">${this._fmtSigned(r.unrealized)}</td>
      </tr>`).join('') || `<tr><td class="hld-td hld-empty" colspan="5">No holdings.</td></tr>`;

    const t = totalSnapshot(rows);
    foot.innerHTML = rows.length ? `
      <tr class="hld-total-row">
        <td class="hld-td" colspan="2">Total</td>
        <td class="hld-td hld-td--num">${this._fmt(t.marketValue)}</td>
        <td class="hld-td hld-td--num">${this._fmt(t.costBasis)}</td>
        <td class="hld-td hld-td--num ${_signCls(t.unrealized)}">${this._fmtSigned(t.unrealized)}</td>
      </tr>` : '';
  }


  // ─── Charts ──────────────────────────────────────────────────────────────

  /**
   * The two mix charts, both over the same allocation-class rollup of the picked
   * account's current positions.
   *
   * They are deliberately a PAIR rather than two pies. A pie cannot draw a negative
   * slice, and unrealized G/L is signed — a class that is down would either vanish or,
   * worse, render as a positive-looking wedge, and "share of total gain" exceeds 100%
   * the moment one class is up and another down. So value (always positive, a genuine
   * part-of-whole) gets the donut, and G/L (signed, a comparison) gets diverging bars.
   *
   * What ties them together is colour and order: the same class sits in the same
   * position with the same hue in both, taken from the shared allocation palette, so
   * the reader maps a wedge to a bar without a legend. Sign is carried by DIRECTION
   * (left/right of zero), not by colour, precisely so colour can keep meaning identity.
   */
  _renderCharts(rows) {
    const groups  = groupSnapshotByAllocation(rows);
    const section = this._q('chart-section');
    if (section) section.style.display = groups.length ? '' : 'none';
    if (!groups.length) return;

    const dark = this._dark();
    // One colour lookup per class, shared by both charts — this is the link between them.
    const colors = new Map(groups.map((g, i) => [g.allocation, colorForSeriesKey(g.allocation, i, { dark })]));

    this._chartFor('mix-chart')?.setOption(this._mixOption(groups, colors, dark), true);
    this._chartFor('gl-chart') ?.setOption(this._glOption(groups, colors, dark),  true);
  }

  /** Donut of market value by allocation class, total in the hole. */
  _mixOption(groups, colors, dark) {
    const ink = dark ? '#94a3b8' : '#52514e';
    // A holding's market value is never negative, but a pie is the one chart that turns
    // a bad number into a silently wrong picture, so guard rather than trust.
    const slices = groups.filter(g => g.marketValue > 0);
    const total  = slices.reduce((sum, g) => sum + g.marketValue, 0);
    const fmt    = (n) => this._fmt(n);

    return {
      animation: false,
      backgroundColor: 'transparent',
      textStyle: { color: ink, fontFamily: 'var(--font-mono, monospace)' },
      tooltip: {
        trigger: 'item',
        formatter: (p) => {
          const g = slices[p.dataIndex];
          const n = g.count === 1 ? '1 holding' : `${g.count} holdings`;
          return `${p.marker} <strong>${p.name}</strong> ${fmt(p.value)}<br>` +
                 `<span style="opacity:.65">${p.percent.toFixed(1)}% · ${n}</span>`;
        },
      },
      series: [{
        type: 'pie',
        // A donut, not a full pie: the hole is where the account total goes, which is the
        // number a reader wants alongside every share and would otherwise have to hunt
        // for in the table's footer.
        radius: ['54%', '80%'],
        center: ['50%', '52%'],
        label:     { show: false },
        labelLine: { show: false },
        itemStyle: { borderWidth: 1, borderColor: dark ? '#111827' : '#ffffff' },
        emphasis:  { scale: false, itemStyle: { shadowBlur: 6, shadowColor: 'rgba(0,0,0,.35)' } },
        data: slices.map(g => ({
          name: g.allocation, value: g.marketValue, itemStyle: { color: colors.get(g.allocation) },
        })),
      }],
      graphic: {
        type: 'text', left: 'center', top: 'middle', silent: true,
        style: {
          text: this._compact(total), fill: ink, fontSize: 12, fontWeight: 600,
          fontFamily: 'var(--font-mono, monospace)',
        },
      },
    };
  }

  /** Diverging horizontal bars of unrealized G/L by allocation class. */
  _glOption(groups, colors, dark) {
    const ink  = dark ? '#94a3b8' : '#52514e';
    const line = dark ? '#334155' : '#e1e0d9';
    const fmt  = (n) => this._fmt(n);
    // ECharts draws a category axis bottom-up; reversing keeps the first class at the
    // TOP, which is where the donut starts its first wedge. Same order, both charts.
    const ordered = [...groups].reverse();

    // Headroom for the bars' own end labels, which ECharts draws OUTSIDE the bar and
    // does not reserve grid space for (`containLabel` covers axis labels only). It has
    // to be a slice of the whole SPAN, not of each end's own value: a chart dominated by
    // one big loss leaves a proportional pad on the small gain side that is a few pixels
    // wide, and the label there gets clipped to a character or two. Only the sides that
    // actually carry data are padded, so an account with no losses does not draw a third
    // of its chart as empty negative space.
    const values = ordered.map(g => g.unrealized);
    const lo   = Math.min(0, ...values);
    const hi   = Math.max(0, ...values);
    const pad  = (hi - lo) * 0.2 || 1;

    return {
      animation: false,
      backgroundColor: 'transparent',
      textStyle: { color: ink, fontFamily: 'var(--font-mono, monospace)' },
      // `containLabel` fits the axis labels; the extra right margin keeps the last x tick
      // from being clipped by the panel edge. Room for the BARS' labels comes from the
      // axis extent instead — see `pad` above.
      grid: { left: 2, right: 12, top: 6, bottom: 2, containLabel: true },
      tooltip: {
        trigger: 'item',
        formatter: (p) => {
          const g   = ordered[p.dataIndex];
          const pct = g.costBasis > 0 ? `${(g.unrealized / g.costBasis * 100).toFixed(1)}% of basis` : 'no basis';
          return `${p.marker} <strong>${g.allocation}</strong> ${this._fmtSigned(g.unrealized)}<br>` +
                 `<span style="opacity:.65">${pct} · ${fmt(g.costBasis)} cost</span>`;
        },
      },
      xAxis: {
        type: 'value',
        min: lo < 0 ? lo - pad : 0,
        max: hi > 0 ? hi + pad : 0,
        // Three gridlines, not five: the panel is narrow, and money ticks are wide enough
        // that five of them run together into a grey smear.
        splitNumber: 3,
        axisLine:  { show: false },
        axisTick:  { show: false },
        splitLine: { lineStyle: { color: line } },
        axisLabel: { color: ink, fontSize: 9, formatter: (v) => this._compact(v) },
      },
      yAxis: {
        type: 'category',
        data: ordered.map(g => g.allocation),
        axisLine:  { lineStyle: { color: line } },
        axisTick:  { show: false },
        axisLabel: { color: ink, fontSize: 9 },
      },
      series: [{
        type: 'bar',
        barWidth: '55%',
        data: ordered.map(g => ({
          value: g.unrealized,
          itemStyle: { color: colors.get(g.allocation) },
          // Per-item so the label sits on the OUTER end of each bar; a single chart-level
          // position would push every negative bar's label back across the zero line.
          label: { position: g.unrealized < 0 ? 'left' : 'right' },
        })),
        label: {
          show: true, color: ink, fontSize: 9,
          formatter: ({ value }) => (value > 0 ? '+' : '') + this._compact(value),
        },
        markLine: {
          silent: true, symbol: 'none', animation: false,
          label: { show: false },
          lineStyle: { color: ink, opacity: 0.5, type: 'solid', width: 1 },
          data: [{ xAxis: 0 }],
        },
      }],
    };
  }

  /** Lazily create (and keep sized) the ECharts instance for one chart host. */
  _chartFor(name) {
    if (!this._canvasAvailable()) return null;
    this._charts ??= new Map();
    const existing = this._charts.get(name);
    if (existing) return existing;

    const host = this._q(name);
    if (!host) return null;

    // ECharts sizes its canvas once, at init, and this panel's box moves WITHOUT a
    // window resize: the section appears when the first account is picked, the pane is
    // draggable, and the two charts share a row that wraps. Observe the box, not the
    // window.
    this._observeHost(name, host);

    // A docked panel whose tab has never been activated is 0x0, and so is this host on
    // the very first render after SCENARIO_READY. Initialising there makes ECharts warn
    // and draw nothing, so wait: the observer above re-renders the moment the host has
    // a real box.
    if (!(host.clientWidth > 0 && host.clientHeight > 0)) return null;

    const chart = echarts.init(host, null, { renderer: 'canvas' });
    this._charts.set(name, chart);
    return chart;
  }

  /**
   * One ResizeObserver per chart host, kept for the panel's lifetime. It does double
   * duty: resize an existing chart, or — when the host was still 0x0 at init time —
   * trigger the render that finally creates it.
   */
  _observeHost(name, host) {
    if (typeof ResizeObserver !== 'function') return;
    this._ros ??= new Map();
    if (this._ros.has(name)) return;
    const ro = new ResizeObserver(() => {
      const chart = this._charts?.get(name);
      if (chart) chart.resize();
      else if (host.clientWidth > 0 && host.clientHeight > 0) this._scheduleRender();
    });
    ro.observe(host);
    this._ros.set(name, ro);
  }

  _resizeCharts() { this._charts?.forEach(c => c.resize()); }

  _disposeCharts() {
    this._ros?.forEach(ro => ro.disconnect());
    this._ros = null;
    this._charts?.forEach(c => c.dispose());
    this._charts = null;
  }

  _dark() {
    const theme = document.documentElement?.dataset?.theme;
    return theme ? theme !== 'light' : true;   // the workbench ships dark
  }

  /**
   * Does this environment have a 2D canvas? jsdom does not, and ECharts fails inside
   * `setOption` rather than at `init`, which would take this panel's DOM tests down
   * with it. Probed once — it is an environment fact, not an error to swallow — and
   * everything else on the panel (tables, ledger, CSV) renders without one.
   */
  _canvasAvailable() {
    if (this._hasCanvas === undefined) {
      try {
        // Ask for the CONSTRUCTOR first. jsdom defines `getContext` but not
        // `CanvasRenderingContext2D`, and calling getContext there logs a jsdom
        // "not implemented" error through the virtual console on every mount — noise
        // in a suite that is otherwise clean. Every real browser has both, so the
        // second half still does the actual asking where the answer can vary.
        const ctor  = typeof globalThis.CanvasRenderingContext2D === 'function';
        const probe = ctor ? document.createElement('canvas') : null;
        this._hasCanvas = ctor && typeof probe.getContext === 'function' && !!probe.getContext('2d');
      } catch { this._hasCanvas = false; }
    }
    return this._hasCanvas;
  }

  /**
   * Compact money for an axis tick / bar label, in the same display currency the table
   * uses — a chart reading in USD beside a table reading in AUD is a bug the reader
   * cannot see. Goes through this panel's services seam rather than money-format's
   * global one so tests can inject.
   */
  _compact(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    const code = this._activeCurrency ?? this._currency();
    const conv = this._services()?.schemaRegistry?.convertForDisplay?.(n, code);
    const v    = conv?.value ?? n;
    const sym  = conv?.symbol ?? '$';
    const abs  = Math.abs(v);
    const sign = v < 0 ? '-' : '';
    if (abs >= 1_000_000) return `${sign}${sym}${(abs / 1e6).toFixed(1)}M`;
    if (abs >= 1_000)     return `${sign}${sym}${Math.round(abs / 1e3)}k`;
    return `${sign}${sym}${Math.round(abs)}`;
  }

  /**
   * Append-only activity rendering. Rebuilding the whole table every sim step
   * (and re-scanning the entire journal) was the panel's dominant cost. Instead
   * we keep a cursor (`_actScanned`) into the journal and only render rows from
   * entries added since the last frame, appending them to the existing <tbody>.
   *
   * A full rebuild is forced when the account or the growth toggle changes, when
   * the journal shrinks or the as-of date moves backward (rewind / scrub), or on
   * the first render.
   */
  _renderActivity() {
    if (!this._mounted) return;
    if (this._activeCurrency == null) this._activeCurrency = this._currency();
    const growth = this._q('growth');
    if (growth) growth.checked = this._includeGrowth;

    const body = this._q('act-body');
    if (!body) return;

    const journal = this._sim?.journal?.journal ?? [];
    const asOfMs  = this._sim?.currentDate ? new Date(this._sim.currentDate).getTime() : null;
    const key     = `${this._stateKey}|${this._includeGrowth}`;

    const rewound = journal.length < (this._actScanned ?? 0) ||
                    (this._actAsOf != null && asOfMs != null && asOfMs < this._actAsOf);
    const full    = this._actScanned == null || key !== this._actKey || rewound;

    if (full) {
      const rows = buildHoldingActivity(journal, this._stateKey, { asOfMs, includeGrowth: this._includeGrowth });
      body.innerHTML = rows.length
        ? rows.map(r => this._activityRowHtml(r)).join('')
        : `<tr data-hld-empty><td class="hld-td hld-empty" colspan="5">No activity yet.</td></tr>`;
    } else if (journal.length > this._actScanned) {
      const fresh = buildHoldingActivity(
        journal.slice(this._actScanned), this._stateKey, { asOfMs, includeGrowth: this._includeGrowth }
      );
      if (fresh.length) {
        body.querySelector('[data-hld-empty]')?.remove();
        body.insertAdjacentHTML('beforeend', fresh.map(r => this._activityRowHtml(r)).join(''));
      }
    }

    this._actScanned = journal.length;
    this._actKey     = key;
    this._actAsOf    = asOfMs;
  }

  _activityRowHtml(r) {
    return `
      <tr>
        <td class="hld-td hld-act-date">${this._fmtDate(r.date)}</td>
        <td class="hld-td"><span class="hld-kind hld-kind--${r.kind.toLowerCase()}">${r.kind}</span></td>
        <td class="hld-td">${_esc(r.label)}</td>
        <td class="hld-td hld-td--num ${_signCls(r.mvDelta)}">${this._fmtSigned(r.mvDelta)}</td>
        <td class="hld-td hld-td--num ${_signCls(r.basisDelta)}">${this._fmtSigned(r.basisDelta)}</td>
      </tr>`;
  }

  _activityRows() {
    const entries = this._sim?.journal?.journal ?? [];
    const asOfMs  = this._sim?.currentDate ? new Date(this._sim.currentDate).getTime() : null;
    return buildHoldingActivity(entries, this._stateKey, { asOfMs, includeGrowth: this._includeGrowth });
  }

  _downloadCsv() {
    const rows = this._activityRows();
    if (!rows.length) return;
    const cols = ['date', 'kind', 'actionType', 'holdingId', 'label', 'mvDelta', 'basisDelta'];
    const esc  = v => {
      if (v == null) return '';
      const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
    const blob = new Blob([withBom(csv)], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `holdings-${this._stateKey}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /**
   * Format a date honoring the app timezone dropdown (AppDisplaySettings.formatDate,
   * exposed on schemaRegistry.displaySettings). Without it — dates rendered in the
   * browser's local zone shift a UTC-midnight timestamp to the prior day. Falls
   * back to a local format only when display settings aren't wired (tests).
   */
  _fmtDate(d) {
    const fmt = this._services()?.schemaRegistry?.displaySettings?.formatDate;
    if (!fmt || !d) return _fmtDateLocal(d);
    const date = d instanceof Date ? d : new Date(d);
    return Number.isNaN(date.getTime()) ? _fmtDateLocal(d) : fmt(date);
  }

  _q(name) { return this.el?.querySelector(`[data-hld="${name}"]`) ?? null; }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function _signCls(n) { return n == null || n === 0 ? '' : n > 0 ? 'hld-amount--pos' : 'hld-amount--neg'; }
function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function _fmtDateLocal(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return String(d); }
}

// Re-export kind constants for consumers/tests that import via the plugin.
export { HOLDING_ACTIVITY_KIND };
