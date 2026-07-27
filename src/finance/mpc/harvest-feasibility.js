/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * F1 — feasibility is a GATE on the harvest, not a warning (design/80 §4.1, D1).
 *
 * The motivating failure: a `DIE_WITH_TARGET_LIQUID` (target $0) run that is
 * solvent at every one of its 44 epochs harvests into a scenario that goes
 * out-of-funds 2051-04-30 with a $5.7M deficit. Nothing in the harvest noticed,
 * and nothing could have — §13.7's verify compares the two on the goal's own
 * metric, and `finalNetLiquidity` is DEGENERATE at target 0: a perfect spend-down
 * and a plan that went broke in 2051 and sat at zero for 194 months both read
 * exactly $0, so the drift is ≈0% and the check passes a bankrupt plan.
 *
 * Two rules follow, and they are the whole design of this module:
 *
 *  1. **Feasibility is a separate, PRIOR axis to fidelity.** Never expressed as a
 *     percentage of the goal metric — see above; the percentage is a lie at the
 *     target. Answered instead by running the plan and asking the simulation
 *     whether it ran out of money.
 *  2. **Check exactly what will be applied.** The fold here mirrors
 *     `applyHarvestPlan` entry-for-entry, enabling params included — a check of a
 *     different params bag than the writer produces is worse than no check.
 *
 * Deliberately NOT folded into `applyHarvestPlan`, which is a pure, synchronous
 * param writer and stays one (design/80 §4.1: "the preview panel calls it before
 * enabling Copy to scenario; applyHarvestPlan stays a dumb writer"). That split
 * is also what lets design/81 reuse this as its Phase-5 promotion gate: the check
 * takes a PLAN, and a plan with one entry is a valid input.
 */

import { OptimizationProblem } from '../optimization/optimization-problem.js';
import { infeasibilityOf }     from '../optimization/optimization-objectives.js';
import { set }                 from '../monte-carlo/mc-param-paths.js';
import { isIncludesRequirement, requirementSatisfied } from './harvest.js';
import { withIncluded }        from './harvest-apply.js';

/**
 * Fold a whole HarvestPlan onto a params bag — every entry regardless of form,
 * plus the enabling params.
 *
 * The sibling `foldScheduleBakes` (harvest-resolve.js) folds only the SCHEDULE
 * entries, because RESOLVE's job is to re-solve the POINT ones and it must not
 * pin them first. This one folds everything, because its job is to reproduce the
 * applied scenario exactly. Same `set()` both use, so nested and `::`-flat keys
 * land where a candidate application would put them.
 */
export function foldHarvestPlan(baseParams, plan, { applyRequires = true } = {}) {
  const out = _deepCopy(baseParams ?? {});
  for (const e of (plan?.entries ?? [])) {
    if (e?.paramKey == null || e.to === undefined) continue;
    set(out, e.paramKey, e.to);
  }
  if (applyRequires) {
    for (const req of (plan?.requires ?? [])) {
      if (req?.paramKey == null) continue;
      const current = out[req.paramKey];
      if (requirementSatisfied(current, req.to)) continue;
      set(out, req.paramKey,
        isIncludesRequirement(req.to) ? withIncluded(current, req.to.includes) : req.to);
    }
  }
  return out;
}

/**
 * Solvency of one rollout `result`, in the shape the panel and the headless
 * verify both render.
 *
 * `infeasibilityOf` (design 80 U2) is the single solvency test in the codebase and
 * this defers to it rather than re-deriving one: it already handles the
 * `scenarioFailed`-without-accrued-deficit case and snapshot windowing. Passing no
 * snapshot is correct here — a harvested scenario is re-run from t₀, so the whole
 * horizon is in scope and there is no realized past to subtract.
 */
export function feasibilityOfResult(result) {
  const shortfall = infeasibilityOf(result, null);
  return {
    feasible:          shortfall === 0,
    shortfall,
    outOfFundsDate:    result?.outOfFundsDate ?? null,
    cumulativeDeficit: result?.cumulativeDeficit ?? 0,
    deficitMonths:     result?.deficitMonths ?? 0,
    scenarioFailed:    result?.scenarioFailed ?? false,
  };
}

/**
 * Run the candidate plan from t₀ and report whether it stays solvent.
 *
 * From t₀ and NOT from the cockpit's "now" snapshot, for the same reason RESOLVE
 * solves from t₀: what the user is about to create is a SAVED SCENARIO, which
 * re-runs from the beginning. A check that started at "now" would skip exactly
 * the years a bake most distorts (the harvest re-keys decisions onto age bands
 * that begin before the current epoch).
 *
 * Cost is one full-horizon run — ~0.4s on the motivating 44-year scenario with
 * telemetry off, i.e. cheap enough to run when the preview opens. Failures are
 * reported, never thrown: a check that cannot run must not block a copy, so an
 * error surfaces as `feasible: null` ("could not verify") and the panel says so.
 *
 * @param {object}   opts
 * @param {object}   opts.plan          - from `harvestDecisions()` (± `mergeResolved`).
 * @param {object}   opts.baseParams    - the scenario's current flat params.
 * @param {Date}     opts.simStart
 * @param {Date}     opts.simEnd
 * @param {object}  [opts.cfgTemplate]  - the active scenario; compiled in an isolated registry.
 * @param {object}  [opts.objective]    - only affects the returned `score`; solvency is objective-free.
 * @param {function}[opts.makeProblem]  - DI seam (mirrors `resolveStaticLevers`).
 * @returns {{ feasible: boolean|null, shortfall, outOfFundsDate, cumulativeDeficit,
 *             deficitMonths, scenarioFailed, result, params, error }}
 */
export function checkHarvestFeasibility({
  plan,
  baseParams  = {},
  simStart,
  simEnd,
  cfgTemplate = null,
  objective   = undefined,
  makeProblem = (opts) => new OptimizationProblem(opts),
} = {}) {
  let params = baseParams;
  try {
    params = foldHarvestPlan(baseParams, plan);
    const problem = makeProblem({
      variables: [], baseParams: params, simStart, simEnd,
      ...(objective ? { objective } : {}),
      initialState: { kind: 'compile', cfgTemplate },
    });
    const { result } = problem.evaluate({});
    return { ...feasibilityOfResult(result), result, params, error: null };
  } catch (err) {
    // Unverifiable ≠ infeasible. `feasible: null` is a third state the caller must
    // render as "could not check" rather than silently treating as either verdict.
    return {
      feasible: null, shortfall: 0, outOfFundsDate: null,
      cumulativeDeficit: 0, deficitMonths: 0, scenarioFailed: false,
      result: null, params, error: err?.message ?? String(err),
    };
  }
}

/**
 * One-line verdict for a feasibility result — shared by the review panel and
 * `verify-harvest.mjs` so the UI and the headless check cannot drift in what they
 * call a failure.
 */
export function describeFeasibility(f, { fmtDate = _isoMonth, fmtUsd = _usd } = {}) {
  if (!f || f.feasible === null) {
    return `Feasibility could not be checked${f?.error ? ` (${f.error})` : ''} — copy at your own risk.`;
  }
  if (f.feasible) return 'Solvent — the copied plan runs to the end of the scenario without running out of money.';
  const when = f.outOfFundsDate ? ` in ${fmtDate(f.outOfFundsDate)}` : '';
  const how  = f.cumulativeDeficit > 0
    ? ` — ${fmtUsd(f.cumulativeDeficit)} short over ${f.deficitMonths} month(s)`
    : '';
  return `This plan runs out of money${when}${how}.`;
}

/**
 * Deep-copy the params bag so `set()` cannot reach through into the caller's
 * arrays (a nested path like `spendingExpenseBands[0].monthlyAmount` would edit
 * the live scenario otherwise — the harvest's cardinal sin, and the bug design 39
 * §13 found where `apply()` rewrote the ACTIVE scenario's band table).
 *
 * `structuredClone` where it exists; a container-only recursion elsewhere (jsdom
 * has no structuredClone). Dates and other non-plain values pass through by
 * reference, which is correct — nothing here writes into one.
 */
function _deepCopy(v) {
  if (typeof structuredClone === 'function') return structuredClone(v);
  if (Array.isArray(v)) return v.map(_deepCopy);
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, _deepCopy(x)]));
  }
  return v;
}

function _isoMonth(d) {
  try {
    return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', timeZone: 'UTC' });
  } catch { return String(d); }
}
function _usd(n) {
  return Number.isFinite(n) ? '$' + Math.round(n).toLocaleString('en-US') : '—';
}
