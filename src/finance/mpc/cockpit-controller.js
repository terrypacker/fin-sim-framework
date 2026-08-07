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
import { OPTIMIZATION_OBJECTIVES, objectivePrimaryMetric, infeasibilityOf }
  from '../optimization/optimization-objectives.js';
import { createSolver }            from '../optimization/solvers/solver-registry.js';
import { OPT_PARAM_TYPES }         from '../optimization/optimization-objectives.js';
import { rollForwardWithControls, recordDecisionRecord } from './apply-forward.js';
import { repinExpensesIfChanged }  from '../spending/strategies/explicit-bands-spending-reducer.js';
import { retargetRothConversionEvents, BRACKET_BASE_YEAR } from '../../scenarios/toolsets/us-roth-conversion-toolset.js';
import { retargetEarlyWithdrawalEvents } from '../../scenarios/toolsets/us-early-withdrawal-toolset.js';
import { set }                     from '../monte-carlo/mc-param-paths.js';
import { DateUtils }               from '../../simulation-framework/date-utils.js';
import { usRatesForYear }         from '../tax-settle-service.js';
import { synthesizeWeightedPriorities } from '../../scenarios/scenario-loader.js';
import {
  DRAWDOWN_WEIGHT_ROLES, DRAWDOWN_CASH_ROLES, DEFAULT_DRAWDOWN_WEIGHTS,
  DRAWDOWN_WEIGHT_PREFIX, DRAWDOWN_WEIGHT_SEP, DRAWDOWN_WEIGHT_MODE,
  DRAWDOWN_ROLE_LABELS, drawdownWeightKey,
  ALLOC_WEIGHT_CLASSES, ALLOC_WEIGHT_CLASS_LABELS, allocWeightKey,
  ALLOCATION_OPTIMIZED_MODE, synthesizeTargetAllocation, presentAllocations,
} from '../../scenarios/intl-retirement-scenario.js';
import {
  DRAWDOWN_SLEEVE_CLASSES, SLEEVE_WEIGHT_MODE, sleeveWeightKey,
} from '../holdings/holdings-selection.js';
import { ALLOCATION_SCHEDULE }      from '../behavioral/rebalance-to-target-reducer.js';
import { HARVEST_FORMS, collapseConsecutive, ageAt, requiresIncludes } from './harvest.js';

/**
 * The set of account roles actually present in a live sim state — every entry
 * that looks like an account (an object carrying a `role`). Used to prune the
 * Lever-B drawdown-weight lever to roles an account backs (design 58 build-time
 * filter), so the online path matches the compile cascade.
 */
function _presentRolesFromState(state) {
  const roles = new Set();
  for (const v of Object.values(state ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && v.role) roles.add(v.role);
  }
  return roles;
}

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
      // When the targeted band starts in the FUTURE (age below every startAge —
      // _activeBandIndex's "soonest upcoming decision" fallback), the amount does
      // NOT bite at "now": it takes effect the year the person reaches startAge.
      // Stamp that so describe/describeRecord annotate the right year and say so.
      const startAge  = bands[i]?.startAge ?? null;
      const effective = _bandEffectiveYear(bands, i, asOf, state);
      return [{
        paramKey: `spendingExpenseBands[${i}].monthlyAmount`,
        type: OPT_PARAM_TYPES.INTEGER,
        min:  range?.min  ?? 3000,
        max:  range?.max  ?? 12000,
        step: range?.step ?? 500,
        group: 'Spending', _bandIndex: i,
        _startAge: startAge, _effectiveYear: effective.year, _future: effective.future,
      }];
    },
    describe: (candidate, vars, ctx) => {
      const v = vars[0];
      const real = candidate[v.paramKey];
      // The band amount is REAL base-year USD; the reducer compounds it to nominal
      // by inflationAccumulator (explicit-bands-spending-reducer.js). Show both so
      // a late-life "$8,000" isn't misread as a nominal collapse — and nominalize
      // at the year the band ACTUALLY starts, not at "now".
      return `Set monthly spend${_bandWhen(v)} to ${fmtUsd(real)}${_nominalSuffix(real, _effectiveYear(v, ctx), ctx, '/mo')}`;
    },
    // The save-points log is a record of what applied AT that date, so it reads the
    // single nominal amount the plan actually spent then — no real/nominal pairing.
    describeRecord: (candidate, vars, ctx) => {
      const v = vars[0];
      return `Set monthly spend${_bandWhen(v)} to ${fmtUsd(_toNominal(candidate[v.paramKey], _effectiveYear(v, ctx), ctx))}/mo`;
    },
    liveActuatable: true,
    // EnumMulti: the strategy list must CONTAIN the mode, not be replaced by it
    // (that would silently drop the user's other active spending strategies).
    harvestRequires: { spendingStrategy: requiresIncludes('EXPLICIT_BANDS') },
    /**
     * SCHEDULE bake (design 39 §13.6.1) — the run's per-epoch amounts become the
     * band table, which is already an age-keyed step schedule.
     *
     * The lever tunes the band ACTIVE AT "now", so each epoch's committed amount
     * is what the plan spent from that epoch until the next decision — exactly a
     * band boundary. Rules:
     *   - one { startAge, monthlyAmount } per epoch, `startAge` = the primary's
     *     age at asOfDate (or the targeted band's own startAge when the decision
     *     was aimed at a band not yet entered — then it bites at that age, not now);
     *   - consecutive equal amounts collapse (|Δ| ≤ ε, default $1);
     *   - two epochs in the same age-year: last wins;
     *   - bands starting BELOW the first epoch's age are PRESERVED — that is the
     *     pre-MPC plan for the realized past, which the run never re-decided.
     * Units pass through unchanged: lever, param and reducer all speak real
     * base-year USD.
     */
    harvest: ({ epochs, baseParams, birth, epsilon }) => {
      const eps  = epsilon?.spending ?? 1;
      const warnings = [];
      const points = [];
      for (const e of epochs) {
        const v = e.vars?.[0];
        const amount = v ? e.candidate?.[v.paramKey] : undefined;
        if (!Number.isFinite(Number(amount))) continue;
        // A decision aimed at a band the person has NOT yet entered takes effect
        // at that band's startAge (the cockpit stamps `_future`/`_startAge`), so
        // key it there rather than at "now".
        const age = (v?._future && Number.isFinite(v?._startAge))
          ? v._startAge
          : ageAt(birth?.birthDate, e.asOfDate);
        if (!Number.isFinite(age)) continue;
        // Same age-year → last wins.
        if (points.length && points[points.length - 1].key === age) points.pop();
        points.push({ key: age, value: Number(amount) });
      }
      if (!points.length) {
        return { form: HARVEST_FORMS.SCHEDULE, params: {}, warnings:
          ['Monthly Spending: no dated decisions could be keyed to an age (missing birth date?) — nothing harvested.'] };
      }

      const collapsed = collapseConsecutive(points, (a, b) => Math.abs(a - b), eps);
      const firstAge  = collapsed[0].key;
      // Preserve the pre-MPC plan for ages the run never re-decided.
      const prior = (Array.isArray(baseParams?.spendingExpenseBands) ? baseParams.spendingExpenseBands : [])
        .filter(b => Number.isFinite(b?.startAge) && b.startAge < firstAge)
        .map(b => ({ ...b }));
      const bands = [
        ...prior,
        ...collapsed.map(p => ({ startAge: p.key, monthlyAmount: p.value })),
      ].sort((a, b) => a.startAge - b.startAge);

      if (collapsed.length < points.length) {
        warnings.push(`Monthly Spending: ${points.length} decisions collapsed to ${collapsed.length} band(s) `
          + `(consecutive amounts within $${eps}).`);
      }
      return {
        form: HARVEST_FORMS.SCHEDULE,
        params: { spendingExpenseBands: bands },
        labels: { spendingExpenseBands:
          collapsed.map(p => `age ${p.key} ${fmtUsd(p.value)}`).join(' · ') },
        varied: { spendingExpenseBands: collapsed.length > 1 },
        warnings,
      };
    },
    /**
     * Forward-effective LIVE-VALUE SYNC (design 39 Step 5b / Phase B; §13 H3):
     * re-wire the running ExplicitBandsSpendingReducer's band amount and mirror it
     * onto the active scenario param so the next Advise rollout — which recompiles
     * from params — sees the live plan. This is NOT the persistence path: it keeps
     * projection and live sim consistent within a run, and leaves only the LAST
     * epoch's amount on one band. Baking the run into a re-runnable scenario is
     * `harvest` above (§13.1's table is the record of the difference).
     * The realized past (journal/state) is untouched; the change bites at the next
     * period advance via the reducer's appliedAmount re-pin. Returns true when it
     * actually hit the live plan.
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
      // The NEXT actionable conversion year — not the calendar year of "now": at
      // Dec 31 the year's conversion date (default Dec 1) has already passed, so
      // tuning it is inert (design 42). Pick the next year whose date is future.
      const year  = _nextConversionYear(asOf, baseParams);
      const sched = Array.isArray(baseParams?.rothConversionSchedule)
        ? baseParams.rothConversionSchedule.slice()
        : [];
      if (!sched.some(e => e?.year === year)) sched.push({ year, incomeTarget: 0 });
      sched.sort((a, b) => (a?.year ?? 0) - (b?.year ?? 0));
      return { ...baseParams, rothConversionSchedule: sched };
    },
    buildVariables: ({ baseParams, range, asOf, state }) => {
      // Decide the NEXT actionable year's income-fill target (annual epoch, §6;
      // next-future-date year, design 42). The receding-horizon loop re-decides
      // each subsequent year as "now" advances.
      const year  = asOf ? _nextConversionYear(asOf, baseParams) : null;
      const sched = baseParams?.rothConversionSchedule ?? [];
      const found = year != null ? sched.findIndex(e => e?.year === year) : -1;
      const idx   = found >= 0 ? found : Math.max(0, sched.length - 1);

      // Cap the search to what the IRA(s) can ACTUALLY convert this year so the
      // cockpit never recommends filling income to a level no dollar of which is
      // reachable. The policy handler converts min(nominalTarget − ordIncomeYTD,
      // iraBalance) per owner; any target beyond that headroom is inert. Once the
      // convertible IRA is drained the cap is ~0, so the recommendation collapses
      // to "no conversion this year" instead of a degenerate top-of-range fill the
      // handler would no-op anyway (the flat-objective artifact). Infinity = no
      // state ⇒ preserve the user's range unchanged.
      const userMin = range?.min ?? 0;
      const userMax = range?.max ?? 500_000;
      const reachable = _convertibleRealCap(state, baseParams, year);
      const max = Math.max(0, Math.min(userMax, reachable));
      const min = Math.min(userMin, max);   // keep min ≤ max when the cap bites
      return [{
        paramKey: `rothConversionSchedule[${idx}].incomeTarget`,
        type: OPT_PARAM_TYPES.CONTINUOUS,
        min, max,
        step: range?.step ?? 5_000,
        group: 'Roth', _year: year,
      }];
    },
    describe: (candidate, vars, ctx) => {
      const v = vars?.[0];
      const t = v ? candidate?.[v.paramKey] : null;
      if (t == null || t <= 0) return 'No Roth conversion this year';
      const br = _bracketLabelForRealIncome(t);
      // The target is REAL base-year USD; the toolset compounds it to the YEAR's
      // nominal ceiling. Annotate with that nominal value (keyed off the event year,
      // not "now") so a late-life "$100,000" isn't misread as today's dollars.
      const suffix = _nominalSuffix(t, v?._year, ctx, '/yr');
      return br
        ? `Fill ordinary income to ${fmtUsd(t)}/yr (real) — ${br}${suffix}`
        : `Fill ordinary income to ${fmtUsd(t)}/yr (real)${suffix}`;
    },
    // Save-points log: the nominal ceiling the conversion actually filled to at the
    // event year (mirrors SPENDING.describeRecord — no real/nominal pairing).
    describeRecord: (candidate, vars, ctx) => {
      const v = vars?.[0];
      const t = v ? candidate?.[v.paramKey] : null;
      if (t == null || t <= 0) return 'No Roth conversion this year';
      return `Fill ordinary income to ${fmtUsd(_toNominal(t, v?._year, ctx))}/yr`;
    },
    harvestRequires: { rothConversionEnabled: true },
    /**
     * SCHEDULE bake (design 39 §13.6.2) — the union of every epoch's decided year,
     * positive targets only (absence == skip-year, matching the toolset).
     *
     * This is already the shape `actuate` accumulates, so the harvest is
     * IDEMPOTENT here — it re-derives the schedule from the log rather than
     * trusting the side effect, which also covers the case where the user edited
     * or reverted the param mid-run.
     */
    harvest: ({ epochs }) => {
      const byYear = new Map();
      let dropped = 0;
      for (const e of epochs) {
        const v = e.vars?.[0];
        const year   = v?._year;
        const target = v ? e.candidate?.[v.paramKey] : undefined;
        if (!Number.isFinite(year) || !Number.isFinite(Number(target))) continue;
        if (Number(target) > 0) byYear.set(year, Number(target));
        else { byYear.delete(year); dropped++; }     // decided NOT to convert
      }
      const sched = [...byYear.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([year, incomeTarget]) => ({ year, incomeTarget }));
      const warnings = [];
      if (!sched.length) {
        warnings.push('Roth Conversion: every epoch decided against converting — the harvested schedule is empty '
          + '(the scenario falls back to its start/end window on the next Rebuild).');
      }
      return {
        form: HARVEST_FORMS.SCHEDULE,
        params: { rothConversionSchedule: sched },
        labels: { rothConversionSchedule: sched.length
          ? `${sched.length} year(s): ${sched.slice(0, 3).map(s => `${s.year} ${fmtUsd(s.incomeTarget)}`).join(' · ')}`
            + (sched.length > 3 ? ' …' : '')
          : 'no conversion years' },
        varied: { rothConversionSchedule: sched.length > 1 },
        warnings: dropped ? [...warnings,
          `Roth Conversion: ${dropped} skip-year decision(s) recorded as "no conversion" (year omitted).`] : warnings,
      };
    },
    /**
     * Forward-effective LIVE-VALUE SYNC (design 39 Step 10; §13 H3). Unlike
     * SPENDING (a persistent reducer), Roth conversion is driven by scheduled
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
      //    A non-positive target is "no conversion this year", which the toolset
      //    already represents by the YEAR BEING ABSENT (skip-year). So don't append
      //    a redundant 0-entry — that's exactly the per-year clutter the cockpit
      //    used to pile up once the IRA was drained. We still clear a pre-existing
      //    entry for the year so a previously committed conversion is cancelled.
      const p = paramOf('rothConversionSchedule');
      if (p) {
        const sched = Array.isArray(p.value) ? p.value.slice() : [];
        const idx   = sched.findIndex(e => e?.year === year);
        if (realTarget > 0) {
          if (idx >= 0) sched[idx] = { ...sched[idx], incomeTarget: realTarget };
          else          sched.push({ year, incomeTarget: realTarget });
        } else if (idx >= 0) {
          sched.splice(idx, 1);   // cancel a prior conversion; absence == skip-year
        }
        sched.sort((a, b) => (a?.year ?? 0) - (b?.year ?? 0));
        p.value = sched;
      }

      // 2) Live re-wire: mutate the future queued conversion events for the year,
      //    via the SAME shared helper the advise rollout uses (advise == apply).
      const sim = services?.simulationRegistry?.getPrimary?.();
      const queue = sim?.queue?.data;
      if (!Array.isArray(queue)) return false;

      const hits = retargetRothConversionEvents(queue, [{ year, incomeTarget: realTarget }], {
        inflationRate: paramOf('inflationRate')?.value ?? 0.03,
        nowMs:         new Date(sim.currentDate).getTime(),
      });
      return hits > 0;
    },
  },

  EARLY_WITHDRAWAL: {
    key:     'EARLY_WITHDRAWAL',
    label:   'Early Withdrawal (Decant)',
    numeric: true,
    // Two control variables — tax-deferred and Roth GROSS draw, real base-year USD
    // (the toolset compounds to the year's nominal). 0 = OFF for the class.
    defaultRange: { min: 0, max: 500_000, step: 5_000 },
    liveActuatable: true,
    // Enabling is necessary but NOT sufficient: the toolset's schedules() only
    // seeds tunable SCHEDULED_EARLY_WITHDRAWAL events when there's a non-empty
    // schedule OR a valid optimization window (us-early-withdrawal-toolset.js
    // §189). Without events to re-target, the lever advises moves it can't
    // execute (save-point text ≠ behavior). Mirror that gate here so the cockpit
    // refuses the inert case and surfaces `requirement` — unlike ROTH, whose
    // annual evaluate events exist whenever rothConversionEnabled is true.
    appliesTo: (bp) => bp?.earlyWithdrawalEnabled === true && (
      (Array.isArray(bp?.earlyWithdrawalSchedule) && bp.earlyWithdrawalSchedule.length > 0) ||
      (Number.isFinite(bp?.earlyWithdrawalStartYear) &&
       Number.isFinite(bp?.earlyWithdrawalEndYear) &&
       bp.earlyWithdrawalEndYear >= bp.earlyWithdrawalStartYear)
    ),
    requirement: 'Enable early withdrawals and set an optimization window (Scenario panel) to use this lever.',
    // The next actionable withdrawal year needs a schedule entry before the solver
    // can address its amounts (`set()` never creates nodes). Append + keep
    // chronological so the entry index is stable. Idempotent.
    prepareBaseParams: ({ baseParams, asOf }) => {
      if (!asOf) return baseParams;
      const year  = _nextEarlyWithdrawalYear(asOf, baseParams);
      const sched = Array.isArray(baseParams?.earlyWithdrawalSchedule)
        ? baseParams.earlyWithdrawalSchedule.slice()
        : [];
      if (!sched.some(e => e?.year === year)) sched.push({ year, taxDeferredAmount: 0, rothAmount: 0 });
      sched.sort((a, b) => (a?.year ?? 0) - (b?.year ?? 0));
      return { ...baseParams, earlyWithdrawalSchedule: sched };
    },
    buildVariables: ({ baseParams, range, asOf, state }) => {
      const year  = asOf ? _nextEarlyWithdrawalYear(asOf, baseParams) : null;
      const sched = baseParams?.earlyWithdrawalSchedule ?? [];
      const found = year != null ? sched.findIndex(e => e?.year === year) : -1;
      const idx   = found >= 0 ? found : Math.max(0, sched.length - 1);

      const userMin = range?.min ?? 0;
      const userMax = range?.max ?? 500_000;
      const step    = range?.step ?? 5_000;
      // Cap each class to its drawable balance (real base-year), and to 0 above the
      // age gate where the lever provides no benefit (design 45 §5 / Q6) — mirrors
      // the Roth lever capping to the convertible IRA.
      const caps = _earlyWithdrawalRealCaps(state, baseParams, year);
      const mk = (field, cap) => {
        const max = Math.max(0, Math.min(userMax, cap));
        const min = Math.min(userMin, max);
        return {
          paramKey: `earlyWithdrawalSchedule[${idx}].${field}`,
          type: OPT_PARAM_TYPES.INTEGER,
          min, max, step, group: 'Early Withdrawal', _year: year,
        };
      };
      return [mk('taxDeferredAmount', caps.taxDeferred), mk('rothAmount', caps.roth)];
    },
    describe: (candidate, vars, ctx) => {
      const td = vars?.find(v => v.paramKey.endsWith('.taxDeferredAmount'));
      const rt = vars?.find(v => v.paramKey.endsWith('.rothAmount'));
      const tdAmt = td ? (candidate?.[td.paramKey] ?? 0) : 0;
      const rtAmt = rt ? (candidate?.[rt.paramKey] ?? 0) : 0;
      if (tdAmt <= 0 && rtAmt <= 0) return 'No early withdrawal this year';
      const parts = [];
      if (tdAmt > 0) parts.push(`${fmtUsd(tdAmt)} tax-deferred`);
      if (rtAmt > 0) parts.push(`${fmtUsd(rtAmt)} Roth`);
      // Penalty floor: 10% of the always-penalized tax-deferred draw (Roth
      // contributions are penalty-free, so its penalty depends on the unknown
      // earnings split — shown as a "+").
      const penalty = 0.10 * tdAmt;
      const pen = penalty > 0 ? ` (≈${fmtUsd(penalty)}+ penalty)` : '';
      // Amounts are REAL base-year USD; the toolset compounds them to the event
      // year's nominal gross draw. Annotate the combined draw's nominal value (keyed
      // off the event year) so a late-life real "$50,000" isn't read as today's $.
      const year = td?._year ?? rt?._year ?? null;
      const suffix = _nominalSuffix(tdAmt + rtAmt, year, ctx);
      return `Withdraw ${parts.join(' + ')} early${pen} → brokerage (real $)${suffix}`;
    },
    // Save-points log: the nominal per-class cash that actually left the accounts at
    // the event year (mirrors SPENDING.describeRecord — the audit log records what
    // moved, not the real base-year input).
    describeRecord: (candidate, vars, ctx) => {
      const td = vars?.find(v => v.paramKey.endsWith('.taxDeferredAmount'));
      const rt = vars?.find(v => v.paramKey.endsWith('.rothAmount'));
      const tdAmt = td ? (candidate?.[td.paramKey] ?? 0) : 0;
      const rtAmt = rt ? (candidate?.[rt.paramKey] ?? 0) : 0;
      if (tdAmt <= 0 && rtAmt <= 0) return 'No early withdrawal this year';
      const year = td?._year ?? rt?._year ?? null;
      const parts = [];
      if (tdAmt > 0) parts.push(`${fmtUsd(_toNominal(tdAmt, year, ctx))} tax-deferred`);
      if (rtAmt > 0) parts.push(`${fmtUsd(_toNominal(rtAmt, year, ctx))} Roth`);
      return `Withdraw ${parts.join(' + ')} early → brokerage`;
    },
    harvestRequires: { earlyWithdrawalEnabled: true },
    /**
     * SCHEDULE bake (design 39 §13.6.2) — mirrors ROTH: the union of every epoch's
     * decided year, entries with any positive class amount only (absence == no
     * withdrawal). Idempotent against `actuate`'s live-value sync.
     */
    harvest: ({ epochs }) => {
      const byYear = new Map();
      for (const e of epochs) {
        const td = e.vars?.find(v => v.paramKey.endsWith('.taxDeferredAmount'));
        const rt = e.vars?.find(v => v.paramKey.endsWith('.rothAmount'));
        const year = td?._year ?? rt?._year ?? null;
        if (!Number.isFinite(year)) continue;
        const tdAmt = td ? Number(e.candidate?.[td.paramKey] ?? 0) : 0;
        const rtAmt = rt ? Number(e.candidate?.[rt.paramKey] ?? 0) : 0;
        if (tdAmt > 0 || rtAmt > 0) byYear.set(year, { year, taxDeferredAmount: tdAmt, rothAmount: rtAmt });
        else byYear.delete(year);
      }
      const sched = [...byYear.values()].sort((a, b) => a.year - b.year);
      return {
        form: HARVEST_FORMS.SCHEDULE,
        params: { earlyWithdrawalSchedule: sched },
        labels: { earlyWithdrawalSchedule: sched.length
          ? `${sched.length} year(s): ${sched.slice(0, 3).map(s =>
              `${s.year} ${fmtUsd(s.taxDeferredAmount + s.rothAmount)}`).join(' · ')}`
            + (sched.length > 3 ? ' …' : '')
          : 'no withdrawal years' },
        varied: { earlyWithdrawalSchedule: sched.length > 1 },
        warnings: sched.length ? [] :
          ['Early Withdrawal: every epoch decided against withdrawing — the harvested schedule is empty.'],
      };
    },
    /**
     * Forward-effective LIVE-VALUE SYNC (design 45 Phase 3; §13 H3), mirroring
     * ROTH: (1) mirror the chosen real per-class amounts onto the scenario's
     * earlyWithdrawalSchedule param, and (2) re-wire the future queued
     * SCHEDULED_EARLY_WITHDRAWAL events for the year via the SAME shared helper the
     * rollout uses (advise == apply). Returns true when it moved a live event.
     */
    actuate: ({ services, scenario, candidate, vars }) => {
      const td = vars?.find(v => v.paramKey.endsWith('.taxDeferredAmount'));
      const rt = vars?.find(v => v.paramKey.endsWith('.rothAmount'));
      const year = td?._year ?? rt?._year ?? null;
      if (year == null) return false;
      const tdAmt = td ? (candidate?.[td.paramKey] ?? 0) : 0;
      const rtAmt = rt ? (candidate?.[rt.paramKey] ?? 0) : 0;

      const paramOf = (key) => (scenario?.params ?? []).find(pp => (pp.key ?? pp.name) === key);

      // 1) Persist the real amounts to the scenario schedule param. Both ≤ 0 cancels
      //    a prior entry (absence == no withdrawal), so no-op years don't clutter it.
      const p = paramOf('earlyWithdrawalSchedule');
      if (p) {
        const sched = Array.isArray(p.value) ? p.value.slice() : [];
        const idx   = sched.findIndex(e => e?.year === year);
        if (tdAmt > 0 || rtAmt > 0) {
          const entry = { year, taxDeferredAmount: tdAmt, rothAmount: rtAmt };
          if (idx >= 0) sched[idx] = { ...sched[idx], ...entry };
          else          sched.push(entry);
        } else if (idx >= 0) {
          sched.splice(idx, 1);
        }
        sched.sort((a, b) => (a?.year ?? 0) - (b?.year ?? 0));
        p.value = sched;
      }

      // 2) Live re-wire the future queued events for the year (rollout-side twin).
      const sim = services?.simulationRegistry?.getPrimary?.();
      const queue = sim?.queue?.data;
      if (!Array.isArray(queue)) return false;
      const hits = retargetEarlyWithdrawalEvents(queue, [{ year, taxDeferredAmount: tdAmt, rothAmount: rtAmt }], {
        inflationRate: paramOf('inflationRate')?.value ?? 0.03,
        nowMs:         new Date(sim.currentDate).getTime(),
      });
      return hits > 0;
    },
  },

  // ── Cross-border drawdown mode (design 58 §11.3 Phase 1-MPC — Lever A online) ──
  DRAWDOWN_XBORDER: {
    key:     'DRAWDOWN_XBORDER',
    label:   'Cross-Border Drawdown',
    numeric: false,                      // categorical — no min/max/step range
    liveActuatable: true,
    // Always applicable in the cross-border scenario: which country's accounts
    // compete for a draw is a valid decision whenever the plan spans both. The
    // lever is inert only when the horizon never draws across the border — a data
    // condition, not a config one — so there is no scenario-param gate.
    appliesTo: () => true,
    // One categorical decision variable over the state-resident policy field. The
    // solver encodes/decodes ENUMs by index; a 2-value lever is fully covered by a
    // grid/pattern search. AUTO is not a search value — the online lever chooses a
    // concrete behavior (the toolset AUTO coupling is the static default only).
    buildVariables: () => [{
      paramKey: 'crossBorderDrawdown',
      type:     OPT_PARAM_TYPES.ENUM,
      values:   ['LOCAL_FIRST', 'GLOBAL'],
      group:    'Spending',
    }],
    describe: (candidate, vars) => {
      const v = vars?.[0];
      const mode = v ? candidate?.[v.paramKey] : null;
      return mode === 'GLOBAL'
        ? 'Draw across the US↔AU border in one global priority order'
        : 'Drain the current residence country first (LOCAL_FIRST)';
    },
    /**
     * Forward-effective LIVE-VALUE SYNC (design 58 §11.2, leg 3; design 39 §13 H3):
     * re-stamp the running sim's `crossBorderDrawdown` state field so AccountService
     * .replenishSavings honors the committed mode from the next draw, and mirror
     * it onto the active scenario param so future Advise rollouts (which recompile
     * from params) and the live sim agree. NOT the persistence path — over a run it
     * leaves only the LAST epoch's mode; the harvest (§13.6.3, POINT + warning) is
     * what bakes a decision into a re-runnable scenario. The realized past is untouched — the
     * change bites forward, mirroring the projection's `_seededSim` re-stamp.
     */
    actuate: ({ services, scenario, candidate, vars }) => {
      const v = vars?.[0];
      const mode = v ? candidate?.[v.paramKey] : null;
      if (mode !== 'LOCAL_FIRST' && mode !== 'GLOBAL') return false;
      // 1) Re-stamp the live sim state forward-effective.
      const sim = services?.simulationRegistry?.getPrimary?.();
      if (!sim?.state) return false;
      sim.state = { ...sim.state, crossBorderDrawdown: mode };
      // 2) Persist to the active scenario param so Advise/Rebuild stay consistent.
      const p = (scenario?.params ?? []).find(pp => (pp.key ?? pp.name) === 'crossBorderDrawdown');
      if (p) p.value = mode;
      return true;
    },
  },

  // ── Within-tier draw policy (design 58 §11.3 Phase 2-MPC — Lever C online) ─────
  DRAWDOWN_WITHINTIER: {
    key:     'DRAWDOWN_WITHINTIER',
    label:   'Within-Tier Draw',
    numeric: false,                      // categorical — no min/max/step range
    liveActuatable: true,
    // Always applicable: how accounts sharing a drawdown tier split a draw is a
    // valid decision whenever a tier has ≥2 members. Inert only when every tier is
    // a singleton — a data condition, not a config one — so no scenario-param gate.
    appliesTo: () => true,
    buildVariables: () => [{
      paramKey: 'withinTierDraw',
      type:     OPT_PARAM_TYPES.ENUM,
      values:   ['SEQUENTIAL', 'EQUAL', 'PROPORTIONAL'],
      group:    'Spending',
    }],
    describe: (candidate, vars) => {
      const v = vars?.[0];
      switch (v ? candidate?.[v.paramKey] : null) {
        case 'EQUAL':        return 'Split each drawdown tier evenly across its accounts';
        case 'PROPORTIONAL': return 'Split each drawdown tier by account balance';
        default:             return 'Drain one account per tier fully before the next (SEQUENTIAL)';
      }
    },
    /**
     * Forward-effective LIVE-VALUE SYNC (design 58 §11.2, leg 3; design 39 §13 H3):
     * re-stamp the running sim's `withinTierDraw` state field so AccountService
     * .replenishSavings splits shared tiers by the committed policy from the next
     * draw, and mirror it onto the active scenario param. Last-epoch-wins over a
     * run; the harvest (§13.6.3) is the persistence path. Realized past untouched — the projection's
     * `_seededSim` re-stamp is the twin.
     */
    actuate: ({ services, scenario, candidate, vars }) => {
      const v = vars?.[0];
      const mode = v ? candidate?.[v.paramKey] : null;
      if (!['SEQUENTIAL', 'EQUAL', 'PROPORTIONAL'].includes(mode)) return false;
      const sim = services?.simulationRegistry?.getPrimary?.();
      if (!sim?.state) return false;
      sim.state = { ...sim.state, withinTierDraw: mode };
      const p = (scenario?.params ?? []).find(pp => (pp.key ?? pp.name) === 'withinTierDraw');
      if (p) p.value = mode;
      return true;
    },
  },

  // ── Drawdown order weights (design 58 §11.3 Phase 3-MPC — Lever B online) ──────
  // The flagship: each epoch the controller re-solves the drawdown ORDER from the
  // realized state. The order is encoded as one continuous weight per investment
  // role (ascending sort = draw order), so the solver searches the order directly.
  DRAWDOWN_WEIGHTS: {
    key:     'DRAWDOWN_WEIGHTS',
    label:   'Drawdown Order (weights)',
    numeric: true,                       // the [0,1] range applies to every weight
    defaultRange: { min: 0, max: 1, step: 0.05 },
    liveActuatable: true,
    // Only meaningful under the WEIGHTED strategy — the weights synthesize the order
    // only then (every other strategy fixes it). Gate + surface the requirement.
    appliesTo: (bp) => bp?.drawdownStrategy === DRAWDOWN_WEIGHT_MODE,
    requirement: 'Set Drawdown Strategy to WEIGHTED (Scenario panel) to tune the drawdown order online.',
    // No `harvest` hook ⇒ the POINT default (§13.6.3): last-epoch weights + a
    // quantified collapse warning. A faithful bake needs an age-keyed
    // `drawdownWeightSchedule` that does not exist yet (§13.6.5, gated on VoTV).
    harvestRequires: { drawdownStrategy: DRAWDOWN_WEIGHT_MODE },
    // One CONTINUOUS variable per investment role; the draw order is the ascending
    // sort of the committed weights. Same-role siblings share a weight → one tier.
    // One CONTINUOUS variable per investment role an account backs (design 58
    // build-time filter): a phantom role is a flat search dimension and would only
    // clutter the recommended-order card, so prune it from the live search too.
    buildVariables: ({ range, state }) => {
      const present = _presentRolesFromState(state);
      const roles = DRAWDOWN_WEIGHT_ROLES.filter(role => present.size === 0 || present.has(role));
      return roles.map(role => ({
        paramKey: drawdownWeightKey(role),
        type:     OPT_PARAM_TYPES.CONTINUOUS,
        min:      range?.min  ?? 0,
        max:      range?.max  ?? 1,
        step:     range?.step ?? 0.05,
        group:    'Spending', _role: role,
      }));
    },
    describe: (candidate, vars) => {
      // Show the resulting draw order (roles ascending by committed weight).
      const ranked = vars
        .map(v => ({ role: v._role, w: Number(candidate?.[v.paramKey]) }))
        .filter(r => Number.isFinite(r.w))
        .sort((a, b) => a.w - b.w)
        .map(r => DRAWDOWN_ROLE_LABELS[r.role] ?? r.role);
      return ranked.length ? `Draw order: ${ranked.join(' → ')}` : 'Drawdown order unchanged';
    },
    /**
     * Forward-effective LIVE-VALUE SYNC (design 58 §11.3 leg 3; design 39 §13 H3):
     * mirror each committed weight onto its scenario param, and re-stamp the running sim's
     * per-account `drawdownPriority` from the weights using the SAME role→rank
     * synthesis the compile cascade uses (synthesizeWeightedPriorities) + the
     * configured owner banding — so replenishSavings honors the new order from the
     * next draw. Realized past untouched; the projection's `_seededSim` per-account
     * re-stamp is the twin.
     */
    actuate: ({ services, scenario, candidate, vars }) => {
      if (!vars?.length) return false;
      const sim = services?.simulationRegistry?.getPrimary?.();
      if (!sim?.state) return false;

      // 1) Persist each committed weight to its scenario param.
      for (const v of vars) {
        const w = candidate?.[v.paramKey];
        if (w == null) continue;
        const p = (scenario?.params ?? []).find(pp => (pp.key ?? pp.name) === v.paramKey);
        if (p) p.value = w;
      }

      // 2) Synthesize role → rank from the committed weights (missing roles fall back
      //    to the shipped defaults), then apply owner banding to match the cascade.
      const roleRank = synthesizeWeightedPriorities({
        weightKeyPrefix: DRAWDOWN_WEIGHT_PREFIX, weightKeySep: DRAWDOWN_WEIGHT_SEP,
        weightRoles: DRAWDOWN_WEIGHT_ROLES, cashRoles: DRAWDOWN_CASH_ROLES,
        weightDefaults: DEFAULT_DRAWDOWN_WEIGHTS,
      }, candidate ?? {}, _presentRolesFromState(sim.state));

      const mode = (scenario?.params ?? []).find(pp => (pp.key ?? pp.name) === 'drawdownOwnerOrdering')?.value;
      const ownerOrder  = mode === 'SPOUSE_FIRST' ? ['spouse', 'primary'] : ['primary', 'spouse'];
      const ownerStride = mode === 'POOLED' ? 0 : 100;

      // 3) Re-stamp each drawdown-eligible live account forward-effective.
      const next = { ...sim.state };
      let changed = false;
      for (const [k, acct] of Object.entries(next)) {
        if (!acct || typeof acct !== 'object' || Array.isArray(acct)) continue;
        if (!('drawdownPriority' in acct) || roleRank[acct.role] == null) continue;
        const rank = Math.max(0, ownerOrder.indexOf(acct.ownerId));
        const pr = roleRank[acct.role] + rank * ownerStride;
        if (acct.drawdownPriority !== pr) { next[k] = { ...acct, drawdownPriority: pr }; changed = true; }
      }
      if (changed) sim.state = next;
      return true;
    },
  },

  // ── Drawdown sleeve weights (design 65 Phase 4 — Lever A online) ──────────────
  // Each epoch, re-solve which asset class (sleeve) a spending debit sells first,
  // encoded as one continuous weight per class (ascending sort = sold first). Unlike
  // the design-58 role weights (which bake into per-account drawdownPriority and need
  // a cascade re-stamp), the sleeve policy is a state-resident config the disposal
  // primitive reads fresh each draw — so it bites under MPC with NO `_seededSim`
  // per-account shim (the fields ride FORWARD_DRAWDOWN_STATE_FIELDS). Actuation writes
  // the live state fields directly (verified by `scripts/verify-mpc-lever.mjs drawdownSleeve`).
  DRAWDOWN_SLEEVE: {
    key:     'DRAWDOWN_SLEEVE',
    label:   'Drawdown Sleeve (weights)',
    numeric: true,                       // the [0,1] range applies to every weight
    defaultRange: { min: 0, max: 1, step: 0.05 },
    liveActuatable: true,
    // Meaningful only under the WEIGHTED sleeve order — the weights synthesize the
    // sell order only then (FIFO/TAX_COST/PRESERVE_GROWTH fix it). Gate + surface why.
    appliesTo: (bp) => bp?.drawdownSleeveOrder === SLEEVE_WEIGHT_MODE,
    requirement: 'Set Drawdown Sleeve Order to WEIGHTED (Scenario panel) to tune the sleeve sell order online.',
    harvestRequires: { drawdownSleeveOrder: SLEEVE_WEIGHT_MODE },
    // One CONTINUOUS variable per drawdown sleeve class; the sell order is the
    // ascending sort of the committed weights.
    buildVariables: ({ range }) => DRAWDOWN_SLEEVE_CLASSES.map(cls => ({
      paramKey: sleeveWeightKey(cls),
      type:     OPT_PARAM_TYPES.CONTINUOUS,
      min:      range?.min  ?? 0,
      max:      range?.max  ?? 1,
      step:     range?.step ?? 0.05,
      group:    'Spending', _class: cls,
    })),
    describe: (candidate, vars) => {
      // Show the resulting sell order (classes ascending by committed weight).
      const ranked = vars
        .map(v => ({ cls: v._class, w: Number(candidate?.[v.paramKey]) }))
        .filter(r => Number.isFinite(r.w))
        .sort((a, b) => a.w - b.w)
        .map(r => r.cls);
      return ranked.length ? `Sell order: ${ranked.join(' → ')}` : 'Sleeve order unchanged';
    },
    /**
     * Forward-effective LIVE-VALUE SYNC (design 65 Phase 4; design 39 §13 H3): mirror
     * each committed weight onto its scenario param, then re-wire the running sim's state selection
     * fields (drawdownSleeveOrder=WEIGHTED + drawdownSleeveWeights) so the disposal
     * primitive honors the new sell order from the next draw. No per-account re-stamp
     * (the policy is read fresh from state each draw) — the projection's twin is the
     * FORWARD_DRAWDOWN_STATE_FIELDS forwarding, not a `_seededSim` shim.
     */
    actuate: ({ services, scenario, candidate, vars }) => {
      if (!vars?.length) return false;
      const sim = services?.simulationRegistry?.getPrimary?.();
      if (!sim?.state) return false;

      // 1) Persist each committed weight to its scenario param + collect the map.
      const weights = {};
      for (const v of vars) {
        const w = candidate?.[v.paramKey];
        if (w == null) continue;
        weights[v._class] = w;
        const p = (scenario?.params ?? []).find(pp => (pp.key ?? pp.name) === v.paramKey);
        if (p) p.value = w;
      }
      if (!Object.keys(weights).length) return false;

      // 2) Re-wire the live selection policy (state-resident config read each draw).
      sim.state = {
        ...sim.state,
        drawdownSleeveOrder:   SLEEVE_WEIGHT_MODE,
        drawdownSleeveWeights: { ...(sim.state.drawdownSleeveWeights ?? {}), ...weights },
      };
      return true;
    },
  },

  // ── Allocation mix weights (design 61 Phase 5 — Lever A online, the flagship) ──
  // Each epoch the controller re-solves the target Stock/Bond/Cash/Gold mix from the
  // realized state, encoded as one continuous weight per class (stick-breaking → the
  // applied mix). Unlike the drawdown levers, the target is held in the freshly
  // compiled RebalanceToTargetReducer — NOT a per-account state field — so it survives
  // snapshot injection and bites under MPC with no `_seededSim` re-stamp (verified by
  // `scripts/verify-mpc-lever.mjs allocationMix`). Actuation re-wires the live reducer.
  ALLOCATION_MIX: {
    key:     'ALLOCATION_MIX',
    label:   'Allocation Mix (weights)',
    numeric: true,                       // the [0,1] range applies to every weight
    defaultRange: { min: 0, max: 1, step: 0.05 },
    liveActuatable: true,
    // Meaningful only when the allocation lever is selected AND its strategy is
    // OPTIMIZED (the weights synthesize the target only then). Gate + surface why.
    appliesTo: (bp) => bp?.allocationStrategy === ALLOCATION_OPTIMIZED_MODE
                    && _hasStrategy(bp?.behavioralStrategies, 'TARGET_ALLOCATION'),
    requirement: 'Select the TARGET_ALLOCATION behavioral strategy and set Allocation Strategy to OPTIMIZED (Scenario panel) to tune the mix online.',
    // One CONTINUOUS variable per NON-residual class (the last class is the
    // stick-breaking residual, no param), pruned to the classes reachable in the live
    // state (the design-58 build-time-filter analog; all four are reachable today).
    buildVariables: ({ range }) => {
      // presentAllocations() reports the reachable classes (all four today); the hook
      // is here so a later per-account prune matches buildAllocWeightSchema.
      const present = presentAllocations();
      const classes = ALLOC_WEIGHT_CLASSES.slice(0, -1).filter(c => present.has(c));
      return classes.map(cls => ({
        paramKey: allocWeightKey(cls),
        type:     OPT_PARAM_TYPES.CONTINUOUS,
        min:      range?.min  ?? 0,
        max:      range?.max  ?? 1,
        step:     range?.step ?? 0.05,
        group:    'Allocation', _class: cls,
      }));
    },
    describe: (candidate, vars) => {
      // Render the synthesized target mix (percentages), not the raw stick-breaking
      // weights — the weights aren't directly legible, the mix is.
      const present = new Set(vars.map(v => v._class).filter(Boolean));
      const mix = synthesizeTargetAllocation(candidate, present.size ? present : null);
      const parts = ALLOC_WEIGHT_CLASSES
        .filter(c => (mix[c] ?? 0) > 0.005)
        .map(c => `${ALLOC_WEIGHT_CLASS_LABELS[c] ?? c} ${Math.round((mix[c] ?? 0) * 100)}%`);
      return parts.length ? `Target mix: ${parts.join(' / ')}` : 'Allocation mix unchanged';
    },
    harvestRequires: {
      behavioralStrategies: requiresIncludes('TARGET_ALLOCATION'),
      allocationSchedule:   ALLOCATION_SCHEDULE.GLIDEPATH,
    },
    /**
     * SCHEDULE bake → GLIDEPATH anchors (design 39 §13.6.4; closes design 61 §7 /
     * OQ7). The plant half already exists and was unused: `allocationSchedule =
     * GLIDEPATH` + `allocationGlidepath: [{ age, weights }]`, interpolated by the
     * primary's age in `RebalanceToTargetReducer.resolveScheduledTarget`.
     *
     * Four rules, three load-bearing for fidelity:
     *  1. Anchor the SYNTHESIZED mix (what the run actually held), not the raw
     *     stick-breaking weights — the weights aren't a mix and don't interpolate.
     *  2. ε-collapse on L1 distance over the simplex (default 0.02) — the same
     *     hold-band idea design 61 §7 uses against CGT-churning flip-flop, reused
     *     here to keep the anchor table legible.
     *  3. STEP-FAITHFUL by default. `interpolateGlidepath` BLENDS linearly between
     *     anchors, but the MPC held each mix flat until the next decision. So emit
     *     paired anchors — {age_i, mix_i} and {age_{i+1}−δ, mix_i} — to reproduce
     *     the run. `allocationSmooth` emits one anchor per epoch instead (more
     *     legible, not what the run did); §13.7's verify quantifies the difference.
     *  4. PREPEND a start anchor at the plan's start age carrying the pre-run
     *     static mix. `interpolateGlidepath` CLAMPS below the first anchor, so
     *     without this a from-t₀ re-run would apply the first MPC epoch's mix to
     *     the entire realized past — silently rewriting years the run never decided.
     *
     * The last committed mix is also kept in `allocWeight::*`, the reducer's
     * `targetAllocation` fallback when the glidepath is empty.
     */
    harvest: ({ epochs, baseParams, birth, epsilon, simStart }) => {
      const eps    = epsilon?.allocation ?? 0.02;
      const smooth = epsilon?.allocationSmooth === true;
      const warnings = [];

      const points = [];
      for (const e of epochs) {
        const age = ageAt(birth?.birthDate, e.asOfDate);
        if (!Number.isFinite(age)) continue;
        const present = new Set((e.vars ?? []).map(v => v._class).filter(Boolean));
        const mix = synthesizeTargetAllocation(e.candidate ?? {}, present.size ? present : null);
        if (!mix || !Object.keys(mix).length) continue;
        if (points.length && points[points.length - 1].key === age) points.pop();
        points.push({ key: age, value: mix });
      }
      if (!points.length) {
        return { form: HARVEST_FORMS.SCHEDULE, params: {}, warnings:
          ['Allocation Mix: no dated decisions could be keyed to an age (missing birth date?) — nothing harvested.'] };
      }

      const collapsed = collapseConsecutive(points, _mixL1, eps);
      if (collapsed.length < points.length) {
        warnings.push(`Allocation Mix: ${points.length} decisions collapsed to ${collapsed.length} anchor(s) `
          + `(consecutive mixes within L1 ${eps}).`);
      }

      // (4) Prepend the pre-run mix at the plan's start age, so the clamp below the
      //     first anchor replays the realized past rather than the first decision.
      const anchors = [];
      const startAge = ageAt(birth?.birthDate, simStart);
      const priorMix = _priorTargetMix(baseParams);
      if (Number.isFinite(startAge) && startAge < collapsed[0].key && priorMix) {
        anchors.push({ age: startAge, weights: priorMix });
      } else if (!Number.isFinite(startAge)) {
        warnings.push('Allocation Mix: plan start age unknown — no leading anchor was added, so a re-run '
          + 'applies the first harvested mix to the years before the run started.');
      }

      // (3) Step-faithful pairs, unless the user asked for a smooth glidepath.
      const DELTA = 0.01;   // sub-year shim: hold the mix flat right up to the next anchor
      for (let i = 0; i < collapsed.length; i++) {
        const p = collapsed[i];
        anchors.push({ age: p.key, weights: p.value });
        const next = collapsed[i + 1];
        if (!smooth && next && next.key - p.key > DELTA) {
          anchors.push({ age: +(next.key - DELTA).toFixed(2), weights: p.value });
        }
      }

      // (5) Zeroed-class diagnostics (design 61 §12.1 D5). Both warn; neither edits
      //     the bake, because a corner is a well-formed mix and the controller did
      //     commit it — the reader, not the harvest, decides whether it was meant.
      warnings.push(..._zeroedClassWarnings(collapsed));

      // Keep the last mix in the weight params (the reducer's static fallback).
      const lastEpoch = epochs[epochs.length - 1];
      const weightParams = {};
      for (const v of (lastEpoch?.vars ?? [])) {
        const w = lastEpoch.candidate?.[v.paramKey];
        if (w != null) weightParams[v.paramKey] = w;
      }

      return {
        form: HARVEST_FORMS.SCHEDULE,
        params: { allocationGlidepath: anchors, ...weightParams },
        labels: {
          allocationGlidepath: collapsed.map(p => `age ${p.key} ${_mixLabel(p.value)}`).join(' → '),
        },
        varied: { allocationGlidepath: collapsed.length > 1 },
        warnings,
      };
    },
    /**
     * Forward-effective LIVE-VALUE SYNC (design 61 §7 leg 3; §13 H3): mirror each
     * committed weight onto its scenario param, then re-wire the running RebalanceToTargetReducer's
     * `targetAllocation` to the freshly synthesized mix so the next rebalance honors it.
     * No per-account state re-stamp is needed (the target is reducer-resident), so
     * Advise/Apply/live agree without a projection shim. Realized past untouched.
     */
    actuate: ({ services, scenario, candidate, vars }) => {
      if (!vars?.length) return false;

      // 1) Persist each committed weight to its scenario param.
      for (const v of vars) {
        const w = candidate?.[v.paramKey];
        if (w == null) continue;
        const p = (scenario?.params ?? []).find(pp => (pp.key ?? pp.name) === v.paramKey);
        if (p) p.value = w;
      }

      // 2) Re-wire the live rebalance reducer's target from the committed weights.
      const rs = services?.reducerService;
      const reducer = rs?.getAll?.().find(r => r?.constructor?.type === 'RebalanceToTargetReducer');
      if (!rs || !reducer) return false;
      const present = new Set(vars.map(v => v._class).filter(Boolean));
      const target  = synthesizeTargetAllocation(candidate, present.size ? present : null);
      rs.updateReducer(reducer, { targetAllocation: target });
      return true;
    },
  },

  // ── Bond ladder length (design 66 §G8 Phase C — ladder length online) ─────────
  // Tune how many rungs the maintained bond ladder holds. Like ALLOCATION_MIX the
  // target (rung count) lives on the freshly compiled BondLadderReducer — NOT a state
  // field — so it survives snapshot injection and bites under MPC with no `_seededSim`
  // re-stamp. Actuation re-wires the live reducer; it re-shapes the ladder next period.
  BOND_LADDER: {
    key:     'BOND_LADDER',
    label:   'Bond Ladder Length (rungs)',
    numeric: true,
    defaultRange: { min: 2, max: 15, step: 1 },
    liveActuatable: true,
    appliesTo: (bp) => _hasStrategy(bp?.behavioralStrategies, 'BOND_LADDER'),
    requirement: 'Select the BOND_LADDER behavioral strategy (Scenario panel) to tune the ladder length online.',
    harvestRequires: { behavioralStrategies: requiresIncludes('BOND_LADDER') },
    buildVariables: ({ range }) => [{
      paramKey: 'bondLadderRungs',
      type:     OPT_PARAM_TYPES.INTEGER,
      min:      range?.min  ?? 2,
      max:      range?.max  ?? 15,
      step:     range?.step ?? 1,
      group:    'Allocation',
    }],
    describe: (candidate) => {
      const n = Math.round(Number(candidate?.bondLadderRungs));
      return Number.isFinite(n) ? `Ladder length: ${n} rungs (≈${n}-year)` : 'Ladder length unchanged';
    },
    /**
     * Forward-effective LIVE-VALUE SYNC (design 39 §13 H3): mirror the committed rung
     * count onto its scenario param, then re-wire the running BondLadderReducer's
     * `targetRungs` so it re-shapes
     * the ladder on the next period. Reducer-resident target ⇒ no per-account re-stamp.
     */
    actuate: ({ services, scenario, candidate }) => {
      const n = candidate?.bondLadderRungs;
      if (n == null) return false;
      const p = (scenario?.params ?? []).find(pp => (pp.key ?? pp.name) === 'bondLadderRungs');
      if (p) p.value = n;
      const rs = services?.reducerService;
      const reducer = rs?.getAll?.().find(r => r?.constructor?.type === 'BondLadderReducer');
      if (!rs || !reducer) return false;
      rs.updateReducer(reducer, { targetRungs: Math.round(Number(n)) });
      return true;
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
    // Design 88 D10 / §5.4: the LIQUID terminal, not the worth one. A controller
    // should not be pointed at a quantity it has no lever for — see
    // resolveTerminalKey for the measurement that settled it.
    objective    = OPTIMIZATION_OBJECTIVES.DIE_WITH_TARGET_LIQUID,
    control      = COCKPIT_CONTROLS.SPENDING,
    controls     = null,       // multi-lever set (design 45 Phase 4); null ⇒ [control]
    controlRange = null,       // { min, max, step } for numeric levers; null = spec default
    controlRanges = null,      // per-control { [key]: { min, max, step } } overrides (multi-lever)
    graph        = null,       // optional Graph for DERIVES_FROM recording
    parentId     = null,       // parent scenario id for the audit trail
    horizonYears = null,       // sliding prediction window H (design 41); null = full horizon
    runId        = null,       // cockpit run this controller's epochs belong to (§13.2)
    decisionStore = null,      // optional DecisionRecordRegistry — durable log (§13 H4)
    feasibilityFirst = true,   // solvency outranks reward, always (design 80 U2)
  } = {}) {
    this.simStart     = simStart;
    this.simEnd       = simEnd;
    // DEEP copies, not spreads. `apply()` writes committed values through the
    // path-aware `set()` (e.g. `spendingExpenseBands[0].monthlyAmount`), which
    // mutates the CONTAINER — and a spread shares every nested array/object with
    // the caller. In the cockpit that caller is `_paramsToMap(scenario.params)`,
    // so a shallow copy let each epoch silently rewrite the ACTIVE SCENARIO's
    // band table / schedule entries in place: an undeclared write outside the
    // actuate + harvest paths, which also made the harvest diff's "from" side show
    // the mutated value instead of the pre-run one (found by scripts/lab/verify-harvest.mjs).
    this.baseParams   = _deepCopyParams(baseParams);
    this.committed    = _deepCopyParams(baseParams);
    this.cfgTemplate  = cfgTemplate;
    this.objective    = objective;
    this.feasibilityFirst = feasibilityFirst;
    // Multi-lever (design 45 §8): the controller searches a SET of controls whose
    // decision variables union into one vector and commit together each epoch.
    // `controls` (array) wins; otherwise the single `control` (back-compat). The
    // `control` getter returns the first for legacy single-lever callers.
    this.controls     = Array.isArray(controls) && controls.length ? controls.slice() : [control];
    this.controlRange = controlRange;
    this.controlRanges = controlRanges ?? {};
    this.graph        = graph;
    this.parentId     = parentId;
    this.horizonYears = horizonYears;
    // The cockpit re-creates this controller after every Apply and every clock
    // step, so the run identity CANNOT live here — it is minted by the surface
    // that outlives the epochs (the plugin) and threaded through (§13.2).
    this.runId        = runId;
    this.decisionStore = decisionStore;

    this.snapshot    = null;   // the "now"
    this.lastAdvice  = null;
    this._applyCount = 0;
  }

  setObjective(objective) { this.objective = objective; }
  /** Legacy single-lever read: the first active control. */
  get control()           { return this.controls[0]; }
  setControl(control)     { this.controls = [control]; }
  /** Activate a SET of levers searched jointly (design 45 §8). */
  setControls(controls)   { this.controls = (Array.isArray(controls) && controls.length) ? controls.slice() : this.controls; }
  setControlRange(range)  { this.controlRange = range; }
  /** Per-control range override for the multi-lever search (by control key). */
  setControlRangeFor(key, range) { this.controlRanges = { ...this.controlRanges, [key]: range }; }
  /** Sliding prediction window H in years (design 41); null/0 = full horizon. */
  setHorizonYears(h)      { this.horizonYears = (h == null || h <= 0) ? null : h; }

  /** Seed "now" from a SimulationHistory-shaped snapshot ({ date, state, queue, rngState }). */
  setSnapshot(snapshot) { this.snapshot = snapshot; return this; }

  /**
   * Scaffold `committed` for controls that need pre-existing param structure
   * before the solver/apply can address it (e.g. ROTH needs a schedule entry for
   * the year at "now" — `set()` never creates nodes). Idempotent; no-op for
   * controls without a `prepareBaseParams` hook.
   */
  _prepareControl() {
    if (!this.snapshot) return;
    // Compose every active control's scaffold (design 45 §8.2): each returns a new
    // baseParams; they address distinct schedule params (rothConversionSchedule,
    // earlyWithdrawalSchedule, spendingExpenseBands) so they don't clobber.
    for (const control of this.controls) {
      if (control?.prepareBaseParams) {
        this.committed = control.prepareBaseParams({ baseParams: this.committed, asOf: this.snapshot.date });
      }
    }
  }

  /** The range a control searches: the legacy single range only in single-lever
   *  mode, else a per-control override, else the spec default. */
  _rangeFor(control) {
    if (this.controls.length === 1 && this.controlRange) return this.controlRange;
    return this.controlRanges?.[control.key] ?? control.defaultRange ?? null;
  }

  /**
   * The joint decision vector for the current epoch (design 45 §8.1–§8.2): the
   * union of every active control's variables, each tagged with its `_controlKey`
   * so describe/record can route a candidate back to the control that owns it.
   */
  _variables() {
    const out = [];
    for (const control of this.controls) {
      const vars = control.buildVariables({
        asOf:       this.snapshot?.date,
        state:      this.snapshot?.state,
        baseParams: this.committed,
        range:      this._rangeFor(control),
      }) ?? [];
      for (const v of vars) out.push({ ...v, _controlKey: control.key });
    }
    return out;
  }

  /**
   * Human-legible label for a candidate move, with the inflation context ("now"
   * year + rate) the lever needs to annotate real base-year amounts with their
   * nominal value at "now". Single source for the card, save-points, and Apply.
   */
  describeMove(candidate, variables = this._variables()) {
    const ctx = this._describeCtx();
    if (this.controls.length === 1) return this.controls[0].describe(candidate, variables, ctx);
    return this._describeJoint(candidate, variables, ctx, c => c.describe);
  }

  /**
   * Label for the save-points decision log: the nominal amount that applied at
   * "now" (no real/nominal pairing). Falls back to the card form for controls
   * without a dedicated record description.
   */
  describeRecordMove(candidate, variables = this._variables()) {
    const ctx = this._describeCtx();
    if (this.controls.length === 1) {
      const fn = this.controls[0].describeRecord ?? this.controls[0].describe;
      return fn(candidate, variables, ctx);
    }
    return this._describeJoint(candidate, variables, ctx, c => c.describeRecord ?? c.describe);
  }

  /** Join each active control's label (over its own variable subset) for a
   *  multi-lever move. Drops empty/"no change" labels so the card stays terse. */
  _describeJoint(candidate, variables, ctx, pick) {
    const parts = [];
    for (const control of this.controls) {
      const subset = variables.filter(v => v._controlKey === control.key);
      if (subset.length === 0) continue;
      const label = pick(control)(candidate, subset, ctx);
      if (label && !/^No /.test(label)) parts.push(label);
    }
    return parts.join(' · ');
  }

  /** Inflation context a lever needs to map its real base-year amount to nominal. */
  _describeCtx() {
    return { asOf: this.snapshot?.date, inflationRate: this.committed?.inflationRate };
  }

  _problem(variables) {
    return new OptimizationProblem({
      variables,
      baseParams:   this.committed,
      objective:    this.objective,
      simStart:     this.simStart,
      simEnd:       this.simEnd,
      horizonYears: this.horizonYears,   // sliding window for scoring + fan (design 41)
      initialState: { kind: 'snapshot', snapshot: this.snapshot, cfgTemplate: this.cfgTemplate },
      // Design 80 U2 — solvency outranks reward structurally, so the search cannot
      // drift into the infeasible region the way it did at §2.7's five consecutive
      // failing epochs. Cockpit-only: the OPT panel keeps the plain score unless it
      // opts in, so design-38 results stay byte-identical.
      feasibilityFirst: this.feasibilityFirst,
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
  async advise({ solverKey = 'CEM', solverOptions = {}, workerPool = null, fanSize = 5, seriesPoints = 24 } = {}) {
    if (!this.snapshot) throw new Error('CockpitController.advise: call setSnapshot(now) first');

    this._prepareControl();
    const variables = this._variables();
    const problem   = this._problem(variables);
    const solver    = createSolver(solverKey, solverOptions);
    // `workerPool` (design 46 Phase 0.5) parallelizes a generation's rollouts;
    // batchable solvers (CEM) use it, others ignore it. Bit-identical to sequential.
    const solution  = await solver.solve(problem, { ...solverOptions, workerPool });

    const best = solution.best ?? { candidate: {}, result: null, score: -Infinity };
    const recommended = { ...best, label: this.describeMove(best.candidate, variables) };

    // Fan: per-step trajectories for the top-K distinct candidates (recommended
    // first), so the UI can draw realized-past → diverging futures.
    const top = (solution.candidates ?? []).slice(0, Math.max(1, fanSize));
    const mkFan = (c, series) => ({
      candidate:   c.candidate,
      dates:       series.dates,
      netWorth:    series.netWorth,
      recommended: c.candidate === best.candidate,
    });
    let fan;
    if (workerPool) {
      // Parallelize the fan too (design 46 Phase 0.5 P-d): the top-K series rollouts
      // are independent. Same pool + context as the solve (setProblem ref-dedupes to
      // one broadcast; also seeds the context if a non-batching solver skipped it).
      workerPool.setProblem(problem);
      const seriesList = await workerPool.mapSeries(top.map(c => c.candidate), { points: seriesPoints });
      fan = top.map((c, i) => mkFan(c, seriesList[i]));
    } else {
      fan = top.map(c => mkFan(c, problem.rolloutSeries(c.candidate, { points: seriesPoints })));
    }

    // Design 80 U2 — feasibilityFirst guarantees a solvent candidate wins WHEN ONE
    // EXISTS. When none does, the solver still has to return something, and the
    // least-bad option is not a recommendation — it is a plan that runs out of
    // money. That state was previously indistinguishable from a good one, because
    // the goal metric itself cannot tell them apart: `finalNetLiquidity` reaches 0
    // at the same moment OutOfFunds fires, so a ruined plan displays "$0" and reads
    // as ON TARGET for a die-with-zero goal (design 80 §2.6). Say it explicitly.
    const shortfall = best.result ? infeasibilityOf(best.result, this.snapshot) : 0;
    const feasibility = {
      feasible: shortfall === 0,
      shortfall,
      // How much of the searched set was even solvent — 0 of N is the signal that
      // the lever's RANGE is the binding constraint, not the controller's choice
      // (a spending floor above the affordable level, design 80 §2.5).
      feasibleCandidates: (solution.candidates ?? [])
        .filter(c => c.result && infeasibilityOf(c.result, this.snapshot) === 0).length,
      totalCandidates: (solution.candidates ?? []).length,
      outOfFundsDate: best.result?.outOfFundsDate ?? null,
    };

    this.lastAdvice = {
      now: { date: this.snapshot.date, netWorth: fan[0]?.netWorth?.[0] ?? null },
      recommended,
      candidates: solution.candidates ?? [],
      fan,
      variables,
      feasibility,
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
      // Tag the record with the goal's primary metric so the save-points log can
      // show the value the goal anchored on (not just net worth) — even after the
      // user switches goals (records made under different goals stay correct).
      const metric = objectivePrimaryMetric(this.objective);
      const variables = this._variables();
      recordDecisionRecord({
        graph: this.graph, parentId: this.parentId, id: recordId,
        name: this.describeRecordMove(candidate ?? {}, variables),
        controlParams: candidate, asOfDate: this.snapshot.date,
        simStart: this.simStart, simEnd: this.simEnd, result,
        // Harvest source metadata (§13.2): which run, which levers, and the
        // variable descriptors needed to re-key the values onto schedule params.
        runId:       this.runId,
        controlKeys: this.controls.map(c => c.key),
        controlVars: variables,
        extra: {
          goalMetric: { key: metric.key, label: metric.label },
          // Design 80 F5 — solvency of the epoch's OWN projection, recorded at
          // decision time. `result` already carries cumulativeDeficit, but nothing
          // read it, so a run could commit five consecutive failing plans in
          // silence (§2.7). The goal metric cannot substitute: for the liquid scope
          // a ruined plan and a perfect spend-down both terminate at 0 (§2.6).
          // Stamped here so the harvest and the save-points log can both refuse to
          // present a ruined epoch as a recommendation.
          feasibility: {
            feasible:       infeasibilityOf(result, this.snapshot) === 0,
            shortfall:      infeasibilityOf(result, this.snapshot),
            deficit:        result?.cumulativeDeficit ?? 0,
            deficitMonths:  result?.deficitMonths ?? 0,
            scenarioFailed: result?.scenarioFailed ?? false,
            outOfFundsDate: result?.outOfFundsDate ?? null,
          },
        },
      });
      // Mirror the layer to durable storage so an un-harvested run survives a
      // reload (§13 H4). The graph stays the source of truth.
      this.decisionStore?.persist?.();
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
  async autoRun({ solverKey = 'CEM', solverOptions = {}, workerPool = null, stepYears = 1, shouldStop = null, onEpoch = null } = {}) {
    if (!this.snapshot) throw new Error('CockpitController.autoRun: call setSnapshot(now) first');
    const endMs = +new Date(this.simEnd);
    const log = [];
    let epoch = 0;

    while (+new Date(this.snapshot.date) < endMs) {
      if (shouldStop && shouldStop()) break;

      const advice    = await this.advise({ solverKey, solverOptions, workerPool });
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

/**
 * Copy a flat params bag so nested containers are OURS to mutate. Param values are
 * JSON-ish (numbers, strings, band tables, schedules, mix maps), so a structured
 * clone is right; anything exotic falls back to the shared reference rather than
 * throwing — a controller that can't be constructed is worse than one that shares
 * an oddball value it will never write through.
 */
function _deepCopyParams(bag) {
  const out = {};
  for (const [k, v] of Object.entries(bag ?? {})) {
    if (v && typeof v === 'object') {
      try { out[k] = structuredClone(v); }
      catch { out[k] = v; }
    } else out[k] = v;
  }
  return out;
}

/** L1 distance between two allocation mixes over the union of their classes —
 *  the "did the mix really move?" metric for the glidepath ε-collapse (§13.6.4). */
function _mixL1(a, b) {
  const classes = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  let d = 0;
  for (const c of classes) d += Math.abs((a?.[c] ?? 0) - (b?.[c] ?? 0));
  return d;
}

/** A share this size or larger is a real position, not a rounding remnant. */
const _MATERIAL_SHARE = 0.05;

/**
 * Warn about anchors that drive a MATERIAL class to exactly zero (design 61 §12.1
 * D5). Two shapes, and the measurement says only one of them is expensive:
 *
 *  • TERMINAL — the final anchor zeroes a class the plan was still holding.
 *    `interpolateGlidepath` CLAMPS above the last anchor, so a mix the controller
 *    committed for ONE epoch silently becomes policy for every remaining year.
 *    This is the exact mirror of rule (4)'s leading anchor, and it is the one that
 *    costs: on the reference plan the terminal `BOND 100%` liquidates the whole
 *    equity book into a single tax year immediately before the terminal settle
 *    would have priced those gains anyway — measured −\$2.2M after-tax net worth,
 *    losing on 11 of 12 seeds.
 *
 *  • ROUND TRIP — a class goes material → exactly 0 → material again. D5 filed
 *    these as the defect ("realizes CGT and buys straight back"), but they do NOT
 *    measure as friction: smoothing them LOSES money, and by no more than matched
 *    edits to ordinary non-corner rungs do. Reported as information, deliberately
 *    not as a defect, so a reader can see the shape without being told it is a bug.
 *
 * Neither rewrites the bake. A corner is a well-formed total mix and the MPC really
 * did choose it; only the reader knows whether it was intent or a flat objective.
 */
function _zeroedClassWarnings(collapsed) {
  if (!Array.isArray(collapsed) || collapsed.length < 2) return [];
  const out = [];
  const at = (i, c) => collapsed[i]?.value?.[c] ?? 0;
  const classes = [...new Set(collapsed.flatMap(p => Object.keys(p.value ?? {})))];
  const pct = v => `${Math.round(v * 100)}%`;

  // ── TERMINAL: the last anchor zeroes something the previous one held. ──
  const last = collapsed.length - 1;
  const dropped = classes.filter(c => at(last, c) === 0 && at(last - 1, c) >= _MATERIAL_SHARE);
  if (dropped.length) {
    out.push(`Allocation Mix: the FINAL anchor (age ${collapsed[last].key}, ${_mixLabel(collapsed[last].value)}) `
      + `zeroes ${dropped.map(c => `${ALLOC_WEIGHT_CLASS_LABELS[c] ?? c} (${pct(at(last - 1, c))} → 0)`).join(', ')}. `
      + `The glidepath CLAMPS above its last anchor, so this mix applies to EVERY year after `
      + `age ${collapsed[last].key} — but the controller committed it for one epoch, against a horizon `
      + `that ended there. A re-run will liquidate those classes in full at that age. Check it is intended `
      + `(design 61 §12.1 D5).`);
  }

  // ── ROUND TRIP: material → exactly 0 (one or more anchors) → material. ──
  for (const c of classes) {
    let i = 1;
    while (i < collapsed.length) {
      if (at(i, c) !== 0) { i++; continue; }
      let end = i;
      while (end + 1 < collapsed.length && at(end + 1, c) === 0) end++;
      if (at(i - 1, c) >= _MATERIAL_SHARE && end + 1 < collapsed.length && at(end + 1, c) >= _MATERIAL_SHARE) {
        out.push(`Allocation Mix: ${ALLOC_WEIGHT_CLASS_LABELS[c] ?? c} leaves the plan entirely for `
          + `ages ${collapsed[i].key}–${collapsed[end].key} (${pct(at(i - 1, c))} → 0 → ${pct(at(end + 1, c))}) `
          + `and is bought back. Informational: this shape has NOT measured as pure friction (design 61 §12.1 D5).`);
      }
      i = end + 1;
    }
  }
  return out;
}

/** "E70 / B25 / C5" — a compact mix for the harvest diff. */
function _mixLabel(mix) {
  return ALLOC_WEIGHT_CLASSES
    .filter(c => (mix?.[c] ?? 0) > 0.005)
    .map(c => `${(ALLOC_WEIGHT_CLASS_LABELS[c] ?? c).slice(0, 1)}${Math.round((mix[c] ?? 0) * 100)}`)
    .join('/');
}

/**
 * The target mix the scenario used BEFORE the run — the glidepath's leading
 * anchor (§13.6.4 rule 4). Under OPTIMIZED the mix is synthesized from the
 * `allocWeight::*` params; otherwise it is the explicit `rebalanceTargetAllocation`
 * object. Null when neither is configured (then no leading anchor is emitted).
 */
function _priorTargetMix(baseParams) {
  if (baseParams?.allocationStrategy === ALLOCATION_OPTIMIZED_MODE) {
    const mix = synthesizeTargetAllocation(baseParams ?? {}, null);
    return mix && Object.keys(mix).length ? mix : null;
  }
  const t = baseParams?.rebalanceTargetAllocation;
  return t && typeof t === 'object' && Object.keys(t).length ? { ...t } : null;
}

/**
 * The next ACTIONABLE Roth-conversion year at `asOf` (design 42): the earliest
 * year that (a) whose conversion date (rothConversionMonth/Day, default Dec 1) is
 * still in the future AND (b) is actually a conversion year for this scenario — a
 * scheduled year, or within the legacy window [start, end]. Without (a) the lever
 * tunes an event that already fired (e.g. at Dec 31); without (b) it tunes a year
 * the scenario never converts (e.g. standing at 2026 when the window starts 2028)
 * — either way an inert, confusing flat result. Falls back to the date-only year.
 */
function _nextConversionYear(asOf, baseParams) {
  const month = (baseParams?.rothConversionMonth ?? 12) - 1;   // 0-based
  const day   = baseParams?.rothConversionDay ?? 1;
  const now   = new Date(asOf);
  let year = now.getUTCFullYear();
  if (Date.UTC(year, month, day) <= now.getTime()) year += 1;   // this year's already fired

  // (b) If standing before the legacy window opens, jump to its start — keyed off
  // the STABLE window param, not the schedule (which prepareBaseParams mutates, so
  // reading it here would make prepareBaseParams and buildVariables disagree).
  const start = baseParams?.rothConversionStartYear;
  if (Number.isFinite(start) && year < start) year = start;
  return year;
}

/**
 * The largest REAL (base-year) income-fill target that could actually convert a
 * dollar at `year`, given the snapshot's convertible IRA balances. The policy
 * handler (RothConversionPolicyHandler) converts
 * `min(nominalTarget − usOrdinaryIncomeYTD, iraBalance)` per conversion owner, so
 * any target beyond `(ordIncomeYTD + Σ convertible IRA)` is inert. We deflate
 * that nominal headroom back to real base-year USD — the lever's units — by the
 * same inflation path the toolset compounds with. The conversion draws the IRA
 * only (a 401(k) must be rolled to the IRA first), so only IRA balances count.
 * Returns +Infinity when state is unavailable so the user's range is preserved.
 */
function _convertibleRealCap(state, baseParams, year) {
  if (!state || !Number.isFinite(year)) return Infinity;
  const owner = baseParams?.rothConversionOwner ?? 'both';
  let ira = 0;
  if (owner === 'primary' || owner === 'both') ira += state.iraAccount?.balance       ?? 0;
  if (owner === 'spouse'  || owner === 'both') ira += state.spouseIraAccount?.balance ?? 0;
  const ordYtd = state.usOrdinaryIncomeYTD ?? 0;
  const infl   = baseParams?.inflationRate ?? 0.03;
  const factor = Math.pow(1 + infl, year - BRACKET_BASE_YEAR);
  return (ordYtd + ira) / (factor > 0 ? factor : 1);
}

/**
 * The next ACTIONABLE early-withdrawal year at `asOf` (design 45 Phase 3): the
 * earliest year whose withdrawal date (earlyWithdrawalMonth/Day, default Dec 1) is
 * still in the future, clamped up to the opt-in optimization window's start so the
 * lever tunes a year the toolset actually seeded an event for. Mirrors
 * `_nextConversionYear`.
 */
function _nextEarlyWithdrawalYear(asOf, baseParams) {
  const month = (baseParams?.earlyWithdrawalMonth ?? 12) - 1;
  const day   = baseParams?.earlyWithdrawalDay ?? 1;
  const now   = new Date(asOf);
  let year = now.getUTCFullYear();
  if (Date.UTC(year, month, day) <= now.getTime()) year += 1;   // this year's already fired
  const start = baseParams?.earlyWithdrawalStartYear;
  if (Number.isFinite(start) && year < start) year = start;
  return year;
}

/** Younger relevant owner's decimal age at the `year` withdrawal date (gates the
 *  per-class caps below). For 'both', the younger keeps the window open longer. */
function _ownerDecimalAgeAt(state, baseParams, year) {
  const people = state?.people ?? {};
  const keys = Object.keys(people);
  if (keys.length === 0 || !Number.isFinite(year)) return null;
  const owner = baseParams?.earlyWithdrawalOwner ?? 'primary';
  const month = (baseParams?.earlyWithdrawalMonth ?? 12) - 1;
  const day   = baseParams?.earlyWithdrawalDay ?? 1;
  const atMs  = Date.UTC(year, month, day);
  const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
  const ageOf = (k) => {
    const bd = people[k]?.birthDate;
    return bd ? (atMs - new Date(bd).getTime()) / msPerYear : null;
  };
  if (owner === 'spouse') return keys[1] ? ageOf(keys[1]) : ageOf(keys[0]);
  if (owner === 'both') {
    const ages = keys.map(ageOf).filter(a => a != null);
    return ages.length ? Math.min(...ages) : null;
  }
  return ageOf(keys[0]);
}

/**
 * Real (base-year) per-class drawable caps for the early-withdrawal lever at
 * `year`: the owner's tax-deferred (IRA + 401k) and Roth balances, deflated to
 * base-year USD (the lever's units). Capped to 0 above the age gate, where normal
 * drawdown is already penalty-free so the decant lever provides no benefit
 * (design 45 §5 / Q6). +Infinity when state is unavailable (preserve the range).
 */
function _earlyWithdrawalRealCaps(state, baseParams, year) {
  if (!state || !Number.isFinite(year)) return { taxDeferred: Infinity, roth: Infinity };
  const owner = baseParams?.earlyWithdrawalOwner ?? 'primary';
  const wantPrimary = owner === 'primary' || owner === 'both';
  const wantSpouse  = owner === 'spouse'  || owner === 'both';
  let taxDeferred = 0;
  let roth = 0;
  if (wantPrimary) {
    taxDeferred += (state.iraAccount?.balance ?? 0) + (state.k401Account?.balance ?? 0);
    roth        += (state.rothAccount?.balance ?? 0);
  }
  if (wantSpouse) {
    taxDeferred += (state.spouseIraAccount?.balance ?? 0) + (state.spouseK401Account?.balance ?? 0);
    roth        += (state.spouseRothAccount?.balance ?? 0);
  }
  const age = _ownerDecimalAgeAt(state, baseParams, year);
  if (age != null) {
    if (age >= 60.0) taxDeferred = 0;   // IRA/401k penalty-free by 60
    if (age >= 59.5) roth = 0;          // Roth earnings penalty-free at 59.5
  }
  const infl   = baseParams?.inflationRate ?? 0.03;
  const factor = Math.pow(1 + infl, year - BRACKET_BASE_YEAR);
  const f = factor > 0 ? factor : 1;
  return { taxDeferred: taxDeferred / f, roth: roth / f };
}

// Marginal MFJ bracket a REAL (base-year) ordinary income lands in, for the
// recommended-move card. Real target vs base-year brackets is inflation-free:
// both the target and the statutory edges deflate by the same factor (§12.2).
// Base-year table = the newest registered US statutory module (BRACKET_BASE_YEAR),
// which is exactly where the settle-time inflation accumulator is 1.0.
const _US_BASE_RATES = usRatesForYear(BRACKET_BASE_YEAR);
function _bracketLabelForRealIncome(realIncome) {
  const taxable = realIncome - _US_BASE_RATES._stdDeduction_mfj;
  if (!(taxable > 0)) return null;
  let rate = _US_BASE_RATES._brackets_mfj[0]?.[1] ?? null;
  for (const [threshold, r] of _US_BASE_RATES._brackets_mfj) {
    if (taxable >= threshold) rate = r; else break;
  }
  return rate == null ? null : `${Math.round(rate * 100)}% bracket`;
}

/**
 * Suffix annotating a REAL base-year amount with its nominal value at the "now"
 * year, so a real-dollars recommendation (the spending band amount) isn't misread
 * as a nominal collapse late in life. Uses the same inflation path the reducer
 * compounds with (`(1+infl)^(year − BRACKET_BASE_YEAR)`). Near the base year the
 * two coincide, so it just tags "(today's $)".
 */
function _nominalFactor(year, ctx) {
  if (!Number.isFinite(year)) return null;
  const infl = ctx?.inflationRate ?? 0.03;
  return { factor: Math.pow(1 + infl, year - BRACKET_BASE_YEAR), year };
}

/** The "now" calendar year from ctx.asOf — for levers whose amount applies now
 *  (SPENDING). Roth/early-withdrawal amounts fire in a FUTURE event year, so those
 *  pass that event year (the variable's `_year`) explicitly instead. */
function _nowYear(ctx) {
  const asOf = ctx?.asOf ? new Date(ctx.asOf) : null;
  if (!asOf || Number.isNaN(asOf.getTime())) return null;
  return asOf.getUTCFullYear();
}

function _nominalSuffix(real, year, ctx, unit = '') {
  if (!Number.isFinite(real)) return '';
  const nf = _nominalFactor(year, ctx);
  if (!nf || !(nf.factor > 1.001)) return ' (today’s $)';
  return ` (today’s $) ≈ ${fmtUsd(real * nf.factor)}${unit} in ${nf.year}`;
}

/** Real base-year amount expressed in nominal `year` dollars (falls back to real). */
function _toNominal(real, year, ctx) {
  const nf = _nominalFactor(year, ctx);
  return nf ? real * nf.factor : real;
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

/**
 * The calendar year band `i` takes effect, and whether that is still in the future.
 *
 * A band already in force bites at "now" (its amount is what the plan spends this
 * year); a band the person has NOT yet reached bites in the year they turn its
 * startAge — which is the year its real amount must be nominalized at. Falls back
 * to the "now" year whenever age/birthDate are unknown (pre-design-39 behaviour).
 */
function _bandEffectiveYear(bands, i, asOf, state) {
  const nowYear = asOf ? new Date(asOf).getUTCFullYear() : null;
  const startAge = bands?.[i]?.startAge;
  const age = _personAgeAt(asOf, state);
  if (age == null || !Number.isFinite(startAge) || age >= startAge) {
    return { year: nowYear, future: false };
  }
  const people = state?.people ?? {};
  const bd = people[Object.keys(people)[0]]?.birthDate ?? state?.personBirthDate;
  // The year they turn startAge — exact from the birth year, so a Q4 birthday
  // doesn't shift it the way (nowYear + age delta) would.
  const year = bd ? new Date(bd).getUTCFullYear() + startAge
                  : (nowYear != null ? nowYear + (startAge - age) : null);
  return { year, future: true };
}

/** The year a spending variable's amount actually applies (stamped at build time). */
function _effectiveYear(v, ctx) {
  return Number.isFinite(v?._effectiveYear) ? v._effectiveYear : _nowYear(ctx);
}

/** " from age 65" for a band that hasn't started yet; '' for one already in force. */
function _bandWhen(v) {
  return v?._future && Number.isFinite(v?._startAge) ? ` from age ${v._startAge}` : '';
}
