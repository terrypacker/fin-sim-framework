/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseComponent }              from '../components/base-component.js';
import { DEFAULT_MC_VARIABLE_CONFIGS, CENTER_SOURCES } from '../../finance/monte-carlo/intl-retirement-mc-config.js';
import { DISTRIBUTION_TYPES }          from '../../simulation-framework/distributions.js';

/**
 * McConfigPanel — left pane of the MC tab.
 *
 * Renders the run controls (iterations, run button, status) and a grouped
 * variable-distribution table into the provided container element.
 *
 * Call setVariables(vars) after construction to populate with the full dynamic
 * variable list (including per-shock rows from buildVariables()).
 *
 * A variable's CENTER is the scenario's value for that param unless the user typed
 * their own. The panel tracks that distinction per row (`centerDirty`) so it can
 * re-sync untouched rows from the live scenario on every run — otherwise a panel
 * built at load time keeps sampling a plan the user has since edited away from, and
 * every number it produces silently describes the old plan. User-set centers are
 * never overwritten; they are flagged instead (see syncScenarioCenters).
 *
 * Callbacks:
 *   onRun({ n, variableConfigs })   — fired when the Run button is clicked.
 *   onResolveScenarioCenters()      — must return Map(paramKey → current scenario
 *                                     value); used to re-sync untouched centers.
 */
export class McConfigPanel extends BaseComponent {
  constructor(containerEl) {
    super();
    this._container  = containerEl;
    this._rowMap     = new Map(); // paramKey → { enabledCb, typeSel, meanInp, stdDevInp, valueInp, minDateInp, maxDateInp }
    this._variables  = DEFAULT_MC_VARIABLE_CONFIGS; // current variable list
    this._iterEl     = null;
    this._runBtn     = null;
    this._copyBtn    = null;
    this._statusEl   = null;
    this._section    = null;
    this.onRun       = null;
    this.onCopyFromScenario = null;
    this.onResolveScenarioCenters = null;

    this._render();
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  showProgress(msg) {
    if (this._statusEl) this._statusEl.textContent = msg;
    if (this._runBtn)   this._runBtn.disabled = true;
  }

  enableRun() {
    if (this._runBtn) this._runBtn.disabled = false;
  }

  /** Show a transient status message without touching the Run button state. */
  setStatus(msg) {
    if (this._statusEl) this._statusEl.textContent = msg;
  }

  /**
   * Overwrite each variable row's distribution center with the current scenario
   * parameter value: `mean` for distribution types, `value` for CONSTANT. The
   * enabled flag, distribution type, and stdDev are left untouched so the user's
   * configured perturbation/spread survives the copy.
   *
   * `values` is a Map paramKey → value. Rows whose paramKey is absent (or maps to
   * null/undefined) are left as-is. Generic by design: any MC variable — present
   * or future — is matched by its resolved paramKey with no per-key wiring.
   *
   * Unlike syncScenarioCenters() this overwrites user-typed centers too — that is
   * what the button is for — so it also clears their user-set flag, which puts them
   * back under automatic re-centring.
   *
   * @returns {number} count of rows updated
   */
  applyScenarioValues(values) {
    return this._writeCenters(values, { pristineOnly: false }).updated;
  }

  /**
   * Re-sync every UNTOUCHED variable center from the live scenario, and flag the
   * user-set ones that disagree with it.
   *
   * This is what makes re-centring automatic: the panel is built once per scenario
   * load, so without it any param edited afterwards leaves its MC center behind and
   * the run silently samples the previous plan. Rows the user typed into are left
   * exactly as they are — an intentional center is a legitimate thing to sweep — but
   * they are marked so the divergence is visible rather than invisible.
   *
   * @returns {{ updated: number, diverged: Array<{paramKey, center, scenarioValue}> }}
   */
  syncScenarioCenters() {
    const values = this.onResolveScenarioCenters?.();
    if (!(values instanceof Map)) return { updated: 0, diverged: [] };
    return this._writeCenters(values, { pristineOnly: true });
  }

  /**
   * Write scenario values into row centers.
   *
   * `pristineOnly` skips rows whose center the user typed into, and instead reports
   * them as diverged when their value differs from the scenario's.
   */
  _writeCenters(values, { pristineOnly }) {
    let updated = 0;
    const diverged = [];
    for (const cfg of this._variables) {
      if (!values.has(cfg.paramKey)) continue;
      const v = values.get(cfg.paramKey);
      if (v === undefined || v === null) continue;
      const row = this._rowMap.get(cfg.paramKey);
      if (!row) continue;
      const type = row.typeSel.value;
      // Date-valued params have no single numeric center to copy into a [min,max]
      // window — leave the user-set bounds alone.
      if (type === DISTRIBUTION_TYPES.UNIFORM_DATE) continue;
      const inp = type === DISTRIBUTION_TYPES.CONSTANT ? row.valueInp : row.meanInp;

      if (pristineOnly && row.centerDirty) {
        const center    = parseFloat(inp.value);
        const disagrees = isFinite(center) && typeof v === 'number' && Math.abs(center - v) > 1e-9;
        if (disagrees) diverged.push({ paramKey: cfg.paramKey, center, scenarioValue: v });
        this._markDiverged(row, disagrees ? v : null);
        continue;
      }

      inp.value = String(v);
      row.centerDirty = false;      // the center is the scenario's again
      this._markDiverged(row, null);
      this._renderSource(row);
      updated++;
    }
    return { updated, diverged };
  }

  /**
   * Render a row's center-provenance tag, BEFORE anything is run.
   *
   * Answering "is this variable centered on my plan?" only after a run is too late —
   * you have already spent the compute and read the failure rate. `scenario` is the
   * normal case and stays quiet; `default` is the one that means the center is tied
   * to nothing the sim will run, so it is the one styled to be noticed.
   */
  _renderSource(row) {
    const el = row.sourceEl;
    if (!el) return;
    const source = row.centerDirty ? 'user' : row.centerSource;
    const TITLES = {
      scenario: 'Centered on this scenario\'s own value for the parameter.',
      schema:   'The scenario carries no value here, so the parameter schema\'s default is used — the same value the simulation runs at.',
      default:  'Centered on a framework default: neither the scenario nor the schema has a value here, so nothing ties this center to what the simulation runs.',
      user:     'You typed this center. It is used as-is and is not re-synced from the scenario.',
      'n/a':    'No single numeric center — this variable is sampled over a date range.',
    };
    el.textContent = source && source !== CENTER_SOURCES.SCENARIO ? source : '';
    el.title       = TITLES[source] ?? '';
    el.className   = `mc-var-source${source ? ` mc-var-source--${source}` : ''}`;
  }

  /** Flag (or clear) a row whose user-set center disagrees with the scenario value. */
  _markDiverged(row, scenarioValue) {
    const diverged = scenarioValue != null;
    row.el.classList.toggle('mc-var-diverged', diverged);
    row.labelEl.title = diverged
      ? `Center is user-set and differs from the scenario value (${scenarioValue}). `
        + 'Clear it or use "Copy from Scenario" to sample the plan as written.'
      : row.labelEl.dataset.label ?? row.labelEl.title;
  }

  /**
   * Replace the variable list with a fresh set (e.g. after scenario load).
   * Preserves existing user state for rows whose paramKey is unchanged.
   */
  setVariables(variables) {
    // Snapshot current user state before wiping rows
    const savedState = this._snapshotState();

    this._variables = variables;
    this._rowMap.clear();

    // Clear just the variable rows, keep the header
    if (this._section) {
      // Remove everything after the section header
      while (this._section.children.length > 1) {
        this._section.removeChild(this._section.lastChild);
      }
      this._buildVarTable(this._section, variables, savedState);
    }
  }

  /**
   * Returns the current panel configuration.
   * @returns {{ n: number, variableConfigs: Array }}
   */
  getConfig() {
    const n = Math.max(1, parseInt(this._iterEl?.value ?? '100', 10) || 100);

    const variableConfigs = this._variables.map(cfg => {
      const row = this._rowMap.get(cfg.paramKey);
      if (!row) return { ...cfg };

      const enabled = row.enabledCb.checked;
      const type    = row.typeSel.value;
      // Carry the center's provenance with it. The panel emits a center for every
      // row, so without this the runner cannot tell "the user chose 4%" from "this
      // is just the scenario value the panel copied in" — and every UI run reports
      // as if the whole variable set had been hand-set.
      const out     = { ...cfg, enabled, type, centerDirty: !!row.centerDirty, centerSource: row.centerSource };

      if (type === DISTRIBUTION_TYPES.CONSTANT) {
        out.value  = parseFloat(row.valueInp.value);
        if (!isFinite(out.value)) out.value = cfg.value ?? cfg.mean ?? 0;
      } else if (type === DISTRIBUTION_TYPES.UNIFORM_DATE) {
        out.min = row.minDateInp.value || cfg.min || '';
        out.max = row.maxDateInp.value || cfg.max || '';
      } else {
        out.mean   = parseFloat(row.meanInp.value);
        out.stdDev = parseFloat(row.stdDevInp.value);
        if (!isFinite(out.mean))   out.mean   = cfg.mean   ?? 0;
        if (!isFinite(out.stdDev)) out.stdDev = cfg.stdDev ?? 0;
      }
      return out;
    });

    return { n, variableConfigs };
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  /** Capture current UI state as a map paramKey → partial config, for preservation across setVariables. */
  _snapshotState() {
    const state = new Map();
    for (const cfg of this._variables) {
      const row = this._rowMap.get(cfg.paramKey);
      if (!row) continue;
      const type = row.typeSel.value;
      // centerDirty rides along so a rebuilt row still knows whether its center is
      // the user's or the scenario's.
      const snap = { enabled: row.enabledCb.checked, type, centerDirty: row.centerDirty };
      if (type === DISTRIBUTION_TYPES.CONSTANT) {
        snap.value = row.valueInp.value;
      } else if (type === DISTRIBUTION_TYPES.UNIFORM_DATE) {
        snap.min = row.minDateInp.value;
        snap.max = row.maxDateInp.value;
      } else {
        snap.mean   = row.meanInp.value;
        snap.stdDev = row.stdDevInp.value;
      }
      state.set(cfg.paramKey, snap);
    }
    return state;
  }

  _render() {
    const shell = document.createElement('div');
    shell.innerHTML = `
      <div class="node-header">Monte Carlo</div>
      <div class="mc-controls">
        <div class="node-field">
          <label>Iterations</label>
          <input type="number" class="mc-iters-input" value="100" min="1" max="10000" />
        </div>
        <button class="btn btn-primary" style="width:100%">▶ Run Monte Carlo</button>
      </div>
      <div class="mc-status-el"></div>
      <div class="mc-var-section">
        <div class="mc-var-header">
          <span>Variable Distributions</span>
          <button class="btn btn-xs btn-ghost mc-copy-scenario-btn"
            title="Copy the current scenario parameter values into the variable centers (mean / value)">Copy from Scenario</button>
        </div>
      </div>
    `;
    this.append(this._container, shell);

    this._iterEl   = shell.querySelector('.mc-iters-input');
    this._runBtn   = shell.querySelector('.btn-primary');
    this._copyBtn  = shell.querySelector('.mc-copy-scenario-btn');
    this._statusEl = shell.querySelector('.mc-status-el');
    this._section  = shell.querySelector('.mc-var-section');

    this.listen(this._runBtn, 'click', () => {
      // Re-sync untouched centers from the live scenario FIRST, so what runs is
      // what the panel shows and both are the current plan (see syncScenarioCenters).
      this.syncScenarioCenters();
      if (this.onRun) this.onRun(this.getConfig());
    });

    this.listen(this._copyBtn, 'click', () => {
      if (this.onCopyFromScenario) this.onCopyFromScenario();
    });

    this._buildVarTable(this._section, this._variables, new Map());
  }

  _buildVarTable(section, variables, savedState) {
    const groups = new Map();
    for (const cfg of variables) {
      if (!groups.has(cfg.group)) groups.set(cfg.group, []);
      groups.get(cfg.group).push(cfg);
    }

    for (const [groupName, configs] of groups) {
      const header = document.createElement('div');
      header.className = 'mc-group-header';
      header.textContent = groupName;
      section.appendChild(header);

      for (const cfg of configs) {
        // Merge saved state into cfg so the rebuilt row restores user values
        const prior = savedState.get(cfg.paramKey);
        const merged = prior ? { ...cfg, ...prior } : cfg;
        const { el, refs } = this._buildVarRow(merged);
        section.appendChild(el);
        this._rowMap.set(cfg.paramKey, refs);
      }
    }
  }

  _buildVarRow(cfg) {
    const isConst = cfg.type === DISTRIBUTION_TYPES.CONSTANT;
    const isDate  = cfg.type === DISTRIBUTION_TYPES.UNIFORM_DATE;

    const el = document.createElement('div');
    el.className = 'mc-var-row';

    const labelRow = document.createElement('div');
    labelRow.className = 'mc-var-label-row';
    labelRow.innerHTML = `
      <input type="checkbox" ${cfg.enabled ? 'checked' : ''}
        style="margin:0;cursor:pointer;accent-color:var(--purple);flex-shrink:0" />
      <span class="mc-var-label" title="${cfg.label}">${cfg.label}</span>
      <span class="mc-var-source"></span>
    `;
    el.appendChild(labelRow);

    const inputRow = document.createElement('div');
    inputRow.className = 'mc-var-input-row';

    const typeSel = document.createElement('select');
    typeSel.className = 'mc-num-input';
    typeSel.innerHTML = [
      DISTRIBUTION_TYPES.NORMAL,
      DISTRIBUTION_TYPES.LOG_NORMAL,
      DISTRIBUTION_TYPES.UNIFORM,
      DISTRIBUTION_TYPES.UNIFORM_DATE,
      DISTRIBUTION_TYPES.CONSTANT,
    ].map(t => `<option value="${t}" ${cfg.type === t ? 'selected' : ''}>${t}</option>`).join('');

    const meanInp = document.createElement('input');
    meanInp.type  = 'number';
    meanInp.step  = 'any';
    meanInp.placeholder = 'mean';
    meanInp.value = (isConst || isDate) ? '' : String(cfg.mean ?? cfg.defaultValue ?? '');
    meanInp.className = 'mc-num-input';
    meanInp.style.width = '60px';
    meanInp.style.display = (isConst || isDate) ? 'none' : 'block';

    const stdDevInp = document.createElement('input');
    stdDevInp.type  = 'number';
    stdDevInp.step  = 'any';
    stdDevInp.placeholder = 'σ';
    stdDevInp.value = (isConst || isDate) ? '' : String(cfg.stdDev ?? '');
    stdDevInp.className = 'mc-num-input';
    stdDevInp.style.width = '48px';
    stdDevInp.style.display = (isConst || isDate) ? 'none' : 'block';

    const valueInp = document.createElement('input');
    valueInp.type  = 'number';
    valueInp.step  = 'any';
    valueInp.placeholder = 'value';
    valueInp.value = isConst ? String(cfg.value ?? cfg.mean ?? '') : '';
    valueInp.className = 'mc-num-input';
    valueInp.style.width = '72px';
    valueInp.style.display = isConst ? 'block' : 'none';

    const minDateInp = document.createElement('input');
    minDateInp.type = 'date';
    minDateInp.placeholder = 'from';
    minDateInp.value = isDate ? String(cfg.min ?? '') : '';
    minDateInp.className = 'mc-num-input';
    minDateInp.style.width = '110px';
    minDateInp.style.display = isDate ? 'block' : 'none';

    const maxDateInp = document.createElement('input');
    maxDateInp.type = 'date';
    maxDateInp.placeholder = 'to';
    maxDateInp.value = isDate ? String(cfg.max ?? '') : '';
    maxDateInp.className = 'mc-num-input';
    maxDateInp.style.width = '110px';
    maxDateInp.style.display = isDate ? 'block' : 'none';

    inputRow.append(typeSel, meanInp, stdDevInp, valueInp, minDateInp, maxDateInp);
    el.appendChild(inputRow);

    this.listen(typeSel, 'change', () => {
      const c = typeSel.value === DISTRIBUTION_TYPES.CONSTANT;
      const d = typeSel.value === DISTRIBUTION_TYPES.UNIFORM_DATE;
      meanInp.style.display    = (c || d) ? 'none' : 'block';
      stdDevInp.style.display  = (c || d) ? 'none' : 'block';
      valueInp.style.display   = c ? 'block' : 'none';
      minDateInp.style.display = d ? 'block' : 'none';
      maxDateInp.style.display = d ? 'block' : 'none';
    });

    const enabledCb = labelRow.querySelector('input[type="checkbox"]');
    const labelEl   = labelRow.querySelector('.mc-var-label');
    labelEl.dataset.label = cfg.label ?? '';

    const refs = {
      el, labelEl, enabledCb, typeSel, meanInp, stdDevInp, valueInp, minDateInp, maxDateInp,
      sourceEl:    labelRow.querySelector('.mc-var-source'),
      // Where this row's center comes from when the user hasn't touched it.
      centerSource: cfg.centerSource ?? null,
      // True once the user types their own center: it must survive a scenario
      // re-sync (syncScenarioCenters) instead of being silently overwritten.
      centerDirty: !!cfg.centerDirty,
    };
    for (const centerInp of [meanInp, valueInp]) {
      this.listen(centerInp, 'input', () => { refs.centerDirty = true; this._renderSource(refs); });
    }
    this._renderSource(refs);
    return { el, refs };
  }
}
