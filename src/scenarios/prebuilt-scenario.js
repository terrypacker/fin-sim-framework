/*
 * Copyright (c) 2026 Terry Packer.
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

import {BaseScenario} from "./base-scenario.js";

/**
 * PrebuiltScenario — descriptor for a scenario that ships with the application.
 *
 * An array of these is passed to BaseApp (via the `prebuiltScenarios` option)
 * and forwarded to ScenarioTabPresenter, which:
 *   - Shows them as the first option group in the scenario dropdown.
 *   - Selects the one with the lowest `order` value on first page load (no saved state).
 *   - Calls `factory` to instantiate the correct scenario class whenever the
 *     prebuilt (or a user scenario derived from it) is loaded.
 */
export class PrebuiltScenario extends BaseScenario {
  /**
   * @param {object}   opts
   * @param {string}   opts.id        - Unique stable identifier (e.g. 'intl-retirement').
   *                                    Stored in saved user scenarios via `scenarioId`.
   * @param {string}   opts.label     - Display name shown in the dropdown.
   * @param {number}   opts.order     - Sort key; lower values appear first and are
   *                                    selected by default on a fresh page load.
   * @param {string}   [opts.simStart='2026-01-01'] - ISO date for the default sim start.
   * @param {string}   [opts.simEnd='2041-01-01']   - ISO date for the default sim end.
   * @param {Function} opts.factory   - (params, initialState, eventSchedulerUI) => BaseScenario
   */
  constructor({ id, label, order, simStart = '2026-01-01', simEnd = '2041-01-01', factory, active = false }) {
    super({
      id, order, context: {}, simStart, simEnd
    })
    this.label    = label;
    this.prebuilt = true;
    this.active   = active;
    this.factory  = factory;
    this.params   = {};
  }
}
