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
import { WB_EVENTS }          from '../../workbench-runtime.js';
import { ServiceRegistry }    from '../../../../services/service-registry.js';
import { normalizeFarm, CROPS } from '../../../../finance/farm/farm-records.js';
import { FarmMcRunner, FarmMcConfig, calibratedPriceVolFor } from '../../../../finance/farm/farm-mc.js';
import { farmMcStore }        from './farm-mc-store.js';
import { decorateSweepRows }  from '../../../help/sweep-row-help.js';

// The results moved to the Farm MC Results panel (design 134 §17.12); their helpers are
// exported from here too, so an import of them from this module keeps working.
export { farmMcRows, farmMcCsv, farmCashFan, farmNetHistogram, farmFanOption, farmHistOption }
  from './farm-mc-results-plugin.js';

/**
 * FarmMcPlugin — Monte Carlo over the active farm season (design 134 phase 2, step 2f).
 *
 * The farm gets its own Monte Carlo panels rather than bending the retirement ones (§4): a
 * retirement batch answers "does the money last", a farm batch "how likely is each field to
 * lose money, and how wide are its breakevens".
 *
 * This panel SETS UP AND RUNS the batch, as the Monte Carlo panel does for a retirement plan:
 * a run bar (paths, Run) over the VARIABLES the batch samples, a typed table, one row per
 * catalog variable, with a switch and its spread. The farm-wide yield shocks and the price
 * paths are calibrated from USDA NASS history (§13.8); the rest of the catalog's spreads are
 * 0, because no source on disk sets them, so a row switched on draws nothing until a spread is
 * typed; the panel says so rather than running a batch of identical paths without comment.
 *
 * The batch goes to the runtime's farm MC store, and Farm MC Results opens to show it
 * (design 134 §17.12): the distribution, the paths, and Replay.
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
    this._settings = new Map();      // paramKey → { enabled, stdDev }
    this._store    = farmMcStore(runtime);
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
        <span class="sec-spacer"></span>
        <span class="sec-asof" data-fmc="status">—</span>
        <button class="btn btn-sm" data-fmc="open" style="display:none" title="Show the last batch's distribution and paths">Results &#8594;</button>
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
    const open = this._q('open');
    if (open && !open._fmcBound) { open.addEventListener('click', () => this._openResults()); open._fmcBound = true; }
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
      const { summary, runs } = await runner.run({}, (done, total) => this._setStatus(`running… ${done} / ${total}`));
      const labels = Object.fromEntries(cat.variables.map(v => [v.paramKey, v.label ?? v.paramKey]));
      this._running = false;
      this._store.setResult({ summary, runs, farm: normalizeFarm(cat.cfg.farm), labels, scenarioId: cat.cfg.id ?? null });
      this._render();
      this._openResults();
      return;
    } catch (e) {
      this._error = `The batch failed: ${e.message}`;
    } finally {
      this._running = false;
    }
    this._render();
  }

  _openResults() { this._runtime?.bus?.publish?.({ type: WB_EVENTS.PANEL_OPEN, id: 'farm-mc-results' }); }

  // ─── Rendering ───────────────────────────────────────────────────────────

  _render() {
    if (!this._mounted) return;
    const cat = this._catalog();
    const ph = this._q('placeholder');
    if (cat.reason) {
      ph.textContent = cat.reason; ph.style.display = '';
      this._q('vars-box').style.display = 'none';
      this._q('open').style.display = 'none';
      this._renderWarn();
      this._setStatus('—');
      return;
    }
    this._q('vars-box').style.display = '';
    this._renderVariables(cat.variables);
    this._renderWarn(cat.variables);
    ph.style.display = 'none';
    const r = this._store.result;
    const mine = r && (r.scenarioId ?? null) === (cat.cfg.id ?? null);
    this._q('open').style.display = mine && !this._running ? '' : 'none';
    if (!this._running) this._setStatus(mine ? `last batch: ${r.summary.n} paths` : '—');
  }

  _renderVariables(variables) {
    const sampled = variables.filter(v => this._setting(v).enabled).length;
    this._q('vars-count').textContent = `(${sampled} of ${variables.length} sampled)`;
    this._q('var-rows').innerHTML = variables.map(v => {
      const s = this._setting(v);
      return `
      <tr data-key="${_esc(v.paramKey)}" class="sec-row">
        <td class="sec-td"><input type="checkbox" ${s.enabled ? 'checked' : ''} aria-label="Sample ${_esc(v.label ?? v.paramKey)}"></td>
        <td class="sec-td"><span class="fmc-var-label" title="${_esc(v.paramKey)}">${_esc(v.label ?? v.paramKey)}</span></td>
        <td class="sec-td sec-td--muted">${_esc(v.group ?? '')}</td>
        <td class="sec-td sec-td--num">${v.bootstrap ? '—' : _num(v.mean)}</td>
        <td class="sec-td sec-td--num">${v.bootstrap
          ? `<span class="sec-td--muted" title="Each path is one real season: a NASS county-year, both yield shocks from the same year (design 134 §17.13)">history · ${v.years} years</span>`
          : v.fixedSpread
          ? `<span class="sec-td--muted" title="A unit normal draw: its scale is the season's price volatility for this crop">z</span>`
          : `<input type="number" class="mc-num-input fmc-spread-input" min="0" step="any" value="${s.stdDev ?? 0}" aria-label="Spread of ${_esc(v.label ?? v.paramKey)}">`}${v.skew
          ? ` <span class="sec-td--muted" title="Skew-normal: a bad year falls further below than a good one rises above (design 134 §13.8)">skew ${v.skew}</span>` : ''}</td>
      </tr>`;
    }).join('');
    this._decorateHelp(variables);
  }

  /**
   * Each row's `?` and hover, as the retirement Monte Carlo panel's rows have them: the
   * words are the record field's own (sweep-row-help.js routes the key). Asynchronous; a
   * rebuild before the index lands only decorates rows already detached.
   */
  _decorateHelp(variables) {
    const byKey = new Map(variables.map(v => [v.paramKey, v]));
    const rows = [...this._q('var-rows').querySelectorAll('tr[data-key]')].map(tr => ({
      cfg: byKey.get(tr.dataset.key), refs: { labelEl: tr.querySelector('.fmc-var-label') },
    }));
    return decorateSweepRows(rows, { onOpenHelp: (ref) => this._openHelp(ref) });
  }

  /** Activate Help first: it subscribes on its first mount (workbench-app `_openHelp`). */
  _openHelp(ref) {
    const bus = this._runtime?.bus;
    bus?.publish?.({ type: WB_EVENTS.PANEL_OPEN, id: 'help' });
    bus?.publish?.({ type: WB_EVENTS.HELP_OPEN, ...ref });
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
    const flat = on.filter(v => !v.fixedSpread && !v.bootstrap && !(this._setting(v).stdDev > 0));
    if (on.length === 0) items.push(['⚠', 'Nothing is sampled, so every path is the deterministic season. Switch variables on.']);
    else if (flat.length) items.push(['⚠', `${flat.length} sampled variable${flat.length === 1 ? ' has' : 's have'} a spread of 0 and draw${flat.length === 1 ? 's' : ''} nothing.`]);
    // A spread is calibrated only where the catalog says so and it has not been retyped.
    const typed = on.filter(v => !v.fixedSpread && !v.bootstrap && this._setting(v).stdDev > 0
      && !(v.calibrated && this._setting(v).stdDev === v.stdDev));
    if (typed.length) {
      items.push(['⚠', `${typed.length} sampled spread${typed.length === 1 ? ' is' : 's are'} typed here, not calibrated from a source `
        + '(design 134 §13.8): read the results as a sensitivity run on '
        + `${typed.length === 1 ? 'it' : 'them'}.`]);
    }
    // A historical year writes both season shocks, so a shock row sampled with it draws for nothing.
    const onKeys = new Set(on.map(v => v.paramKey));
    const shadowed = on.filter(v => v.bootstrap).flatMap(v => (v.replaces ?? []).filter(k => onKeys.has(k)));
    if (shadowed.length) {
      items.push(['⚠', `The historical yield year sets the season's yield shocks, so ${shadowed.length === 1 ? 'the sampled shock row is' : `${shadowed.length} sampled shock rows are`} `
        + 'replaced by it. Untick one or the other.']);
    }
    const filled = calibratedPriceVolFor(this._cfg(), on.map(v => ({ ...v, enabled: true })));
    if (Object.keys(filled).length) {
      items.push(['ℹ', `Prices of ${_esc(Object.entries(filled).map(([c, v]) => `${CROPS[c]?.label ?? c} (${v})`).join(', '))} `
        + 'move at the calibrated volatility (USDA NASS, Nebraska): the season sets none of its own.']);
    }
    el.innerHTML = items.map(([icon, text]) => `<div>${icon} ${text}</div>`).join('');
    el.style.display = items.length ? '' : 'none';
  }

  _setStatus(text) { const s = this._q('status'); if (s) s.textContent = text; }

  _q(name) { return this.el?.querySelector(`[data-fmc="${name}"]`) ?? null; }
}

const _num = (n, d) => (n == null || !Number.isFinite(n) ? '—'
  : (d == null ? String(+n.toPrecision(6)) : n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })));

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
