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
 * each EXECUTION_END snapshot.
 *
 * These run at EVERY telemetry level, including silent and Monte Carlo runs — they are
 * computation, not observation (design 78 §4.2). Gating them on `!silent` once left
 * `netWorth` at *0* rather than absent in every silent run, a trap each batch caller had
 * to know to route around. See the note beside the call site in `simulation.js`.
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
   * @param {Date}   [date] — current simulation date; passed as second arg to each fn
   */
  run(state, date) {
    for (const fn of this._fns) fn(state, date);
  }
}
