/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Worker } from 'node:worker_threads';

/**
 * A RolloutWorkerPool `spawn` backed by Node worker_threads, for exercising the
 * pool under `node --test` (production injects `browserRolloutSpawn`). Normalizes a
 * worker_threads Worker to the pool's handle interface.
 */
export function nodeRolloutSpawn() {
  const entry = new URL('./rollout-worker.node-entry.mjs', import.meta.url);
  return () => {
    const w = new Worker(entry);
    return {
      postMessage: (m)  => w.postMessage(m),
      onMessage:   (cb) => w.on('message', cb),
      onError:     (cb) => w.on('error', cb),
      terminate:   ()   => w.terminate(),
    };
  };
}
