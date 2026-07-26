/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { OptimizationProblem } from '../optimization/optimization-problem.js';
import { createSolver }        from '../optimization/solvers/solver-registry.js';
import { set }                 from '../monte-carlo/mc-param-paths.js';
import { HARVEST_FORMS }       from './harvest.js';

/**
 * RESOLVE — the best STATIC value for the whole run (design/39 §13.6.6).
 *
 * POINT asks "which epoch's answer do we keep?", a question with no good answer.
 * The right question is "given that this param must be ONE number for the whole
 * run, what number is best?" — and that is not a collapse of the MPC's decisions
 * at all. It is a design-38 optimization over the full horizon **from t₀**, with
 * the lever as a static variable. The machinery already exists; harvest only has
 * to call it.
 *
 * Three properties make this the right default for the scalar levers:
 *  1. it answers the user's actual question (an open-loop, whole-run problem —
 *     design 38's problem, not design 39's; harvest is where the two meet);
 *  2. the MPC run is a free warm start — the controller has already explored this
 *     lever against realized state, so its committed values seed the search;
 *  3. it composes — it runs AFTER the SCHEDULE bakes are folded into `baseParams`,
 *     so the static value is optimal *given* the harvested spending/Roth/allocation
 *     schedules, not against the pre-run scenario. Order matters and is enforced
 *     here by construction (the caller passes the already-baked params).
 *
 * The scalar levers resolve **jointly** (one solve, one vector) for the same
 * coupling reason harvest targets a single run: drawdown order and cross-border
 * mode are not independent decisions.
 *
 * **Honest limit** (§13.7): this finds the best static value *on the path it
 * solves over* — under stochastic returns (design 74/75) that is one seed. Better
 * than last-epoch-wins by construction; not a guarantee out of sample.
 *
 * @param {object}   opts
 * @param {object}   opts.plan            - the HarvestPlan; its POINT entries are the target.
 * @param {object}   opts.controlsByKey   - { key: controlSpec }.
 * @param {object}   opts.baseParams      - scenario params WITH the schedule bakes folded in.
 * @param {object}   opts.objective       - the run's goal.
 * @param {Date}     opts.simStart
 * @param {Date}     opts.simEnd
 * @param {object}  [opts.cfgTemplate]
 * @param {object}  [opts.state]          - a realized state, for levers that prune their
 *                                          variables to what the scenario actually has.
 * @param {string}  [opts.solverKey='CEM']
 * @param {object}  [opts.solverOptions]
 * @param {object}  [opts.workerPool]
 * @returns {Promise<{ params, entries, warnings, score, evaluations }>}
 */
export async function resolveStaticLevers({
  plan,
  controlsByKey = {},
  baseParams    = {},
  objective,
  simStart,
  simEnd,
  cfgTemplate   = null,
  state         = null,
  solverKey     = 'CEM',
  solverOptions = {},
  workerPool    = null,
  // DI seams (mirroring `runMpc`'s buildProblem/advance hooks) so the resolve
  // contract — which levers, which warm start, which order — is testable without
  // paying for a real full-horizon solve.
  makeProblem   = (opts) => new OptimizationProblem(opts),
  makeSolver    = (key, opts) => createSolver(key, opts),
} = {}) {
  const warnings = [];
  const pointEntries = (plan?.entries ?? []).filter(e => e.form === HARVEST_FORMS.POINT);
  if (!pointEntries.length) {
    return { params: {}, entries: [], warnings: ['Nothing to resolve — every lever baked as a schedule.'], score: null, evaluations: 0 };
  }

  // The levers whose values RESOLVE owns, and the variables they search. Reusing
  // `buildVariables` keeps the encoding identical to the one the cockpit searched
  // (ranges, enum value sets, role/class pruning), so the warm start is meaningful.
  const leverKeys = [...new Set(pointEntries.map(e => e.leverKey))];
  const variables = [];
  for (const key of leverKeys) {
    const control = controlsByKey[key];
    if (!control?.buildVariables) {
      warnings.push(`Lever “${key}” cannot be re-solved (no variable encoding) — keeping its POINT value.`);
      continue;
    }
    const vars = control.buildVariables({
      baseParams, state, asOf: simStart, range: control.defaultRange ?? null,
    }) ?? [];
    for (const v of vars) variables.push({ ...v, _controlKey: key });
  }
  if (!variables.length) {
    return { params: {}, entries: [], warnings: [...warnings, 'No resolvable variables — keeping the POINT values.'], score: null, evaluations: 0 };
  }

  // Warm start: the values the MPC committed (§13.6.6 property 2). Only keys the
  // encoding actually addresses — a stale key would be dropped by the codec anyway.
  const addressed = new Set(variables.map(v => v.paramKey));
  const start = {};
  for (const e of pointEntries) {
    if (addressed.has(e.paramKey) && e.to !== undefined) start[e.paramKey] = e.to;
  }

  // From t₀, NOT from a snapshot: an open-loop, whole-run solve is the question.
  const problem = makeProblem({
    variables, baseParams, objective, simStart, simEnd,
    initialState: { kind: 'compile', cfgTemplate },
  });
  const solver   = makeSolver(solverKey, solverOptions);
  const solution = await solver.solve(problem, { ...solverOptions, start, workerPool });

  const best = solution?.best?.candidate ?? {};
  const params  = {};
  const entries = [];
  for (const v of variables) {
    const value = best[v.paramKey];
    if (value === undefined) continue;
    params[v.paramKey] = value;
    const prior = pointEntries.find(e => e.paramKey === v.paramKey);
    entries.push({
      paramKey: v.paramKey,
      lever:    prior?.lever ?? v._controlKey,
      leverKey: v._controlKey,
      form:     HARVEST_FORMS.RESOLVE,
      from:     prior?.from,
      to:       value,
      epochs:   prior?.epochs ?? 0,
      label:    `${_short(value)} (best static value over the whole run)`,
      varied:   prior?.varied ?? false,
      pointValue: prior?.to,
    });
  }
  return {
    params, entries, warnings,
    score:       solution?.best?.score ?? null,
    evaluations: solution?.evaluations ?? solution?.ledger?.size ?? 0,
  };
}

/**
 * Fold a HarvestPlan's SCHEDULE bakes into a params bag, so a subsequent RESOLVE
 * solves *given* those schedules (§13.6.6 property 3) rather than against the
 * pre-run scenario. Uses the same path-aware `set()` the solvers use, so nested
 * and `::`-flat keys behave identically to a candidate application.
 */
export function foldScheduleBakes(baseParams, plan) {
  const out = { ...(baseParams ?? {}) };
  for (const e of (plan?.entries ?? [])) {
    if (e.form !== HARVEST_FORMS.SCHEDULE) continue;
    set(out, e.paramKey, e.to);
  }
  return out;
}

/**
 * Replace a plan's POINT entries with the RESOLVE results, in place of a second
 * plan shape — the cockpit renders one table either way, with the `form` column
 * saying which numbers were searched over the whole run and which are snapshots
 * of a moment (§13.6.6).
 */
export function mergeResolved(plan, resolved) {
  if (!resolved?.entries?.length) return plan;
  const byKey = new Map(resolved.entries.map(e => [e.paramKey, e]));
  return {
    ...plan,
    entries:  plan.entries.map(e => byKey.get(e.paramKey) ?? e),
    warnings: [...(plan.warnings ?? []), ...(resolved.warnings ?? [])],
    resolved: { score: resolved.score, evaluations: resolved.evaluations },
  };
}

function _short(v) {
  if (v == null) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(4)));
  return String(v);
}
