/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { WorkerPool } from '../../parallel/worker-pool.js';

/**
 * Browser spawn: a Vite module worker normalized to the pool's handle interface.
 * Only the returned closure touches `Worker`/`new URL(...)`, so importing this
 * module in Node (tests) is safe as long as the closure isn't called there.
 */
export function browserMcSpawn() {
  return () => {
    const w = new Worker(new URL('./mc-worker.js', import.meta.url), { type: 'module' });
    return {
      postMessage: (m)  => w.postMessage(m),
      onMessage:   (cb) => w.addEventListener('message', (e) => cb(e.data)),
      onError:     (cb) => w.addEventListener('error', cb),
      terminate:   ()   => w.terminate(),
    };
  };
}

/**
 * McWorkerPool — the Monte Carlo batch, sharded across workers (design 89 §21.7).
 *
 * The whole batch shares ONE context (the serialized template, the resolved base
 * params and variable list), broadcast once by `setContext`; a task is then just an
 * iteration INDEX, and the result is that path's `{ seed, params, result }` record.
 * That asymmetry is why this parallelizes so cheaply: a few hundred kilobytes of
 * world go out once, an integer per task, and ~45 sampled points come back — MC
 * already records metrics rather than state (design 78 §4.5).
 *
 * Ordering is not a correctness concern here the way it is for the optimizer: each
 * iteration is seeded from its own index, so results are bit-identical to the serial
 * loop regardless of which worker ran which path. `map` still returns input order,
 * because `runs[i]` is addressed by index everywhere downstream (the runs panel, the
 * replay button, `firstDecadeBelowMedian`).
 */
export class McWorkerPool extends WorkerPool {
  constructor({ size, spawn = browserMcSpawn() } = {}) {
    super({ size, spawn });
  }

  /**
   * Run the given iteration indices; resolves to their records in INPUT order.
   *
   * @param {number[]} indices
   * @param {object}   [opts]
   * @param {Function} [opts.onSettled] (completed, total) as each path lands
   */
  map(indices, { onSettled } = {}) {
    return this.mapTasks(indices, 'iteration', { onSettled });
  }
}
