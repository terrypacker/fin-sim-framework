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
 * Sets the surviving spouse's monthly Social Security benefit to
 * max(survivor's own benefit, deceased's benefit).
 *
 * The deceased's SS value is carried on the action (captured by MortalityHandler
 * before PersonDiedApplyReducer removes the person from state.people).
 */
export class SocialSecuritySurvivorApplyReducer extends Reducer {
  static description = "Sets survivor's SS monthly to max(survivor, deceased).";
  static type        = 'SocialSecuritySurvivorApplyReducer';
  static actionType  = 'SOCIAL_SECURITY_SURVIVOR_APPLY';

  constructor() {
    super('Social Security Survivor Apply', PRIORITY.PRE_PROCESS);
    this.reducedActionTypes = ['SOCIAL_SECURITY_SURVIVOR_APPLY'];
  }

  reduce(state, action) {
    const { survivorId, deceasedSocialSecurityMonthly } = action;
    const survivor = state.people?.[survivorId];
    if (!survivor) return this.newState(state);

    const newSS      = Math.max(survivor.socialSecurityMonthly ?? 0, deceasedSocialSecurityMonthly ?? 0);
    const newPeople  = {
      ...state.people,
      [survivorId]: { ...survivor, socialSecurityMonthly: newSS },
    };

    return this.newState({ ...state, people: newPeople });
  }
}
