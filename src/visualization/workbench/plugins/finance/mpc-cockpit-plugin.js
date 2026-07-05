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
import { readDecisionRecords } from '../../../../finance/mpc/apply-forward.js';
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
  }

  setServices(services) { this._servicesOverride = services ?? null; }
  _services() { return this._servicesOverride ?? ServiceRegistry.getInstance(); }

  render() {
    const root = document.createElement('div');
    root.className = 'mpc-cockpit wb-plugin-fill';
    root.innerHTML = `
      <div class="mpc-toolbar">
        <label class="mpc-field">Lever
          <select class="wb-select" data-mpc="control">
            ${Object.values(COCKPIT_CONTROLS).map(c => `<option value="${c.key}">${_esc(c.label)}</option>`).join('')}
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
      </div>

      <div class="mpc-toolbar mpc-range" data-mpc="range-row">
        <span class="mpc-range-title" title="Limits are in real, base-year (today's) dollars — the reducer compounds them to nominal by inflation, so they stay fixed across the run.">Search range (today’s $)</span>
        <label class="mpc-field">Min <input class="wb-input mpc-num" type="number" step="500" data-mpc="rmin" value="3000"></label>
        <label class="mpc-field">Max <input class="wb-input mpc-num" type="number" step="500" data-mpc="rmax" value="12000"></label>
        <label class="mpc-field">Step <input class="wb-input mpc-num" type="number" step="100" data-mpc="rstep" value="500"></label>
      </div>

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

      <div class="mpc-savepoints" data-mpc="savepoints" style="display:none">
        <div class="mpc-savepoints-head">MPC Save Points <span class="mpc-savepoints-sub">decision log · inspect only</span></div>
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
    this._bind('control', 'change', () => {
      this._controller?.setControl(this._currentControl());
      this._applyControlDefaultRange();   // each lever has its own natural range
      this._controller?.setControlRange(this._currentRange());
      this._syncRangeEnabled();
      this._syncLeverApplicability();
    });
    this._bind('objective','change',() => {
      this._syncObjectiveAxes();
      this._controller?.setObjective(this._currentObjective());
      this._syncHorizonEnabled();        // some goals can't use a window (full-horizon only)
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
    this._renderSavePoints();
  }

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

  /** Whether the selected lever actually affects the active scenario. */
  _leverApplies() {
    const c = this._currentControl();
    if (typeof c?.appliesTo !== 'function') return { ok: true };
    return { ok: !!c.appliesTo(this._baseParams()), requirement: c.requirement, label: c.label };
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

  /** Range inputs only apply to numeric levers (e.g. Spending), not ENUM (Roth). */
  _syncRangeEnabled() {
    const numeric = !!this._currentControl()?.numeric;
    const row = this._q('range-row');
    if (row) row.style.opacity = numeric ? '' : '0.4';
    for (const n of ['rmin', 'rmax', 'rstep']) {
      const el = this._q(n);
      if (el) el.disabled = !numeric;
    }
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

  _currentControl()   { return COCKPIT_CONTROLS[this._q('control')?.value] ?? COCKPIT_CONTROLS.SPENDING; }
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
      control:      this._currentControl(),
      controlRange: this._currentRange(),
      horizonYears: this._currentHorizon(),   // sliding prediction window (design 41)
      graph:       svc?.graph ?? null,
      parentId:    scenario.id ?? null,
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
      const advice = await c.advise({ solverKey: this._currentSolver(), solverOptions: { budget: 64, seed: 1 }, fanSize: 6, seriesPoints: 20 });
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

    // Phase B (design 39 Step 5b): actuate the chosen control on the LIVE sim
    // forward, so the realized trajectory bakes in the decision and every panel
    // reflects it once advanced.
    const control = c.control;
    let actuated = false;
    if (control?.liveActuatable && typeof control.actuate === 'function') {
      try {
        actuated = control.actuate({
          services: this._services(),
          scenario: this._services()?.scenarioService?.getActive?.() ?? null,
          candidate,
          vars:     c.lastAdvice.variables,
        });
      } catch (err) {
        this._setNow(`Apply failed: ${err?.message ?? err}`);
        return false;
      }
    }

    if (actuated) {
      this._controller = null;   // next Advise re-snapshots against the actuated plan
      this._setNow(`Applied to the live plan: ${c.describeMove(candidate, c.lastAdvice.variables)} — Advance to see it unfold.`);
    } else {
      this._setNow(`Recorded projection (terminal ${_usd(result.finalNetWorthUsd)}); “${control.label}” isn’t live-actuatable yet.`);
    }
    this._clearCard({ keepFan: this._autoRunning });   // keep the fan visible through auto
    this._renderSavePoints();   // the just-recorded decision joins the log
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
          advice = await c.advise({ solverKey: this._currentSolver(), solverOptions: { budget: 64, seed: 1 }, fanSize: 6, seriesPoints: 20 });
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

  /**
   * The "MPC Save Points" log (design 39 Step 5c): the session's decision records,
   * read straight from the shared `decision` graph layer. Inspect-only — date ·
   * move · projected terminal — NOT loadable scenarios. Hidden when empty.
   */
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
