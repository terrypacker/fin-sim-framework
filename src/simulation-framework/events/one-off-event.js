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
 * A single one-time event configuration for a scenario.
 *
 * @property {Date} date - The date on which this event fires
 */
export class OneOffEvent extends BaseEvent {
  constructor({ id, name, type, enabled = true, color = '#888888', date, data = {}, meta = {} } = {}) {
    super({ id, name, type, enabled, color, data, meta });
    this.date = date;
  }
}
