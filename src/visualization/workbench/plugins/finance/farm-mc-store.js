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
 * The farm Monte Carlo's shared state (design 134 §17.12): the last batch, which the Farm MC
 * panel writes and the Farm MC Results panel reads, and the path a replay has put in force,
 * which the app writes and the results panel's badge reads.
 *
 * It lives on the workbench runtime, the session's one object, because a replay rebuilds the
 * scenario: panel state that is not on the runtime is the household's `_mcResultCarry` problem
 * over again. The runtime outlives every rebuild; a batch is kept until the next one.
 *
 *   result: { summary, runs, farm, labels, scenarioId } | null
 *   replay: { index, seed, label, scenarioId } | null
 */
export class FarmMcStore {
  constructor() {
    this.result = null;
    this.replay = null;
    this._listeners = new Set();
  }

  /** `fn()` on every change; returns the unsubscribe. */
  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  setResult(result) { this.result = result ?? null; this._notify(); }
  setReplay(replay) { this.replay = replay ?? null; this._notify(); }

  _notify() { for (const fn of [...this._listeners]) fn(); }
}

/** The runtime's farm MC store, made on first use. */
export function farmMcStore(runtime) {
  if (!runtime) return new FarmMcStore();
  runtime.farmMc ??= new FarmMcStore();
  return runtime.farmMc;
}
