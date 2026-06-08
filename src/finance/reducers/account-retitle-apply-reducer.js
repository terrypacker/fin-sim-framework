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
 * Minimum-viable estate handling (design/27 §3, §8):
 * transfers solo-owned retirement accounts from the deceased to the surviving spouse.
 *
 * Iterates all account state keys; for each account where ownerId === deceasedId,
 * sets ownerId → survivorId. Jointly-owned accounts (ownerId null or !== deceased) are untouched.
 * Holdings travel with their parent account — no per-holding action required.
 *
 * Full estate/RMD/beneficiary machinery is explicitly out of scope.
 */
export class AccountRetitleApplyReducer extends Reducer {
  static description = 'Retitles solo-owned accounts from deceased to surviving spouse.';
  static type        = 'AccountRetitleApplyReducer';
  static actionType  = 'ACCOUNT_RETITLE_APPLY';

  constructor() {
    super('Account Retitle Apply', PRIORITY.PRE_PROCESS);
    this.reducedActionTypes = ['ACCOUNT_RETITLE_APPLY'];
  }

  reduce(state, action) {
    const { deceasedId, survivorId } = action;
    const patches = {};

    for (const [key, value] of Object.entries(state)) {
      if (value && typeof value === 'object' && !Array.isArray(value) && value.ownerId === deceasedId) {
        patches[key] = { ...value, ownerId: survivorId };
      }
    }

    if (Object.keys(patches).length === 0) return this.newState(state);
    return this.newState({ ...state, ...patches });
  }
}
