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
import { set }                     from '../monte-carlo/mc-param-paths.js';

/**
 * MPC receding-horizon controller (design/39 Step 3).
 *
 * The closed loop, layered over the proven seams:
 *
 *   at each decision epoch t:
 *     1. build a horizon OptimizationProblem seeded from the now-snapshot at t
 *        (initialState:{kind:'snapshot'}), whose variables are the controls
 *        re-decided at t and whose horizon rolls to simEnd (full-life — §10 Q1);
 *     2. solve it with a design-38 solver, WARM-STARTED from the previous epoch's
 *        decision (the standard MPC trick — keeps later solves cheap);
 *     3. COMMIT the chosen controls forward (apply-forward / §5), then ADVANCE:
 *        roll the snapshot from t to the next epoch with the committed controls
 *        — this realizes "apply only the first segment";
 *     4. re-solve at the next epoch.
 *
 * Nothing here re-implements search (solvers) or evaluation (OptimizationProblem.
 * evaluate / rollToSnapshot). The loop is a pure orchestrator, so `buildProblem`
 * and `advance` are injectable — the default wires the real IntlRetirement
 * problem; tests inject a toy problem with a known optimum.
 */

/** Merge a solver candidate's paramKey→value pairs into a params object (path-aware). */
function mergeCandidate(params, candidate = {}) {
  const out = structuredClone(params ?? {});
  for (const [k, v] of Object.entries(candidate)) set(out, k, v);
  return out;
}

/** Restrict a previous candidate to the keys of the current variable set (warm start). */
function warmStartFrom(prevCandidate, variables) {
  if (!prevCandidate) return null;
  const keys = new Set(variables.map(v => v.paramKey));
  const start = {};
  let any = false;
  for (const [k, v] of Object.entries(prevCandidate)) {
    if (keys.has(k)) { start[k] = v; any = true; }
  }
  return any ? start : null;
}

/** Default problem factory — the real snapshot-seeded IntlRetirement problem. */
function defaultBuildProblem({ variables, baseParams, snapshot, objective, simStart, simEnd, cfgTemplate }) {
  return new OptimizationProblem({
    variables,
    baseParams,
    objective,
    simStart,
    simEnd,
    initialState: { kind: 'snapshot', snapshot, cfgTemplate },
  });
}

/**
 * Run the receding-horizon MPC loop.
 *
 * @param {object}   opts
 * @param {Date}     opts.simStart
 * @param {Date}     opts.simEnd
 * @param {Date[]}   opts.epochs          - decision epochs (ascending; the union of
 *                                          per-control grids + material events, §6).
 * @param {object}   opts.initialSnapshot - now-snapshot at epochs[0] (see makeInitialSnapshot).
 * @param {object}  [opts.baseParams]     - scenario params the snapshot was produced under.
 * @param {(asOf: Date, state: object) => Array} opts.buildVariables
 *                                          - the controls re-decided at a given epoch.
 * @param {object}  [opts.objective]      - OPTIMIZATION_OBJECTIVES entry.
 * @param {string}  [opts.solverKey]      - SOLVER_REGISTRY key (default PATTERN_SEARCH).
 * @param {object}  [opts.solverOptions]  - solver knobs (budget, seed, …).
 * @param {boolean} [opts.warmStart=true] - seed each replan from the previous decision.
 * @param {object}  [opts.cfgTemplate]    - optional serialized cfg template.
 * @param {function}[opts.buildProblem]   - DI hook (defaults to the real problem).
 * @param {function}[opts.advance]        - DI hook (problem, candidate, toDate) => nextSnapshot.
 * @param {function}[opts.onEpoch]        - optional per-epoch callback.
 * @returns {Promise<{ decisions: Array, finalResult: object, committedParams: object }>}
 */
export async function runMpc({
  simStart,
  simEnd,
  epochs,
  initialSnapshot,
  baseParams    = {},
  buildVariables,
  objective     = OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH,
  solverKey     = 'PATTERN_SEARCH',
  solverOptions = {},
  warmStart     = true,
  cfgTemplate   = null,
  buildProblem  = defaultBuildProblem,
  advance       = (problem, candidate, toDate) => problem.rollToSnapshot(candidate, toDate),
  onEpoch,
} = {}) {
  if (!Array.isArray(epochs) || epochs.length === 0) throw new Error('runMpc requires at least one epoch');
  if (!initialSnapshot) throw new Error('runMpc requires an initialSnapshot at epochs[0]');
  if (typeof buildVariables !== 'function') throw new Error('runMpc requires a buildVariables(asOf, state) fn');

  let snapshot  = initialSnapshot;
  let committed = { ...baseParams };
  let prevCandidate = null;
  const decisions = [];

  for (let i = 0; i < epochs.length; i++) {
    const epoch     = epochs[i];
    const variables = buildVariables(epoch, snapshot.state) ?? [];

    const problem = buildProblem({
      variables, baseParams: committed, snapshot, objective, simStart, simEnd, cfgTemplate,
    });

    const solver = createSolver(solverKey, solverOptions);
    const start  = warmStart ? warmStartFrom(prevCandidate, variables) : null;
    const solution = await solver.solve(problem, { ...solverOptions, start });

    const best = solution.best ?? { candidate: {}, result: null, score: -Infinity };
    const decision = {
      epoch,
      candidate:   best.candidate,
      score:       best.score,
      result:      best.result,
      evaluations: solution.evaluations,
    };
    decisions.push(decision);
    onEpoch?.(decision, { index: i, snapshot });

    // ADVANCE: realize the committed first segment from this epoch to the next,
    // producing the snapshot the next replan is seeded from. Use THIS epoch's
    // problem (baseParams = committed-so-far) before folding the choice in.
    if (i + 1 < epochs.length) {
      snapshot = advance(problem, best.candidate, epochs[i + 1]);
    }

    // COMMIT the chosen controls so the next epoch's baseParams carry them.
    committed     = mergeCandidate(committed, best.candidate);
    prevCandidate = best.candidate;
  }

  // Full-life horizon (§10 Q1): the last epoch's solve already rolled the
  // committed trajectory to simEnd, so its result IS the realized terminal.
  return {
    decisions,
    finalResult:     decisions.at(-1)?.result ?? null,
    committedParams: committed,
  };
}

/**
 * Build the initial now-snapshot at `asOfDate` by rolling a fresh t0 compile of
 * the scenario forward under `baseParams`. The realized "play up to now."
 *
 * @returns {{ date: Date, state: object, queue: Array, rngState: number }}
 */
export function makeInitialSnapshot({ simStart, simEnd, asOfDate, baseParams = {}, cfgTemplate = null }) {
  const problem = new OptimizationProblem({
    variables: [],
    baseParams,
    simStart,
    simEnd,
    initialState: { kind: 'compile', cfgTemplate },
  });
  return problem.rollToSnapshot({}, asOfDate);
}
