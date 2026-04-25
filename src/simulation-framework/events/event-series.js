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
 */
export class EventSeries extends BaseEvent {
  constructor({ id, name, type, enabled = true, color = '#888888', interval, startOffset = 0 } = {}) {
    super({ id, name, type, enabled, color });
    this.interval    = interval;
    this.startOffset = startOffset;
  }
}
