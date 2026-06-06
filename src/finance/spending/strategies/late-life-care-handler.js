/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HandlerEntry } from '../../../simulation-framework/handlers.js';

/**
 * Handles LATE_LIFE_CARE_BEGIN and LATE_LIFE_CARE_END one-off events.
 *
 * BEGIN: emits LATE_LIFE_CARE_APPLY { active: true, factor, personId }
 * END:   emits LATE_LIFE_CARE_APPLY { active: false, personId }
 *
 * Both slices (essential + discretionary) are multiplied uniformly on BEGIN
 * and divided back out on END — late-life medical hits both (design/27 §4, §11).
 */
export class LateLifeCareHandler extends HandlerEntry {
  static description = 'Handles LATE_LIFE_CARE_BEGIN/END: emits LATE_LIFE_CARE_APPLY with active flag and factor.';
  static type        = 'LateLifeCareHandler';
  static eventType   = 'LATE_LIFE_CARE_BEGIN';

  constructor() {
    super(null, 'Late-Life Care');
    this.generatedActionTypes = ['LATE_LIFE_CARE_APPLY'];
  }

  static fromJSON(d, _ctx) {
    const h = new this();
    h.id = d.id;
    return h;
  }

  call({ event }) {
    const { personId, factor } = event.data ?? {};
    const active = event.type === 'LATE_LIFE_CARE_BEGIN';
    return [{ type: 'LATE_LIFE_CARE_APPLY', active, factor: factor ?? 2.0, personId }];
  }
}
