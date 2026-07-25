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
 * scenario-harness.js — a full-sim harness for the International Retirement
 * scenario, shared by the behavioral / toolset e2e tests.
 *
 * Roughly two dozen test files hand-roll the same four-step dance:
 *
 *     ServiceRegistry.resetAll();
 *     const cfg = IntlRetirementScenario.buildDefaultConfig(params);
 *     …buildSim()… ScenarioLoader().load(cfg, services)… sim.stepTo(…)
 *
 * plus, for toolset-contributed params (behavioralStrategies, bondLadderRungs,
 * shocks, …), an extra `mutateCfg` that poked `cfg.parameters` directly because
 * `buildDefaultConfig` used to drop those keys. That drop is fixed —
 * buildDefaultConfig now forwards any toolset param passed as an override — so a
 * caller can put toolset params straight in `params` and skip the poke.
 *
 * `mutateCfg` remains for *structural* config edits the param bag can't express
 * (seeding holdings, rewriting an account), not for param plumbing.
 */

import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { BaseScenario }           from '../../src/scenarios/base-scenario.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';

/**
 * Build, compile and load an International Retirement sim from a param bag.
 *
 * @param {object}   [opts]
 * @param {object}   [opts.params]     scenario- AND toolset-level params. Toolset
 *                                     params (e.g. `behavioralStrategies`,
 *                                     `bondLadderRungs`) are forwarded onto
 *                                     `cfg.parameters` by buildDefaultConfig.
 * @param {function} [opts.mutateCfg]  (cfg) ⇒ void — structural cfg edits applied
 *                                     after build, before load (seed holdings, …).
 * @param {Date|number|string} [opts.simStart]
 * @param {Date|number|string} [opts.simEnd]
 * @param {Date|number|string} [opts.stepTo]  when set, advances the sim to here.
 * @param {'full'|'journal'|'metrics'|'off'} [opts.telemetry='full'] observation
 *                                     level for the run — see TELEMETRY_LEVELS
 *                                     (design 78 §4.3).
 * @param {function} [opts.sampler]    optional (state, date) ⇒ record collected at
 *                                     the snapshot cadence; read back via sim.samples.
 * @returns {{ sim, scenario, services, cfg }}
 */
export function loadScenarioSim({ params = {}, mutateCfg, simStart, simEnd, stepTo,
                                  telemetry = 'full', sampler = null } = {}) {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  const cfg = IntlRetirementScenario.buildDefaultConfig(params, simStart, simEnd);
  if (mutateCfg) mutateCfg(cfg);
  const scenario = new BaseScenario({
    context:      services.simulationContext,
    initialState: cfg.initialState ?? {},
    simStart:     new Date(cfg.simStart),
    simEnd:       new Date(cfg.simEnd),
  });
  scenario.buildSim({ telemetry, sampler });
  new ScenarioLoader().load(cfg, services);
  if (stepTo != null) scenario.sim.stepTo(stepTo instanceof Date ? stepTo : new Date(stepTo));
  return { sim: scenario.sim, scenario, services, cfg };
}

/**
 * Thin convenience wrapper matching the "core params + toolset params" split some
 * callers prefer. The two bags are merged (toolset params win on collision) and
 * handed to {@link loadScenarioSim}; returns the sim directly.
 *
 * @param {object} [coreParams]     scenario-level params.
 * @param {object} [toolsetParams]  toolset-contributed params (forwarded through).
 * @param {object} [opts]           `{ mutateCfg, simStart, simEnd, stepTo }`.
 * @returns the loaded `sim`.
 */
export function runScenarioWithParams(coreParams = {}, toolsetParams = {}, opts = {}) {
  return loadScenarioSim({ ...opts, params: { ...coreParams, ...toolsetParams } }).sim;
}
