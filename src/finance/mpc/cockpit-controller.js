/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { OptimizationProblem }     from '../optimization/optimization-problem.js';
import { OPTIMIZATION_OBJECTIVES } from '../optimization/optimization-objectives.js';
import { createSolver }            from '../optimization/solvers/solver-registry.js';
import { OPT_PARAM_TYPES }         from '../optimization/optimization-objectives.js';
import { rollForwardWithControls, recordDecisionRecord } from './apply-forward.js';
import { repinExpensesIfChanged }  from '../spending/strategies/explicit-bands-spending-reducer.js';
import { set }                     from '../monte-carlo/mc-param-paths.js';
import { DateUtils }               from '../../simulation-framework/date-utils.js';
import { UsTaxRates2025 }          from '../tax/us/us-tax-rates-2025.js';

/**
 * Built-in control specs for the cockpit (design 39 §7). A control spec maps the
 * UI's chosen lever to (a) the decision variables to search and (b) a
 * human-legible description of a chosen value for the recommended-move card.
 *
 * `buildVariables(ctx)` receives { asOf, state, baseParams } so a spec can size
 * itself to the realized "now" (e.g. the spending band active at the current age).
 */
export const COCKPIT_CONTROLS = {
  SPENDING: {
    key:     'SPENDING',
    label:   'Monthly Spending',
    numeric: true,                       // search range (min/max/step) applies
    defaultRange: { min: 3000, max: 12000, step: 500 },
    // The lever drives the EXPLICIT_BANDS table; it only affects the live sim
    // when that strategy is active (AGE_BANDED/FIXED read other params).
    appliesTo: (bp) => _hasStrategy(bp?.spendingStrategy, 'EXPLICIT_BANDS'),
    requirement: 'Switch Spending Strategy to include EXPLICIT_BANDS (Scenario panel) to use this lever.',
    buildVariables: ({ baseParams, range, asOf, state }) => {
      const bands = baseParams?.spendingExpenseBands ?? [{ startAge: 65, monthlyAmount: 6000 }];
      // Target the band active at "now" (matching the reducer's bandForAge), or
      // the first/upcoming band — NOT blindly the last band.
      const i = _activeBandIndex(bands, asOf, state);
      return [{
        paramKey: `spendingExpenseBands[${i}].monthlyAmount`,
        type: OPT_PARAM_TYPES.INTEGER,
        min:  range?.min  ?? 3000,
        max:  range?.max  ?? 12000,
        step: range?.step ?? 500,
        group: 'Spending', _bandIndex: i,
      }];
    },
    describe: (candidate, vars) => {
      const v = vars[0];
      return `Set monthly spend to ${fmtUsd(candidate[v.paramKey])}`;
    },
    liveActuatable: true,
    /**
     * Forward-effective live actuation (design 39 Step 5b / Phase B): re-wire the
     * running ExplicitBandsSpendingReducer's band amount and persist it to the
     * active scenario param. The realized past (journal/state) is untouched; the
     * change bites at the next period advance via the reducer's appliedAmount
     * re-pin. Returns true when it actually hit the live plan.
     */
    actuate: ({ services, scenario, candidate, vars }) => {
      const v = vars?.[0];
      if (!v) return false;
      const i = v._bandIndex ?? 0;
      const amount = candidate?.[v.paramKey];
      if (amount == null) return false;

      const rs = services?.reducerService;
      const reducer = rs?.getAll?.().find(r => r?.constructor?.type === 'ExplicitBandsSpendingReducer');
      if (!rs || !reducer || !Array.isArray(reducer.bands) || !reducer.bands[i]) return false;

      // 1) Re-wire the live reducer forward (service UPDATE → SimulationSync).
      const bands = reducer.bands.map((b, k) => (k === i ? { ...b, monthlyAmount: amount } : { ...b }));
      rs.updateReducer(reducer, { bands });

      // 2) Re-pin the live state immediately if the edit hit the band active at
      //    "now", so the rest of the CURRENT year spends the new amount instead of
      //    waiting for the next annual period advance (design 39 Step 5b — matches
      //    the projection's _seededSim re-pin). The realized past is untouched.
      const sim = services?.simulationRegistry?.getPrimary?.();
      if (sim?.state) {
        const patch = repinExpensesIfChanged(sim.state, bands, new Date(sim.currentDate).getTime());
        if (patch) sim.state = { ...sim.state, ...patch };
      }

      // 3) Persist to the active scenario param so future Advise rollouts (which
      //    recompile from scenario params) and the live sim stay consistent.
      const p = (scenario?.params ?? []).find(pp => (pp.key ?? pp.name) === 'spendingExpenseBands');
      if (p && Array.isArray(p.value) && p.value[i]) {
        p.value = p.value.map((b, k) => (k === i ? { ...b, monthlyAmount: amount } : b));
      }
      return true;
    },
  },

  ROTH: {
    key:     'ROTH',
    label:   'Roth Conversion Ceiling',
    numeric: true,                       // continuous income-fill target ($, real base-year)
    // Range is in REAL base-year (2025) USD ordinary-income fill level (design 39
    // §12.2). 0 = OFF (no conversion this year); the cap spans up to the top
    // brackets. The toolset compounds the target to the year's nominal ceiling.
    defaultRange: { min: 0, max: 500_000, step: 5_000 },
    liveActuatable: true,                // forward-effective live re-wire (Step 10)
    appliesTo: (bp) => bp?.rothConversionEnabled === true,
    requirement: 'Enable Roth conversions (Scenario panel) to use this lever.',
    // Per-year schedule needs an entry (with its `year`) for the year at "now"
    // before the solver can tune its incomeTarget — `set()` never creates nodes.
    // Append (preserving prior committed years) and keep chronological so the
    // entry index is stable. Idempotent.
    prepareBaseParams: ({ baseParams, asOf }) => {
      if (!asOf) return baseParams;
      const year  = new Date(asOf).getUTCFullYear();
      const sched = Array.isArray(baseParams?.rothConversionSchedule)
        ? baseParams.rothConversionSchedule.slice()
        : [];
      if (!sched.some(e => e?.year === year)) sched.push({ year, incomeTarget: 0 });
      sched.sort((a, b) => (a?.year ?? 0) - (b?.year ?? 0));
      return { ...baseParams, rothConversionSchedule: sched };
    },
    buildVariables: ({ baseParams, range, asOf }) => {
      // Decide THIS year's income-fill target (annual epoch, §6). The receding-
      // horizon loop re-decides each subsequent year as "now" advances.
      const year  = asOf ? new Date(asOf).getUTCFullYear() : null;
      const sched = baseParams?.rothConversionSchedule ?? [];
      const found = year != null ? sched.findIndex(e => e?.year === year) : -1;
      const idx   = found >= 0 ? found : Math.max(0, sched.length - 1);
      return [{
        paramKey: `rothConversionSchedule[${idx}].incomeTarget`,
        type: OPT_PARAM_TYPES.CONTINUOUS,
        min:  range?.min  ?? 0,
        max:  range?.max  ?? 500_000,
        step: range?.step ?? 5_000,
        group: 'Roth', _year: year,
      }];
    },
    describe: (candidate, vars) => {
      const v = vars?.[0];
      const t = v ? candidate?.[v.paramKey] : null;
      if (t == null || t <= 0) return 'No Roth conversion this year';
      const br = _bracketLabelForRealIncome(t);
      return br
        ? `Fill ordinary income to ${fmtUsd(t)}/yr (real) — ${br}`
        : `Fill ordinary income to ${fmtUsd(t)}/yr (real)`;
    },
    /**
     * Forward-effective live actuation (design 39 Step 10). Unlike SPENDING (a
     * persistent reducer), Roth conversion is driven by scheduled
     * ROTH_CONVERSION_POLICY_EVALUATE events, and SimulationSync's event-update
     * path unschedules by *type* (would wipe every year's conversion). So we
     * re-wire directly:
     *   1) update the FUTURE queued conversion events for the now-year to the new
     *      nominal target (real→nominal by the toolset's inflation path), leaving
     *      the realized past (already-fired events) and other years untouched —
     *      the snapshot carries this mutated queue, so the next Advise stays
     *      consistent; and
     *   2) persist the chosen real target into the active scenario's
     *      rothConversionSchedule param (create/update the now-year entry) so a
     *      Rebuild and recompiled rollouts reflect it (mirrors SPENDING).
     * Returns true when it changed a live queued conversion event.
     */
    actuate: ({ services, scenario, candidate, vars }) => {
      const v = vars?.[0];
      if (!v) return false;
      const realTarget = candidate?.[v.paramKey];
      const year       = v._year ?? null;
      if (realTarget == null || year == null) return false;

      const paramOf = (key) => (scenario?.params ?? []).find(pp => (pp.key ?? pp.name) === key);

      // 1) Persist the real base-year target to the scenario schedule param.
      const p = paramOf('rothConversionSchedule');
      if (p) {
        const sched = Array.isArray(p.value) ? p.value.slice() : [];
        const idx   = sched.findIndex(e => e?.year === year);
        if (idx >= 0) sched[idx] = { ...sched[idx], incomeTarget: realTarget };
        else          sched.push({ year, incomeTarget: realTarget });
        sched.sort((a, b) => (a?.year ?? 0) - (b?.year ?? 0));
        p.value = sched;
      }

      // 2) Live re-wire: mutate the future queued conversion events for the year.
      const sim = services?.simulationRegistry?.getPrimary?.();
      const queue = sim?.queue?.data;
      if (!Array.isArray(queue)) return false;

      const inflationRate = paramOf('inflationRate')?.value ?? 0.03;
      const nominalTarget = realTarget * Math.pow(1 + inflationRate, year - ROTH_BASE_YEAR);
      const nowMs = new Date(sim.currentDate).getTime();

      let hit = 0;
      for (const item of queue) {
        if (item?.type === 'ROTH_CONVERSION_POLICY_EVALUATE'
            && item.data
            && new Date(item.date).getUTCFullYear() === year
            && new Date(item.date).getTime() > nowMs) {
          item.data.targetIncome = nominalTarget;
          hit++;
        }
      }
      return hit > 0;
    },
  },
};

/**
 * CockpitController — the headless brain of the MPC cockpit (design 39 §7).
 *
 * It is the human-in-the-loop counterpart to the autonomous `runMpc`: instead of
 * committing automatically, it exposes the three cockpit verbs over the shared
 * snapshot primitives —
 *   advise()  → solve at "now" and return the recommended move + a fan of
 *               candidate futures (per-step net-worth trajectories) to display;
 *   apply()   → commit a chosen (recommended OR user-overridden) control forward
 *               via apply-forward, recording a DERIVES_FROM decision record;
 *   advance() → roll the committed plan to the next epoch, moving "now" forward.
 *
 * No new simulation primitive — every rollout is an OptimizationProblem seeded
 * from the now-snapshot (Step 1) and the commit is rollForwardWithControls (Step 2).
 */
export class CockpitController {
  constructor({
    simStart,
    simEnd,
    baseParams  = {},
    cfgTemplate = null,
    objective    = OPTIMIZATION_OBJECTIVES.DIE_WITH_TARGET,
    control      = COCKPIT_CONTROLS.SPENDING,
    controlRange = null,       // { min, max, step } for numeric levers; null = spec default
    graph        = null,       // optional Graph for DERIVES_FROM recording
    parentId     = null,       // parent scenario id for the audit trail
  } = {}) {
    this.simStart     = simStart;
    this.simEnd       = simEnd;
    this.baseParams   = { ...baseParams };
    this.committed    = { ...baseParams };
    this.cfgTemplate  = cfgTemplate;
    this.objective    = objective;
    this.control      = control;
    this.controlRange = controlRange;
    this.graph        = graph;
    this.parentId     = parentId;

    this.snapshot    = null;   // the "now"
    this.lastAdvice  = null;
    this._applyCount = 0;
  }

  setObjective(objective) { this.objective = objective; }
  setControl(control)     { this.control = control; }
  setControlRange(range)  { this.controlRange = range; }

  /** Seed "now" from a SimulationHistory-shaped snapshot ({ date, state, queue, rngState }). */
  setSnapshot(snapshot) { this.snapshot = snapshot; return this; }

  /**
   * Scaffold `committed` for controls that need pre-existing param structure
   * before the solver/apply can address it (e.g. ROTH needs a schedule entry for
   * the year at "now" — `set()` never creates nodes). Idempotent; no-op for
   * controls without a `prepareBaseParams` hook.
   */
  _prepareControl() {
    if (this.control?.prepareBaseParams && this.snapshot) {
      this.committed = this.control.prepareBaseParams({
        baseParams: this.committed,
        asOf:       this.snapshot.date,
      });
    }
  }

  /** The control variables for the current epoch, sized to the realized "now". */
  _variables() {
    return this.control.buildVariables({
      asOf:       this.snapshot?.date,
      state:      this.snapshot?.state,
      baseParams: this.committed,
      range:      this.controlRange ?? this.control.defaultRange ?? null,
    }) ?? [];
  }

  _problem(variables) {
    return new OptimizationProblem({
      variables,
      baseParams:   this.committed,
      objective:    this.objective,
      simStart:     this.simStart,
      simEnd:       this.simEnd,
      initialState: { kind: 'snapshot', snapshot: this.snapshot, cfgTemplate: this.cfgTemplate },
    });
  }

  /**
   * Solve at "now" and build the cockpit payload: the recommended move, the
   * ranked candidate set, and a fan of per-step net-worth trajectories.
   *
   * @returns {Promise<{
   *   now: { date: Date, netWorth: number },
   *   recommended: { candidate, result, score, label },
   *   candidates: Array<{ candidate, result, score }>,
   *   fan: Array<{ candidate, dates: Date[], netWorth: number[], recommended: boolean }>,
   * }>}
   */
  async advise({ solverKey = 'CEM', solverOptions = {}, fanSize = 5, seriesPoints = 24 } = {}) {
    if (!this.snapshot) throw new Error('CockpitController.advise: call setSnapshot(now) first');

    this._prepareControl();
    const variables = this._variables();
    const problem   = this._problem(variables);
    const solver    = createSolver(solverKey, solverOptions);
    const solution  = await solver.solve(problem, { ...solverOptions });

    const best = solution.best ?? { candidate: {}, result: null, score: -Infinity };
    const recommended = { ...best, label: this.control.describe(best.candidate, variables) };

    // Fan: per-step trajectories for the top-K distinct candidates (recommended
    // first), so the UI can draw realized-past → diverging futures.
    const top = (solution.candidates ?? []).slice(0, Math.max(1, fanSize));
    const fan = top.map(c => {
      const series = problem.rolloutSeries(c.candidate, { points: seriesPoints });
      return {
        candidate:   c.candidate,
        dates:       series.dates,
        netWorth:    series.netWorth,
        recommended: c.candidate === best.candidate,
      };
    });

    this.lastAdvice = {
      now: { date: this.snapshot.date, netWorth: fan[0]?.netWorth?.[0] ?? null },
      recommended,
      candidates: solution.candidates ?? [],
      fan,
      variables,
    };
    return this.lastAdvice;
  }

  /**
   * Commit a chosen control forward (apply-forward / §5). Accepts the recommended
   * candidate or a user override. Records a DERIVES_FROM decision record (layer
   * 'decision', Step 5c) when a graph is wired. Does NOT advance "now" — the user
   * advances separately.
   *
   * @param {object} candidate
   * @returns {{ result, committedParams, recordId: string|null }}
   */
  apply(candidate) {
    if (!this.snapshot) throw new Error('CockpitController.apply: no snapshot');
    this._prepareControl();
    const { result } = rollForwardWithControls({
      snapshot:      this.snapshot,
      controlParams: candidate ?? {},
      baseParams:    this.committed,
      simStart:      this.simStart,
      simEnd:        this.simEnd,
      cfgTemplate:   this.cfgTemplate,
      objective:     this.objective,
    });

    for (const [k, v] of Object.entries(candidate ?? {})) set(this.committed, k, v);

    let recordId = null;
    if (this.graph) {
      recordId = `mpc:${this._applyCount++}:${+new Date(this.snapshot.date)}`;
      recordDecisionRecord({
        graph: this.graph, parentId: this.parentId, id: recordId,
        name: this.control.describe(candidate ?? {}, this._variables()),
        controlParams: candidate, asOfDate: this.snapshot.date,
        simStart: this.simStart, simEnd: this.simEnd, result,
      });
    }
    return { result, committedParams: { ...this.committed }, recordId };
  }

  /**
   * Advance "now" to a later date by rolling the committed plan forward from the
   * current snapshot. Updates the snapshot and returns it.
   */
  advance(toDate) {
    if (!this.snapshot) throw new Error('CockpitController.advance: no snapshot');
    const problem = new OptimizationProblem({
      variables:    [],
      baseParams:   this.committed,
      simStart:     this.simStart,
      simEnd:       this.simEnd,
      initialState: { kind: 'snapshot', snapshot: this.snapshot, cfgTemplate: this.cfgTemplate },
    });
    this.snapshot   = problem.rollToSnapshot({}, toDate);
    this.lastAdvice = null;
    return this.snapshot;
  }

  /**
   * Autopilot (design 39 — "auto" cockpit mode): chain advise → apply(recommended)
   * → advance, epoch by epoch, until "now" reaches `simEnd`. This is the headless,
   * projection-only loop — it commits the recommendation into `this.committed` and
   * rolls the committed plan forward, exactly as a user clicking Apply+Advance each
   * year would, but with no override and no human pause. (The live cockpit drives
   * its own loop so it can actuate the real sim + repaint between epochs.)
   *
   * @param {object}   opts
   * @param {string}  [opts.solverKey='CEM']
   * @param {object}  [opts.solverOptions={}]
   * @param {number}  [opts.stepYears=1]   - epoch cadence (years per advance).
   * @param {function}[opts.shouldStop]    - () => boolean cancel hook, checked each epoch.
   * @param {function}[opts.onEpoch]       - optional async ({ epoch, date, candidate, advice, applied }) callback.
   * @returns {Promise<Array<{ epoch, date, candidate, advice, applied }>>} the epoch log.
   */
  async autoRun({ solverKey = 'CEM', solverOptions = {}, stepYears = 1, shouldStop = null, onEpoch = null } = {}) {
    if (!this.snapshot) throw new Error('CockpitController.autoRun: call setSnapshot(now) first');
    const endMs = +new Date(this.simEnd);
    const log = [];
    let epoch = 0;

    while (+new Date(this.snapshot.date) < endMs) {
      if (shouldStop && shouldStop()) break;

      const advice    = await this.advise({ solverKey, solverOptions });
      const candidate = advice.recommended?.candidate ?? {};
      const date      = this.snapshot.date;
      const applied   = this.apply(candidate);
      const record    = { epoch, date, candidate, advice, applied };
      log.push(record);
      if (onEpoch) await onEpoch(record);

      const next   = DateUtils.addYears(new Date(this.snapshot.date), stepYears);
      const toDate = +next > endMs ? new Date(this.simEnd) : next;
      this.advance(toDate);
      epoch++;
    }
    return log;
  }
}

function fmtUsd(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

// Base year for the Roth income-target schedule (matches the toolset's
// BRACKET_BASE_YEAR / usBracketGrossIncomeCeiling): real targets are quoted in
// this year's USD and compounded by inflation to a year's nominal ceiling.
const ROTH_BASE_YEAR = 2025;

// Marginal MFJ bracket a REAL (base-year) ordinary income lands in, for the
// recommended-move card. Real target vs base-year brackets is inflation-free:
// both the target and the statutory edges deflate by the same factor (§12.2).
const _US_RATES_2025 = new UsTaxRates2025();
function _bracketLabelForRealIncome(realIncome) {
  const taxable = realIncome - _US_RATES_2025._stdDeduction_mfj;
  if (!(taxable > 0)) return null;
  let rate = _US_RATES_2025._brackets_mfj[0]?.[1] ?? null;
  for (const [threshold, r] of _US_RATES_2025._brackets_mfj) {
    if (taxable >= threshold) rate = r; else break;
  }
  return rate == null ? null : `${Math.round(rate * 100)}% bracket`;
}

/** True when `strategy` (array or string) includes `key`. */
function _hasStrategy(strategy, key) {
  if (Array.isArray(strategy)) return strategy.includes(key);
  return strategy === key;
}

/** Whole years of age at `asOf`, from the snapshot's primary person (mirrors the reducer). */
function _personAgeAt(asOf, state) {
  if (!asOf || !state) return null;
  const people = state.people ?? {};
  const bd = people[Object.keys(people)[0]]?.birthDate ?? state.personBirthDate;
  if (!bd) return null;
  const d = new Date(asOf), b = new Date(bd);
  const years = d.getUTCFullYear() - b.getUTCFullYear();
  const hadBirthday = d.getUTCMonth() > b.getUTCMonth()
    || (d.getUTCMonth() === b.getUTCMonth() && d.getUTCDate() >= b.getUTCDate());
  return hadBirthday ? years : years - 1;
}

/**
 * The band the spending decision should target at "now": the last band whose
 * startAge ≤ age (the one currently in effect), else the first band (the soonest
 * upcoming decision), else — when age is unknown — the last band.
 */
function _activeBandIndex(bands, asOf, state) {
  const age = _personAgeAt(asOf, state);
  if (age == null) return Math.max(0, bands.length - 1);
  let idx = -1;
  for (let k = 0; k < bands.length; k++) {
    if (age >= (bands[k].startAge ?? -Infinity)) idx = k; else break;
  }
  return idx >= 0 ? idx : 0;
}
