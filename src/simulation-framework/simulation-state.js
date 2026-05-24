/*
 * Copyright (c) 2026 Terry Packer.
 *
 * This file is part of Terry Packer's Work.
 * See www.terrypacker.com for further info.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * SimulationState is a factory/builder for the plain-object state passed to
 * `new Simulation(date, { initialState })`.
 *
 * It defines the standard state shape and its defaults.  Subclasses extend it
 * to add domain-specific fields.  Call `toPlain()` to obtain the raw object
 * that `Simulation` stores and clones during snapshots.
 *
 * IMPORTANT: The object returned by `toPlain()` must remain serialisable by
 * `structuredClone`.  Do not place class instances with methods in state —
 * use service objects (e.g. `AccountService`) outside state to operate on
 * plain data held inside it.
 *
 * Standard fields
 * ───────────────
 * metrics  {Object}  Keyed metric arrays consumed by MetricReducer.
 *                    e.g. { salary: [8000, 8000], tax: [1200] }
 *
 * Usage
 * ─────
 * // Direct use
 * const sim = new Simulation(startDate, {
 *   initialState: new SimulationState({ metrics: { score: [] } }).toPlain()
 * });
 *
 * // Subclass use
 * class MyState extends SimulationState {
 *   constructor(opts = {}) {
 *     super(opts);
 *     this.score = opts.score ?? 0;
 *   }
 * }
 * const sim = new Simulation(startDate, {
 *   initialState: new MyState({ score: 100 }).toPlain()
 * });
 */
export class SimulationState {
  constructor({ metrics = {}, ...extra } = {}) {
    this.metrics = metrics;
    Object.assign(this, extra);
  }

  /**
   * Returns a plain data object suitable for use as `initialState` in
   * `new Simulation(...)`.  The result is safe for `structuredClone`.
   *
   * @returns {object}
   */
  toPlain() {
    return { ...this };
  }
}
