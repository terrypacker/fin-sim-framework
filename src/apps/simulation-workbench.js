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

import {BaseApp} from "./base-app.js";
import { IntlRetirementScenario } from "../scenarios/intl-retirement-scenario.js";

const CHART_SERIES = [
  { key: 'usSavingsAccount.balance', color: '#60a5fa', label: 'US Savings'    },
  { key: 'auSavingsAccount.balance', color: '#34d399', label: 'AU Savings'    },
  { key: 'superAccount.balance',     color: '#f59e0b', label: 'Super'         },
  { key: 'stockAccount.balance',     color: '#a78bfa', label: 'US Stock'      },
];

export class SimulationWorkbench extends BaseApp {
  constructor() {
    super({
      newScenario: (params, initialState, eventSchedulerUI) => {
        return new IntlRetirementScenario({ eventSchedulerUI });
      },
      chartSeries: CHART_SERIES,
    });
  }
}
