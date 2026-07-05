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
 * Standalone seeded PRNG — same algorithm as Simulation.createRNG /
 * IntlRetirementMcRunner.makeSeededRng. Every solver draws from this (never
 * Math.random) so a run is fully reproducible from its seed — the project's
 * reproducibility ethos and a hard requirement for design 39's warm-started
 * replans.
 */
export function makeSeededRng(seed) {
  let s = seed;
  return () => {
    s = Math.trunc(s + 0x6D2B79F5);
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t ^= t + Math.imul(t ^ t >>> 7, 61 | t);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/**
 * EvalLedger — shared evaluation bookkeeping for the sampling/local-search
 * solvers (design/38 §4).
 *
 * - **De-dupes**: the same candidate is only simulated once (sims are the
 *   expensive resource; pattern search revisits points constantly).
 * - **Budgets**: a hard cap on unique evaluations (`budget`), plus an optional
 *   convergence early-out (`noImproveLimit` consecutive evals without a new
 *   best). Both are honoured via `exhausted` (design/38 Q1: both).
 * - **Tracks the best** and yields to the event loop so long runs keep the UI
 *   responsive — exactly like GridSearchSolver.
 */
export class EvalLedger {
  constructor(problem, { onProgress, budget = Infinity, noImproveLimit = Infinity, signal, workerPool = null } = {}) {
    this.problem        = problem;
    this.onProgress     = onProgress;
    this.budget         = budget;
    this.noImproveLimit = noImproveLimit;
    this.signal         = signal;
    this.workerPool     = workerPool;   // design 46 Phase 0.5: parallel rollout pool (null ⇒ in-process)

    this.evaluations  = [];          // unique { candidate, result, score }
    this.best         = null;
    this._cache       = new Map();   // candidate key → entry
    this._sinceBest   = 0;
  }

  /** True once the budget, convergence, or abort criteria are met. */
  get exhausted() {
    return this.evaluations.length >= this.budget
      || this._sinceBest >= this.noImproveLimit
      || !!this.signal?.aborted;
  }

  /**
   * Fold one novel (candidate, result, score) into the ledger: cache it, count it,
   * update best/convergence, and report progress. Shared by `evaluate` and
   * `evaluateBatch` so both accrue budget/best/`_sinceBest` identically.
   */
  _record(candidate, result, score) {
    const entry = { candidate, result, score };
    this._cache.set(JSON.stringify(candidate), entry);
    this.evaluations.push(entry);

    if (this.best === null || score > this.best.score) {
      this.best = entry;
      this._sinceBest = 0;
    } else {
      this._sinceBest++;
    }

    if (this.onProgress) {
      const total = Number.isFinite(this.budget) ? this.budget : this.evaluations.length;
      this.onProgress(this.evaluations.length, total);
    }
    return entry;
  }

  /** Evaluate a candidate (cached). Counts toward the budget only when novel. */
  async evaluate(candidate) {
    const key = JSON.stringify(candidate);
    const hit = this._cache.get(key);
    if (hit) return hit;

    const { result, score } = this.problem.evaluate(candidate);
    const entry = this._record(candidate, result, score);
    await new Promise(resolve => setTimeout(resolve, 0));
    return entry;
  }

  /**
   * Evaluate a whole batch (one CEM generation) — design 46 Phase 0.5. Bit-identical
   * to calling `evaluate` on each candidate in order, but the novel rollouts are
   * computed together (in a worker pool when present, else in-process), which is
   * safe because a rollout is a pure deterministic function of the candidate.
   *
   * Exactness is preserved by folding results **in candidate order** through the
   * same `_record`/`exhausted` path the sequential loop uses:
   *   1. Plan — walk candidates in order, marking cache hits vs novel, capping the
   *      novel set at the remaining budget headroom (a novel beyond it would be
   *      skipped by the sequential `break`, so it isn't computed).
   *   2. Compute — roll the unique novel candidates (pool or in-process).
   *   3. Fold — replay the sequential loop: stop at `exhausted`, return cache hits
   *      untouched, `_record` novels. Budget/best/`_sinceBest`/abort behave exactly
   *      as the per-candidate path. Any surplus rollout computed in step 2 but cut
   *      by a mid-fold convergence/abort stop is simply discarded (rare; harmless).
   *
   * @returns {Array} entries for the candidates processed before exhaustion, in order.
   */
  async evaluateBatch(candidates) {
    if (this.exhausted) return [];

    // 1) Plan.
    const plan = [];                 // { candidate, key } in processing order
    const novelCandidates = [];      // unique novel candidates to compute, first-seen order
    const novelIndexByKey = new Map();
    const plannedNovel = new Set();
    const headroom = Number.isFinite(this.budget)
      ? Math.max(0, this.budget - this.evaluations.length) : Infinity;
    for (const candidate of candidates) {
      const key = JSON.stringify(candidate);
      const known = this._cache.has(key) || plannedNovel.has(key);
      if (!known) {
        if (novelCandidates.length >= headroom) break;   // budget stops here (sequential break)
        plannedNovel.add(key);
        novelIndexByKey.set(key, novelCandidates.length);
        novelCandidates.push(candidate);
      }
      plan.push({ candidate, key });
    }

    // 2) Compute the unique novel candidates → { result, score }, aligned to
    //    novelCandidates order (deterministic per candidate).
    const computed = await this._computeEntries(novelCandidates);

    // 3) Fold in order — exact sequential semantics.
    const out = [];
    for (const { candidate, key } of plan) {
      if (this.exhausted) break;
      const hit = this._cache.get(key);
      if (hit) { out.push(hit); continue; }
      const { result, score } = computed[novelIndexByKey.get(key)];
      out.push(this._record(candidate, result, score));
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    return out;
  }

  /**
   * Compute { result, score } for a set of unique novel candidates.
   *
   * In-process (no pool): the canonical `problem.evaluate` — so the batch path is
   * behavior-identical to the sequential loop and honors any `evaluate` override
   * (e.g. the analytic test mocks). This is the path P-a and every worker-less
   * environment (Node tests) take.
   *
   * With a worker pool (design 46 Phase 0.5 P-b): the worker rolls the
   * objective-free `result` off the main thread and the score is applied here via
   * `problem._scoreResult` (objectives carry functions and don't cross the boundary).
   */
  async _computeEntries(candidates) {
    if (candidates.length === 0) return [];
    if (this.workerPool) {
      // Configure the pool for this problem (ref-deduped inside setProblem — one
      // broadcast per solve, re-broadcast on a new epoch's problem) before any task.
      this.workerPool.setProblem(this.problem);
      const results = await this.workerPool.map(candidates);
      return results.map(result => ({ result, score: this.problem._scoreResult(result) }));
    }
    return candidates.map(c => this.problem.evaluate(c));
  }

  /** Final result in the shared solver shape, candidates ranked best-first. */
  result(solverKey) {
    const candidates = [...this.evaluations].sort((a, b) => b.score - a.score);
    return {
      candidates,
      best:        this.best ?? candidates[0] ?? null,
      evaluations: this.evaluations.length,
      solver:      solverKey,
    };
  }
}
