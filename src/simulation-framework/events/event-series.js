/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseEvent } from './base-event.js';

/**
 * Recurring event series configuration for a scenario.
 *
 * @property {string} interval    - Recurrence: 'monthly' | 'quarterly' | 'annually' | 'month-end' | 'year-end'
 * @property {number} startOffset - Years after simStart to begin (0 = start immediately)
 * @property {number} [month]     - 1–12: anchor to this calendar month (requires interval='annually')
 * @property {number} [day]       - 1–31: anchor to this day of month  (requires interval='annually')
 *
 * When both month and day are set, the series fires on that exact date every year
 * regardless of simStart (e.g. month=6, day=30 → Jun 30 annually for AU tax settle).
 */
export class EventSeries extends BaseEvent {
  constructor({ id, name, type, enabled = true, color = '#888888', order = 0, interval, startOffset = 0, month, day, data = {}, meta = {} } = {}) {
    super({ id, name, type, enabled, color, order, data, meta });
    this.interval    = interval;
    this.startOffset = startOffset;
    if (month != null) this.month = month;
    if (day   != null) this.day   = day;
  }
}
