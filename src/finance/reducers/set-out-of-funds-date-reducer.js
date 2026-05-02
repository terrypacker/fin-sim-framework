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
 * Handles SET_OUT_OF_FUNDS_DATE actions.
 *
 * Stamps `state.outOfFundsDate` with the date from the action.  Because
 * OutOfFundsHandler only emits this action when `state.outOfFundsDate` is
 * falsy, this reducer effectively records the first occurrence only.
 *
 * Runs at PRIORITY.PRE_PROCESS so the date is visible to any later reducers
 * in the same event cycle.
 */
export class SetOutOfFundsDateReducer extends Reducer {
  static description = 'Stamps outOfFundsDate in state on the first out-of-funds occurrence.';

  static actionType = 'SET_OUT_OF_FUNDS_DATE';

  constructor() {
    super('Set Out of Funds Date', PRIORITY.PRE_PROCESS);
  }

  reduce(state, action) {
    return this.newState({
      ...state,
      outOfFundsDate: action.date,
    });
  }
}
