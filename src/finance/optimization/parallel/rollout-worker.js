/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { initProblem, runTask, runSeriesTask } from './rollout-worker-core.js';

/**
 * Browser module-worker entry (design 46 Phase 0.5 P-b). Vite bundles this file's
 * import graph when it is referenced via
 * `new Worker(new URL('./rollout-worker.js', import.meta.url), { type: 'module' })`
 * (see `browserRolloutSpawn`); it is never imported into the main-thread graph, so
 * `self` is only ever touched inside the worker.
 */
self.onmessage = (e) => {
  const msg = e.data;
  if (!msg) return;
  if (msg.type === 'init') { initProblem(msg.ctx); return; }
  if (msg.type === 'task') {
    try {
      const result = msg.kind === 'series' ? runSeriesTask(msg.candidate, msg.opts) : runTask(msg.candidate);
      self.postMessage({ taskId: msg.taskId, result });
    } catch (err) {
      self.postMessage({ taskId: msg.taskId, error: String(err?.stack ?? err) });
    }
  }
};
