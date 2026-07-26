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
import { set }                     from '../monte-carlo/mc-param-paths.js';

/**
 * Replay a recorded cockpit run — the **A′** term (design/80 F6).
 *
 * The MPC loop is `solve → commit first segment → advance → re-solve`. Replay is
 * that loop with the solve deleted: at each epoch it applies the value the
 * controller actually committed, rolls to the next epoch, repeats. So it
 * reconstructs the run's REALIZED trajectory from the decision log alone, with no
 * solver, in one pass instead of `epochs × budget` rollouts.
 *
 * Why this exists. A harvest turns a run into scenario params, and when the baked
 * scenario misbehaves there are two candidate culprits and no way to tell them
 * apart: the run itself was bad, or the BAKE of it was. Replay is the control that
 * separates them —
 *
 *   A  = what each epoch projected            (recorded on the decision records)
 *   A′ = the realized closed-loop path        (this function)
 *   B  = the baked scenario re-run from t₀    (`applyHarvestPlan` + a plain run)
 *
 * A′ vs B is the harvest's true fidelity. A vs A′ is the gap between what the
 * controller *predicted* each epoch and what its own decisions actually produced —
 * which is not zero, because every epoch prices its tail at values later epochs
 * overwrite.
 *
 * **Replay is not a harvest destination.** It reconstructs one path; it produces no
 * editable, searchable, shareable params, and it is just as open-loop as a baked
 * schedule the moment anything about the world changes. It is instrumentation.
 *
 * @param {Array}  records            decision records, any order (sorted here).
 * @param {object} opts
 * @param {object} opts.baseParams    params the run STARTED from (pre-run, not harvested).
 * @param {Date}   opts.simStart
 * @param {Date}   opts.simEnd
 * @param {object} [opts.cfgTemplate] serialized scenario the rollouts compile.
 * @param {object} [opts.objective]   scoring objective; defaults to the goal metric's family.
 * @param {string} [opts.runId]       replay only this run's records.
 * @returns {{ result, score, epochs, committed }}
 */
export function replayDecisions(records, {
  baseParams = {},
  simStart,
  simEnd,
  cfgTemplate = null,
  objective   = OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH,
  runId       = null,
} = {}) {
  const log = (records ?? [])
    .filter(r => r && (runId == null || r.runId === runId))
    .sort((a, b) => new Date(a.asOfDate) - new Date(b.asOfDate));
  if (!log.length) throw new Error('replayDecisions: no records to replay');

  // Deep copy: `set()` writes through nested paths like
  // `spendingExpenseBands[3].monthlyAmount` and mutates the container, so a shallow
  // copy would rewrite the caller's band table in place — the same aliasing trap
  // the cockpit's `_deepCopyParams` exists to avoid.
  const committed = JSON.parse(JSON.stringify(baseParams));
  const epochs = [];

  let snapshot = null;
  for (const [i, rec] of log.entries()) {
    const asOf = new Date(rec.asOfDate);

    // Seed the first epoch by compiling from t₀ and rolling to epoch 1, so the
    // realized past before the first decision is simulated rather than assumed.
    if (!snapshot) {
      snapshot = new OptimizationProblem({
        variables: [], baseParams: committed, objective, simStart, simEnd,
        initialState: { kind: 'compile', cfgTemplate },
      }).rollToSnapshot({}, asOf);
    }

    // Commit this epoch's decision exactly as `apply()` did, then roll the
    // committed plan to the NEXT epoch — the receding-horizon "advance". The last
    // epoch rolls to simEnd, which is what makes the final result the realized
    // terminal rather than another projection.
    for (const [k, v] of Object.entries(rec.controlParams ?? {})) set(committed, k, v);

    const next = i + 1 < log.length ? new Date(log[i + 1].asOfDate) : new Date(simEnd);
    const problem = new OptimizationProblem({
      variables: [], baseParams: committed, objective, simStart, simEnd,
      initialState: { kind: 'snapshot', snapshot, cfgTemplate },
    });

    if (i + 1 < log.length) {
      snapshot = problem.rollToSnapshot({}, next);
      epochs.push({
        asOfDate: asOf, controlParams: rec.controlParams,
        cumulativeDeficit: snapshot.state?.cumulativeDeficit ?? 0,
        scenarioFailed:    snapshot.state?.scenarioFailed ?? false,
      });
    } else {
      const { result, score } = problem.evaluate({});
      epochs.push({
        asOfDate: asOf, controlParams: rec.controlParams,
        cumulativeDeficit: result.cumulativeDeficit ?? 0,
        scenarioFailed:    result.scenarioFailed ?? false,
      });
      return { result, score, epochs, committed };
    }
  }
  /* istanbul ignore next — the loop always returns on its final iteration. */
  throw new Error('replayDecisions: exhausted the log without a terminal evaluation');
}
