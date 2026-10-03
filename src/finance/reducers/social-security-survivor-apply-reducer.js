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
import { claimMonthOf, monthIndex, monthIndexToMs, survivorBaseRatio, survivorStartMonth }
  from '../account-rules/us/us-social-security-rules.js';

/**
 * Records what a surviving spouse inherits from the deceased's Social Security record
 * (design 118 §5.3, phase 4). It writes four fields on the survivor and leaves their own
 * `socialSecurityMonthly` alone:
 *
 * - `ssSurvivorPia`: the deceased's PIA, inflated yearly from here on as if they lived;
 * - `ssSurvivorRatio`: 1, or 1 + the deceased's delayed credits (404.338(b));
 * - `ssSurvivorRibLimCap`: set only when the deceased claimed early (404.338(c));
 * - `ssSurvivorFromMs`: the first month the survivor benefit is paid (D10).
 *
 * MonthlySocialSecurityHandler pays the larger of the survivor's own benefit and this
 * one. The deceased's PIA, birth date and claim stamp are carried on the action, captured
 * by MortalityHandler before PersonDiedApplyReducer removes the deceased from
 * state.people. A deceased with no PIA leaves nothing to inherit.
 */
export class SocialSecuritySurvivorApplyReducer extends Reducer {
  static description = "Records the survivor benefit on a widow(er)'s record: the deceased's PIA, their delayed credits or early-claim cap, and the month it starts.";
  static type        = 'SocialSecuritySurvivorApplyReducer';
  static actionType  = 'SOCIAL_SECURITY_SURVIVOR_APPLY';

  constructor() {
    super('Social Security Survivor Apply', PRIORITY.PRE_PROCESS);
    this.reducedActionTypes = ['SOCIAL_SECURITY_SURVIVOR_APPLY'];
  }

  reduce(state, action) {
    const { survivorId, deceasedSocialSecurityMonthly: pia,
            deceasedBirthDate, deceasedEntitledMs, deathMs } = action;
    const survivor = state.people?.[survivorId];
    if (!survivor || !(pia > 0)) return this.newState(state);

    const deathMi = monthIndex(deathMs);
    const { ratio, ribLimCap } = survivorBaseRatio({
      birthDate:  deceasedBirthDate,
      entitledMi: deceasedEntitledMs != null ? monthIndex(deceasedEntitledMs) : null,
      deathMi,
    });
    const fromMi = survivorStartMonth(survivor.birthDate, claimMonthOf(survivor), deathMi);
    return this.newState({
      ...state,
      people: { ...state.people, [survivorId]: {
        ...survivor,
        ssSurvivorPia:       pia,
        ssSurvivorRatio:     ratio,
        ssSurvivorRibLimCap: ribLimCap,
        ssSurvivorFromMs:    monthIndexToMs(fromMi),
      } },
    });
  }
}
