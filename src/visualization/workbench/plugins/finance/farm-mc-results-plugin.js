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
import { CROPS }              from '../../../../finance/farm/farm-records.js';
import { farmMcStore }        from './farm-mc-store.js';

/**
 * FarmMcResultsPlugin — the farm Monte Carlo's results (design 134 §17.12), as MC Results and
 * MC Runs are the retirement batch's. The Farm MC panel sets up and runs the batch; this panel
 * reads it from the runtime's farm MC store, so it survives the rebuild a replay makes.
 *
 * ─── layout ──────────────────────────────────────────────────────────────────────
 *
 * A toolbar (the machinery basis, the scope, CSV), a replay badge while a path is in force,
 * then the batch as a distribution (a fan of the cumulative cash net, a histogram of the
 * crop-year net, the table of P(loss), net percentiles and breakeven ranges), then its PATHS:
 * the representative ones (worst, P10, median, P90, best by the scope's net) and every path,
 * sortable, with losses only on a switch. A path expands to the values it drew, ranked by how
 * far each sits from the batch median in the batch's own spread, so the outlier at the top is
 * usually what made the season. **Replay** asks the app to write the path onto the scenario,
 * rebuild, run the season and open the Field P&L (`WB_EVENTS.FARM_MC_REPLAY`); the badge's
 * Clear puts the scenario's values back.
 *
 * The paths table is built when it is shown and lists rows, not tables: a path's drawn values
 * are built only when it is expanded.
 */
export class FarmMcResultsPlugin extends WorkbenchComponent {
  constructor(runtime) {
    super();
    this._runtime = runtime;
    this._servicesOverride = null;   // tests
    this._cfgOverride      = null;   // tests
    this._store    = farmMcStore(runtime);
    this._basis    = 'custom';
    this._scope    = 'farm';         // 'farm' | 'operator.<id>'
    this._sort     = { key: 'net', dir: 1 };
    this._lossesOnly = false;
    this._expanded = new Set();      // path indices
    this._fanChart  = null;
    this._histChart = null;
    this._ro        = null;
    this._unsub = this._store.subscribe(() => {
      // A new batch starts closed: its indices are not the last one's.
      if (this._store.result !== this._shown) { this._expanded.clear(); this._shown = this._store.result; }
      this._render();
    });
    this._shown = this._store.result;
  }

  setServices(services) { this._servicesOverride = services ?? null; }
  _services() { return this._servicesOverride ?? ServiceRegistry.getInstance(); }
  /** Tests: the scenario cfg, instead of the active one. */
  setConfig(cfg) { this._cfgOverride = cfg ?? null; }
  _cfg() { return this._cfgOverride ?? this._services()?.scenarioService?.getActive?.() ?? null; }

  render() {
    const root = document.createElement('div');
    root.className = 'fmc-plugin sec-plugin wb-plugin-fill';
    root.innerHTML = `
      <div class="sec-toolbar">
        <span class="bond-seg" data-fmr="basis" title="Machinery in the nets: custom-hire rates, or the operator's real machinery cost (design 134 §5.3)">
          <button data-v="custom" class="on">custom rates</button><button data-v="actual">actual machinery</button>
        </span>
        <span class="bond-seg" data-fmr="scope" title="Which scope the charts and paths show"></span>
        <span class="sec-spacer"></span>
        <span class="sec-asof" data-fmr="status">—</span>
        <button class="sec-csv-btn" data-fmr="csv" title="Download the results as CSV">&#11015; CSV</button>
      </div>
      <div class="sec-body" data-fmr="body">
        <div class="mc-replay-badge" data-fmr="replay" style="display:none">
          <span data-fmr="replay-text"></span>
          <button class="btn btn-sm" data-fmr="replay-clear" title="Put back every value the replay changed and rebuild. A value you edited while replaying keeps your edit.">Clear</button>
        </div>
        <div class="bond-warn" data-fmr="warn" style="display:none"></div>
        <div class="sec-placeholder" data-fmr="placeholder">Run a batch in the Farm MC panel.</div>
        <div class="fmc-charts" data-fmr="charts" style="display:none">
          <div class="mc-section-label" data-fmr="fan-label">Cumulative cash net — confidence bands</div>
          <div class="mc-fan-wrap"><div class="mc-chart-fill" data-fmr="fan"></div></div>
          <div class="bond-caption" data-fmr="fan-caption"></div>
          <div class="mc-section-label" data-fmr="hist-label">Crop-year net — distribution</div>
          <div class="mc-hist-wrap"><div class="mc-chart-fill" data-fmr="hist"></div></div>
        </div>
        <table class="sec-grid" data-fmr="grid" style="display:none">
          <thead><tr>
            <th class="sec-th">Scope</th>
            <th class="sec-th sec-th--num" title="Share of paths whose crop-year net is below zero">P(loss)</th>
            <th class="sec-th sec-th--num">Net p10</th>
            <th class="sec-th sec-th--num">Net p50</th>
            <th class="sec-th sec-th--num">Net p90</th>
            <th class="sec-th sec-th--num" title="The price the bushels not under contract must fetch, p10 – p90">BE unpriced \$/bu</th>
            <th class="sec-th sec-th--num" title="The yield that covers cost, p10 – p90">BE yield</th>
            <th class="sec-th sec-th--num" title="The operator's crop-year Schedule F (cash) net after §464(d), p50, and its loss probability">Sched F p50 · P(loss)</th>
            <th class="sec-th sec-th--num" title="Crop insurance indemnity: its mean over all paths, and the share of paths in which a claim pays">Insurance mean · P(pays)</th>
            <th class="sec-th sec-th--num" title="This crop's ARC-County payment (paid the next October): its mean, and the share of paths in which it pays">ARC mean · P(pays)</th>
          </tr></thead>
          <tbody data-fmr="rows"></tbody>
        </table>
        <div class="fmr-paths" data-fmr="paths" style="display:none">
          <div class="fmc-chart-head">
            <span class="mc-section-label" data-fmr="paths-label">Paths</span>
            <label class="sec-toggle" title="List only the paths whose net is below zero">
              <input type="checkbox" data-fmr="losses"> losses only
            </label>
          </div>
          <table class="sec-grid fmr-path-grid">
            <thead><tr>
              <th class="sec-th fmr-sort" data-sort="index" title="The path's number, which is also its seed: the same number gives the same season">Path</th>
              <th class="sec-th sec-th--num fmr-sort" data-sort="net" title="The scope's crop-year net on the machinery basis">Net</th>
              <th class="sec-th sec-th--num fmr-sort" data-sort="revenue" title="Grain and other revenue">Revenue</th>
              <th class="sec-th sec-th--num fmr-sort" data-sort="breakevenUnpricedPrice" title="What the unpriced bushels must fetch">BE unpriced \$/bu</th>
              <th class="sec-th" title="The drawn value furthest from the batch median, in the batch's spread">Furthest draw</th>
              <th class="sec-th"></th>
            </tr></thead>
            <tbody data-fmr="rep-rows"></tbody>
            <tbody data-fmr="path-rows"></tbody>
          </table>
        </div>
      </div>
    `;
    return root;
  }

  onMount() {
    const seg = (name, apply) => {
      const el = this._q(name);
      if (!el || el._fmrBound) return;
      el.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-v]');
        if (!btn) return;
        apply(btn.dataset.v);
        this._render();
      });
      el._fmrBound = true;
    };
    seg('basis', (v) => { this._basis = v; });
    seg('scope', (v) => { this._scope = v; });
    const once = (name, type, fn) => {
      const el = this._q(name);
      if (!el || el[`_fmr_${type}`]) return;
      el.addEventListener(type, fn);
      el[`_fmr_${type}`] = true;
    };
    once('csv', 'click', () => this._downloadCsv());
    once('replay-clear', 'click', () => this._runtime?.bus?.publish?.({ type: WB_EVENTS.FARM_MC_REPLAY_CLEAR }));
    once('losses', 'change', (e) => { this._lossesOnly = e.target.checked; this._renderPaths(); });
    once('paths', 'click', (e) => {
      const sortTh = e.target.closest('th[data-sort]');
      if (sortTh) {
        const key = sortTh.dataset.sort;
        this._sort = { key, dir: this._sort.key === key ? -this._sort.dir : 1 };
        this._renderPaths();
        return;
      }
      const replay = e.target.closest('button[data-replay]');
      if (replay) { this.replay(Number(replay.dataset.replay)); return; }
      const tr = e.target.closest('tr[data-path]');
      if (tr) {
        const i = Number(tr.dataset.path);
        if (this._expanded.has(i)) this._expanded.delete(i); else this._expanded.add(i);
        this._renderPaths();
      }
    });
    this._render();
  }

  onActivate() {
    // ECharts cannot size itself in a hidden pane.
    this._fanChart?.resize();
    this._histChart?.resize();
    this._render();
  }

  onAdopt() { this._fanChart?.resize(); this._histChart?.resize(); }

  onUnmount() { this._disposeCharts(); }

  destroy() {
    this._unsub?.();
    this._disposeCharts();
    super.destroy?.();
  }

  _disposeCharts() {
    this._ro?.disconnect();
    this._ro = null;
    this._fanChart?.dispose();
    this._histChart?.dispose();
    this._fanChart = null;
    this._histChart = null;
  }

  // ─── Replay ──────────────────────────────────────────────────────────────

  /** Whether the batch was run on the active scenario, so its paths can be replayed onto it. */
  _sameScenario() {
    const r = this._store.result;
    return !!r && (r.scenarioId ?? null) === (this._cfg()?.id ?? null);
  }

  /** Ask the app to replay path `index` of the batch (design 134 §17.12). */
  replay(index) {
    const r = this._store.result;
    const run = r?.runs?.[index];
    if (!run || !this._sameScenario()) return;
    const rep = farmMcRepresentatives(farmMcPaths(r.runs, this._scope, this._basis)).find(x => x.index === index);
    this._runtime?.bus?.publish?.({
      type: WB_EVENTS.FARM_MC_REPLAY, run, index,
      priceVolFilled: r.summary?.provenance?.priceVolFilled ?? {},
      label: `path ${index + 1}${rep ? ` (${rep.label.toLowerCase()} by ${this._scopeLabel()} net)` : ''}`,
    });
  }

  // ─── Rendering ───────────────────────────────────────────────────────────

  _render() {
    if (!this._mounted) return;
    this._renderReplay();
    const r = this._store.result;
    const ph = this._q('placeholder');
    if (!r) {
      for (const n of ['grid', 'charts', 'paths', 'warn']) this._q(n).style.display = 'none';
      this._q('scope').innerHTML = '';
      ph.style.display = '';
      this._setStatus('—');
      return;
    }
    ph.style.display = 'none';
    const { farm } = r;
    if (this._scope !== 'farm' && !farm.operators.some(o => `operator.${o.id}` === this._scope)) this._scope = 'farm';
    const scopes = this._scopes();
    this._q('scope').innerHTML = scopes.map(([v, label]) =>
      `<button data-v="${_esc(v)}" class="${v === this._scope ? 'on' : ''}">${_esc(label)}</button>`).join('');
    this._q('basis').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === this._basis));
    this._setStatus(`${r.summary.n} paths · crop year ${farm.season.cropYear}`);
    this._renderWarn();
    this._renderTable();
    this._renderCharts();
    this._renderPaths();
  }

  _scopes() {
    const farm = this._store.result?.farm;
    return [['farm', 'Whole farm'], ...(farm?.operators ?? []).map(o => [`operator.${o.id}`, o.name ?? o.id])];
  }

  _scopeLabel() { return this._scopes().find(([v]) => v === this._scope)?.[1] ?? ''; }

  _renderReplay() {
    const badge = this._q('replay');
    const rp = this._store.replay;
    const on = !!rp && (rp.scenarioId ?? null) === (this._cfg()?.id ?? null);
    badge.style.display = on ? '' : 'none';
    if (on) {
      this._q('replay-text').textContent = `▶ The scenario is replaying ${rp.label ?? `path ${rp.index + 1}`}: `
        + 'the Field P&L shows that season.';
    }
  }

  _renderWarn() {
    const el = this._q('warn');
    const r = this._store.result;
    const items = [];
    if (r && !this._sameScenario()) items.push('This batch ran on another scenario, so its paths cannot be replayed here. Run the batch again.');
    if (r?.summary?.erroredRuns?.length) items.push(`${r.summary.erroredRuns.length} path(s) threw and are excluded.`);
    el.innerHTML = items.map(t => `<div>⚠ ${_esc(t)}</div>`).join('');
    el.style.display = items.length ? '' : 'none';
  }

  _renderTable() {
    const { summary, farm } = this._store.result;
    this._q('grid').style.display = '';
    this._q('rows').innerHTML = farmMcRows(summary, farm, this._basis).map(r => `
      <tr class="sec-row ${r.level === 'farm' ? 'sec-total-row' : r.level === 'plan' ? 'sec-detail-row' : 'fpl-group-row'}">
        <td class="sec-td sec-name${r.level === 'plan' ? ' sec-detail-name' : ''}">${_esc(r.label)}</td>
        <td class="sec-td sec-td--num ${r.lossProbability > 0 ? 'sec-neg' : ''}">${_pct(r.lossProbability)}</td>
        <td class="sec-td sec-td--num ${_signCls(r.net?.p10)}">${this._money(r.net?.p10)}</td>
        <td class="sec-td sec-td--num ${_signCls(r.net?.p50)}">${this._money(r.net?.p50)}</td>
        <td class="sec-td sec-td--num ${_signCls(r.net?.p90)}">${this._money(r.net?.p90)}</td>
        <td class="sec-td sec-td--num">${_range(r.breakevenUnpricedPrice, _perBu)}</td>
        <td class="sec-td sec-td--num">${_range(r.breakevenYield, (x) => _num(x, 1))}</td>
        <td class="sec-td sec-td--num">${r.scheduleF ? `${this._money(r.scheduleF.p50)} · ${_pct(r.scheduleF.lossProbability)}` : ''}</td>
        <td class="sec-td sec-td--num">${r.insurance ? `${this._money(r.insurance.mean)} · ${_pct(r.insurancePays?.mean)}` : ''}</td>
        <td class="sec-td sec-td--num">${r.arc ? `${this._money(r.arc.mean)} · ${_pct(r.arcPays?.mean)}` : ''}</td>
      </tr>`).join('');
  }

  _renderCharts() {
    const wrap = this._q('charts');
    const { runs } = this._store.result;
    if (!runs?.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    const scopeLabel = this._scopeLabel();
    const fan  = farmCashFan(runs, this._scope);
    const hist = farmNetHistogram(runs, this._scope, this._basis);
    this._q('fan-label').textContent = `${scopeLabel} — cumulative cash net, confidence bands`;
    this._q('hist-label').textContent = `${scopeLabel} — crop-year net (${this._basis === 'actual' ? 'actual machinery' : 'custom rates'}), `
      + `${hist.n} paths, ${_pct(hist.lossProbability)} below \$0`;
    this._q('fan-caption').textContent = fan
      ? 'Cash in and out on the day it moves (before the custom-rate costing charges and before §464(d) and §451(f) '
        + `move income between tax years). Ends ${fan.months.at(-1)} at P50 ${this._money(fan.p50.at(-1))}.`
      : 'These paths carry no cash series.';
    if (!this._canvasAvailable()) return;
    const colors = this._colors();
    const fanHost = this._q('fan');
    const histHost = this._q('hist');
    if (!this._fanChart) {
      this._fanChart  = echarts.init(fanHost, null, { renderer: 'canvas' });
      this._histChart = echarts.init(histHost, null, { renderer: 'canvas' });
      if (typeof ResizeObserver === 'function') {
        this._ro = new ResizeObserver(() => { this._fanChart?.resize(); this._histChart?.resize(); });
        this._ro.observe(fanHost);
      }
    }
    const money = (n) => _moneyK(n);
    if (fan) this._fanChart.setOption(farmFanOption(fan, { colors, money }), true);
    else this._fanChart.clear();
    this._histChart.setOption(farmHistOption(hist, { colors, money }), true);
  }

  _renderPaths() {
    const wrap = this._q('paths');
    const r = this._store.result;
    if (!r?.runs?.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    const paths = farmMcPaths(r.runs, this._scope, this._basis);
    // Every param that varies, not only the sampled keys: a historical yield year is sampled as
    // one draw and lands as the two shocks it stands for (design 134 §17.13).
    const drivers = farmMcDrivers(r.runs, Object.keys(r.runs[0]?.params ?? {}));
    const sampledText = (r.summary?.pairing?.sampled ?? []).map(x => x.key);
    const canReplay = this._sameScenario();
    const reps = farmMcRepresentatives(paths);
    const losses = paths.filter(p => p.net != null && p.net < 0).length;
    this._q('paths-label').textContent = `${this._scopeLabel()} — paths: ${paths.length}, ${losses} losing`;
    this._q('paths').querySelectorAll('th[data-sort]').forEach(th => {
      th.classList.toggle('fmr-sorted', th.dataset.sort === this._sort.key);
      th.dataset.dir = th.dataset.sort === this._sort.key ? (this._sort.dir > 0 ? 'asc' : 'desc') : '';
    });
    const row = (p, tag) => {
      const top = drivers.of(p.index)[0];
      const open = this._expanded.has(p.index) && !tag;
      const main = `
      <tr class="sec-row${tag ? '' : ' fpl-clickable'}${p.net < 0 ? ' fmr-loss' : ''}"${tag ? ' data-rep="' + _esc(tag) + '"' : ` data-path="${p.index}"`}>
        <td class="sec-td">${tag ? `<b>${_esc(tag)}</b> · ` : `${open ? '▾' : '▸'} `}${p.index + 1}</td>
        <td class="sec-td sec-td--num ${_signCls(p.net)}">${this._money(p.net)}</td>
        <td class="sec-td sec-td--num">${this._money(p.revenue)}</td>
        <td class="sec-td sec-td--num">${_perBu(p.breakevenUnpricedPrice)}</td>
        <td class="sec-td sec-td--muted">${top ? `${_esc(r.labels?.[top.key] ?? top.key)} ${_z(top.z)}` : '—'}</td>
        <td class="sec-td"><button class="btn btn-sm" data-replay="${p.index}" ${canReplay ? '' : 'disabled'}
          title="Write this path onto the scenario, rebuild, run the season and open the Field P&L">&#9654; Replay</button></td>
      </tr>`;
      if (!open) return main;
      const ds = drivers.of(p.index);
      const drawn = sampledText.map(k => [k, r.runs[p.index].params?.[k]]).filter(([, v]) => typeof v === 'string');
      return main + `
      <tr class="sec-detail-row"><td class="sec-td" colspan="6">
        ${drawn.map(([k, v]) => `<div class="fmr-drawn">${_esc(r.labels?.[k] ?? k)}: <b>${_esc(v)}</b></div>`).join('')}
        ${ds.length ? `<table class="sec-grid fmr-drivers"><thead><tr>
          <th class="sec-th">Drawn value</th><th class="sec-th sec-th--num">This path</th>
          <th class="sec-th sec-th--num">Batch median</th><th class="sec-th sec-th--num" title="(this path − median) ÷ the batch's standard deviation">From median</th>
        </tr></thead><tbody>${ds.map(d => `<tr class="sec-row">
          <td class="sec-td" title="${_esc(d.key)}">${_esc(r.labels?.[d.key] ?? d.key)}</td>
          <td class="sec-td sec-td--num">${_num(d.value)}</td>
          <td class="sec-td sec-td--num">${_num(d.median)}</td>
          <td class="sec-td sec-td--num">${_z(d.z)}</td></tr>`).join('')}</tbody></table>`
          : '<span class="sec-td--muted">This batch sampled nothing that varies, so every path is the same season.</span>'}
      </td></tr>`;
    };
    this._q('rep-rows').innerHTML = reps.map(x => row(paths.find(p => p.index === x.index), x.label)).join('');
    const list = farmMcSortPaths(paths.filter(p => !this._lossesOnly || (p.net != null && p.net < 0)), this._sort);
    this._q('path-rows').innerHTML = list.map(p => row(p, null)).join('');
  }

  _colors() {
    const c = (name, fallback) => {
      const v = typeof document !== 'undefined' ? readThemeColor(name) : '';
      return /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
    };
    return {
      band: c('--blue-muted', '#60a5fa'), red: c('--red', '#ff4455'), dim: c('--text-dim', '#94a3b8'),
      border: c('--border', '#334155'), borderHi: c('--border-hi', '#475569'), text: c('--text-primary', '#e2e8f0'),
      muted: c('--text-muted', '#64748b'), panel: c('--bg-panel2', '#1e293b'),
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

  _setStatus(text) { const s = this._q('status'); if (s) s.textContent = text; }

  _downloadCsv() {
    const r = this._store.result;
    if (!r) return;
    const blob = new Blob([withBom(farmMcCsv(r.summary))], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `farm-mc-${r.farm.season.cropYear}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  _money(n) {
    if (n == null) return '—';
    const formatted = this._services()?.schemaRegistry?.formatAmount?.(n, 'USD', { maximumFractionDigits: 0 });
    if (formatted != null) return formatted;
    return `${n < 0 ? '-' : ''}$${Math.abs(Math.round(n)).toLocaleString()}`;
  }

  _q(name) { return this.el?.querySelector(`[data-fmr="${name}"]`) ?? null; }
}

// ─── The paths (design 134 §17.12) ───────────────────────────────────────────────

/**
 * One row per path for a scope and basis: its index in the batch, seed, net, revenue and the
 * breakeven its unpriced bushels must fetch.
 *
 * @returns {{ index, seed, net, revenue, breakevenUnpricedPrice }[]} in batch order
 */
export function farmMcPaths(runs, scope, basis = 'custom') {
  return (runs ?? []).map((r, index) => ({
    index, seed: r.seed ?? null,
    net:     r.metrics?.[`${scope}.net.${basis}`] ?? null,
    revenue: r.metrics?.[`${scope}.revenue`] ?? null,
    breakevenUnpricedPrice: r.metrics?.[`${scope}.breakevenUnpricedPrice.${basis}`] ?? null,
  }));
}

/**
 * The representative paths by net: the worst, the 10th percentile, the median, the 90th and the
 * best. Each is a real path (the one at that rank), never an interpolation, so it can be
 * replayed. A path that holds two ranks in a small batch is listed once, at the first.
 *
 * @returns {{ label: string, index: number }[]}
 */
export function farmMcRepresentatives(paths) {
  const ranked = paths.filter(p => p.net != null && Number.isFinite(p.net))
    .sort((a, b) => a.net - b.net || a.index - b.index);
  if (!ranked.length) return [];
  const at = (q) => ranked[Math.round(q * (ranked.length - 1))].index;
  const out = [];
  for (const [label, q] of [['Worst', 0], ['P10', 0.1], ['Median', 0.5], ['P90', 0.9], ['Best', 1]]) {
    const index = at(q);
    if (!out.some(x => x.index === index)) out.push({ label, index });
  }
  return out;
}

/** The paths sorted on one column (`dir` 1 ascending, -1 descending), a missing value last. */
export function farmMcSortPaths(paths, { key = 'net', dir = 1 } = {}) {
  return [...paths].sort((a, b) => {
    const x = a[key], y = b[key];
    if (x == null && y == null) return a.index - b.index;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x - y) * dir || a.index - b.index;
  });
}

/**
 * What each path drew, against the batch: for every sampled key that varies across the paths,
 * the batch median and standard deviation, and per path the value and its distance from the
 * median in standard deviations. A key every path drew the same (a spread of 0) says nothing
 * and is left out.
 *
 * @param {object[]} runs the batch's paths (`params`)
 * @param {string[]} keys the sampled keys (`summary.pairing.sampled`)
 * @returns {{ stats: Map<string, { median: number, sd: number }>,
 *   of: (index: number) => { key, value, median, sd, z }[] }} `of` ranks by |z|, largest first
 */
export function farmMcDrivers(runs, keys) {
  const stats = new Map();
  for (const key of keys ?? []) {
    const xs = (runs ?? []).map(r => r.params?.[key]).filter(x => typeof x === 'number' && Number.isFinite(x));
    if (xs.length < 2) continue;
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    if (!(sd > 0)) continue;
    const sorted = [...xs].sort((a, b) => a - b);
    stats.set(key, { median: _quantile(sorted, 0.5), sd });
  }
  return {
    stats,
    of(index) {
      const p = runs?.[index]?.params ?? {};
      return [...stats].filter(([k]) => typeof p[k] === 'number')
        .map(([key, s]) => ({ key, value: p[key], median: s.median, sd: s.sd, z: (p[key] - s.median) / s.sd }))
        .sort((a, b) => Math.abs(b.z) - Math.abs(a.z) || (a.key < b.key ? -1 : 1));
    },
  };
}

const _z = (z) => (z == null || !Number.isFinite(z) ? '' : `${z >= 0 ? '+' : '−'}${Math.abs(z).toFixed(1)}σ`);

// ─── Pure helpers (tested without a DOM) ─────────────────────────────────────────

/**
 * The results table: the whole farm, then each operator with its crop plans beneath it, then
 * each crop. Every row carries its net's distribution and loss probability on `basis`, and its
 * breakevens' distribution; an operator row also its Schedule F net.
 *
 * @param {object} summary `FarmMcRunner.run().summary`
 * @param {object} farm normalized farm (labels, and which plans are an operator's)
 * @param {'custom'|'actual'} [basis='custom']
 * @returns {{ level: 'farm'|'operator'|'plan'|'crop', key: string, label: string, net: object|null,
 *   lossProbability: number|null, breakevenUnpricedPrice: object|null, breakevenYield: object|null,
 *   scheduleF: object|null, insurance: object|null, insurancePays: object|null,
 *   arc: object|null, arcPays: object|null }[]}
 */
export function farmMcRows(summary, farm, basis = 'custom') {
  const m = summary?.metrics ?? {};
  const row = (level, scope, label) => {
    const net = m[`${scope}.net.${basis}`] ?? null;
    return {
      level, key: scope, label,
      net, lossProbability: net?.lossProbability ?? null,
      breakevenUnpricedPrice: m[`${scope}.breakevenUnpricedPrice.${basis}`] ?? null,
      breakevenYield:         m[`${scope}.breakevenYield.${basis}`] ?? null,
      scheduleF: level === 'operator' ? (m[`${scope}.scheduleF`] ?? null) : null,
      insurance:     m[`${scope}.insurance`] ?? null,
      insurancePays: m[`${scope}.insurancePays`] ?? null,
      arc:           m[`${scope}.arc`] ?? null,
      arcPays:       m[`${scope}.arcPays`] ?? null,
    };
  };
  const fieldOf = new Map(farm.fields.map(f => [f.id, f]));
  const out = [row('farm', 'farm', 'Whole farm')];
  for (const o of farm.operators) {
    out.push(row('operator', `operator.${o.id}`, o.name ?? o.id));
    for (const p of farm.cropPlans.filter(x => fieldOf.get(x.fieldId)?.operatorId === o.id)) {
      const f = fieldOf.get(p.fieldId);
      out.push(row('plan', `plan.${p.id}`, `${f.name ?? f.id} · ${CROPS[p.crop]?.label ?? p.crop}`));
    }
  }
  for (const c of [...new Set(farm.cropPlans.map(p => p.crop))]) out.push(row('crop', `crop.${c}`, CROPS[c]?.label ?? c));
  return out.filter(r => r.net != null);
}

/**
 * The cash-net fan for one scope: P10/P25/P50/P75/P90 of the paths' cumulative cash net at
 * each month end. Months before the first cash movement of any path, and after the last, are
 * trimmed: they are the flat ends of the season window.
 *
 * @param {Array<{ cashSeries?: { months: string[], series: Record<string, number[]> } }>} runs
 * @param {string} scope `farm` or `operator.<id>`
 * @returns {{ months: string[], p10: number[], p25: number[], p50: number[], p75: number[], p90: number[] }|null}
 *   null when no path carries the scope's series
 */
export function farmCashFan(runs, scope) {
  const paths = (runs ?? []).map(r => r.cashSeries).filter(c => c?.series?.[scope]);
  if (!paths.length) return null;
  const months = paths[0].months;
  const cols = months.map((_, i) => paths.map(c => c.series[scope][i]).sort((a, b) => a - b));
  let first = 0;
  while (first < months.length && cols[first].every(v => v === 0)) first++;
  let last = months.length - 1;
  const same = (a, b) => a.every((v, j) => v === b[j]);
  while (last > first && same(cols[last], cols[last - 1])) last--;
  // One flat month before the first movement shows the season start at 0.
  const from = Math.max(0, first - 1);
  const out = { months: months.slice(from, last + 1), p10: [], p25: [], p50: [], p75: [], p90: [] };
  for (const col of cols.slice(from, last + 1)) {
    out.p10.push(_quantile(col, 0.10)); out.p25.push(_quantile(col, 0.25)); out.p50.push(_quantile(col, 0.50));
    out.p75.push(_quantile(col, 0.75)); out.p90.push(_quantile(col, 0.90));
  }
  return out;
}

/**
 * The crop-year net's histogram for one scope, on `basis`: equal-width buckets, each flagged
 * when it lies below \$0 (its lower edge is negative).
 *
 * @returns {{ n: number, lossProbability: number|null, edges: number[], counts: number[] }}
 *   `edges` has one more entry than `counts`
 */
export function farmNetHistogram(runs, scope, basis = 'custom', buckets = 24) {
  const xs = (runs ?? []).map(r => r.metrics?.[`${scope}.net.${basis}`]).filter(x => x != null && Number.isFinite(x));
  if (!xs.length) return { n: 0, lossProbability: null, edges: [], counts: [] };
  const lo = Math.min(...xs), hi = Math.max(...xs);
  const k = lo === hi ? 1 : buckets;
  const w = (hi - lo) / k || 1;
  const edges = Array.from({ length: k + 1 }, (_, i) => lo + i * w);
  const counts = new Array(k).fill(0);
  for (const x of xs) counts[Math.min(k - 1, Math.floor((x - lo) / w))]++;
  return { n: xs.length, lossProbability: xs.filter(x => x < 0).length / xs.length, edges, counts };
}

/** ECharts option for the cash fan, drawn as the retirement MC panel's fan is. */
export function farmFanOption(fan, { colors, money }) {
  const { months, p10, p25, p50, p75, p90 } = fan;
  // Each band is a hidden base (P10, P25) with the band's height stacked on it. ECharts'
  // default stackStrategy 'samesign' stacks positive and negative values apart, so a positive
  // height over a negative base was stacked on $0 and the band never went below zero; 'all'
  // stacks every value on the one before it.
  const base = {
    type: 'line', symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 },
    emphasis: { disabled: true }, tooltip: { show: false }, stackStrategy: 'all',
  };
  const diff = (hi, lo) => hi.map((v, i) => v - lo[i]);
  return {
    backgroundColor: 'transparent',
    animation: false,
    grid: { top: 16, right: 16, bottom: 28, left: 16, containLabel: true },
    xAxis: {
      type: 'category', data: months, boundaryGap: false,
      axisLabel: { color: colors.dim, fontSize: 10, fontFamily: 'monospace' },
      axisLine: { lineStyle: { color: colors.border } }, axisTick: { lineStyle: { color: colors.border } },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: colors.dim, fontSize: 10, fontFamily: 'monospace', formatter: money },
      splitLine: { lineStyle: { color: colors.border } },
    },
    tooltip: {
      trigger: 'axis', backgroundColor: colors.panel, borderColor: colors.borderHi, borderWidth: 1,
      textStyle: { color: colors.text, fontSize: 10, fontFamily: 'monospace' },
      formatter: (params) => {
        const i = params[0]?.dataIndex;
        if (i == null) return '';
        return `<span style="color:${colors.muted}">${months[i]}</span><br/>`
          + `P90: <b>${money(p90[i])}</b><br/>P75: <b>${money(p75[i])}</b><br/>P50: <b>${money(p50[i])}</b><br/>`
          + `P25: <b>${money(p25[i])}</b><br/>P10: <b>${money(p10[i])}</b>`;
      },
    },
    series: [
      { ...base, id: 'outer-base', data: p10, stack: 'outer' },
      { ...base, id: 'outer-fill', data: diff(p90, p10), stack: 'outer', areaStyle: { color: colors.band + '17', opacity: 1 } },
      { ...base, id: 'inner-base', data: p25, stack: 'inner' },
      { ...base, id: 'inner-fill', data: diff(p75, p25), stack: 'inner', areaStyle: { color: colors.band + '29', opacity: 1 } },
      { id: 'p90-line', type: 'line', data: p90, symbol: 'none', lineStyle: { color: colors.band + '47', width: 1 }, tooltip: { show: false } },
      { id: 'p10-line', type: 'line', data: p10, symbol: 'none', lineStyle: { color: colors.band + '47', width: 1 }, tooltip: { show: false } },
      { id: 'p50', name: 'Median (P50)', type: 'line', data: p50, symbol: 'none', lineStyle: { color: colors.band, width: 2.5 },
        markLine: { silent: true, symbol: 'none', data: [{ yAxis: 0 }], lineStyle: { color: colors.muted, type: 'dashed', width: 1 }, label: { show: false } } },
    ],
  };
}

/** ECharts option for the net histogram: losing buckets red, as the retirement panel's are. */
export function farmHistOption(hist, { colors, money }) {
  const labels = hist.counts.map((_, i) => money(hist.edges[i]));
  return {
    backgroundColor: 'transparent',
    animation: false,
    grid: { top: 10, right: 16, bottom: 48, left: 16, containLabel: true },
    xAxis: {
      type: 'category', data: labels,
      axisLabel: { color: colors.dim, fontSize: 9, fontFamily: 'monospace', rotate: 45,
        interval: Math.max(0, Math.floor(labels.length / 10) - 1) },
      axisLine: { lineStyle: { color: colors.border } }, axisTick: { lineStyle: { color: colors.border } },
    },
    yAxis: {
      type: 'value', minInterval: 1,
      axisLabel: { color: colors.dim, fontSize: 10, fontFamily: 'monospace' },
      splitLine: { lineStyle: { color: colors.border } },
    },
    tooltip: {
      trigger: 'axis', backgroundColor: colors.panel, borderColor: colors.borderHi, borderWidth: 1,
      textStyle: { color: colors.text, fontSize: 10, fontFamily: 'monospace' },
      formatter: (params) => {
        const i = params[0]?.dataIndex;
        if (i == null) return '';
        const c = hist.counts[i];
        return `${money(hist.edges[i])} – ${money(hist.edges[i + 1])}: <b>${c} path${c === 1 ? '' : 's'}</b>`;
      },
    },
    series: [{
      type: 'bar', barMaxWidth: 40, itemStyle: { borderRadius: [2, 2, 0, 0] },
      data: hist.counts.map((v, i) => ({ value: v, itemStyle: { color: (hist.edges[i] < 0 ? colors.red : colors.band) + 'bf' } })),
    }],
  };
}

function _quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function _moneyK(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n), sign = n < 0 ? '-' : '';
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
  return `${sign}$${Math.round(a)}`;
}

/** Every metric's distribution as CSV: one row per metric key. */
export function farmMcCsv(summary) {
  const cols = ['metric', 'n', 'mean', 'p10', 'p50', 'p90', 'min', 'max', 'lossProbability'];
  const cell = (v) => (v == null ? '' : String(typeof v === 'number' ? +v.toFixed(6) : v));
  const rows = Object.entries(summary?.metrics ?? {}).map(([k, s]) => [k, ...cols.slice(1).map(c => s[c])].map(cell).join(','));
  return [cols.join(','), ...rows].join('\n');
}

const _pct = (x) => (x == null ? '—' : `${(100 * x).toFixed(1)}%`);
const _perBu = (n) => (n == null ? '—' : `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`);
const _num = (n, d) => (n == null || !Number.isFinite(n) ? '—'
  : (d == null ? String(+n.toPrecision(6)) : n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })));
const _range = (s, fmt) => (s?.p10 == null ? '—' : (s.p10 === s.p90 ? fmt(s.p50) : `${fmt(s.p10)} – ${fmt(s.p90)}`));

function _signCls(n) {
  if (n == null || n === 0) return '';
  return n > 0 ? 'sec-pos' : 'sec-neg';
}

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
