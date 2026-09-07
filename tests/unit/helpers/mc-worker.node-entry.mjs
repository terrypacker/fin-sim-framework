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
 * Node worker_threads entry for testing McWorkerPool under `node --test`
 * (design 89 §21.7). Mirrors the browser entry (`mc-worker.js`) but uses
 * `parentPort` instead of `self`. Kept under tests/ so `node:worker_threads` never
 * enters the production/Vite bundle.
 */
import { parentPort } from 'node:worker_threads';
import { initMcContext, runMcIteration } from '../../../src/finance/monte-carlo/parallel/mc-worker-core.js';

parentPort.on('message', (msg) => {
  if (!msg) return;
  if (msg.type === 'init') { initMcContext(msg.ctx); return; }
  if (msg.type === 'task') {
    try {
      parentPort.postMessage({ taskId: msg.taskId, result: runMcIteration(msg.payload) });
    } catch (err) {
      parentPort.postMessage({ taskId: msg.taskId, error: String(err?.stack ?? err) });
    }
  }
});
