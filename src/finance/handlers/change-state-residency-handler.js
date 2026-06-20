/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HandlerEntry } from '../../simulation-framework/handlers.js';
import { RecordBalanceAction } from '../../simulation-framework/actions.js';

/**
 * Handles CHANGE_STATE_RESIDENCY events (design 34 §9 — Phase 3 state move).
 *
 * The US-sub-jurisdiction analog of ChangeResidencyHandler. Fires as a one-off
 * event on the state-move date and emits:
 *
 *   1. CHANGE_STATE_RESIDENCY_APPLY — sets `residencyState` to the destination on
 *      every person (carried as `destination` from the event's data).
 *   2. RecordBalanceAction — captures the post-change stateAfter snapshot.
 *
 * Like the country move, it deliberately does NOT settle state tax on the move
 * date: the person is a US citizen taxed by the destination state for the whole
 * calendar year. Phase 3 pins the move to Jan 1 (design 34 §9.1) so the entire
 * year is taxed by the destination state and no part-year apportionment is
 * needed — the Dec-31 StateTaxSettleHandler already resolves the active state at
 * runtime, so no settle-side change is required here. (Full part-year split is
 * deferred to the AU part-year residency phase.)
 */
export class ChangeStateResidencyHandler extends HandlerEntry {
  static description = 'Emits CHANGE_STATE_RESIDENCY_APPLY + RECORD_BALANCE on the state-move date; does NOT settle state tax (destination state taxes the full calendar year via the Dec-31 settle).';
  static type        = 'ChangeStateResidencyHandler';
  static eventType   = 'CHANGE_STATE_RESIDENCY';

  constructor() {
    super(null, 'Change State Residency');
    this.generatedActionTypes = ['CHANGE_STATE_RESIDENCY_APPLY', 'RECORD_BALANCE'];
  }

  call({ data } = {}) {
    const destination = data?.destination || null;
    return [
      { type: 'CHANGE_STATE_RESIDENCY_APPLY', destination },
      new RecordBalanceAction(),
    ];
  }
}
