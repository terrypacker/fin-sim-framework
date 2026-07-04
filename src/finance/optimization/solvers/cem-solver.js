/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { OPT_PARAM_TYPES } from '../optimization-objectives.js';
import { makeSeededRng, EvalLedger } from './solver-support.js';

/** Per-dimension [lo, hi] bounds in the encoded vector space the solver searches. */
function encodedBounds(variables) {
  return variables.map(v => {
    if (v.type === OPT_PARAM_TYPES.ENUM) return [0, Math.max(0, (v.values?.length ?? 1) - 1)];
    return [v.min, v.max];
  });
}

/** One standard normal draw from a uniform seeded rng (Box–Muller). */
function gaussian(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * CemSolver — Cross-Entropy Method, the sampling-based MPC backbone (design/39
 * §4). No solver library, no gradients: it samples candidate control vectors
 * from a Gaussian over the encoded space, ranks them by the objective J, keeps an
 * **elite set**, and refits the Gaussian to the elites — iterating toward the
 * optimum. It eats the plant's non-smoothness and the categorical/ordinal
 * controls natively (integer/enum coordinates snap on `decode`), which is exactly
 * why it suits the Roth-ceiling + expense-band problem where a QP cannot reach.
 *
 * It IS a design-38 solver: same `solve(problem, runOpts)` contract, same
 * EvalLedger budgeting/dedup, deterministic from its seed. The receding-horizon
 * controller warm-starts each replan by passing `start` (the previous epoch's
 * decision), which seeds the initial mean — keeping later solves cheap.
 *
 * The first generation, with a broad `sigma0`, is effectively random shooting;
 * successive generations are CEM. (MPPI — exponential score-weighting of the
 * whole population instead of a hard elite cut — is a refinement on the same
 * machinery, deferred.)
 */
export class CemSolver {
  static key   = 'CEM';
  static label = 'Cross-Entropy Method (sampling MPC)';

  constructor({
    budget         = 256,
    seed           = 1,
    population     = 32,
    eliteFrac      = 0.25,
    sigma0         = 0.5,    // initial std as a fraction of each dim's range
    smoothing      = 0.7,    // μ/σ update inertia (0 = jump to elite stats, 1 = frozen)
    sigmaFloor     = 0.01,   // min std as a fraction of range (keeps exploring)
    noImproveLimit = Infinity,
    start          = null,
  } = {}) {
    this.budget         = budget;
    this.seed           = seed;
    this.population     = population;
    this.eliteFrac      = eliteFrac;
    this.sigma0         = sigma0;
    this.smoothing      = smoothing;
    this.sigmaFloor     = sigmaFloor;
    this.noImproveLimit = noImproveLimit;
    this.start          = start;
  }

  async solve(problem, {
    onProgress, signal,
    workerPool     = null,   // design 46 Phase 0.5: parallel rollout pool for a generation
    budget         = this.budget,
    seed           = this.seed,
    population     = this.population,
    eliteFrac      = this.eliteFrac,
    sigma0         = this.sigma0,
    smoothing      = this.smoothing,
    sigmaFloor     = this.sigmaFloor,
    noImproveLimit = this.noImproveLimit,
    start          = this.start,
  } = {}) {
    const rng      = makeSeededRng(seed);
    const patience = noImproveLimit > 0 ? noImproveLimit : Infinity;
    const ledger   = new EvalLedger(problem, { onProgress, budget, noImproveLimit: patience, signal, workerPool });
    const vars     = problem.variables;
    const n        = vars.length;

    if (n === 0) {
      await ledger.evaluate({});
      return ledger.result(CemSolver.key);
    }

    const bounds = encodedBounds(vars);
    const range  = bounds.map(([lo, hi]) => (hi - lo) || 1);

    // Initial mean: warm-start point if given, else the box centre.
    const mean = start
      ? problem.encode(start).map((x, k) => clamp(x, bounds[k][0], bounds[k][1]))
      : bounds.map(([lo, hi]) => (lo + hi) / 2);
    let sigma = range.map(r => sigma0 * r);

    const nElite = Math.max(1, Math.round(population * eliteFrac));

    // Cap generations so a degenerate distribution (all duplicates near an
    // integer/enum optimum → zero novel evals) can't spin without consuming
    // budget. Budget is still the primary stop.
    const maxGen = Math.ceil(budget / Math.max(1, population)) + 4;

    let m = mean.slice();
    for (let g = 0; g < maxGen && !ledger.exhausted; g++) {
      const popVecs = [];
      for (let i = 0; i < population; i++) {
        const vec = m.map((mu, k) => clamp(mu + sigma[k] * gaussian(rng), bounds[k][0], bounds[k][1]));
        popVecs.push(vec);
      }

      // Evaluate the whole generation as one batch (design 46 Phase 0.5): parallel
      // across the worker pool when wired, else sequential in-process — either way
      // bit-identical to per-candidate `evaluate` (order-preserving fold). The
      // returned entries are in popVecs order, truncated where the budget exhausts.
      const before  = ledger.evaluations.length;
      const entries = await ledger.evaluateBatch(popVecs.map(v => problem.decode(v)));
      const scored  = entries.map((entry, i) => ({ vec: popVecs[i], score: entry.score }));
      const novel   = ledger.evaluations.length - before;
      if (scored.length === 0) break;

      // Refit μ/σ to the elite set (top-scoring vectors).
      scored.sort((a, b) => b.score - a.score);
      const elite = scored.slice(0, Math.min(nElite, scored.length));
      const eMean = m.map((_, k) => elite.reduce((s, e) => s + e.vec[k], 0) / elite.length);
      const eStd  = m.map((_, k) => {
        const varK = elite.reduce((s, e) => s + (e.vec[k] - eMean[k]) ** 2, 0) / elite.length;
        return Math.max(Math.sqrt(varK), sigmaFloor * range[k]);
      });

      // Smoothed update (CEM with inertia) toward the elite statistics.
      m     = m.map((mu, k) => smoothing * mu + (1 - smoothing) * eMean[k]);
      sigma = sigma.map((s, k) => smoothing * s + (1 - smoothing) * eStd[k]);

      // Converged + producing no new points → stop (budget would just churn dupes).
      if (novel === 0) break;
    }

    return ledger.result(CemSolver.key);
  }
}
