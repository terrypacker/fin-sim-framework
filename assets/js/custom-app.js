/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */
import { CustomScenario } from './scenarios/custom-scenario.js';

// ── Chart series ──────────────────────────────────────────────────────────────
const CHART_SERIES = [
  { key: 'monthCounter', color: '#60a5fa', label: 'Month Count' },
  { key: 'yearCounter',  color: '#34d399', label: 'Year Count'  },
];

class CustomApp extends FinSimLib.Misc.BaseApp {
  constructor() {
    super({
      newScenario: (params, initialState, eventSchedulerUI) => {
        const cfg = this._activeScenario();
        if (cfg) {
          return new FinSimLib.Scenarios.BaseScenario({
            eventSchedulerUI,
            simStart: cfg.simStart ? new Date(cfg.simStart) : new Date(Date.UTC(2026, 0, 1)),
            simEnd:   cfg.simEnd   ? new Date(cfg.simEnd)   : new Date(Date.UTC(2041, 0, 1)),
          });
        }
        return new CustomScenario({ eventSchedulerUI });
      },
      chartSeries: CHART_SERIES,
    });
  }

  getInitialState() {
    const activeScenario = super._activeScenario();
    if(activeScenario) {
      return activeScenario.initialState;
    }else {
      return {
        metrics: {
          amount: 0,
          salary: 0
        }
      };
    }
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const app = new CustomApp();
  app.initView();
  app.buildScenario();
});
