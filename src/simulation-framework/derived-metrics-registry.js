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
 * Registry of derived-metric functions run against simulation state just before
 * each EXECUTION_END snapshot (non-silent runs only).
 *
 * Each registered function receives the mutable state object and may write any
 * fields it likes (conventionally under state.metrics.*).  Functions run in
 * insertion order.
 *
 * Usage:
 *   const registry = new DerivedMetricsRegistry();
 *   registry.register(deriveNetWorth);
 *   sim = new Simulation(start, { opts: { derivedMetrics: registry } });
 */
export class DerivedMetricsRegistry {
  constructor() {
    this._fns = [];
  }

  /**
   * Add a derived-metric function.
   * @param {function(state: object): void} fn
   */
  register(fn) {
    this._fns.push(fn);
  }

  /**
   * Run all registered functions against state in insertion order.
   * @param {object} state — mutable simulation state
   */
  run(state) {
    for (const fn of this._fns) fn(state);
  }
}
