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
 * Records the death of a person and removes them from state.people.
 *
 * Runs at PRE_PROCESS so downstream reducers in the same chain (SS survivor,
 * retitle, etc.) see the updated state.people map immediately.
 *
 * Writes:
 *   state.deceased[personId] = { date, taxJurisdiction, name, incomeSupportRecipient }
 *   state.people  — clone-and-delete (mirrors design-20 mutation pattern)
 *
 * `name` and `incomeSupportRecipient` are captured here (from the person, via the
 * action) because the person is gone from state.people after this reducer runs.
 * The year-of-death AU settle (design/68 Gap 1) reads them back to file the
 * deceased's final-year return with the right name and Age Pension CGT exemption.
 */
export class PersonDiedApplyReducer extends Reducer {
  static description = 'Records death in state.deceased and removes person from state.people.';
  static type        = 'PersonDiedApplyReducer';
  static actionType  = 'PERSON_DIED_APPLY';

  constructor() {
    super('Person Died Apply', PRIORITY.PRE_PROCESS);
    this.reducedActionTypes = ['PERSON_DIED_APPLY'];
  }

  reduce(state, action) {
    const { personId, date, taxJurisdiction, personName, incomeSupportRecipient } = action;

    const deceased  = {
      ...(state.deceased ?? {}),
      [personId]: { date, taxJurisdiction, name: personName, incomeSupportRecipient: incomeSupportRecipient === true },
    };
    const newPeople = { ...(state.people ?? {}) };
    delete newPeople[personId];

    return this.newState({ ...state, deceased, people: newPeople });
  }
}
