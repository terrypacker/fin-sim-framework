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
 * RolloutProfiler — Phase-0 instrumentation for design/46 (MPC performance).
 *
 * Splits the cost of ONE solver rollout (`OptimizationProblem._rollout`) into the
 * three buckets the design's §1/§12 hinge on:
 *   compile   — per-rollout SETUP: `_seededSim` (fresh `_compile` + snapshot inject
 *               + Roth/early-withdrawal retargets). This is the amortizable cost the
 *               "reuse the compiled sim" win (§12) would kill.
 *   step      — the forward simulation: `sim.stepTo(endDate)`.
 *   objective — reading terminal + accumulator metrics: `_readResult`
 *               (net worth, after-tax re-pricing, …). The objective's own
 *               `evaluate()` arithmetic is negligible and left uncounted.
 *
 * Only `_rollout` is instrumented, so the cockpit's fan (`rolloutSeries`) and epoch
 * advance (`rollToSnapshot`) — which don't call `_rollout` — never pollute the split.
 *
 * Disabled by default (near-zero overhead: one branch per bucket). Console workflow,
 * against the app's live loaded scenario:
 *
 *     __rolloutProfiler.enable()          // reset + start timing
 *     // …click "Advise next move" (or run autopilot)…
 *     __rolloutProfiler.report()          // { rollouts, totalMs, compile/step/objective }
 *
 * Exposed as `globalThis.__rolloutProfiler` alongside the existing `window.__app`
 * debug handle (see src/main.js).
 */

const _now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

class RolloutProfiler {
  constructor() {
    this.enabled = false;
    this.reset();
  }

  reset() {
    this.buckets = {
      compile:   { ms: 0, count: 0 },
      step:      { ms: 0, count: 0 },
      objective: { ms: 0, count: 0 },
    };
    this.rollouts = 0;
    return this;
  }

  /** Turn timing on and clear prior samples so a solve is measured in isolation. */
  enable()  { this.enabled = true; this.reset(); return this; }
  disable() { this.enabled = false; return this; }

  /**
   * Time the synchronous `fn()` into `bucket`, returning its result. A pass-through
   * (no clock reads) when disabled, so instrumented call sites stay cheap in prod.
   */
  time(bucket, fn) {
    if (!this.enabled) return fn();
    const t = _now();
    try {
      return fn();
    } finally {
      const b = this.buckets[bucket];
      b.ms += _now() - t;
      b.count += 1;
    }
  }

  /** Count one completed rollout (one `evaluate`). */
  countRollout() { if (this.enabled) this.rollouts += 1; }

  /** Human-readable split: per-rollout averages + share of measured compute. */
  report() {
    const { compile, step, objective } = this.buckets;
    const total = compile.ms + step.ms + objective.ms;
    const share = (x) => (total > 0 ? `${(100 * x / total).toFixed(1)}%` : '—');
    const per   = (b) => (b.count > 0 ? +(b.ms / b.count).toFixed(3) : null);
    return {
      rollouts:    this.rollouts,
      totalMs:     +total.toFixed(1),
      msPerRollout: this.rollouts > 0 ? +(total / this.rollouts).toFixed(3) : null,
      compile:   { totalMs: +compile.ms.toFixed(1),   perRolloutMs: per(compile),   share: share(compile.ms) },
      step:      { totalMs: +step.ms.toFixed(1),       perRolloutMs: per(step),       share: share(step.ms) },
      objective: { totalMs: +objective.ms.toFixed(1), perRolloutMs: per(objective), share: share(objective.ms) },
    };
  }
}

export const rolloutProfiler = new RolloutProfiler();

if (typeof globalThis !== 'undefined') globalThis.__rolloutProfiler = rolloutProfiler;
