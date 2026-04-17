/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { DateUtils } from '../simulation-framework/date-utils.js';

/**
 * Base class for simulation scenarios.
 *
 * Subclasses must set `this.sim` and `this.simStart` before calling `_scheduleEvents()`.
 * They must also set `this.customEvents` (default []) if they want one-off event support.
 */
export class BaseScenario {
  constructor({ eventSeries, customEvents = [] } = {}) {
    this.eventSeries  = eventSeries;
    this.customEvents = customEvents;
  }

  /**
   * Schedules all enabled recurring event series onto `this.sim`, then schedules
   * any one-off custom events. Relies on `this.sim` and `this.simStart` being set.
   */
  _scheduleEvents() {
    const intervalFns = {
      monthly:   d => DateUtils.addMonths(d, 1),
      quarterly: d => DateUtils.addMonths(d, 3),
      annually:  d => DateUtils.addYears(d, 1)
    };

    for (const series of this.eventSeries) {
      if (!series.enabled) continue;
      const start = series.startOffset
          ? DateUtils.addYears(this.simStart, series.startOffset)
          : this.simStart;
      this.sim.scheduleRecurring({
        startDate:  start,
        type:       series.type,
        intervalFn: intervalFns[series.interval]
      });
    }

    for (const ev of this.customEvents) {
      this.sim.schedule({
        date: new Date(ev.date),
        type: ev.type,
        data: ev.amount != null ? { amount: ev.amount } : {}
      });
    }
  }
}
