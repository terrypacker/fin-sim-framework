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

import { WorkbenchApp }            from './workbench-app.js';
import { IntlRetirementScenario } from '../scenarios/intl-retirement-scenario.js';
import { UsSingleHomeownerScenario } from '../scenarios/us-single-homeowner-scenario.js';
import { AuSingleHomeownerScenario } from '../scenarios/au-single-homeowner-scenario.js';
import { FarmScenario }            from '../scenarios/farm-scenario.js';
import { seasonWindow }            from '../finance/farm/farm-records.js';

// One farm season (design 134): the crop year's inputs are prepaid the December before, and
// its grain is sold into the year after harvest, so the window is the season's own.
const FARM_WINDOW = seasonWindow(FarmScenario.DEFAULT_CROP_YEAR);

const CHART_SERIES = [
  { key: 'usSavingsAccount.balance', color: '#60a5fa', label: 'US Savings'    },
  { key: 'auSavingsAccount.balance', color: '#34d399', label: 'AU Savings'    },
  { key: 'superAccount.balance',     color: '#f59e0b', label: 'Super'         },
  { key: 'stockAccount.balance',     color: '#a78bfa', label: 'US Stock'      },
];

/**
 * Pre-built scenarios available in the SimulationWorkbench dropdown.
 *
 * Each entry: { cls, order, active, simStart, simEnd }
 * The scenario with the lowest `order` is selected on a fresh page load.
 */
const PREBUILT_SCENARIOS = [
  {
    cls:      IntlRetirementScenario,
    order:    1,
    active:   true,
    simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd:   new Date(Date.UTC(2041, 0, 1)),
  },
  {
    // Runs to age 85. Long on purpose: the twenty working years, the mortgage term
    // and the RMD age all have to fall inside the window or the scenario's own
    // subject matter never happens.
    cls:      UsSingleHomeownerScenario,
    order:    2,
    active:   false,
    simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd:   new Date(Date.UTC(2066, 0, 1)),
  },
  {
    // Same window as its US sibling, deliberately: the two are meant to be read
    // side by side, and a different horizon would make every terminal figure
    // incomparable for a reason that has nothing to do with the tax systems.
    cls:      AuSingleHomeownerScenario,
    order:    3,
    active:   false,
    simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd:   new Date(Date.UTC(2066, 0, 1)),
  },
  {
    // A farm with no household: the Field P&L panel (Farm view) is its report.
    cls:      FarmScenario,
    order:    4,
    active:   false,
    simStart: new Date(`${FARM_WINDOW.simStart}T00:00:00.000Z`),
    simEnd:   new Date(`${FARM_WINDOW.simEnd}T00:00:00.000Z`),
  },
];

export class SimulationWorkbench extends WorkbenchApp {
  constructor() {
    super({
      prebuiltScenarios: PREBUILT_SCENARIOS,
      chartSeries:       CHART_SERIES,
    });
  }
}
