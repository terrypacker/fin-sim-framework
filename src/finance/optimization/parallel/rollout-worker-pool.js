/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { objectiveIsWindowable } from '../optimization-objectives.js';

const MAX_POOL = 8;

function defaultSize() {
  const c = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  return Math.max(1, Math.min(c, MAX_POOL));
}

/**
 * The per-epoch context a worker needs to rebuild the problem (design 46 Phase 0.5).
 * Everything here is structured-clone-safe: the cfg template is PRE-serialized (the
 * raw form carries registry factories), baseParams/variables/snapshot are plain data
 * with Dates, and the objective is reduced to just its `windowable` flag — the only
 * thing the rollout path reads (scoring stays on the main thread).
 */
export function rolloutContext(problem) {
  return {
    serializedTemplate:  problem._cfgTemplate(),
    // The RESOLVED base (template params merged in), not the raw constructor arg:
    // the worker is handed a pre-serialized template and so cannot redo that merge
    // itself. Sending the raw arg would make worker rollouts run a different world
    // than serial ones — the kind of divergence that shows up as a solver that
    // "only reproduces single-threaded".
    baseParams:          problem._resolveBase(),
    variables:           problem.variables,
    simStart:            problem.simStart,
    simEnd:              problem.simEnd,
    initialState:        { kind: problem.initialState?.kind, snapshot: problem.initialState?.snapshot },
    horizonYears:        problem.horizonYears,
    objectiveWindowable: objectiveIsWindowable(problem.objective),
  };
}

/**
 * Browser spawn: a Vite module worker normalized to the pool's handle interface.
 * Only the returned closure touches `Worker`/`new URL(...)`, so importing this
 * module in Node (tests) is safe as long as the closure isn't called there.
 */
export function browserRolloutSpawn() {
  return () => {
    const w = new Worker(new URL('./rollout-worker.js', import.meta.url), { type: 'module' });
    return {
      postMessage: (m)  => w.postMessage(m),
      onMessage:   (cb) => w.addEventListener('message', (e) => cb(e.data)),
      onError:     (cb) => w.addEventListener('error', cb),
      terminate:   ()   => w.terminate(),
    };
  };
}

/**
 * RolloutWorkerPool — a fixed set of workers that each hold a resident problem and
 * roll candidates in parallel (design 46 Phase 0.5). Environment-agnostic: `spawn`
 * returns a normalized handle `{ postMessage, onMessage, onError?, terminate }`; the
 * browser default is `browserRolloutSpawn`, and tests inject a Node worker_threads
 * spawn (keeping `node:worker_threads` out of the production bundle).
 *
 * The heavy shared epoch state is broadcast ONCE via `setContext`; per task only the
 * tiny candidate travels. Per-worker message order guarantees a worker processes
 * `init` before any `task`. Results carry a `taskId`, so completion order is
 * irrelevant — `map` resolves each candidate's promise by id and returns in the
 * caller's order.
 */
export class RolloutWorkerPool {
  constructor({ size, spawn = browserRolloutSpawn() } = {}) {
    this._size    = size ?? defaultSize();
    this._spawn   = spawn;
    this._handles = null;            // lazily started
    this._idle    = [];
    this._queue   = [];              // { candidate, resolve, reject }
    this._pending = new Map();       // taskId → { resolve, reject, handle }
    this._taskId  = 0;
    this._context = null;
    this._fatal   = null;            // a worker-level error poisons the pool
    this._problemRef = null;         // last problem `setProblem` configured for (ref-dedup)
  }

  _start() {
    if (this._handles) return;
    this._handles = [];
    for (let i = 0; i < this._size; i++) {
      const h = this._spawn();
      h.onMessage((msg) => this._onMessage(h, msg));
      h.onError?.((err) => this._onError(err));
      this._handles.push(h);
      this._idle.push(h);
    }
  }

  /**
   * Configure the pool for a specific problem. Ref-deduped: repeated calls with the
   * SAME problem object (the solve then the fan within one advise) broadcast once; a
   * new epoch's problem re-broadcasts. The single entry point callers should use.
   */
  setProblem(problem) {
    if (this._problemRef === problem) return;
    this._problemRef = problem;
    this.setContext(rolloutContext(problem));
  }

  /** Broadcast the epoch context; every worker rebuilds its resident problem. */
  setContext(ctx) {
    this._context = ctx;
    this._start();
    for (const h of this._handles) h.postMessage({ type: 'init', ctx });
  }

  /** Roll a set of candidates to `result`s, aligned to input order. */
  map(candidates) { return this._dispatch(candidates, 'rollout'); }

  /** Roll a set of candidates to net-worth series (the cockpit fan), input order. */
  mapSeries(candidates, opts) { return this._dispatch(candidates, 'series', opts); }

  _dispatch(candidates, kind, opts) {
    this._start();
    return Promise.all(candidates.map(c => this._enqueue(c, kind, opts)));
  }

  _enqueue(candidate, kind, opts) {
    if (this._fatal) return Promise.reject(this._fatal);
    return new Promise((resolve, reject) => {
      this._queue.push({ candidate, kind, opts, resolve, reject });
      this._pump();
    });
  }

  _pump() {
    while (this._idle.length && this._queue.length) {
      const h   = this._idle.pop();
      const job = this._queue.shift();
      const taskId = this._taskId++;
      this._pending.set(taskId, { ...job, handle: h });
      h.postMessage({ type: 'task', kind: job.kind, taskId, candidate: job.candidate, opts: job.opts });
    }
  }

  _onMessage(handle, msg) {
    if (msg == null || msg.taskId == null) return;
    const job = this._pending.get(msg.taskId);
    if (!job) return;
    this._pending.delete(msg.taskId);
    this._idle.push(handle);
    if (msg.error) job.reject(new Error(msg.error));
    else           job.resolve(msg.result);
    this._pump();
  }

  _onError(err) {
    const e = err instanceof Error ? err : new Error(String(err?.message ?? err));
    this._fatal = e;
    for (const [, job] of this._pending) job.reject(e);
    for (const job of this._queue) job.reject(e);
    this._pending.clear();
    this._queue = [];
  }

  /** Tear down all workers. */
  terminate() {
    if (!this._handles) return;
    for (const h of this._handles) h.terminate();
    this._handles = null;
    this._idle = [];
    this._queue = [];
    this._pending.clear();
    this._problemRef = null;   // a respawn must re-broadcast context
    this._context = null;
  }
}
