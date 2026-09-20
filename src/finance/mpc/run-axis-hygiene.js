/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { resolveActiveMpcRun, allDecisionsOf } from './run-schedule.js';
import { LEVER_SCHEDULE }                      from './lever-schedule.js';

/**
 * DESIGN 81 D11, SECOND HALF — study hygiene for a plan that is playing a recorded run.
 *
 * D11 splits the refusal the way design 110 already splits it, and phase 3 built the first
 * half: a scenario-level contradiction **throws at load** (`assertRunIsPlayable`). This is the
 * other half — a *study* misconfiguration **reports and never repairs**, which is exactly what
 * `pool-axis-hygiene.js` does and for the same stated reason: a grid launched from a config the
 * app quietly edited is a grid nobody can reproduce.
 *
 * ─── the misconfiguration (Q1) ───────────────────────────────────────────────────
 *
 * An active run pins `allocWeight::EQUITY` at 44 dates. An MC or optimizer variable perturbs
 * it. Today the later write wins and nothing says which. Neither "the run wins" nor "MC wins"
 * is honest, because **both produce a grid that looks comparable and is not**: the run re-stamps
 * its own value at the next period advance, so the axis moves the plan for a few months and then
 * stops mattering — a response curve that is neither the lever's effect nor zero.
 *
 * ─── what this deliberately does NOT flag ────────────────────────────────────────
 *
 * `mpcActiveRun` as the axis ITSELF. That is §4.2, the entire justification for the bag /
 * selector indirection: a decision point over recorded plans is the thing this design exists to
 * make possible, and it pins nothing MC is perturbing. Flagging it would warn against the
 * feature.
 */

/**
 * What a hygiene row says. One kind today, named rather than left implicit, because the pool
 * module's experience is that the *sentence* is the useful part: an operator who reads "the
 * cells differ for two reasons" does something different from one who reads "the axis is inert".
 */
export const RUN_AXIS_PROBLEM_KIND = Object.freeze({
  /** The axis moves, and the run overwrites it as the clock passes each decision date. */
  PINNED: 'pinned',
});

/**
 * The scenario params an active run pins, as a Set.
 *
 * Two shapes, and the difference is the same one §4.4 draws. A lever whose decision key IS a
 * param key (`allocWeight::EQUITY`, `crossBorderDrawdown`) pins exactly those keys. A lever that
 * addresses a TABLE by anchor (`band@69`, `year@2031`) pins the whole table, because the axis a
 * study would sweep is `spendingExpenseBands[3].monthlyAmount` — an index the run never stores
 * and cannot be compared against key-by-key.
 *
 * @param {object} params  the scenario parameter bag
 * @returns {Set<string>}  empty when no run is selected
 */
export function pinnedParamsOf(params) {
  const run = resolveActiveMpcRun(params);
  const byLever = run ? allDecisionsOf(run) : null;
  const pinned = new Set();
  if (!byLever) return pinned;

  for (const [lever, rows] of byLever) {
    const table = LEVER_SCHEDULE[lever]?.paramKey;
    if (table) pinned.add(table);
    else for (const r of rows) pinned.add(r.key);
  }
  return pinned;
}

/** `spendingExpenseBands[3].monthlyAmount` → `spendingExpenseBands`; a flat key is itself. */
function _rootParam(paramKey) {
  if (typeof paramKey !== 'string') return null;
  const cut = Math.min(...['[', '.'].map(c => {
    const i = paramKey.indexOf(c);
    return i < 0 ? paramKey.length : i;
  }));
  return paramKey.slice(0, cut);
}

/**
 * Problems for the axes a study is about to sweep, or `[]` when there is nothing to say.
 *
 * Rows are shaped like `poolAxisProblems`' so one renderer draws both, and are always
 * `severity: 'warn'`: this does not make the plan illegal and must not stop a Rebuild or a
 * launch. The operator decides — turn the run off with `mpcRunEnabled`, or drop the axis.
 *
 * @param {object} params        the scenario parameter bag
 * @param {Array}  axisParamKeys the param keys the study will sweep
 * @returns {Array<{param:string, index:null, field:null, severity:'warn', kind:string, message:string}>}
 */
export function runAxisProblems(params, axisParamKeys = []) {
  const pinned = pinnedParamsOf(params);
  if (pinned.size === 0) return [];

  const runId = params?.mpcActiveRun ?? 'the active run';
  const out = [];
  for (const paramKey of axisParamKeys) {
    // §4.2 — the selector is the ONE axis this must never flag.
    if (paramKey === 'mpcActiveRun' || paramKey === 'mpcRuns' || paramKey === 'mpcRunEnabled') continue;
    if (!pinned.has(paramKey) && !pinned.has(_rootParam(paramKey))) continue;
    out.push({
      param: paramKey, index: null, field: null,
      severity: 'warn', kind: RUN_AXIS_PROBLEM_KIND.PINNED,
      message: `Recorded run “${runId}” decides ${pinned.has(paramKey) ? paramKey : _rootParam(paramKey)}, `
        + 'so it re-stamps its own value as the clock reaches each decision date. Sweeping this '
        + 'axis moves the plan only until the next decision overwrites it — the cells will '
        + 'differ, but not by the lever’s effect. Turn the run off (MPC Run Enabled), or '
        + 'sweep Active MPC Run instead to compare whole recorded plans (design 81 D11/Q1).',
    });
  }
  return out;
}
