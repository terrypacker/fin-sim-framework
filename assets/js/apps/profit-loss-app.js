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
 * profit-loss-app.js
 * Main application controller and ES module entry point.
 * Run once on DOMContentLoaded.
 *
 * This is a basic example of how to use the framework.
 */

import { ProfitLossScenario, DEFAULT_EVENT_SERIES } from "../scenarios/profit-loss-scenario.js";
import { BaseApp } from "./base-app.js";

// Editable event series list (copy of defaults so user can toggle)
let eventSeries  = DEFAULT_EVENT_SERIES.map(s => ({ ...s }));
// One-off custom events added via form
let customEvents = [];

const app = new BaseApp({
  newScenario: (params) =>  new ProfitLossScenario({ params, eventSeries, customEvents }),
  readParams: () => readParams(),
});

/* Currently no params */
function readParams() {
  return {  };
}

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  app.initView();
  app.buildScenario();
});

