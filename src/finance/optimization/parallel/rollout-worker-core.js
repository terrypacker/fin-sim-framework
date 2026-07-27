/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { OptimizationProblem } from '../optimization-problem.js';

/**
 * Worker-side rollout core (design 46 Phase 0.5 P-b). Shared by the browser and
 * Node worker entry scripts — the only per-environment difference is the messaging
 * shim (`self` vs `parentPort`), so all the actual work lives here.
 *
 * A worker holds ONE resident OptimizationProblem for the epoch: `initProblem`
 * rebuilds it from the serialized context the pool broadcasts once (see
 * `rolloutContext`), then each `runTask(candidate)` returns the objective-free
 * `result` — the main thread applies the objective via `problem._scoreResult`, so
 * objectives (which carry functions) never cross the worker boundary.
 */
let _problem = null;

/** Rebuild the resident problem from the pool's broadcast context. */
export function initProblem(ctx) {
  const p = new OptimizationProblem({
    variables:    ctx.variables,
    baseParams:   ctx.baseParams,
    simStart:     ctx.simStart,
    simEnd:       ctx.simEnd,
    initialState: ctx.initialState,   // { kind, snapshot } — no cfgTemplate (pre-serialized below)
    horizonYears: ctx.horizonYears,
  });
  // The raw cfg carries registry factories and isn't structured-clone-safe, so the
  // pool sends the already-serialized template; assigning it makes `_cfgTemplate()`
  // skip re-serialization, and `initialState.cfgTemplate` is never consulted.
  p._serializedTemplate = ctx.serializedTemplate;
  // Likewise the base params arrive already merged with that template's own params
  // (rolloutContext sends `_resolveBase()`). Seeding the memo is what stops the
  // worker re-running the merge against a template it doesn't have — which would
  // silently roll a different world here than on the main thread.
  p._resolvedBase = ctx.baseParams;
  // The rollout path reads the objective ONLY through `_scoreEnd`'s windowable check
  // (scoring itself stays on the main thread), so a minimal stub is sufficient.
  p.objective = { windowable: ctx.objectiveWindowable };
  _problem = p;
}

/** Roll one candidate to its objective-free `result` (deterministic per candidate). */
export function runTask(candidate) {
  if (!_problem) throw new Error('rollout worker: initProblem must run before runTask');
  return _problem._rolloutResult(candidate);
}

/**
 * Roll one candidate to a net-worth series — the cockpit "futures fan" (design 46
 * Phase 0.5 P-d). `{ dates, netWorth, result }`; the fan lines are independent, so
 * they parallelize on the same pool as the solve.
 */
export function runSeriesTask(candidate, opts) {
  if (!_problem) throw new Error('rollout worker: initProblem must run before runSeriesTask');
  return _problem.rolloutSeries(candidate, opts ?? {});
}
