/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY } from '../../simulation-framework/reducers.js';

/**
 * Handles CHANGE_STATE_RESIDENCY_APPLY actions (design 34 §9 — Phase 3 state move).
 *
 * The US-sub-jurisdiction analog of ChangeResidencyApplyReducer. Sets
 * `residencyState = destination` on EVERY person in state.people (so the
 * primary-derived `primaryResidencyState` keeps working, and a future per-person
 * model is already seeded). Citizenship and the `residency` country are untouched
 * — a state move does not change either.
 *
 * Runs at PRIORITY.PRE_PROCESS — before any TAX_CALC classification reducers that
 * resolve the active state in the same event cycle, mirroring the country move.
 *
 * Because the state engine resolves `primaryResidencyState(state)` at runtime on
 * every classification action and at settle, this mutation takes effect
 * immediately for all subsequent accrual — no engine change needed (design 34 §9).
 */
export class ChangeStateResidencyApplyReducer extends Reducer {
  static description = 'Sets residencyState to the destination state on all people; does NOT modify citizenship or the residency country.';
  static type        = 'ChangeStateResidencyApplyReducer';
  static actionType  = 'CHANGE_STATE_RESIDENCY_APPLY';

  constructor() {
    super('Change State Residency Apply', PRIORITY.PRE_PROCESS);
    this.reducedActionTypes = ['CHANGE_STATE_RESIDENCY_APPLY'];
  }

  static fromJSON(d) {
    const r = new this();
    r.id = d.id;
    return r;
  }

  reduce(state, action) {
    const destination = action.destination || null;

    const updatedPeople = {};
    if (state.people) {
      for (const [personKey, person] of Object.entries(state.people)) {
        updatedPeople[personKey] = { ...person, residencyState: destination };
      }
    }

    return this.newState({
      ...state,
      people: Object.keys(updatedPeople).length > 0 ? updatedPeople : state.people,
    });
  }
}
