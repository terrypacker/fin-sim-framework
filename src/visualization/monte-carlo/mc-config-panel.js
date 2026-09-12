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
import { SweepVariableTable }          from '../common/sweep-variable-table.js';
import { valuesForConfig }             from '../../finance/optimization/opt-values.js';
import { OPT_PARAM_TYPES }             from '../../finance/optimization/optimization-objectives.js';
import { GRID_MODES, MAX_AXIS_VALUES } from '../../finance/monte-carlo/mc-grid.js';
import { formatAxisValue, formatDuration } from './mc-grid-format.js';

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
 *   onRun({ n, variableConfigs, mix, spending }) — fired when the Run button is clicked.
 *   onRunGrid(getGridConfig())      — fired by Run Grid in Grid mode (design 100 §7).
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
    this.onRunGrid   = null;
    this.onCopyFromScenario = null;
    // Grid mode (design 100 §7).
    this._mode       = 'batch';
    this._gridVars   = [];      // the levers an axis can be (the Opt harvest)
    this._gridAxis   = null;    // [rows, columns]: { select, valuesEl, planEl, previewEl, cfg, inputs }
    this._msPerPath  = null;
    this.onResolveScenarioCenters = null;

    this._render();
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  showProgress(msg) {
    if (this._statusEl) this._statusEl.textContent = msg;
    if (this._runBtn)   this._runBtn.disabled = true;
    if (this._gridRunBtn) this._gridRunBtn.disabled = true;
  }

  enableRun() {
    if (this._runBtn) this._runBtn.disabled = false;
    if (this._gridRunBtn) this._gridRunBtn.disabled = false;
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
    this._table?.render(variables, savedState, this._rowMap);
  }

  /**
   * Returns the current panel configuration.
   * `mix` / `spending` are the runner's opt-in telemetry flags (design 100 §4). Both
   * default off: mix is ~1% extra compute, spending forces full telemetry at ~7.5x.
   *
   * @returns {{ n: number, variableConfigs: Array, mix: boolean, spending: boolean }}
   */
  getConfig() {
    const n = Math.max(1, parseInt(this._iterEl?.value ?? '100', 10) || 100);
    const mix      = !!this._mixCb?.checked;
    const spending = !!this._spendingCb?.checked;

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

    return { n, variableConfigs, mix, spending };
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
        <div class="mc-mode-toggle" title="Batch: one Monte Carlo run of the plan. Grid: one or two levers crossed, every cell run (design 100 §7).">
          <button type="button" class="mc-metric-btn mc-mode-btn mc-metric-btn--active" data-mode="batch">Batch</button>
          <button type="button" class="mc-metric-btn mc-mode-btn" data-mode="grid">Grid</button>
        </div>
        <div class="node-field">
          <label class="mc-iters-label">Iterations</label>
          <input type="number" class="mc-iters-input" value="100" min="1" max="10000" />
        </div>
        <div class="mc-telemetry" title="Extra per-path recording. The cost is on the label because it is the reason both are off by default (design 100 §4).">
          <label class="mc-telemetry-opt"><input type="checkbox" class="mc-opt-mix" />
            Record asset mix <span class="mc-telemetry-cost">+~1% time</span></label>
          <label class="mc-telemetry-opt"><input type="checkbox" class="mc-opt-spending" />
            Record spending <span class="mc-telemetry-cost">~7.5× time</span></label>
        </div>
        <button class="btn btn-primary mc-batch-run" style="width:100%">▶ Run Monte Carlo</button>
        <div class="mc-grid-body" hidden></div>
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
    this._mixCb      = shell.querySelector('.mc-opt-mix');
    this._spendingCb = shell.querySelector('.mc-opt-spending');
    this._runBtn   = shell.querySelector('.mc-batch-run');
    this._telemetryEl = shell.querySelector('.mc-telemetry');
    this._itersLabel  = shell.querySelector('.mc-iters-label');
    this._modeBtns    = [...shell.querySelectorAll('.mc-mode-btn')];
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

    // Grouping, filter and collapse are shared with the Opt panel (design 98 W4).
    this._table = new SweepVariableTable(this, this._section,
      { prefix: 'mc', buildRow: cfg => this._buildVarRow(cfg) });
    this._table.render(this._variables, new Map(), this._rowMap);

    this._buildGridBody(shell.querySelector('.mc-grid-body'));
    for (const b of this._modeBtns) this.listen(b, 'click', () => this._setMode(b.dataset.mode));
  }

  // ── Grid mode (design 100 §7) ────────────────────────────────────────────────

  /**
   * The levers a grid axis can be: the Opt harvest, each row carrying `planValue`.
   * A lever already chosen keeps its edited values if it is still on the list.
   */
  setGridAxes(optVars) {
    this._gridVars = (optVars ?? []).filter(v => v?.paramKey);
    if (!this._gridAxis) return;
    for (const k of [0, 1]) this._fillAxisSelect(k);
    this._updateGridCost();
  }

  /** Wall-clock ms per path from the last run; the cost line's time estimate. */
  setMsPerPath(ms) {
    this._msPerPath = Number.isFinite(ms) && ms > 0 ? ms : null;
    this._updateGridCost();
  }

  /**
   * The grid as configured, with an `error` when it cannot run.
   *
   * `sampledAxes` names chosen levers that are also enabled MC variables. The runner
   * takes them out of sampling for the grid, and the cost line says so BEFORE the run,
   * since it changes what the grid measures.
   *
   * @returns {{ mode, n, variableConfigs, axes: Array<{paramKey, label, values}>,
   *             cells: number, pathsPerCell: number, runs: number, sampledAxes: string[],
   *             error: string|null }}
   */
  getGridConfig() {
    const { n, variableConfigs } = this.getConfig();
    const mode = this._gridModeSel?.value ?? GRID_MODES.MC;
    const axes = [];
    let error = null;
    for (const k of [0, 1]) {
      const axis = this._gridAxis?.[k];
      if (!axis?.cfg) continue;
      const label = axis.cfg.label ?? axis.cfg.paramKey;
      const { values, count } = this._axisValues(k);
      if (!count) error ??= `${label}: no values in that range.`;
      else if (count > MAX_AXIS_VALUES) error ??= `${label}: ${count} values; at most ${MAX_AXIS_VALUES} per axis.`;
      axes.push({ paramKey: axis.cfg.paramKey, label, values, count });
    }
    if (!this._gridAxis?.[0]?.cfg) error = 'Choose a lever for the rows.';
    else if (axes.length === 2 && axes[0].paramKey === axes[1].paramKey) {
      error ??= 'Rows and columns must be different levers.';
    }

    const pathsPerCell = mode === GRID_MODES.DETERMINISTIC ? 1 : n;
    const cells = axes.length ? axes.reduce((p, a) => p * a.count, 1) : 0;
    const sampledAxes = mode === GRID_MODES.DETERMINISTIC ? []
      : axes.map(a => a.paramKey).filter(k => this._rowMap.get(k)?.enabledCb.checked);
    return {
      mode, n, variableConfigs,
      axes: axes.map(({ count: _c, ...a }) => a),
      cells, pathsPerCell, runs: cells * pathsPerCell, sampledAxes, error,
    };
  }

  _setMode(mode) {
    this._mode = mode;
    const grid = mode === 'grid';
    for (const b of this._modeBtns) b.classList.toggle('mc-metric-btn--active', b.dataset.mode === mode);
    this._gridBody.hidden    = !grid;
    this._runBtn.hidden      = grid;
    // A grid never records mix or spending (design 100 §7.2), so the options would lie.
    this._telemetryEl.hidden = grid;
    this._itersLabel.textContent = grid ? 'Paths per cell' : 'Iterations';
    this._updateGridCost();
  }

  _buildGridBody(el) {
    this._gridBody = el;
    this._gridAxis = [0, 1].map(k => {
      const block = document.createElement('div');
      block.className = 'mc-grid-axis-block';
      block.dataset.axis = String(k);
      const label = document.createElement('div');
      label.className = 'mc-grid-label';
      label.textContent = k === 0 ? 'Rows' : 'Columns (optional)';
      const select = document.createElement('select');
      select.className = 'mc-num-input mc-grid-axis';
      const valuesEl = document.createElement('div');
      valuesEl.className = 'mc-grid-values';
      const planEl = document.createElement('div');
      planEl.className = 'mc-grid-plan';
      block.append(label, select, valuesEl, planEl);
      el.appendChild(block);

      this.listen(select, 'change', () => this._selectAxis(k, select.value));
      this.listen(valuesEl, 'input',  () => this._updateGridCost());
      this.listen(valuesEl, 'change', () => this._updateGridCost());
      return { select, valuesEl, planEl, previewEl: null, cfg: null, inputs: null };
    });

    const modeField = document.createElement('div');
    modeField.className = 'node-field';
    const modeLabel = document.createElement('label');
    modeLabel.textContent = 'Cells';
    this._gridModeSel = document.createElement('select');
    this._gridModeSel.className = 'mc-num-input mc-grid-mode';
    this._gridModeSel.innerHTML = `<option value="${GRID_MODES.MC}">Monte Carlo (paths per cell)</option>`
      + `<option value="${GRID_MODES.DETERMINISTIC}">Deterministic (one run each)</option>`;
    modeField.append(modeLabel, this._gridModeSel);

    this._gridCostEl = document.createElement('div');
    this._gridCostEl.className = 'mc-grid-cost';

    this._gridRunBtn = document.createElement('button');
    this._gridRunBtn.className = 'btn btn-primary mc-grid-run';
    this._gridRunBtn.style.width = '100%';
    this._gridRunBtn.textContent = '▶ Run Grid';

    el.append(modeField, this._gridCostEl, this._gridRunBtn);

    this.listen(this._gridModeSel, 'change', () => this._updateGridCost());
    this.listen(this._iterEl, 'input', () => this._updateGridCost());
    // Enabling an MC variable that is also an axis changes the cost line's note.
    this.listen(this._section, 'change', () => this._updateGridCost());
    this.listen(this._gridRunBtn, 'click', () => {
      this.syncScenarioCenters();
      const cfg = this.getGridConfig();
      if (cfg.error) { this.setStatus(cfg.error); return; }
      this.onRunGrid?.(cfg);
    });

    for (const k of [0, 1]) this._fillAxisSelect(k);
    this._updateGridCost();
  }

  /** Rebuild one axis picker from the lever list, grouped as the Opt panel groups them. */
  _fillAxisSelect(k) {
    const axis = this._gridAxis[k];
    const keep = axis.cfg?.paramKey ?? '';
    axis.select.replaceChildren(new Option(k === 0 ? '— choose a lever —' : '— none —', ''));
    const byGroup = new Map();
    for (const v of this._gridVars) {
      const g = v.group ?? 'Other';
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(v);
    }
    for (const [g, vars] of byGroup) {
      const og = document.createElement('optgroup');
      og.label = g;
      for (const v of vars) og.appendChild(new Option(v.label ?? v.paramKey, v.paramKey));
      axis.select.appendChild(og);
    }
    const still = !!keep && this._gridVars.some(v => v.paramKey === keep);
    axis.select.value = still ? keep : '';
    this._selectAxis(k, axis.select.value, { preserve: still });
  }

  /**
   * Point an axis at a lever and build its value editor, typed by the lever's kind: a
   * checkbox per value for an ENUM, min / max / step for a number (the Opt row's own
   * shape, so the defaults are the Opt panel's).
   */
  _selectAxis(k, paramKey, { preserve = false } = {}) {
    const axis = this._gridAxis[k];
    const cfg  = this._gridVars.find(v => v.paramKey === paramKey) ?? null;
    if (preserve && cfg && axis.cfg?.paramKey === paramKey) {
      axis.cfg = cfg;
      this._renderAxisPlan(axis);
      return;
    }
    axis.cfg = cfg;
    axis.inputs = null;
    axis.previewEl = null;
    axis.valuesEl.replaceChildren();
    if (cfg) {
      if (cfg.type === OPT_PARAM_TYPES.ENUM) {
        const wrap = document.createElement('div');
        wrap.className = 'mc-grid-enum';
        axis.inputs = {
          checks: (cfg.values ?? []).map(val => {
            const lab = document.createElement('label');
            const cb  = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = true;
            lab.append(cb, ` ${formatAxisValue(val)}`);
            wrap.appendChild(lab);
            return { cb, val };
          }),
        };
        axis.valuesEl.appendChild(wrap);
      } else {
        const wrap = document.createElement('div');
        wrap.className = 'mc-grid-range';
        const num = (cls, placeholder, v) => {
          const inp = document.createElement('input');
          inp.type = 'number';
          inp.step = 'any';
          inp.className = `mc-num-input ${cls}`;
          inp.placeholder = placeholder;
          inp.value = v == null ? '' : String(v);
          return inp;
        };
        axis.inputs = {
          min:  num('mc-grid-min', 'min', cfg.min),
          max:  num('mc-grid-max', 'max', cfg.max),
          step: num('mc-grid-step', 'step', cfg.step),
        };
        wrap.append(axis.inputs.min, '–', axis.inputs.max, 'step', axis.inputs.step);
        axis.valuesEl.appendChild(wrap);
      }
      axis.previewEl = document.createElement('div');
      axis.previewEl.className = 'mc-grid-preview';
      axis.valuesEl.appendChild(axis.previewEl);
    }
    this._renderAxisPlan(axis);
    this._updateGridCost();
  }

  _renderAxisPlan(axis) {
    const pv = axis.cfg?.planValue;
    axis.planEl.textContent = pv === undefined || pv === null ? '' : `plan: ${formatAxisValue(pv)}`;
  }

  /**
   * An axis's values and their count. The count is computed first, so a mistyped range
   * reports "40,000 values" instead of building the list.
   */
  _axisValues(k) {
    const axis = this._gridAxis?.[k];
    if (!axis?.cfg || !axis.inputs) return { values: [], count: 0 };
    if (axis.inputs.checks) {
      const values = axis.inputs.checks.filter(c => c.cb.checked).map(c => c.val);
      return { values, count: values.length };
    }
    const { min, max, step } = axis.inputs;
    if ([min, max, step].some(i => i.value.trim() === '')) return { values: [], count: 0 };
    const lo = Number(min.value), hi = Number(max.value), st = Number(step.value);
    if (![lo, hi, st].every(Number.isFinite) || st <= 0 || hi < lo) return { values: [], count: 0 };
    const count = Math.floor((hi - lo) / st + 1e-9) + 1;
    if (count > MAX_AXIS_VALUES) return { values: [], count };
    return { values: valuesForConfig({ type: axis.cfg.type, min: lo, max: hi, step: st }), count };
  }

  /** The line under the grid controls: cells × paths = runs, and the time it will take. */
  _updateGridCost() {
    if (!this._gridCostEl) return;
    for (const [k, axis] of (this._gridAxis ?? []).entries()) {
      if (!axis.previewEl) continue;
      const { values, count } = this._axisValues(k);
      axis.previewEl.textContent = count > 0 && count <= MAX_AXIS_VALUES
        ? `${count} value${count === 1 ? '' : 's'}: ${values.map(formatAxisValue).join(', ')}`
        : `${count} values`;
    }

    const c = this.getGridConfig();
    this._gridCostEl.classList.toggle('mc-grid-cost--error', !!c.error);
    if (c.error) { this._gridCostEl.textContent = c.error; return; }
    const paths = `${c.pathsPerCell} path${c.pathsPerCell === 1 ? '' : 's'}`;
    this._gridCostEl.textContent = `${c.cells} cells × ${paths} = ${c.runs} runs`
      + (this._msPerPath ? ` · about ${formatDuration(c.runs * this._msPerPath)}` : ' · time is measured once it starts')
      + (c.sampledAxes.length ? ` · not sampled here (axes): ${c.sampledAxes.join(', ')}` : '');
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
