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
import { ServiceRegistry }    from '../../../../services/service-registry.js';
import { withBom }            from '../../../../utils/csv.js';
import { normalizeFarm, CROPS } from '../../../../finance/farm/farm-records.js';
import { FarmMcRunner, FarmMcConfig, calibratedPriceVolFor } from '../../../../finance/farm/farm-mc.js';

/**
 * FarmMcPlugin — Monte Carlo over the active farm season (design 134 phase 2, step 2f).
 *
 * The farm gets its own results panel rather than bending the retirement one (§4): a
 * retirement batch answers "does the money last", a farm batch "how likely is each field to
 * lose money, and how wide are its breakevens".
 *
 * ─── layout ──────────────────────────────────────────────────────────────────────
 *
 * A run bar (paths, Run, the machinery basis), the RESULTS once a batch has run, and the
 * VARIABLES the batch samples beneath them (they are a long table, and after a run the results
 * are what is read). The results are two charts for one scope (the whole farm or an
 * operator), then the table of farm, operators, crops and crop plans, each with its loss
 * probability, its net at p10 / p50 / p90 and its breakevens' spread.
 *
 * The charts follow the retirement MC panel's: a fan of the cumulative CASH net month by
 * month through the season window (P10–P90 and P25–P75 bands, the P50 line), and a histogram
 * of the crop-year job-cost net with the losing paths in red. The fan is cash, so it is before
 * the custom-rate costing charges and before §464(d)/§451(f) move income between tax years;
 * the histogram is the table's net, on the machinery basis the switch picks.
 *
 * The variables are a typed table, one row per catalog variable: a switch and its spread.
 * The farm-wide yield shocks and the price paths are calibrated from USDA NASS history (§13.8);
 * the rest of the catalog's spreads are 0, because no source on disk sets them, so a
 * row switched on draws nothing until a spread is typed; the panel says so rather than
 * running a batch of identical paths without comment.
 *
 * Runs on the worker pool where the browser has one, serially otherwise; the two are
 * bit-identical (tests/unit/farm-mc.test.mjs).
 */
export class FarmMcPlugin extends WorkbenchComponent {
  constructor(runtime) {
    super();
    this._runtime = runtime;
    this._servicesOverride = null;   // tests
    this._cfgOverride      = null;   // tests
    this._parallel = true;
    this._n        = 200;
    this._basis    = 'custom';
    this._settings = new Map();      // paramKey → { enabled, stdDev }
    this._result   = null;           // { summary, runs, farm }
    this._scope    = 'farm';         // 'farm' | 'operator.<id>': what the charts show
    this._fanChart  = null;
    this._histChart = null;
    this._ro        = null;
    this._running  = false;
    this._error    = null;
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
        <label class="fmc-n-label" title="Number of sampled seasons">Paths
          <input type="number" class="mc-iters-input fmc-n-input" min="1" max="20000" step="1" data-fmc="n"></label>
        <button class="btn btn-primary btn-sm" data-fmc="run" title="Run the batch on the active farm scenario">&#9654; Run</button>
        <span class="bond-seg" data-fmc="basis" title="Machinery in the nets: custom-hire rates, or the operator's real machinery cost (design 134 §5.3)">
          <button data-v="custom" class="on">custom rates</button><button data-v="actual">actual machinery</button>
        </span>
        <span class="sec-spacer"></span>
        <span class="sec-asof" data-fmc="status">—</span>
        <button class="sec-csv-btn" data-fmc="csv" title="Download the results as CSV">&#11015; CSV</button>
      </div>
      <div class="sec-body" data-fmc="body">
        <div class="bond-warn" data-fmc="warn" style="display:none"></div>
        <div class="sec-placeholder" data-fmc="placeholder">—</div>
        <div class="fmc-charts" data-fmc="charts" style="display:none">
          <div class="fmc-chart-head">
            <span class="mc-section-label" data-fmc="fan-label">Cumulative cash net — confidence bands</span>
            <span class="bond-seg" data-fmc="scope" title="Which scope the charts show"></span>
          </div>
          <div class="mc-fan-wrap"><div class="mc-chart-fill" data-fmc="fan"></div></div>
          <div class="bond-caption" data-fmc="fan-caption"></div>
          <div class="mc-section-label" data-fmc="hist-label">Crop-year net — distribution</div>
          <div class="mc-hist-wrap"><div class="mc-chart-fill" data-fmc="hist"></div></div>
        </div>
        <table class="sec-grid" data-fmc="grid" style="display:none">
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
          <tbody data-fmc="rows"></tbody>
        </table>
        <details data-fmc="vars-box" open>
          <summary>Variables <span class="sec-td--muted" data-fmc="vars-count"></span></summary>
          <table class="sec-grid" data-fmc="vars">
            <thead><tr>
              <th class="sec-th">Sample</th><th class="sec-th">Variable</th><th class="sec-th">Group</th>
              <th class="sec-th sec-th--num" title="The record's value: the centre every draw is around">Centre</th>
              <th class="sec-th sec-th--num" title="Standard deviation of the draw. 0 draws nothing.">Spread (sd)</th>
            </tr></thead>
            <tbody data-fmc="var-rows"></tbody>
          </table>
        </details>
      </div>
    `;
    return root;
  }

  onMount() {
    const n = this._q('n');
    if (n && !n._fmcBound) {
      n.value = String(this._n);
      n.addEventListener('change', () => { this._n = Math.max(1, Math.round(Number(n.value) || 1)); n.value = String(this._n); });
      n._fmcBound = true;
    }
    const run = this._q('run');
    if (run && !run._fmcBound) { run.addEventListener('click', () => { this.run(); }); run._fmcBound = true; }
    const csv = this._q('csv');
    if (csv && !csv._fmcBound) { csv.addEventListener('click', () => this._downloadCsv()); csv._fmcBound = true; }
    const basis = this._q('basis');
    if (basis && !basis._fmcBound) {
      basis.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-v]');
        if (!btn) return;
        this._basis = btn.dataset.v;
        basis.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === btn));
        this._renderResults();
      });
      basis._fmcBound = true;
    }
    const scope = this._q('scope');
    if (scope && !scope._fmcBound) {
      scope.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-v]');
        if (!btn) return;
        this._scope = btn.dataset.v;
        this._renderCharts();
      });
      scope._fmcBound = true;
    }
    const vars = this._q('var-rows');
    if (vars && !vars._fmcBound) {
      // Delegated: the rows are rebuilt whenever the scenario changes.
      vars.addEventListener('change', (e) => {
        const tr = e.target.closest('tr[data-key]');
        if (!tr) return;
        const key = tr.dataset.key;
        const s = this._settings.get(key) ?? {};
        if (e.target.matches('input[type="checkbox"]')) s.enabled = e.target.checked;
        if (e.target.matches('input[type="number"]')) s.stdDev = Math.max(0, Number(e.target.value) || 0);
        this._settings.set(key, s);
        this._renderWarn();
      });
      vars._fmcBound = true;
    }
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

  // ─── Data ────────────────────────────────────────────────────────────────

  /** The catalog for the active scenario, or `{ reason }`. */
  _catalog() {
    const cfg = this._cfg();
    if (!cfg?.farm) return { reason: 'This scenario has no farm records. Farm MC runs a farm scenario (US Farm).' };
    try {
      const { ctx } = new FarmMcRunner({ cfgTemplate: cfg })._prepare();
      return { cfg, variables: ctx.variables };
    } catch (e) {
      return { reason: `The farm cannot be sampled: ${e.message}` };
    }
  }

  /** The catalog with this panel's switches and spreads applied. */
  _mcConfig() {
    const m = new FarmMcConfig();
    for (const [k, s] of this._settings) m.applyOverride(k, { ...s, centerDirty: false });
    return m;
  }

  /** Run the batch. Resolves when the results are rendered. */
  async run() {
    if (this._running) return;
    const cat = this._catalog();
    if (cat.reason) { this._error = cat.reason; this._render(); return; }
    this._running = true;
    this._error = null;
    this._setStatus('running…');
    try {
      const runner = new FarmMcRunner({
        n: this._n, cfgTemplate: cat.cfg, mcConfig: this._mcConfig(), parallel: this._parallel,
      });
      const { summary, runs } = await runner.run({}, (done, total) => this._setStatus(`running… ${done} / ${total}`));
      this._result = { summary, runs, farm: normalizeFarm(cat.cfg.farm) };
      if (this._scope !== 'farm' && !this._result.farm.operators.some(o => `operator.${o.id}` === this._scope)) this._scope = 'farm';
    } catch (e) {
      this._error = `The batch failed: ${e.message}`;
      this._result = null;
    } finally {
      this._running = false;
    }
    this._render();
  }

  // ─── Rendering ───────────────────────────────────────────────────────────

  _render() {
    if (!this._mounted) return;
    const cat = this._catalog();
    const ph = this._q('placeholder');
    if (cat.reason) {
      ph.textContent = cat.reason; ph.style.display = '';
      this._q('vars-box').style.display = 'none';
      this._q('grid').style.display = 'none';
      this._q('charts').style.display = 'none';
      this._renderWarn();
      this._setStatus('—');
      return;
    }
    this._q('vars-box').style.display = '';
    this._renderVariables(cat.variables);
    this._renderWarn(cat.variables);
    this._renderResults();
  }

  _renderVariables(variables) {
    const sampled = variables.filter(v => this._setting(v).enabled).length;
    this._q('vars-count').textContent = `(${sampled} of ${variables.length} sampled)`;
    this._q('var-rows').innerHTML = variables.map(v => {
      const s = this._setting(v);
      return `
      <tr data-key="${_esc(v.paramKey)}" class="sec-row">
        <td class="sec-td"><input type="checkbox" ${s.enabled ? 'checked' : ''} aria-label="Sample ${_esc(v.label ?? v.paramKey)}"></td>
        <td class="sec-td" title="${_esc(v.paramKey)}">${_esc(v.label ?? v.paramKey)}</td>
        <td class="sec-td sec-td--muted">${_esc(v.group ?? '')}</td>
        <td class="sec-td sec-td--num">${_num(v.mean)}</td>
        <td class="sec-td sec-td--num">${v.fixedSpread
          ? `<span class="sec-td--muted" title="A unit normal draw: its scale is the season's price volatility for this crop">z</span>`
          : `<input type="number" class="mc-num-input fmc-spread-input" min="0" step="any" value="${s.stdDev ?? 0}" aria-label="Spread of ${_esc(v.label ?? v.paramKey)}">`}${v.skew
          ? ` <span class="sec-td--muted" title="Skew-normal: a bad year falls further below than a good one rises above (design 134 §13.8)">skew ${v.skew}</span>` : ''}</td>
      </tr>`;
    }).join('');
  }

  /** A variable's switch and spread: this panel's setting, else the catalog's. */
  _setting(v) {
    const s = this._settings.get(v.paramKey) ?? {};
    return { enabled: s.enabled ?? v.enabled, stdDev: s.stdDev ?? v.stdDev };
  }

  _renderWarn(variables = this._catalog().variables ?? []) {
    const el = this._q('warn');
    if (!el) return;
    const items = [];   // [icon, text]
    if (this._error) items.push(['⚠', _esc(this._error)]);
    const on = variables.filter(v => this._setting(v).enabled);
    const flat = on.filter(v => !v.fixedSpread && !(this._setting(v).stdDev > 0));
    if (on.length === 0) items.push(['⚠', 'Nothing is sampled, so every path is the deterministic season. Switch variables on.']);
    else if (flat.length) items.push(['⚠', `${flat.length} sampled variable${flat.length === 1 ? ' has' : 's have'} a spread of 0 and draw${flat.length === 1 ? 's' : ''} nothing.`]);
    // A spread is calibrated only where the catalog says so and it has not been retyped.
    const typed = on.filter(v => !v.fixedSpread && this._setting(v).stdDev > 0
      && !(v.calibrated && this._setting(v).stdDev === v.stdDev));
    if (typed.length) {
      items.push(['⚠', `${typed.length} sampled spread${typed.length === 1 ? ' is' : 's are'} typed here, not calibrated from a source `
        + '(design 134 §13.8): read the results as a sensitivity run on '
        + `${typed.length === 1 ? 'it' : 'them'}.`]);
    }
    const filled = calibratedPriceVolFor(this._cfg(), on.map(v => ({ ...v, enabled: true })));
    if (Object.keys(filled).length) {
      items.push(['ℹ', `Prices of ${_esc(Object.entries(filled).map(([c, v]) => `${CROPS[c]?.label ?? c} (${v})`).join(', '))} `
        + 'move at the calibrated volatility (USDA NASS, Nebraska): the season sets none of its own.']);
    }
    if (this._result?.summary?.erroredRuns?.length) items.push(['⚠', `${this._result.summary.erroredRuns.length} path(s) threw and are excluded.`]);
    el.innerHTML = items.map(([icon, text]) => `<div>${icon} ${text}</div>`).join('');
    el.style.display = items.length ? '' : 'none';
  }

  _renderResults() {
    const grid = this._q('grid');
    const ph = this._q('placeholder');
    if (!this._result) {
      grid.style.display = 'none';
      this._q('charts').style.display = 'none';
      ph.textContent = this._running ? 'Running…' : 'Pick the variables to sample, then Run.';
      ph.style.display = '';
      if (!this._running) this._setStatus('—');
      return;
    }
    ph.style.display = 'none';
    grid.style.display = '';
    const { summary, farm } = this._result;
    this._setStatus(`${summary.n} paths · crop year ${farm.season.cropYear}`);
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
    this._renderCharts();
  }

  // ─── Charts ──────────────────────────────────────────────────────────────

  _renderCharts() {
    const wrap = this._q('charts');
    if (!wrap) return;
    if (!this._result?.runs?.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    const { runs, farm } = this._result;
    const scopes = [['farm', 'Whole farm'], ...farm.operators.map(o => [`operator.${o.id}`, o.name ?? o.id])];
    this._q('scope').innerHTML = scopes.map(([v, label]) =>
      `<button data-v="${_esc(v)}" class="${v === this._scope ? 'on' : ''}">${_esc(label)}</button>`).join('');
    const scopeLabel = scopes.find(([v]) => v === this._scope)?.[1] ?? '';
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

  // ─── CSV ─────────────────────────────────────────────────────────────────

  _downloadCsv() {
    if (!this._result) return;
    const blob = new Blob([withBom(farmMcCsv(this._result.summary))], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `farm-mc-${this._result.farm.season.cropYear}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  _money(n) {
    if (n == null) return '—';
    const formatted = this._services()?.schemaRegistry?.formatAmount?.(n, 'USD', { maximumFractionDigits: 0 });
    if (formatted != null) return formatted;
    return `${n < 0 ? '-' : ''}$${Math.abs(Math.round(n)).toLocaleString()}`;
  }

  _q(name) { return this.el?.querySelector(`[data-fmc="${name}"]`) ?? null; }
}

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
