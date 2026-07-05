/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseScenario }    from './base-scenario.js';
import { ServiceRegistry } from '../services/service-registry.js';

/**
 * BlankScenario — a minimal no-op scenario.
 *
 * It declares no params and no toolsets, so ScenarioLoader.load() skips both the
 * compile and deserialize branches and leaves an empty graph. The result is a
 * blank canvas the user can populate by adding nodes and linking them by hand —
 * with none of the persons, accounts, or parameters a finance scenario (e.g.
 * IntlRetirementScenario) would otherwise drag in.
 *
 * Used as the scenarioClass for scenarios created via the "+ New" button
 * (ScenarioService.newBlankScenario). The inherited BaseScenario.buildSim() still
 * registers the generic net-worth / net-liquidity derived metrics, which evaluate
 * to zero over an empty state.
 */
export class BlankScenario extends BaseScenario {
  static scenarioId()   { return 'blank'; }
  static scenarioName() { return 'Blank'; }

  static instantiate(params, simStart, simEnd) {
    return new BlankScenario({
      context: ServiceRegistry.getInstance().simulationContext,
      params,
      simStart,
      simEnd,
    });
  }

  /**
   * No params, no toolsets — a truly empty config. Returning a populated (but
   * empty) object means "Reset to Defaults" restores a clean blank canvas rather
   * than no-opping.
   */
  // eslint-disable-next-line no-unused-vars
  static buildDefaultConfig(_params, _simStart, _simEnd) {
    return {
      toolsets:       [],
      parameters:     {},
      persons:        [],
      accounts:       [],
      realProperties: [],
      collectibles:   [],
    };
  }
}
