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
 * Stamps the month a person became entitled to their own Social Security benefit as
 * `people.<id>.ssEntitledMs` (design 118 D7). MonthlySocialSecurityHandler emits it with
 * the first payment and reads the stamp from then on, so the claim is fixed once made.
 * A stamp already present is never overwritten.
 */
export class SsEntitlementApplyReducer extends Reducer {
  static description = "Stamps the month a person's own Social Security entitlement began.";
  static type        = 'SsEntitlementApplyReducer';
  static actionType  = 'SS_ENTITLEMENT_APPLY';

  constructor() {
    super('Social Security Entitlement Apply', PRIORITY.PRE_PROCESS);
    this.reducedActionTypes = ['SS_ENTITLEMENT_APPLY'];
  }

  reduce(state, action) {
    const { personKey, entitledMs } = action;
    const person = state.people?.[personKey];
    if (!person || person.ssEntitledMs != null) return this.newState(state);
    return this.newState({
      ...state,
      people: { ...state.people, [personKey]: { ...person, ssEntitledMs: entitledMs } },
    });
  }
}
