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
 * Node worker_threads entry for testing RolloutWorkerPool under `node --test`
 * (design 46 Phase 0.5 P-b). Mirrors the browser entry (`rollout-worker.js`) but
 * uses `parentPort` instead of `self`. Kept under tests/ so `node:worker_threads`
 * never enters the production/Vite bundle.
 */
import { parentPort } from 'node:worker_threads';
import { initProblem, runTask, runSeriesTask } from '../../../src/finance/optimization/parallel/rollout-worker-core.js';

parentPort.on('message', (msg) => {
  if (!msg) return;
  if (msg.type === 'init') { initProblem(msg.ctx); return; }
  if (msg.type === 'task') {
    try {
      const result = msg.kind === 'series' ? runSeriesTask(msg.candidate, msg.opts) : runTask(msg.candidate);
      parentPort.postMessage({ taskId: msg.taskId, result });
    } catch (err) {
      parentPort.postMessage({ taskId: msg.taskId, error: String(err?.stack ?? err) });
    }
  }
});
