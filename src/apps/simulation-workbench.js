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

import { BaseApp }                            from './base-app.js';
import { PrebuiltScenario }                   from '../scenarios/prebuilt-scenario.js';
import { IntlRetirementScenario }             from '../scenarios/intl-retirement-scenario.js';
import { SimulationWorkbenchDefaultScenario } from '../scenarios/simulation-workbench-default-scenario.js';
import {ServiceRegistry} from "../services/service-registry.js";

const CHART_SERIES = [
  { key: 'usSavingsAccount.balance', color: '#60a5fa', label: 'US Savings'    },
  { key: 'auSavingsAccount.balance', color: '#34d399', label: 'AU Savings'    },
  { key: 'superAccount.balance',     color: '#f59e0b', label: 'Super'         },
  { key: 'stockAccount.balance',     color: '#a78bfa', label: 'US Stock'      },
];

/**
 * Pre-built scenarios available in the SimulationWorkbench dropdown.
 *
 * Order matters: the scenario with the lowest `order` value is selected
 * automatically on a fresh page load (no saved localStorage state).
 */
const PREBUILT_SCENARIOS = [
  new PrebuiltScenario({
    id:       'intl-retirement',
    label:    'International Retirement',
    order:    1,
    simStart: '2026-01-01',
    simEnd:   '2041-01-01',
    factory:  (_params, _initialState, ui) => new IntlRetirementScenario({
      configPresenter: ui,
      context: ServiceRegistry.getInstance().simulationContext
    }),
  }),
  new PrebuiltScenario({
    id:       'workbench-default',
    label:    'Workbench Default',
    order:    2,
    simStart: '2026-01-01',
    simEnd:   '2041-01-01',
    factory:  (_params, _initialState, ui) => new SimulationWorkbenchDefaultScenario({
      configPresenter: ui,
      context: ServiceRegistry.getInstance().simulationContext
    }),
  }),
];

export class SimulationWorkbench extends BaseApp {
  constructor() {
    super({
      prebuiltScenarios: PREBUILT_SCENARIOS,
      chartSeries:       CHART_SERIES,
    });
  }
}
