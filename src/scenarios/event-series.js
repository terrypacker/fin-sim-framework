/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Represents a recurring event series configuration for a scenario.
 *
 * @property {string}  id          - Unique identifier for this series
 * @property {string}  name       - Human-readable display name
 * @property {string}  type        - Simulation event type string (e.g. 'MONTHLY_SALARY')
 * @property {string}  interval    - Recurrence interval: 'monthly' | 'quarterly' | 'annually' | 'month-end' | 'year-end'
 * @property {boolean} enabled     - Whether this series is active
 * @property {number}  startOffset - Years after simStart to begin (0 = start immediately)
 * @property {string}  color       - CSS color used for visualization
 */
export class EventSeries {
  constructor({ id, name, type, interval, enabled = true, startOffset = 0, color = '#888888' } = {}) {
    this.id          = id;
    this.name       = name;
    this.type        = type;
    this.interval    = interval;
    this.enabled     = enabled;
    this.startOffset = startOffset;
    this.color       = color;
  }
}
