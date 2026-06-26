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

/**
 * SimulatedAnnealingSolver — seeded Metropolis local search over the encoded
 * vector with a geometric cooling schedule (design/38 §4).
 *
 * From the current point it proposes a neighbour (every coordinate perturbed,
 * the move size scaled by the current temperature), decodes/snaps it, and
 * accepts it when it improves OR, when it worsens, with probability
 * `exp(Δ / T)` — so early on it can climb out of local optima and, as `T` cools,
 * it settles into hill-climbing. Best for discrete "many amounts" grids and
 * rugged landscapes. Deterministic given a seed.
 *
 * ── Temperature is in objective units ──────────────────────────────────────
 * `Δ` is a difference of objective scores, so `T` must share their scale — and
 * that scale differs by orders of magnitude between a toy quadratic (~tens) and
 * lifetime net worth (~$10⁶). Rather than ask the user to guess, `T₀` is
 * auto-calibrated from a short burn-in: the mean |Δ| of a handful of random
 * neighbour moves, divided by `-ln(initialAcceptProb)`, so a typical worsening
 * move is accepted ~`initialAcceptProb` of the time at the start. An explicit
 * `initialTemp > 0` overrides the calibration.
 */
export class SimulatedAnnealingSolver {
  static key   = 'SIMULATED_ANNEALING';
  static label = 'Simulated Annealing';

  constructor({
    budget = 300, seed = 1, cooling = 0.95, initialTemp = 0,
    initialAcceptProb = 0.8, noImproveLimit = Infinity, start = null,
  } = {}) {
    this.budget            = budget;
    this.seed              = seed;
    this.cooling           = cooling;
    this.initialTemp       = initialTemp;
    this.initialAcceptProb = initialAcceptProb;
    this.noImproveLimit    = noImproveLimit;
    this.start             = start;
  }

  async solve(problem, {
    onProgress, signal,
    budget         = this.budget,
    seed           = this.seed,
    cooling        = this.cooling,
    initialTemp    = this.initialTemp,
    noImproveLimit = this.noImproveLimit,
    start          = this.start,
  } = {}) {
    const rng      = makeSeededRng(seed);
    const patience = noImproveLimit > 0 ? noImproveLimit : Infinity;
    const ledger   = new EvalLedger(problem, { onProgress, budget, noImproveLimit: patience, signal });
    const n        = problem.variables.length;

    const evalVec = (vec) => ledger.evaluate(problem.decode(vec));

    let curVec   = problem.encode(start ?? problem.randomCandidate(rng));
    let curEntry = await evalVec(curVec);
    let curScore = curEntry.score;

    if (n === 0 || ledger.exhausted) return ledger.result(SimulatedAnnealingSolver.key);

    // Temperature scaled by a fraction in (0,1]; floored so moves never freeze
    // entirely while budget remains.
    let T0 = initialTemp;
    const proposal = (vec, T) => {
      const frac = Math.max(0.05, T0 > 0 ? T / T0 : 1);
      const t = vec.slice();
      for (let k = 0; k < n; k++) {
        const v = problem.variables[k];
        if (v.type === OPT_PARAM_TYPES.ENUM) {
          const span = Math.max(1, Math.round(((v.values?.length ?? 1) - 1) * frac));
          t[k] += (rng() < 0.5 ? -1 : 1) * (1 + Math.floor(rng() * span));
        } else {
          const range = v.max - v.min;
          const base  = v.type === OPT_PARAM_TYPES.INTEGER
            ? Math.max(v.step ?? 1, range * 0.3)
            : range * 0.3;
          t[k] += (rng() * 2 - 1) * base * frac;
        }
      }
      return t;
    };

    // ── Burn-in: estimate T0 from the spread of nearby moves (unless given). ──
    if (!(initialTemp > 0)) {
      const burn = Math.max(1, Math.min(20, Math.floor(budget / 4)));
      let sumAbs = 0, count = 0;
      // Use a unit temperature for burn-in proposals (T0 not known yet).
      T0 = 1;
      for (let i = 0; i < burn && !ledger.exhausted; i++) {
        const e = await evalVec(proposal(curVec, 1));
        sumAbs += Math.abs(e.score - curScore);
        count++;
      }
      const meanAbs = count > 0 ? sumAbs / count : 1;
      T0 = Math.max(1e-9, meanAbs) / Math.max(1e-6, -Math.log(this.initialAcceptProb));
    }

    let T = T0;
    const maxIters = budget * 8 + 32; // guard against all-cached stalls
    for (let i = 0; i < maxIters && !ledger.exhausted; i++) {
      const trial = proposal(curVec, T);
      const e     = await evalVec(trial);
      const delta = e.score - curScore;
      if (delta >= 0 || rng() < Math.exp(delta / Math.max(1e-12, T))) {
        curVec = trial; curScore = e.score;
      }
      T *= cooling;
    }

    return ledger.result(SimulatedAnnealingSolver.key);
  }
}
