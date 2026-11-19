/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { WorkbenchComponent } from '../../component.js';
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
 * A run bar (paths, Run, the machinery basis), the VARIABLES the batch samples, and the
 * RESULTS: farm, operators, crops and crop plans, each with its loss probability, its net at
 * p10 / p50 / p90 and its breakevens' spread.
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
    this._result   = null;           // { summary, farm, source }
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
        <label title="Number of sampled seasons">paths <input type="number" min="1" max="20000" step="1" data-fmc="n" style="width:6em"></label>
        <button data-fmc="run" title="Run the batch on the active farm scenario">&#9654; Run</button>
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
          </tr></thead>
          <tbody data-fmc="rows"></tbody>
        </table>
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

  onActivate() { this._render(); }

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
      const { summary } = await runner.run({}, (done, total) => this._setStatus(`running… ${done} / ${total}`));
      this._result = { summary, farm: normalizeFarm(cat.cfg.farm) };
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
          : `<input type="number" min="0" step="any" value="${s.stdDev ?? 0}" style="width:7em" aria-label="Spread of ${_esc(v.label ?? v.paramKey)}">`}${v.skew
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
      </tr>`).join('');
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
 *   scheduleF: object|null, insurance: object|null, insurancePays: object|null }[]}
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

/** Every metric's distribution as CSV: one row per metric key. */
export function farmMcCsv(summary) {
  const cols = ['metric', 'n', 'mean', 'p10', 'p50', 'p90', 'min', 'max', 'lossProbability'];
  const cell = (v) => (v == null ? '' : String(typeof v === 'number' ? +v.toFixed(6) : v));
  const rows = Object.entries(summary?.metrics ?? {}).map(([k, s]) => [k, ...cols.slice(1).map(c => s[c])].map(cell).join(','));
  return [cols.join(','), ...rows].join('\n');
}

const _pct = (x) => (x == null ? '—' : `${(100 * x).toFixed(1)}%`);
const _perBu = (n) => (n == null ? '—' : `$${n.toFixed(2)}`);
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
