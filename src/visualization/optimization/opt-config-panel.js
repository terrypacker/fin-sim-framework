/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseComponent }                from '../components/base-component.js';
import { DEFAULT_OPTIMIZATION_CONFIGS } from '../../finance/optimization/intl-retirement-opt-config.js';
import {
  OPTIMIZATION_OBJECTIVES, OPT_PARAM_TYPES, groupedObjectiveOptions,
  DIE_WITH_TARGET_AXES, resolveDieWithTargetKey, resolveTerminalKey,
} from '../../finance/optimization/optimization-objectives.js';
import { valuesForConfig }              from '../../finance/optimization/opt-values.js';
import { SOLVER_REGISTRY }              from '../../finance/optimization/solvers/solver-registry.js';



/**
 * OptConfigPanel — left pane of the Optimization tab.
 *
 * Renders the objective selector, run controls, and a grouped
 * search-space table into the provided container element.
 *
 * Call setVariables(vars) after construction to populate with the full dynamic
 * variable list (including per-shock rows from buildOptVariables()).
 *
 * Callbacks:
 *   onRun({ optimizationConfigs, objective, objectiveKey, candidateCount })
 */
export class OptConfigPanel extends BaseComponent {
  constructor(containerEl) {
    super();
    this._container    = containerEl;
    this._rowMap       = new Map(); // paramKey → { enabledCb, rangeEl, minInp?, maxInp?, stepInp? }
    this._variables    = DEFAULT_OPTIMIZATION_CONFIGS; // current variable list
    this._objectiveSel = null;
    this._solverSel    = null;
    this._solverOptsEl = null;
    this._solverOptInputs = new Map(); // optionKey → { input, type }
    this._countEl      = null;
    this._runBtn       = null;
    this._statusEl     = null;
    this._section      = null;
    this.onRun         = null;

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

  /**
   * Replace the variable list with a fresh set (e.g. after scenario load).
   * Preserves existing user state for rows whose paramKey is unchanged.
   */
  setVariables(variables) {
    const savedState = this._snapshotState();

    this._variables = variables;
    this._rowMap.clear();

    if (this._section) {
      while (this._section.children.length > 1) {
        this._section.removeChild(this._section.lastChild);
      }
      this._buildVarTable(this._section, variables, savedState);
    }
    this._updateCount();
  }

  /**
   * Returns the current panel configuration.
   * @returns {{ optimizationConfigs, objective, objectiveKey, candidateCount, solverKey, solverOptions }}
   */
  getConfig() {
    const objectiveKey = this._objectiveKey();
    const objective    = OPTIMIZATION_OBJECTIVES[objectiveKey] ?? OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH;
    const solverKey    = this._solverSel?.value ?? 'GRID';
    const solverOptions = this._readSolverOptions();

    const optimizationConfigs = this._variables.map(cfg => {
      const row = this._rowMap.get(cfg.paramKey);
      if (!row) return { ...cfg };

      const out     = { ...cfg, enabled: row.enabledCb.checked };
      if (cfg.type !== OPT_PARAM_TYPES.ENUM && row.minInp) {
        const min  = parseFloat(row.minInp.value);
        const max  = parseFloat(row.maxInp.value);
        const step = parseFloat(row.stepInp.value);
        if (isFinite(min))  out.min  = min;
        if (isFinite(max))  out.max  = max;
        if (isFinite(step) && step > 0) out.step = step;
      }
      return out;
    });

    const candidateCount = this._computeCount(optimizationConfigs);
    return { optimizationConfigs, objective, objectiveKey, candidateCount, solverKey, solverOptions };
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  /** Resolve the selected objective KEY, folding a grouped family + its axis sub-selects. */
  _objectiveKey() {
    const val = this._objectiveSel?.value ?? 'MAX_NET_WORTH';
    if (val.startsWith('family:')) {
      const terminal = resolveTerminalKey({
        scope: this._axisScope?.value,
        basis: this._axisBasis?.value,
      });
      return resolveDieWithTargetKey({ running: this._axisRunning?.value, terminal });
    }
    return val;
  }

  /** Show the Basis/Terminal axis sub-selects only when a grouped family goal is chosen. */
  _syncObjectiveAxes() {
    if (this._axesEl) {
      this._axesEl.style.display = (this._objectiveSel?.value ?? '').startsWith('family:') ? '' : 'none';
    }
  }

  _snapshotState() {
    const state = new Map();
    for (const cfg of this._variables) {
      const row = this._rowMap.get(cfg.paramKey);
      if (!row) continue;
      const snap = { enabled: row.enabledCb.checked };
      if (cfg.type !== OPT_PARAM_TYPES.ENUM && row.minInp) {
        snap.min  = parseFloat(row.minInp.value);
        snap.max  = parseFloat(row.maxInp.value);
        snap.step = parseFloat(row.stepInp.value);
      }
      state.set(cfg.paramKey, snap);
    }
    return state;
  }

  _computeCount(configs) {
    const enabled = configs.filter(c => c.enabled);
    if (!enabled.length) return 1;
    return enabled.reduce((n, cfg) => n * valuesForConfig(cfg).length, 1);
  }

  _updateCount() {
    if (!this._countEl) return;
    const { optimizationConfigs, solverKey, solverOptions } = this.getConfig();
    const exhaustive = this._computeCount(optimizationConfigs);

    if (solverKey === 'GRID') {
      // Exhaustive Cartesian enumeration.
      this._countEl.textContent = `${exhaustive} candidate${exhaustive !== 1 ? 's' : ''} (exhaustive)`;
    } else {
      // Budgeted solver: cap is the smaller of the budget and the exhaustive grid.
      const budget = Number.isFinite(solverOptions.budget) ? solverOptions.budget : exhaustive;
      const n = Math.min(budget, exhaustive);
      this._countEl.textContent = `≤ ${n} evaluation${n !== 1 ? 's' : ''}`;
    }
  }

  _render() {
    const objectiveOptions = groupedObjectiveOptions()
      .map(o => o.kind === 'family'
        ? `<option value="family:${o.family}">${o.label}</option>`
        : `<option value="${o.key}">${o.label}</option>`)
      .join('');
    const axisOptions = (axis) => DIE_WITH_TARGET_AXES[axis]
      .map(a => `<option value="${a.value}">${a.label}</option>`).join('');
    const solverOptions = Object.entries(SOLVER_REGISTRY)
      .map(([k, v]) => `<option value="${k}">${v.label}</option>`)
      .join('');

    const shell = document.createElement('div');
    shell.innerHTML = `
      <div class="node-header">Optimization</div>
      <div class="opt-controls">
        <div class="node-field">
          <label>Objective</label>
          <select class="toolbar-select opt-objective-select" style="flex:1">
            ${objectiveOptions}
          </select>
        </div>
        <div class="node-field opt-objective-axes" style="display:none">
          <label>Basis</label>
          <select class="toolbar-select opt-axis-running" style="flex:1">${axisOptions('running')}</select>
          <label>Terminal</label>
          <select class="toolbar-select opt-axis-scope" style="flex:1">${axisOptions('scope')}</select>
          <label>Tax basis</label>
          <select class="toolbar-select opt-axis-basis" style="flex:1">${axisOptions('basis')}</select>
        </div>
        <div class="node-field">
          <label>Solver</label>
          <select class="toolbar-select opt-solver-select" style="flex:1">
            ${solverOptions}
          </select>
        </div>
        <div class="opt-solver-options"></div>
        <div class="opt-controls-row">
          <button class="btn btn-primary" style="flex:1">⚡ Run Optimization</button>
          <span class="opt-count-label">— candidates</span>
        </div>
      </div>
      <div class="opt-status"></div>
      <div class="opt-var-section">
        <div class="opt-search-space-header">Search Space</div>
      </div>
    `;
    this.append(this._container, shell);

    this._objectiveSel = shell.querySelector('.opt-objective-select');
    this._axesEl       = shell.querySelector('.opt-objective-axes');
    this._axisRunning  = shell.querySelector('.opt-axis-running');
    this._axisScope    = shell.querySelector('.opt-axis-scope');
    this._axisBasis    = shell.querySelector('.opt-axis-basis');
    this._solverSel    = shell.querySelector('.opt-solver-select');
    this._solverOptsEl = shell.querySelector('.opt-solver-options');
    this._runBtn       = shell.querySelector('button');
    this._statusEl     = shell.querySelector('.opt-status');
    this._countEl      = shell.querySelector('.opt-count-label');
    this._section      = shell.querySelector('.opt-var-section');

    this.listen(this._runBtn, 'click', () => {
      if (this.onRun) this.onRun(this.getConfig());
    });
    this.listen(this._solverSel, 'change', () => {
      this._renderSolverOptions();
      this._updateCount();
    });
    this.listen(this._objectiveSel, 'change', () => this._syncObjectiveAxes());

    this._syncObjectiveAxes();
    this._renderSolverOptions();
    this._buildVarTable(this._section, this._variables, new Map());
    this._updateCount();
  }

  /**
   * Render the selected solver's option knobs from its optionSchema (same shape
   * the spending strategies use), so each solver's budget/seed/etc. are editable
   * generically. GRID has no options → the block is empty.
   */
  _renderSolverOptions() {
    this._solverOptInputs.clear();
    if (!this._solverOptsEl) return;
    this._solverOptsEl.innerHTML = '';

    const key    = this._solverSel?.value ?? 'GRID';
    const schema = SOLVER_REGISTRY[key]?.optionSchema ?? [];

    for (const opt of schema) {
      const field = document.createElement('div');
      field.className = 'node-field';

      const label = document.createElement('label');
      label.textContent = opt.label ?? opt.key;
      if (opt.description) label.title = opt.description;
      field.appendChild(label);

      let input;
      if (opt.type === 'Enum') {
        input = document.createElement('select');
        input.className = 'toolbar-select';
        input.style.flex = '1';
        input.innerHTML = (opt.options ?? [])
          .map(o => `<option value="${o}">${o}</option>`).join('');
        input.value = opt.defaultValue ?? (opt.options?.[0] ?? '');
      } else {
        input = document.createElement('input');
        input.type = opt.type === 'Number' ? 'number' : 'text';
        if (opt.type === 'Number') input.step = 'any';
        input.className = 'opt-num-input';
        input.style.flex = '1';
        input.value = opt.defaultValue ?? '';
      }
      this.listen(input, 'input',  () => this._updateCount());
      this.listen(input, 'change', () => this._updateCount());

      this._solverOptInputs.set(opt.key, { input, type: opt.type });
      field.appendChild(input);
      this._solverOptsEl.appendChild(field);
    }
  }

  /** Read the solver option inputs into a typed { key: value } object. */
  _readSolverOptions() {
    const out = {};
    for (const [key, { input, type }] of this._solverOptInputs) {
      if (type === 'Number') {
        const n = parseFloat(input.value);
        if (isFinite(n)) out[key] = n;
      } else {
        out[key] = input.value;
      }
    }
    return out;
  }

  _buildVarTable(section, variables, savedState) {
    const groups = new Map();
    for (const cfg of variables) {
      if (!groups.has(cfg.group)) groups.set(cfg.group, []);
      groups.get(cfg.group).push(cfg);
    }

    for (const [groupName, configs] of groups) {
      const header = document.createElement('div');
      header.className = 'opt-group-header';
      header.textContent = groupName;
      section.appendChild(header);

      for (const cfg of configs) {
        const prior  = savedState.get(cfg.paramKey);
        const merged = prior ? { ...cfg, ...prior } : cfg;
        const { el, refs } = this._buildVarRow(merged);
        section.appendChild(el);
        this._rowMap.set(cfg.paramKey, refs);
      }
    }
  }

  _buildVarRow(cfg) {
    const el = document.createElement('div');
    el.className = 'opt-var-row';

    // Row 1: enabled checkbox + label + value-count badge
    const labelRow = document.createElement('div');
    labelRow.className = 'opt-var-label-row';

    const valCount = valuesForConfig(cfg).length;
    labelRow.innerHTML = `
      <input type="checkbox" ${cfg.enabled ? 'checked' : ''}
        style="margin:0;cursor:pointer;accent-color:var(--purple);flex-shrink:0" />
      <span class="opt-var-label" title="${cfg.label}">${cfg.label}</span>
      <span class="opt-var-count">${valCount}v</span>
    `;
    el.appendChild(labelRow);

    // Row 2: range details (hidden when disabled)
    const rangeRow = document.createElement('div');
    rangeRow.className = 'opt-var-range-row';
    if (!cfg.enabled) rangeRow.style.display = 'none';

    let refs = { enabledCb: labelRow.querySelector('input[type="checkbox"]') };

    if (cfg.type === OPT_PARAM_TYPES.ENUM) {
      // Read-only pills for enum values
      const pct = v => (typeof v === 'number' && v > 0 && v < 1) ? `${(v * 100).toFixed(0)}%` : String(v);
      rangeRow.innerHTML =
        `<div class="opt-enum-values">` +
        cfg.values.map(v => `<span class="opt-enum-pill">${pct(v)}</span>`).join(' ') +
        `</div>`;
    } else {
      // Editable min / max / step inputs
      const minInp  = this._numInput(String(cfg.min ?? ''),  'min',  '54px');
      const maxInp  = this._numInput(String(cfg.max ?? ''),  'max',  '54px');
      const stepInp = this._numInput(String(cfg.step ?? ''), 'step', '42px');

      const lbl = (t) => {
        const s = document.createElement('span');
        s.className   = 'opt-var-range-lbl';
        s.textContent = t;
        return s;
      };

      rangeRow.append(lbl('min'), minInp, lbl('max'), maxInp, lbl('step'), stepInp);

      refs = { ...refs, minInp, maxInp, stepInp };

      [minInp, maxInp, stepInp].forEach(inp =>
        this.listen(inp, 'input', () => this._updateCount())
      );
    }

    el.appendChild(rangeRow);

    const enabledCb = refs.enabledCb;
    this.listen(enabledCb, 'change', () => {
      rangeRow.style.display = enabledCb.checked ? (cfg.type === OPT_PARAM_TYPES.ENUM ? '' : 'flex') : 'none';
      this._updateCount();
    });

    return { el, refs };
  }

  _numInput(value, placeholder, width) {
    const inp = document.createElement('input');
    inp.type        = 'number';
    inp.step        = 'any';
    inp.value       = value;
    inp.placeholder = placeholder;
    inp.className   = 'opt-num-input';
    inp.style.width = width;
    return inp;
  }
}
