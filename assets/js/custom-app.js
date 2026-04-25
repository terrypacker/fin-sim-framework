/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */
import { CustomScenario, DEFAULT_EVENT_SERIES } from './scenarios/custom-scenario.js';

//TODO IS RELEVANT? ── Chart series ──────────────────────────────────────────────────────────────
const CHART_SERIES = [
  { key: 'monthCounter',  color: '#60a5fa', label: 'Month Count'   },
  { key: 'yearCounter',   color: '#34d399', label: 'Year Count'  },
];

class CustomApp extends FinSimLib.Misc.BaseApp {
   constructor() {
     super({
       newScenario: (params, initialState, eventSchedulerUI) => new CustomScenario({
         eventSchedulerUI }),
       updateChart: (chartView, type, date, state) => {
         if (type === 'RECORD_BALANCE') {
           chartView.addSnapshot(date, {
             monthCounter: state.monthCount,
             yearCounter: state.yearCount,
           });
         }
       },
       chartSeries:     CHART_SERIES,
     });
   }

  getInitialState() {
    return {
      metrics: {
        amount: 0,
        salary: 0
      }
    };
  }
}


// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const app = new CustomApp();
  app.initView();
  app.buildScenario();
});
