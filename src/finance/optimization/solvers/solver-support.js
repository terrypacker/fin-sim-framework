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
  constructor(problem, { onProgress, budget = Infinity, noImproveLimit = Infinity, signal } = {}) {
    this.problem        = problem;
    this.onProgress     = onProgress;
    this.budget         = budget;
    this.noImproveLimit = noImproveLimit;
    this.signal         = signal;

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

  /** Evaluate a candidate (cached). Counts toward the budget only when novel. */
  async evaluate(candidate) {
    const key = JSON.stringify(candidate);
    const hit = this._cache.get(key);
    if (hit) return hit;

    const { result, score } = this.problem.evaluate(candidate);
    const entry = { candidate, result, score };
    this._cache.set(key, entry);
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
    await new Promise(resolve => setTimeout(resolve, 0));
    return entry;
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
