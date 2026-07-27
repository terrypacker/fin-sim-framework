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
import { CockpitController, COCKPIT_CONTROLS } from '../../../../finance/mpc/cockpit-controller.js';
import { RolloutWorkerPool } from '../../../../finance/optimization/parallel/rollout-worker-pool.js';
import { readDecisionRecords, readDecisionRuns } from '../../../../finance/mpc/apply-forward.js';
import { harvestDecisions, COLLAPSE_RULES } from '../../../../finance/mpc/harvest.js';
import { applyHarvestPlan } from '../../../../finance/mpc/harvest-apply.js';
import { resolveStaticLevers, foldScheduleBakes, mergeResolved } from '../../../../finance/mpc/harvest-resolve.js';
import {
  OPTIMIZATION_OBJECTIVES, DIE_WITH_TARGET_AXES, DIE_WITH_TARGET_FAMILY,
  OBJECTIVE_FAMILY_LABELS, resolveDieWithTargetKey, resolveTerminalKey, terminalAxesFor,
  objectiveIsWindowable,
} from '../../../../finance/optimization/optimization-objectives.js';
import { DateUtils }          from '../../../../simulation-framework/date-utils.js';
import { EXECUTION_KINDS, EXECUTION_PHASES } from '../../../../simulation-framework/bus-messages.js';

// Curated cockpit goals: the grouped Die-With-Target family (running × scope ×
// tax-basis sub-options) plus the standalone objectives that make sense as MPC
// goals. MAX_AFTER_TAX_NET_WORTH is the design/40 D2 default for the Roth lever.
const OBJECTIVE_OPTIONS = [
  { kind: 'family', family: DIE_WITH_TARGET_FAMILY },
  { kind: 'single', key: 'MAX_NET_WORTH' },
  { kind: 'single', key: 'MAX_NET_LIQUIDITY' },
  { kind: 'single', key: 'MAX_AFTER_TAX_NET_WORTH' },
  { kind: 'single', key: 'MAX_AFTER_TAX_NET_LIQUIDITY' },
  { kind: 'single', key: 'MAX_CRRA_UTILITY' },
  { kind: 'single', key: 'MIN_LIFETIME_TAXES' },
];
const SOLVER_OPTIONS    = ['CEM', 'QP_POLISH', 'PATTERN_SEARCH', 'SIMULATED_ANNEALING', 'GRID', 'RANDOM'];

/**
 * MpcCockpitPlugin — the closed-loop advisor cockpit (design 39 §7).
 *
 * Stands at the active sim's "now": snapshots the realized present, asks the
 * controller for the next move, and draws a fan of candidate futures with the
 * recommended path highlighted. The user can Apply the recommendation (or an
 * override) and Advance "now" forward, at which point the controller re-plans —
 * an advisor, not an autopilot.
 *
 * Thin DOM view over the headless CockpitController; all rollout/solve logic
 * lives there (and on the shared OptimizationProblem snapshot primitive).
 */
export class MpcCockpitPlugin extends WorkbenchComponent {
  constructor(runtime) {
    super();
    this._runtime          = runtime;
    this._sim              = null;
    this._controller       = null;
    this._busy             = false;
    this._servicesOverride = null;   // tests
    this._unsubSimBus      = null;   // per-run sim-bus subscription (live "now" tracking)
    this._stepQueued       = false;  // rAF debounce for step bursts
    this._autoRunning      = false;  // autopilot loop active
    this._workerPool       = undefined;  // design 46 Phase 0.5: lazy, plugin-owned, reused across epochs
    this._parallel         = true;   // parallelize solver rollouts (bit-identical; toggle for A/B)
    this._runId            = null;   // current cockpit run (design 39 §13.2); null ⇒ mint on next use
    this._harvestPlan      = null;   // the plan under review in the harvest panel
  }

  setServices(services) { this._servicesOverride = services ?? null; }
  _services() { return this._servicesOverride ?? ServiceRegistry.getInstance(); }

  /**
   * The plugin-owned rollout worker pool (design 46 Phase 0.5 P-c). Created lazily
   * and only where Web Workers exist (never in Node tests / SSR), then reused across
   * epochs AND controller re-creations (the pool outlives `this._controller = null`
   * resets). `setContext` re-broadcasts each solve's snapshot, so reuse is safe.
   * Returns null when parallelism is off or unavailable → solvers run in-process.
   */
  _pool() {
    if (!this._parallel || typeof Worker === 'undefined') return null;
    if (this._workerPool === undefined) this._workerPool = new RolloutWorkerPool();
    return this._workerPool;
  }

  /** Terminate the pool on teardown so worker threads don't leak. */
  destroy() {
    if (this._workerPool) { this._workerPool.terminate(); this._workerPool = undefined; }
    super.destroy();
  }

  render() {
    const root = document.createElement('div');
    root.className = 'mpc-cockpit wb-plugin-fill';
    root.innerHTML = `
      <div class="mpc-toolbar">
        <label class="mpc-field" title="Pick one lever, or Ctrl/Cmd-click to search several jointly (design 45 §8)">Levers <span class="mpc-hint">(pick 1+)</span>
          <select class="wb-select mpc-multi" data-mpc="control" multiple size="${Object.keys(COCKPIT_CONTROLS).length}">
            ${Object.values(COCKPIT_CONTROLS).map(c => `<option value="${c.key}"${c.key === 'SPENDING' ? ' selected' : ''}>${_esc(c.label)}</option>`).join('')}
          </select>
        </label>
        <label class="mpc-field">Goal
          <select class="wb-select" data-mpc="objective">
            ${OBJECTIVE_OPTIONS.map(o => o.kind === 'family'
              ? `<option value="family:${o.family}">${_esc(OBJECTIVE_FAMILY_LABELS[o.family] ?? o.family)}</option>`
              : `<option value="${o.key}">${_esc(OPTIMIZATION_OBJECTIVES[o.key]?.label ?? o.key)}</option>`).join('')}
          </select>
        </label>
        <span class="mpc-field mpc-axes" data-mpc="axes" style="display:none">
          <label class="mpc-field">Basis
            <select class="wb-select" data-mpc="axis-running">
              ${DIE_WITH_TARGET_AXES.running.map(a => `<option value="${a.value}">${_esc(a.label)}</option>`).join('')}
            </select>
          </label>
          <label class="mpc-field">Terminal
            <select class="wb-select" data-mpc="axis-scope">
              ${DIE_WITH_TARGET_AXES.scope.map(a => `<option value="${a.value}">${_esc(a.label)}</option>`).join('')}
            </select>
          </label>
          <label class="mpc-field">Tax basis
            <select class="wb-select" data-mpc="axis-basis">
              ${DIE_WITH_TARGET_AXES.basis.map(a => `<option value="${a.value}">${_esc(a.label)}</option>`).join('')}
            </select>
          </label>
        </span>
        <label class="mpc-field">Search
          <select class="wb-select" data-mpc="solver">
            ${SOLVER_OPTIONS.map(k => `<option value="${k}">${_esc(k)}</option>`).join('')}
          </select>
        </label>
        <label class="mpc-field" data-mpc="horizon-field" title="Prediction window: how many years ahead each solve looks (blank = to end of plan)">Horizon (yrs)
          <input class="wb-input mpc-num" type="number" min="1" step="1" data-mpc="horizon" placeholder="Full">
        </label>
        <button class="btn btn-sm btn-primary" data-mpc="advise">Advise next move</button>
        <button class="btn btn-sm" data-mpc="advance" title="Step &quot;now&quot; forward one year and re-plan">Advance ▶</button>
        <button class="btn btn-sm" data-mpc="auto" title="Auto-accept the recommended move and advance each year to the end of the run">Auto ▶▶</button>
        <button class="btn btn-sm" data-mpc="harvest" title="Copy this run's decisions back into the loaded scenario's parameters (design 39 §13)" disabled>Copy to scenario…</button>
      </div>

      <div class="mpc-toolbar mpc-range" data-mpc="range-row">
        <span class="mpc-range-title" data-mpc="range-title" title="Limits are in real, base-year (today's) dollars — the reducer compounds them to nominal by inflation, so they stay fixed across the run.">Search range (today’s $)</span>
        <label class="mpc-field">Min <input class="wb-input mpc-num" type="number" step="500" data-mpc="rmin" value="3000"></label>
        <label class="mpc-field">Max <input class="wb-input mpc-num" type="number" step="500" data-mpc="rmax" value="12000"></label>
        <label class="mpc-field">Step <input class="wb-input mpc-num" type="number" step="100" data-mpc="rstep" value="500"></label>
      </div>

      <!-- Per-lever ranges for a multi-lever search: one Min/Max/Step row per
           selected NUMERIC lever, since a single shared range can't span their
           different unit scales (design 45 §8; design 58). Built dynamically. -->
      <div class="mpc-toolbar mpc-range mpc-range-multi" data-mpc="range-multi" style="display:none"></div>

      <div class="mpc-now" data-mpc="now">Run a simulation, then ask for advice.</div>

      <div class="mpc-card" data-mpc="card" style="display:none">
        <div class="mpc-card-head">Recommended next move</div>
        <div class="mpc-card-move" data-mpc="move">—</div>
        <div class="mpc-card-outcome" data-mpc="outcome">—</div>
        <div class="mpc-card-actions">
          <button class="btn btn-sm btn-primary" data-mpc="apply">Apply</button>
          <label class="mpc-field mpc-override">Override
            <input class="wb-input" type="number" step="500" data-mpc="override" placeholder="today’s $">
          </label>
        </div>
      </div>

      <div class="mpc-fan" data-mpc="fan" style="display:none"></div>

      <!-- Harvest review (design 39 §13.8): nothing is written to the scenario
           until the user reads this diff and approves it. -->
      <div class="mpc-harvest" data-mpc="harvest-panel" style="display:none">
        <div class="mpc-harvest-head">
          <span data-mpc="harvest-title">Copy to scenario</span>
          <label class="mpc-field mpc-harvest-opt" title="Re-solve the best STATIC value over the whole run for levers with no schedule form, instead of freezing the last epoch's decision (design 39 §13.6.6). Costs one optimizer run.">
            <input type="checkbox" data-mpc="harvest-resolve"> Re-solve static levers
          </label>
          <button class="btn btn-sm btn-primary" data-mpc="harvest-apply">Copy to scenario</button>
          <button class="btn btn-sm" data-mpc="harvest-cancel">Cancel</button>
        </div>
        <div class="mpc-harvest-body" data-mpc="harvest-body"></div>
      </div>

      <div class="mpc-savepoints" data-mpc="savepoints" style="display:none">
        <div class="mpc-savepoints-head">MPC Save Points <span class="mpc-savepoints-sub">decision log · inspect only</span>
          <button class="btn btn-sm btn-warn mpc-savepoints-clear" data-mpc="clear-savepoints" title="Delete the decision log. The log persists across Rebuilds by design; this empties it on demand.">Delete</button>
        </div>
        <ul class="mpc-savepoints-list" data-mpc="savepoints-list"></ul>
      </div>
    `;
    return root;
  }

  onInit() {
    this._runtime.bus.subscribe(WB_EVENTS.SCENARIO_READY, ({ scenario }) => this._bindSim(scenario?.sim ?? null));
  }

  onMount() {
    if (!this._sim) this._bindSim(this._services()?.simulationRegistry?.getPrimary?.() ?? null);
    this._bind('advise',  'click',  () => this._advise());
    this._bind('advance', 'click',  () => this._advance());
    this._bind('auto',    'click',  () => this._auto());
    this._bind('apply',   'click',  () => this._apply());
    this._bind('harvest',        'click', () => this._openHarvest());
    this._bind('harvest-apply',  'click', () => this._applyHarvest());
    this._bind('harvest-cancel', 'click', () => this._closeHarvest());
    this._bind('harvest-resolve','change', () => this._openHarvest());   // re-price the preview
    this._bind('control', 'change', () => {
      this._controller?.setControls(this._currentControls());
      this._applyControlDefaultRange();   // each lever has its own natural range
      this._controller?.setControlRange(this._currentRange());
      this._syncRangeEnabled();
      this._syncLeverApplicability();
      this._endRun();     // a different lever set is a different run (§13 H1)
    });
    this._bind('objective','change',() => {
      this._syncObjectiveAxes();
      this._controller?.setObjective(this._currentObjective());
      this._syncHorizonEnabled();        // some goals can't use a window (full-horizon only)
      this._endRun();     // decisions made under a different goal aren't one schedule
    });
    this._bind('axis-running', 'change', () => { this._controller?.setObjective(this._currentObjective()); this._syncHorizonEnabled(); });
    this._bind('axis-scope',   'change', () => { this._controller?.setObjective(this._currentObjective()); this._syncHorizonEnabled(); });
    this._bind('axis-basis',   'change', () => { this._controller?.setObjective(this._currentObjective()); this._syncHorizonEnabled(); });
    this._bind('horizon', 'change', () => this._controller?.setHorizonYears(this._currentHorizon()));
    for (const n of ['rmin', 'rmax', 'rstep']) {
      this._bind(n, 'change', () => { this._controller?.setControlRange(this._currentRange()); });
    }
    this._applyControlDefaultRange();   // seed the range inputs for the initial lever
    this._syncRangeEnabled();
    this._syncObjectiveAxes();          // show the axis sub-selects iff a family is chosen
    this._syncHorizonEnabled();         // disable the window for full-horizon-only goals
    this._syncLeverApplicability();
    this._bind('clear-savepoints', 'click', () => this._clearSavePoints());
    this._renderSavePoints();
    this._syncHarvestEnabled();
  }

  // ─── Run identity (design 39 §13.2) ────────────────────────────────────────

  /**
   * The current cockpit RUN's id. The controller is re-created after every Apply
   * and every clock step, so run identity cannot live there — it lives here, on
   * the surface that outlives the epochs, and is threaded into each controller.
   *
   * A run ends (`_endRun`) on a Rebuild, or when the lever set or goal changes:
   * decisions taken under a different goal or lever set are not one coherent
   * schedule, and harvest targets exactly one run (§13 H1).
   */
  _currentRunId() {
    if (!this._runId) this._runId = `run:${Date.now()}:${Math.floor(Math.random() * 1e4)}`;
    return this._runId;
  }

  _endRun() { this._runId = null; }

  /**
   * The window field is only meaningful for windowable goals (terminal-stock
   * maximizers, design 41 §4). For running / die-with-target goals it's disabled
   * with a hint, since the solve is forced to the full horizon regardless.
   */
  _syncHorizonEnabled() {
    const input = this._q('horizon');
    const field = this._q('horizon-field');
    if (!input || !field) return;
    const ok = objectiveIsWindowable(this._currentObjective());
    input.disabled = !ok;
    // Clear a stale value when the goal can't use a window — a greyed-out "8 yrs"
    // reads as an active horizon. Reset to Full (empty) and sync the controller.
    if (!ok && input.value !== '') {
      input.value = '';
      this._controller?.setHorizonYears(null);
    }
    field.title = ok
      ? 'Prediction window: how many years ahead each solve looks (blank = to end of plan)'
      : 'Full horizon — this goal scores at end of plan; the window does not apply.';
    field.classList.toggle('mpc-field--disabled', !ok);
  }

  /** The window length H (years) from the input — null when blank / non-positive / disabled. */
  _currentHorizon() {
    const input = this._q('horizon');
    if (!input || input.disabled) return null;
    const v = parseInt(input.value, 10);
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  /** Show the Basis/Terminal axis sub-selects only when a grouped family goal is chosen. */
  _syncObjectiveAxes() {
    const axes = this._q('axes');
    if (axes) axes.style.display = (this._q('objective')?.value ?? '').startsWith('family:') ? '' : 'none';
  }

  /** Populate the Min/Max/Step inputs from the current lever's defaultRange. */
  _applyControlDefaultRange() {
    const r = this._currentControl()?.defaultRange;
    if (!r) return;
    const set = (n, v) => { const el = this._q(n); if (el && v != null) el.value = String(v); };
    set('rmin', r.min); set('rmax', r.max); set('rstep', r.step);
  }

  /** Flat {key: value} map of the active scenario's params. */
  _baseParams() {
    return _paramsToMap(this._services()?.scenarioService?.getActive?.()?.params);
  }

  /** Whether the selected lever(s) actually affect the active scenario — for a
   *  joint search every active lever must apply; report the first inert one. */
  _leverApplies() {
    const params = this._baseParams();
    for (const c of this._currentControls()) {
      if (typeof c?.appliesTo === 'function' && !c.appliesTo(params)) {
        return { ok: false, requirement: c.requirement, label: c.label };
      }
    }
    return { ok: true };
  }

  /**
   * Gate the lever: if it can't affect the active scenario (e.g. Monthly Spending
   * chosen but the strategy isn't EXPLICIT_BANDS), disable Advise and say why —
   * rather than advising on an inert table and showing a flat fan.
   */
  _syncLeverApplicability() {
    const advise = this._q('advise');
    // No scenario/sim yet → fall back to the "run a simulation" prompt.
    if (!this._sim || !this._services()?.scenarioService?.getActive?.()) {
      if (advise) advise.disabled = false;
      this._renderNow();
      return;
    }
    const { ok, requirement, label } = this._leverApplies();
    if (advise) advise.disabled = !ok;
    if (!ok) {
      this._clearCard();
      this._setNow(`“${label}” has no effect here — ${requirement}`);
    } else {
      this._renderNow();
    }
  }

  /**
   * Range editor visibility. A SINGLE numeric lever uses the shared Min/Max/Step
   * row (greyed for a categorical lever, which has no range). With several levers
   * selected a single shared range would be meaningless across their different unit
   * scales (Spending $ vs Roth $ vs weights 0–1), so the shared row is swapped for a
   * per-lever editor — one row per selected numeric lever (design 45 §8 / design 58).
   */
  _syncRangeEnabled() {
    const multi     = this._isMultiLever();
    const singleRow = this._q('range-row');
    const multiRow  = this._q('range-multi');
    if (singleRow) singleRow.style.display = multi ? 'none' : '';
    if (multiRow)  multiRow.style.display  = multi ? '' : 'none';
    if (multi) { this._renderMultiRanges(); return; }

    const numeric = !!this._currentControl()?.numeric;
    if (singleRow) singleRow.style.opacity = numeric ? '' : '0.4';
    const title = this._q('range-title');
    if (title) title.textContent = 'Search range (today’s $)';
    for (const n of ['rmin', 'rmax', 'rstep']) {
      const el = this._q(n);
      if (el) el.disabled = !numeric;
    }
  }

  /**
   * Build the per-lever range editor for a multi-lever search: one Min/Max/Step row
   * per selected NUMERIC lever, seeded from the controller's current per-control
   * range (or the lever's defaultRange). Each row wires straight to
   * `setControlRangeFor(key, …)`, and is seeded into the controller on build so the
   * first Advise honors the shown values without waiting for an edit. Categorical
   * levers (no range) are listed as a note.
   */
  _renderMultiRanges() {
    const container = this._q('range-multi');
    if (!container) return;
    // Preserve any ranges the user already edited across a re-render (e.g. adding
    // another lever): capture the current DOM values BEFORE clearing.
    const prev = this._currentControlRanges();
    container.innerHTML = '';

    const controls    = this._currentControls();
    const numeric     = controls.filter(c => c?.numeric);
    const categorical = controls.filter(c => c && !c.numeric);

    const title = document.createElement('span');
    title.className = 'mpc-range-title';
    title.textContent = 'Per-lever search ranges';
    container.appendChild(title);

    for (const c of numeric) {
      const seed = prev[c.key] ?? this._controller?.controlRanges?.[c.key] ?? c.defaultRange ?? { min: 0, max: 1, step: 1 };
      const row = document.createElement('span');
      row.className = 'mpc-lever-range';
      row.dataset.mpcLever = c.key;
      row.innerHTML =
        `<span class="mpc-lever-range-label">${_esc(c.label)}</span>` +
        `<label class="mpc-field">Min <input class="wb-input mpc-num" type="number" data-r="min" value="${seed.min}"></label>` +
        `<label class="mpc-field">Max <input class="wb-input mpc-num" type="number" data-r="max" value="${seed.max}"></label>` +
        `<label class="mpc-field">Step <input class="wb-input mpc-num" type="number" data-r="step" value="${seed.step}"></label>`;
      const readRow = () => {
        const g = (k, d) => { const v = Number(row.querySelector(`[data-r="${k}"]`)?.value); return Number.isFinite(v) ? v : d; };
        let min = g('min', seed.min), max = g('max', seed.max);
        const step = Math.max(1e-9, g('step', seed.step));
        if (max < min) [min, max] = [max, min];
        return { min, max, step };
      };
      for (const inp of row.querySelectorAll('input')) {
        inp.addEventListener('change', () => this._controller?.setControlRangeFor(c.key, readRow()));
      }
      // Seed the controller now so an un-edited row still contributes its shown range.
      this._controller?.setControlRangeFor(c.key, { ...seed });
      container.appendChild(row);
    }

    if (categorical.length) {
      const note = document.createElement('span');
      note.className = 'mpc-hint';
      note.textContent = `${categorical.map(c => c.label).join(', ')}: categorical (no range)`;
      container.appendChild(note);
    }
  }

  /**
   * Per-lever ranges from the multi-lever editor rows, as `{ [key]: {min,max,step} }`.
   * Empty in single-lever mode (the editor is hidden). Read at controller creation so
   * a range set before the first Advise still takes effect.
   */
  _currentControlRanges() {
    const container = this._q('range-multi');
    const out = {};
    if (!container) return out;
    for (const row of container.querySelectorAll('[data-mpc-lever]')) {
      const key = row.dataset.mpcLever;
      const g = (k) => Number(row.querySelector(`[data-r="${k}"]`)?.value);
      let min = g('min'), max = g('max');
      const step = g('step');
      if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
      if (max < min) [min, max] = [max, min];
      out[key] = { min, max, step: Number.isFinite(step) ? Math.max(1e-9, step) : 1 };
    }
    return out;
  }

  /** Current search range from the inputs (sane fallbacks; min<max enforced). */
  _currentRange() {
    const num = (n, d) => { const v = Number(this._q(n)?.value); return Number.isFinite(v) ? v : d; };
    let min  = num('rmin', 3000);
    let max  = num('rmax', 12000);
    const step = Math.max(1, num('rstep', 500));
    if (max < min) [min, max] = [max, min];
    return { min, max, step };
  }

  _bind(name, ev, fn) {
    const el = this._q(name);
    if (el && !el._mpcBound) { el.addEventListener(ev, fn); el._mpcBound = true; }
  }

  _bindSim(sim) {
    // Track the LIVE sim so "now" and the cockpit stay in lockstep with the
    // real clock — stepping from the cockpit's Advance OR the header →/slider
    // both flow through here (design 39 Step 5a). A new sim (every Rebuild)
    // swaps in a fresh bus, so re-subscribe.
    this._unsubSimBus?.();
    this._unsubSimBus = null;
    this._sim = sim ?? null;
    this._controller = null;
    this._endRun();          // a Rebuild starts a new run (§13.2)
    this._closeHarvest();

    if (sim?.bus) {
      this._unsubSimBus = sim.bus.subscribe(
        `EXECUTION_${EXECUTION_PHASES.END}`,
        { kind: EXECUTION_KINDS.EVENT },
        () => this._scheduleStep(),
      );
    }
    if (this._mounted) { this._clearCard(); this._syncLeverApplicability(); }
  }

  /** Coalesce a burst of per-event steps into one "now" refresh per frame. */
  _scheduleStep() {
    if (!this._mounted || this._stepQueued) return;
    this._stepQueued = true;
    const run = () => { this._stepQueued = false; this._onSimStep(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else run();
  }

  /** The live sim advanced (from anywhere) — "now" moved, so prior advice is stale. */
  _onSimStep() {
    if (!this._mounted) return;
    this._controller = null;   // next Advise re-snapshots the new "now"
    this._clearCard({ keepFan: this._autoRunning });   // keep the fan visible through auto
    this._syncLeverApplicability();
  }

  /** All selected levers (design 45 §8 multi-lever); falls back to Spending when none picked. */
  _currentControls() {
    const sel = this._q('control');
    const keys = sel ? [...sel.selectedOptions].map(o => o.value) : [];
    const controls = keys.map(k => COCKPIT_CONTROLS[k]).filter(Boolean);
    return controls.length ? controls : [COCKPIT_CONTROLS.SPENDING];
  }
  /** The primary (first) selected lever — drives the single-lever range/applicability UI. */
  _currentControl()   { return this._currentControls()[0]; }
  /** True when the joint search spans more than one lever (per-lever default ranges). */
  _isMultiLever()     { return this._currentControls().length > 1; }
  /** Resolve the selected objective KEY, folding a grouped family + its axis sub-selects. */
  _currentObjectiveKey() {
    const val = this._q('objective')?.value ?? '';
    if (val.startsWith('family:')) {
      // Only DIE_WITH_TARGET is grouped today; resolve via the three axis selects
      // (running × scope × tax-basis). Scope+basis fold to the terminal key first.
      const terminal = resolveTerminalKey({
        scope: this._q('axis-scope')?.value,
        basis: this._q('axis-basis')?.value,
      });
      return resolveDieWithTargetKey({ running: this._q('axis-running')?.value, terminal });
    }
    return val;
  }

  _currentObjective() { return OPTIMIZATION_OBJECTIVES[this._currentObjectiveKey()] ?? OPTIMIZATION_OBJECTIVES.DIE_WITH_TARGET; }
  _currentSolver()    { return this._q('solver')?.value ?? 'CEM'; }

  /** Build (or rebuild) the controller seeded from the active sim's "now". */
  _ensureController() {
    if (this._controller) return this._controller;
    const svc      = this._services();
    const scenario = svc?.scenarioService?.getActive?.() ?? null;
    const sim      = this._sim;
    if (!sim || !scenario) return null;

    const baseParams = _paramsToMap(scenario.params);
    const snapshot = {
      date:     new Date(sim.currentDate),
      state:    structuredClone(sim.state),
      queue:    sim.cloneQueue ? sim.cloneQueue() : (sim.queue?.data ?? []).map(e => ({ ...e })),
      rngState: sim.rngState,
    };
    this._controller = new CockpitController({
      simStart:    new Date(scenario.simStart),
      simEnd:      new Date(scenario.simEnd),
      baseParams,
      cfgTemplate:  scenario,
      objective:    this._currentObjective(),
      controls:     this._currentControls(),     // joint lever set (design 45 §8)
      controlRange: this._currentRange(),
      controlRanges: this._currentControlRanges(), // per-lever ranges (multi-lever editor)
      horizonYears: this._currentHorizon(),   // sliding prediction window (design 41)
      graph:       svc?.graph ?? null,
      parentId:    scenario.id ?? null,
      // Harvest plumbing (§13.2): stamp every epoch with the run it belongs to,
      // and mirror the log to durable storage so an un-harvested run survives a
      // reload. Both outlive this controller instance.
      runId:        this._currentRunId(),
      decisionStore: svc?.decisionRecords ?? null,
    });
    this._controller.setSnapshot(snapshot);
    return this._controller;
  }

  async _advise() {
    if (this._busy || this._autoRunning) return;
    const applies = this._leverApplies();
    if (!applies.ok) { this._setNow(`“${applies.label}” has no effect here — ${applies.requirement}`); return; }
    const c = this._ensureController();
    if (!c) { this._setNow('Build/run a scenario first.'); return; }
    this._setBusy(true, 'Searching for the best next move…');
    try {
      const advice = await c.advise({ solverKey: this._currentSolver(), solverOptions: { budget: 64, seed: 1 }, workerPool: this._pool(), fanSize: 6, seriesPoints: 20 });
      this._renderAdvice(advice);
    } catch (err) {
      this._setNow(`Advice failed: ${err?.message ?? err}`);
    } finally {
      this._setBusy(false);
    }
  }

  _apply() {
    if (this._autoRunning) return;   // autopilot owns Apply while running
    const c = this._controller;
    if (!c || !c.lastAdvice) return;
    const candidate = this._overrideCandidate() ?? c.lastAdvice.recommended.candidate;
    this._applyCandidate(candidate);
  }

  /**
   * Commit a chosen candidate: record the projection + DERIVES_FROM audit (isolated),
   * then actuate it on the LIVE sim forward when the lever supports it. Shared by the
   * manual Apply button and the autopilot loop. Returns whether it hit the live plan.
   */
  _applyCandidate(candidate) {
    const c = this._controller;
    if (!c || !c.lastAdvice) return false;

    // Record the projection + DERIVES_FROM audit (isolated).
    const { result } = c.apply(candidate);

    // Phase B (design 39 Step 5b): actuate EACH active control on the LIVE sim
    // forward, so the realized trajectory bakes in the decision and every panel
    // reflects it once advanced. Each control gets ONLY its own variable subset
    // (its actuate reads vars[0] / its own paramKeys), routed by `_controlKey`.
    const allVars = c.lastAdvice.variables ?? [];
    const controls = c.controls ?? [c.control];
    let actuated = false;
    try {
      for (const control of controls) {
        if (!control?.liveActuatable || typeof control.actuate !== 'function') continue;
        const subset = allVars.some(v => v._controlKey)
          ? allVars.filter(v => v._controlKey === control.key)
          : allVars;
        if (subset.length === 0) continue;
        const hit = control.actuate({
          services: this._services(),
          scenario: this._services()?.scenarioService?.getActive?.() ?? null,
          candidate,
          vars:     subset,
        });
        actuated = actuated || !!hit;
      }
    } catch (err) {
      this._setNow(`Apply failed: ${err?.message ?? err}`);
      return false;
    }

    if (actuated) {
      this._controller = null;   // next Advise re-snapshots against the actuated plan
      this._setNow(`Applied to the live plan: ${c.describeMove(candidate, allVars)} — Advance to see it unfold.`);
    } else {
      const names = controls.map(ct => ct.label).join(' + ');
      this._setNow(`Recorded projection (terminal ${_usd(result.finalNetWorthUsd)}); “${names}” isn’t live-actuatable yet.`);
    }
    this._clearCard({ keepFan: this._autoRunning });   // keep the fan visible through auto
    this._renderSavePoints();   // the just-recorded decision joins the log
    this._syncHarvestEnabled(); // ...and makes the run harvestable
    return actuated;
  }

  /**
   * Advance "now" by stepping the LIVE primary sim forward one year through the
   * shared TimeControls (design 39 Step 5a) — the header clock/slider and every
   * panel (State/Chart/Holdings/Timeline) move in lockstep. The sim-bus
   * subscription then fires _onSimStep, which refreshes "now" and clears the
   * stale card. Falls back to an isolated controller advance if TimeControls
   * isn't available (e.g. tests/headless).
   */
  _advance() {
    if (this._busy || this._autoRunning) return;
    this._stepLiveForward();
  }

  /**
   * Step the live primary sim forward one year (clamped to simEnd) and return the
   * target date. Shared by manual Advance and the autopilot loop. `_onSimStep`
   * (via the sim bus) then refreshes "now" and clears the stale card.
   */
  _stepLiveForward() {
    const sim = this._sim;
    if (!sim) { this._setNow('Build/run a scenario first.'); return null; }

    const simEnd = new Date(this._services()?.scenarioService?.getActive?.()?.simEnd ?? sim.currentDate);
    let next = DateUtils.addYears(new Date(sim.currentDate), 1);
    if (next > simEnd) next = simEnd;

    const tc = this._runtime?.timeControls;
    if (tc?.stepToDate) {
      tc.stepToDate(next);          // drives the real sim → _onSimStep refreshes us
    } else {
      sim.stepTo(next);             // headless fallback
      this._onSimStep();
    }
    return next;
  }

  /**
   * Autopilot (design 39 "auto" mode): loop advise → apply(recommended) → advance,
   * year by year, until "now" reaches simEnd — an advisor running unattended. The
   * button toggles: a second click stops the loop. Each epoch yields a frame so the
   * recommended-move card, futures fan, and every panel repaint and the user can
   * watch the plan unfold (and interrupt). Override is ignored — auto always takes
   * the recommendation.
   */
  async _auto() {
    if (this._autoRunning) { this._beginStop(); return; }   // toggle → stop

    if (this._busy) return;
    const applies = this._leverApplies();
    if (!applies.ok) { this._setNow(`“${applies.label}” has no effect here — ${applies.requirement}`); return; }
    if (!this._sim) { this._setNow('Build/run a scenario first.'); return; }

    this._autoRunning = true;
    this._setAutoButton(true);
    try {
      while (this._autoRunning) {
        const sim = this._sim;
        if (!sim) break;
        const simEnd = new Date(this._services()?.scenarioService?.getActive?.()?.simEnd ?? sim.currentDate);
        if (new Date(sim.currentDate) >= simEnd) { this._setNow(`Auto complete — reached ${_fmtDate(simEnd)}.`); break; }

        const c = this._ensureController();
        if (!c) { this._setNow('Build/run a scenario first.'); break; }

        let advice;
        try {
          advice = await c.advise({ solverKey: this._currentSolver(), solverOptions: { budget: 64, seed: 1 }, workerPool: this._pool(), fanSize: 6, seriesPoints: 20 });
        } catch (err) {
          this._setNow(`Auto stopped — advice failed: ${err?.message ?? err}`);
          break;
        }
        if (!this._autoRunning) { this._renderAdvice(advice); break; }   // stopped mid-solve

        this._renderAdvice(advice);
        this._applyCandidate(advice.recommended.candidate);   // auto-accept (no override)
        if (!this._autoRunning) break;                        // stopped during apply

        const beforeMs = +new Date(sim.currentDate);
        this._stepLiveForward();
        // Wait for the chart to actually PAINT before the next (blocking) solve, so
        // the user watches the timeline advance year by year. The chart updates via
        // a 2-rAF chain (presenter _doRender → view _doChartUpdate), so a single
        // frame resumes and re-blocks before paint — _afterPaint clears the chain.
        await _afterPaint();
        if (+new Date(this._sim?.currentDate ?? beforeMs) <= beforeMs) {
          this._setNow('Auto stopped — the clock could not advance further.');
          break;   // stall guard: the live sim didn't move forward
        }
      }
    } finally {
      this._autoRunning = false;
      this._setAutoButton(false);
    }
  }

  /**
   * Request a stop: the loop only checks `_autoRunning` at its next yield (it may be
   * mid-solve), so flip the flag now and give immediate, obvious feedback — the
   * button reads "Stopping…", disables (no double-clicks), and pulses — until the
   * loop's finally settles it back to "Auto ▶▶".
   */
  _beginStop() {
    this._autoRunning = false;
    const btn = this._q('auto');
    if (btn) { btn.textContent = 'Stopping…'; btn.disabled = true; btn.classList.add('mpc-stopping'); }
  }

  /** Toggle the Auto button label + disable the conflicting manual controls. */
  _setAutoButton(running) {
    const btn = this._q('auto');
    if (btn) {
      btn.textContent = running ? 'Stop ⏹' : 'Auto ▶▶';
      btn.classList.toggle('btn-warn', running);
      btn.classList.remove('mpc-stopping');   // clear any in-progress "Stopping…" state
      btn.disabled = false;                    // the Auto/Stop toggle is always clickable
    }
    for (const n of ['advise', 'advance', 'apply']) {
      const el = this._q(n);
      if (el) el.disabled = running;
    }
  }

  /** Override input → a candidate matching the recommended control's shape. */
  _overrideCandidate() {
    const raw = this._q('override')?.value;
    if (raw === '' || raw == null) return null;
    const vars = this._controller?.lastAdvice?.variables ?? [];
    if (!vars.length) return null;
    const num = Number(raw);
    if (!Number.isFinite(num)) return null;
    return { [vars[0].paramKey]: num };
  }

  // ─── Rendering ─────────────────────────────────────────────────────────────

  _renderNow() {
    // "Now" is the LIVE sim's current date (Step 5a) — the cockpit tracks the
    // real clock, not a private snapshot.
    const date = this._sim?.currentDate ?? this._controller?.snapshot?.date;
    if (!date) { this._setNow('Run a simulation, then ask for advice.'); return; }
    this._setNow(`“Now” = ${_fmtDate(date)} — pick a lever and ask for the next move.`);
  }

  _renderAdvice(advice) {
    const card = this._q('card');
    this._q('move').textContent = advice.recommended.label;
    const r = advice.recommended.result ?? {};
    const target = r.terminalWealthTarget ?? 0;
    // Annotate the target with the terminal anchor the chosen goal uses
    // (scope × tax-basis, design/40). Surface the after-tax figures whenever the
    // goal anchors on them — a Die-With-Target after-tax *variant* OR a standalone
    // MAX_AFTER_TAX_* maximizer — so the user sees the metric being optimized.
    const terminal = this._currentObjective()?.variant?.terminal;
    const { scope, basis } = terminal ? terminalAxesFor(terminal) : {};
    const scopeWord  = scope === 'liquid' ? 'liquid' : scope === 'worth' ? 'net-worth' : null;
    const targetLabel = scopeWord
      ? `${basis === 'afterTax' ? 'after-tax ' : ''}${scopeWord} target` : 'target';
    const usesAfterTax = basis === 'afterTax'
      || /AFTER_TAX/.test(this._currentObjectiveKey());
    const afterTaxBits = usesAfterTax
      ? ` &nbsp;·&nbsp; after-tax worth <b>${_usd(r.finalAfterTaxNetWorth)}</b>` +
        ` &nbsp;·&nbsp; after-tax liquid <b>${_usd(r.finalAfterTaxNetLiquidity)}</b>`
      : '';
    this._q('outcome').innerHTML =
      `Projected terminal net worth <b>${_usd(r.finalNetWorthUsd)}</b>` +
      ` &nbsp;·&nbsp; liquid <b>${_usd(r.finalNetLiquidity)}</b>` +
      afterTaxBits +
      (target ? ` &nbsp;·&nbsp; ${targetLabel} ${_usd(target)}` : '') +
      ` &nbsp;·&nbsp; as of ${_fmtDate(advice.now.date)}`;
    const ov = this._q('override');
    if (ov) ov.value = '';
    card.style.display = '';
    this._renderFan(advice.fan);
    this._setNow(`Advice ready for ${_fmtDate(advice.now.date)}. Apply or override, then Advance.`);
  }

  /** Inline SVG fan: realized "now" point → diverging candidate futures. */
  _renderFan(fan) {
    const host = this._q('fan');
    if (!host) return;
    // Collapse the (fixed-height) chart box when there's nothing to draw — e.g.
    // between Auto epochs or before the first Advise — so it doesn't reserve a
    // blank band. It is re-shown the moment a fan renders (on Advise / each epoch).
    if (!fan?.length) { host.innerHTML = ''; host.style.display = 'none'; return; }
    host.style.display = '';

    const W = Math.max(320, host.clientWidth || 600), H = 220, P = 28;
    const allNw = fan.flatMap(f => f.netWorth);
    const t0 = +fan[0].dates[0], t1 = +fan[0].dates[fan[0].dates.length - 1];
    const lo = Math.min(...allNw), hi = Math.max(...allNw);
    const span = (hi - lo) || 1;
    const x = t => P + (W - 2 * P) * ((t - t0) / ((t1 - t0) || 1));
    const y = v => (H - P) - (H - 2 * P) * ((v - lo) / span);

    const paths = fan.map(f => {
      const d = f.dates.map((dt, i) => `${i ? 'L' : 'M'}${x(+dt).toFixed(1)},${y(f.netWorth[i]).toFixed(1)}`).join(' ');
      const cls = f.recommended ? 'mpc-line mpc-line--rec' : 'mpc-line';
      return `<path class="${cls}" d="${d}" />`;
    }).join('');

    host.innerHTML = `
      <svg class="mpc-fan-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Futures fan">
        <line class="mpc-axis" x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" />
        <line class="mpc-now-div" x1="${P}" y1="${P}" x2="${P}" y2="${H - P}" />
        ${paths}
        <text class="mpc-fan-lbl" x="${P + 2}" y="${P - 8}">now ${_fmtDate(new Date(t0))}</text>
        <text class="mpc-fan-lbl mpc-fan-lbl--end" x="${W - P}" y="${P - 8}">${_fmtDate(new Date(t1))}</text>
        <text class="mpc-fan-lbl" x="${P + 2}" y="${H - P + 16}">${_usd(lo)}</text>
        <text class="mpc-fan-lbl" x="${P + 2}" y="${P + 4}">${_usd(hi)}</text>
      </svg>`;
  }

  // ─── Harvest: copy the run back into the scenario (design 39 §13) ──────────

  /** Enable "Copy to scenario…" as soon as the session has a decision to copy. */
  _syncHarvestEnabled() {
    const btn = this._q('harvest');
    if (!btn) return;
    btn.disabled = readDecisionRuns(this._services()?.graph ?? null).length === 0;
  }

  /** The run the harvest targets: the current one if it has epochs, else the newest. */
  _harvestRun() {
    const runs = readDecisionRuns(this._services()?.graph ?? null);
    if (!runs.length) return null;
    return runs.find(r => r.runId === this._runId) ?? runs[0];
  }

  /**
   * Build the HarvestPlan and render it for review. Nothing is written here —
   * §13.8's point is that the user reads the diff (values, enabling-param flips,
   * collapse warnings) BEFORE approving. Available at any point in a run (§13 H2),
   * with the epoch range stated so a truncated "first N years" plan is legible.
   */
  async _openHarvest() {
    const run = this._harvestRun();
    const panel = this._q('harvest-panel');
    if (!run || !panel) return;

    const scenario = this._services()?.scenarioService?.getActive?.() ?? null;
    const baseParams = this._baseParams();
    let plan = harvestDecisions(run.records, {
      controlsByKey: COCKPIT_CONTROLS,
      baseParams,
      birth:    { birthDate: _primaryBirthDate(scenario, this._sim) },
      simStart: scenario?.simStart ? new Date(scenario.simStart) : null,
      collapse: COLLAPSE_RULES.LAST,
    });

    // RESOLVE (§13.6.6): re-solve the best static value for the levers with no
    // schedule form — AFTER folding the schedule bakes in, so the static value is
    // optimal *given* them. Opt-in: it costs a full-horizon solve.
    if (this._q('harvest-resolve')?.checked) {
      this._renderHarvest(plan, run, { busy: 'Re-solving the best static values over the whole run…' });
      try {
        const resolved = await resolveStaticLevers({
          plan,
          controlsByKey: COCKPIT_CONTROLS,
          baseParams:    foldScheduleBakes(baseParams, plan),
          objective:     this._currentObjective(),
          simStart:      new Date(scenario.simStart),
          simEnd:        new Date(scenario.simEnd),
          cfgTemplate:   scenario,
          state:         this._sim?.state ?? null,
          solverKey:     this._currentSolver(),
          solverOptions: { budget: 48, seed: 1 },
          workerPool:    this._pool(),
        });
        plan = mergeResolved(plan, resolved);
      } catch (err) {
        plan.warnings = [...(plan.warnings ?? []),
          `Re-solve failed (${err?.message ?? err}) — keeping the last-epoch values.`];
      }
    }

    this._harvestPlan = plan;
    this._renderHarvest(plan, run);
    panel.style.display = '';
  }

  _closeHarvest() {
    this._harvestPlan = null;
    const panel = this._q('harvest-panel');
    if (panel) panel.style.display = 'none';
  }

  /**
   * Execute the reviewed plan against the loaded scenario, then tell the Scenario
   * panel to re-render (it holds the params array by reference). Deliberately does
   * NOT Rebuild — that re-runs from t₀ and throws away the cockpit's realized
   * "now", which the user may still be working from (§13.8).
   */
  _applyHarvest() {
    const plan = this._harvestPlan;
    const scenario = this._services()?.scenarioService?.getActive?.() ?? null;
    if (!plan || !scenario) return;

    let res;
    try {
      res = applyHarvestPlan(scenario, plan);
    } catch (err) {
      this._setNow(`Copy failed: ${err?.message ?? err}`);
      return;
    }

    this._runtime?.bus?.publish({ type: WB_EVENTS.PARAMS_CHANGED, scenario, source: 'mpc-harvest' });

    const bits = [`${res.applied.length} param(s) updated`];
    if (res.created.length)  bits.push(`${res.created.length} created`);
    if (res.requires.length) bits.push(`${res.requires.length} enabling param(s) set`);
    if (res.skipped.length)  bits.push(`${res.skipped.length} skipped`);
    this._setNow(`Copied to “${scenario.name ?? 'scenario'}”: ${bits.join(', ')} — Rebuild to run it, then Save.`);
    this._closeHarvest();
  }

  /** Render the plan as the review table (§13.8). */
  _renderHarvest(plan, run, { busy = null } = {}) {
    const body  = this._q('harvest-body');
    const title = this._q('harvest-title');
    if (!body) return;

    if (title) {
      const range = plan.epochRange?.[0] && plan.epochRange?.[1]
        ? `${_fmtDate(plan.epochRange[0])} → ${_fmtDate(plan.epochRange[1])}` : '—';
      title.textContent = `Harvest run · ${plan.epochs} epoch(s) · ${range}`
        + (plan.goal?.label ? ` · Goal: ${plan.goal.label}` : '');
    }

    const rows = (plan.entries ?? []).map(e => `
      <li class="mpc-hv-row">
        <span class="mpc-hv-lever">${_esc(e.lever)}</span>
        <span class="mpc-hv-form mpc-hv-form--${_esc(String(e.form).toLowerCase())}">${_esc(e.form)}</span>
        <span class="mpc-hv-key" title="${_esc(e.paramKey)}">${_esc(e.paramKey)}</span>
        <span class="mpc-hv-val">${_esc(e.label ?? _shortVal(e.to))}</span>
        <span class="mpc-hv-epochs">${e.epochs || ''}</span>
      </li>`).join('');

    const reqRows = (plan.requires ?? []).map(r => `
      <li class="mpc-hv-row mpc-hv-row--req">
        <span class="mpc-hv-lever">${_esc(r.lever ?? '')}</span>
        <span class="mpc-hv-form mpc-hv-form--enable">ENABLE</span>
        <span class="mpc-hv-key">${_esc(r.paramKey)}</span>
        <span class="mpc-hv-val">${_esc(_shortVal(r.from))} → <b>${_esc(_shortVal(r.to?.includes ?? r.to))}</b></span>
        <span class="mpc-hv-epochs"></span>
      </li>`).join('');

    const warn = (plan.warnings ?? []).map(w => `<li class="mpc-hv-warn">⚠ ${_esc(w)}</li>`).join('');

    body.innerHTML =
      (busy ? `<div class="mpc-hv-busy">${_esc(busy)}</div>` : '') +
      (rows || reqRows
        ? `<ul class="mpc-hv-list">${rows}${reqRows}</ul>`
        : `<div class="mpc-hv-empty">Nothing to copy from this run.</div>`) +
      (warn ? `<ul class="mpc-hv-warns">${warn}</ul>` : '') +
      `<div class="mpc-hv-note">A copied plan is <b>open-loop</b>: it re-runs deterministically on this path, `
      + `but it cannot react the way the controller did — under a different seed or Monte Carlo arm it will differ.</div>`;
  }

  /**
   * The "MPC Save Points" log (design 39 Step 5c): the session's decision records,
   * read straight from the shared `decision` graph layer. Inspect-only — date ·
   * move · projected terminal — NOT loadable scenarios. Hidden when empty.
   */
  /**
   * Empty the MPC decision log on demand. The `decision` graph layer persists
   * across scenario Rebuilds by design (the save-points log is the source of
   * truth independent of any CockpitController's lifecycle), so there is no
   * automatic clear — this button is the manual escape hatch when the user wants
   * a clean slate without reloading the page.
   */
  _clearSavePoints() {
    // Clear the durable store too (§13 H4) — clearing only the graph would leave
    // the records to re-appear on the next reload.
    const svc = this._services();
    if (svc?.decisionRecords) svc.decisionRecords.clear();
    else svc?.graph?.clearLayer('decision');
    this._endRun();
    this._closeHarvest();
    this._renderSavePoints();
    this._syncHarvestEnabled();
  }

  _renderSavePoints() {
    const wrap = this._q('savepoints');
    const list = this._q('savepoints-list');
    if (!wrap || !list) return;
    const records = readDecisionRecords(this._services()?.graph ?? null);
    if (!records.length) { wrap.style.display = 'none'; list.innerHTML = ''; return; }
    wrap.style.display = '';
    // Header row so the value columns read as a table (net worth + the goal metric).
    const head = `<li class="mpc-savepoint mpc-savepoint--head">`
      + `<span class="mpc-sp-date">As of</span>`
      + `<span class="mpc-sp-move">Move</span>`
      + `<span class="mpc-sp-nw">Net Worth</span>`
      + `<span class="mpc-sp-goal">Goal metric</span>`
      + `</li>`;
    list.innerHTML = head + records.map(r => {
      const nw = r.result?.finalNetWorthUsd;
      // The goal's own metric (design/40) — shown alongside net worth so a Net
      // Liquidity / After-Tax / Lifetime-Taxes goal isn't mis-reported as net worth.
      const gm = r.goalMetric;
      const goalVal = gm && r.result ? r.result[gm.key] : null;
      const showGoal = gm && gm.key !== 'finalNetWorthUsd' && goalVal != null;
      const goalCell = showGoal
        ? `<span class="mpc-sp-goal" title="${_esc(gm.label)}">`
          + `<span class="mpc-sp-goal-lbl">${_esc(gm.label)}</span> ${_fmtMetric(gm.key, goalVal)}</span>`
        : `<span class="mpc-sp-goal mpc-sp-goal--na">—</span>`;
      return `<li class="mpc-savepoint">`
        + `<span class="mpc-sp-date">${_fmtDate(r.asOfDate)}</span>`
        + `<span class="mpc-sp-move" title="${_esc(r.move)}">${_esc(r.move)}</span>`
        + `<span class="mpc-sp-nw">${_usd(nw)}</span>`
        + goalCell
        + `</li>`;
    }).join('');
  }

  /**
   * Hide the recommended-move card. By default also clears the futures fan, but
   * `keepFan` leaves the last fan up — used during auto so the chart stays visible
   * (and "walks forward") through the long next-epoch solve instead of blanking.
   */
  _clearCard({ keepFan = false } = {}) {
    const card = this._q('card');
    if (card) card.style.display = 'none';
    if (keepFan) return;
    const fan = this._q('fan');
    if (fan) { fan.innerHTML = ''; fan.style.display = 'none'; }
  }

  _setBusy(busy, msg) {
    this._busy = busy;
    const btn = this._q('advise');
    if (btn) { btn.disabled = busy; btn.textContent = busy ? 'Advising…' : 'Advise next move'; }
    if (msg) this._setNow(msg);
  }

  _setNow(text) { const el = this._q('now'); if (el) el.textContent = text; }
  _q(name) { return this.el?.querySelector(`[data-mpc="${name}"]`) ?? null; }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _paramsToMap(raw) {
  if (!raw) return {};
  if (Array.isArray(raw)) return Object.fromEntries(raw.map(p => [p.key ?? p.name, p.value]));
  return typeof raw === 'object' ? { ...raw } : {};
}
function _usd(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}
/**
 * The primary's birthDate for the age-keyed bakes (§13.6.1/§13.6.4). Prefer the
 * SCENARIO's persons — the sim state is a disposable projection, and after a
 * Rebuild the harvest may run without one.
 */
function _primaryBirthDate(scenario, sim) {
  const p = (scenario?.persons ?? []).find(x => x?.birthDate);
  if (p?.birthDate) return p.birthDate;
  const people = sim?.state?.people ?? {};
  return people[Object.keys(people)[0]]?.birthDate ?? sim?.state?.personBirthDate ?? null;
}
/** Compact renderer for a harvested value in the review table. */
function _shortVal(v) {
  if (v == null) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(4)));
  if (Array.isArray(v)) return `${v.length} entr${v.length === 1 ? 'y' : 'ies'}`;
  if (typeof v === 'object') {
    try { const s = JSON.stringify(v); return s.length > 60 ? `${s.slice(0, 57)}…` : s; }
    catch { return '[object]'; }
  }
  return String(v);
}
/** Format a goal metric by its result key — USD for money fields, plain number for unitless utility. */
function _fmtMetric(key, n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (key === 'lifetimeConsumptionUtility') {
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n);
  }
  return _usd(n);
}
function _fmtDate(d) {
  if (!d) return '—';
  // UTC — sim dates are UTC-midnight; without this a Jan-1 date renders as the
  // prior December in negative-offset locales.
  try { return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', timeZone: 'UTC' }); }
  catch { return String(d); }
}
function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/** Resolve on the next animation frame (or a macrotask when rAF is unavailable). */
function _nextFrame() {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}
/**
 * Resolve AFTER the browser has painted, having cleared the chart's two-stage rAF
 * render chain. Two rAFs let presenter._doRender (frame 1) and view._doChartUpdate
 * (frame 2) both flush; the trailing macrotask resolves after frame 2's paint
 * rather than in the pre-paint rAF microtask — so a long synchronous task scheduled
 * next (the solve) doesn't pre-empt the paint.
 */
function _afterPaint() {
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(finish, 0)));
    }
    // Fallback: rAF is throttled to zero in a backgrounded tab, which would stall
    // the auto loop indefinitely. A timeout guarantees progress; when the tab is
    // visible the (faster) rAF path wins and the paint still lands first.
    setTimeout(finish, 120);
  });
}
