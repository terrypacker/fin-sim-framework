/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { initMcContext, runMcIteration } from './mc-worker-core.js';

/**
 * Browser module-worker entry for Monte Carlo (design 89 §21.7). Vite bundles this
 * file's import graph when it is referenced via
 * `new Worker(new URL('./mc-worker.js', import.meta.url), { type: 'module' })`
 * (see `browserMcSpawn`); it is never imported into the main-thread graph, so `self`
 * is only ever touched inside the worker.
 *
 * Mirrors `optimization/parallel/rollout-worker.js` deliberately — one message shape
 * for both pools, so a change to the protocol is a change to one thing.
 */
self.onmessage = (e) => {
  const msg = e.data;
  if (!msg) return;
  if (msg.type === 'init') { initMcContext(msg.ctx); return; }
  if (msg.type === 'task') {
    try {
      self.postMessage({ taskId: msg.taskId, result: runMcIteration(msg.payload) });
    } catch (err) {
      self.postMessage({ taskId: msg.taskId, error: String(err?.stack ?? err) });
    }
  }
};
