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
import { OPTIMIZATION_OBJECTIVES, objectivePrimaryMetric } from '../optimization/optimization-objectives.js';
import { createSolver }            from '../optimization/solvers/solver-registry.js';
import { OPT_PARAM_TYPES }         from '../optimization/optimization-objectives.js';
import { rollForwardWithControls, recordDecisionRecord } from './apply-forward.js';
import { repinExpensesIfChanged }  from '../spending/strategies/explicit-bands-spending-reducer.js';
import { retargetRothConversionEvents, BRACKET_BASE_YEAR } from '../../scenarios/toolsets/us-roth-conversion-toolset.js';
import { retargetEarlyWithdrawalEvents } from '../../scenarios/toolsets/us-early-withdrawal-toolset.js';
import { set }                     from '../monte-carlo/mc-param-paths.js';
import { DateUtils }               from '../../simulation-framework/date-utils.js';
import { UsTaxRates2025 }          from '../tax/us/us-tax-rates-2025.js';
import { synthesizeWeightedPriorities } from '../../scenarios/scenario-loader.js';
import {
  DRAWDOWN_WEIGHT_ROLES, DRAWDOWN_CASH_ROLES, DEFAULT_DRAWDOWN_WEIGHTS,
  DRAWDOWN_WEIGHT_PREFIX, DRAWDOWN_WEIGHT_SEP, DRAWDOWN_WEIGHT_MODE,
  DRAWDOWN_ROLE_LABELS, drawdownWeightKey,
} from '../../scenarios/intl-retirement-scenario.js';

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
    describe: (candidate, vars, ctx) => {
      const v = vars[0];
      const real = candidate[v.paramKey];
      // The band amount is REAL base-year USD; the reducer compounds it to nominal
      // by inflationAccumulator (explicit-bands-spending-reducer.js). Show both so
      // a late-life "$8,000" isn't misread as a nominal collapse.
      return `Set monthly spend to ${fmtUsd(real)}${_nominalSuffix(real, _nowYear(ctx), ctx, '/mo')}`;
    },
    // The save-points log is a record of what applied AT that date, so it reads the
    // single nominal amount the plan actually spent then — no real/nominal pairing.
    describeRecord: (candidate, vars, ctx) => {
      const v = vars[0];
      return `Set monthly spend to ${fmtUsd(_toNominal(candidate[v.paramKey], _nowYear(ctx), ctx))}/mo`;
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
    /**
     * Forward-effective live actuation (design 45 Phase 3), mirroring ROTH: (1)
     * persist the chosen real per-class amounts into the scenario's
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
     * Forward-effective live actuation (design 58 §11.2, leg 3): re-stamp the
     * running sim's `crossBorderDrawdown` state field so AccountService
     * .replenishSavings honors the committed mode from the next draw, and persist
     * it to the active scenario param so future Advise rollouts (which recompile
     * from params) and the live sim agree. The realized past is untouched — the
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
     * Forward-effective live actuation (design 58 §11.2, leg 3): re-stamp the
     * running sim's `withinTierDraw` state field so AccountService.replenishSavings
     * splits shared tiers by the committed policy from the next draw, and persist
     * it to the active scenario param. Realized past untouched — the projection's
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
    // One CONTINUOUS variable per investment role; the draw order is the ascending
    // sort of the committed weights. Same-role siblings share a weight → one tier.
    buildVariables: ({ range }) => DRAWDOWN_WEIGHT_ROLES.map(role => ({
      paramKey: drawdownWeightKey(role),
      type:     OPT_PARAM_TYPES.CONTINUOUS,
      min:      range?.min  ?? 0,
      max:      range?.max  ?? 1,
      step:     range?.step ?? 0.05,
      group:    'Spending', _role: role,
    })),
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
     * Forward-effective live actuation (design 58 §11.3 leg 3): persist each
     * committed weight to its scenario param, and re-stamp the running sim's
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
      }, candidate ?? {});

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
    controls     = null,       // multi-lever set (design 45 Phase 4); null ⇒ [control]
    controlRange = null,       // { min, max, step } for numeric levers; null = spec default
    controlRanges = null,      // per-control { [key]: { min, max, step } } overrides (multi-lever)
    graph        = null,       // optional Graph for DERIVES_FROM recording
    parentId     = null,       // parent scenario id for the audit trail
    horizonYears = null,       // sliding prediction window H (design 41); null = full horizon
  } = {}) {
    this.simStart     = simStart;
    this.simEnd       = simEnd;
    this.baseParams   = { ...baseParams };
    this.committed    = { ...baseParams };
    this.cfgTemplate  = cfgTemplate;
    this.objective    = objective;
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
      // Tag the record with the goal's primary metric so the save-points log can
      // show the value the goal anchored on (not just net worth) — even after the
      // user switches goals (records made under different goals stay correct).
      const metric = objectivePrimaryMetric(this.objective);
      recordDecisionRecord({
        graph: this.graph, parentId: this.parentId, id: recordId,
        name: this.describeRecordMove(candidate ?? {}, this._variables()),
        controlParams: candidate, asOfDate: this.snapshot.date,
        simStart: this.simStart, simEnd: this.simEnd, result,
        extra: { goalMetric: { key: metric.key, label: metric.label } },
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
