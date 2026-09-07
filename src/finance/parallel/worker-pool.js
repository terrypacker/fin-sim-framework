/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

const MAX_POOL = 8;

/** Pool size: one worker per core, capped, with a conservative fallback. */
export function defaultPoolSize() {
  const c = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  return Math.max(1, Math.min(c, MAX_POOL));
}

/**
 * WorkerPool — the environment-agnostic half of the rollout pool (design 46 Phase
 * 0.5), extracted so Monte Carlo can reuse it without depending on the optimizer.
 *
 * The pool knows only three things, none of them domain-specific:
 *
 *   1. `spawn()` returns a normalized handle `{ postMessage, onMessage, onError?,
 *      terminate }`. The browser subclass wraps a Vite module worker; tests inject a
 *      `node:worker_threads` spawn, which is what keeps `node:worker_threads` out of
 *      the production bundle.
 *   2. The heavy shared context is broadcast ONCE via `setContext` as
 *      `{ type: 'init', ctx }`; per task only a small payload travels. Per-worker
 *      message ORDER guarantees a worker processes `init` before any `task`.
 *   3. Tasks carry a `taskId`, so completion order is irrelevant — `mapTasks`
 *      resolves each payload's promise by id and returns results in the CALLER's
 *      order. A domain that wants completion-order feedback asks for it explicitly
 *      via `onSettled`, which fires as each result lands.
 *
 * A worker-level error poisons the pool: every pending and queued task rejects, and
 * so does everything submitted afterwards. That is deliberate — a worker that failed
 * to build its resident context would otherwise return quietly wrong answers.
 */
export class WorkerPool {
  constructor({ size, spawn } = {}) {
    if (typeof spawn !== 'function') throw new Error('WorkerPool: `spawn` is required');
    this._size    = size ?? defaultPoolSize();
    this._spawn   = spawn;
    this._handles = null;            // lazily started
    this._idle    = [];
    this._queue   = [];              // { payload, kind, opts, resolve, reject }
    this._pending = new Map();       // taskId → { resolve, reject, handle }
    this._taskId  = 0;
    this._context = null;
    this._fatal   = null;            // a worker-level error poisons the pool
  }

  /** Number of workers this pool will run (spawned lazily on first use). */
  get size() { return this._size; }

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

  /** Broadcast the shared context; every worker rebuilds its resident state. */
  setContext(ctx) {
    this._context = ctx;
    this._start();
    for (const h of this._handles) h.postMessage({ type: 'init', ctx });
  }

  /**
   * Run one task per payload, resolving to results in INPUT order.
   *
   * @param {Array}    payloads          one small, structured-clone-safe value per task
   * @param {string}   [kind]            passed through to the worker entry
   * @param {object}   [opts]
   * @param {object}   [opts.opts]       extra per-task options, passed through
   * @param {Function} [opts.onSettled]  called as each task lands, in COMPLETION
   *        order, with (completed, total). Progress is the one thing a caller cannot
   *        reconstruct from the input-ordered result array.
   */
  mapTasks(payloads, kind, { opts, onSettled } = {}) {
    this._start();
    const total = payloads.length;
    let done = 0;
    return Promise.all(payloads.map(p => this._enqueue(p, kind, opts).then(
      (r) => { if (onSettled) onSettled(++done, total); return r; },
      (e) => { if (onSettled) onSettled(++done, total); throw e; },
    )));
  }

  _enqueue(payload, kind, opts) {
    if (this._fatal) return Promise.reject(this._fatal);
    return new Promise((resolve, reject) => {
      this._queue.push({ payload, kind, opts, resolve, reject });
      this._pump();
    });
  }

  _pump() {
    while (this._idle.length && this._queue.length) {
      const h   = this._idle.pop();
      const job = this._queue.shift();
      const taskId = this._taskId++;
      this._pending.set(taskId, { ...job, handle: h });
      h.postMessage({ type: 'task', kind: job.kind, taskId, payload: job.payload, opts: job.opts });
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

  /** Tear down all workers. Subclasses that memoize context must clear it here. */
  terminate() {
    if (!this._handles) return;
    for (const h of this._handles) h.terminate();
    this._handles = null;
    this._idle = [];
    this._queue = [];
    this._pending.clear();
    this._context = null;
  }
}
