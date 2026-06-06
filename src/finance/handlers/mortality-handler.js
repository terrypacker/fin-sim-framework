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

/**
 * MortalityHandler — handles PERSON_DIED one-off events.
 *
 * Emits the ordered action chain defined in design/27 §3:
 *  1. PERSON_DIED_APPLY       — records death, removes person from state.people
 *  2. ACCOUNT_RETITLE_APPLY   — (if spouse survives) transfers solo-owned accounts
 *  3. SPENDING_STRATEGY_APPLY — (if spouse survives) two deltas: essential + discretionary
 *  4. SOCIAL_SECURITY_SURVIVOR_APPLY — (if spouse survives) survivor SS = max(self, deceased)
 *  5. SCENARIO_COMPLETE_CHECK — always last; sets scenarioComplete if no survivors remain
 *
 * Pure action emitter — does not touch the scheduling queue (design/27 §2.1 Path A).
 *
 * @param {object} [opts]
 * @param {number} [opts.survivorEssentialMultiplier=0.85]
 * @param {number} [opts.survivorDiscretionaryMultiplier=0.50]
 */
export class MortalityHandler extends HandlerEntry {
  static description = 'Handles PERSON_DIED: emits death record, account retitle, survivor expense adjustments, SS update, and scenario-complete check.';
  static type        = 'MortalityHandler';
  static eventType   = 'PERSON_DIED';

  constructor({ survivorEssentialMultiplier = 0.85, survivorDiscretionaryMultiplier = 0.50 } = {}) {
    super(null, 'Mortality');
    this.survivorEssentialMultiplier     = survivorEssentialMultiplier;
    this.survivorDiscretionaryMultiplier = survivorDiscretionaryMultiplier;
    this.generatedActionTypes = [
      'PERSON_DIED_APPLY',
      'ACCOUNT_RETITLE_APPLY',
      'SPENDING_STRATEGY_APPLY',
      'SOCIAL_SECURITY_SURVIVOR_APPLY',
      'SCENARIO_COMPLETE_CHECK',
    ];
  }

  static fromJSON(d, _ctx) {
    const h = new this({
      survivorEssentialMultiplier:     d.survivorEssentialMultiplier     ?? 0.85,
      survivorDiscretionaryMultiplier: d.survivorDiscretionaryMultiplier ?? 0.50,
    });
    h.id = d.id;
    return h;
  }

  toJSON() {
    const base = super.toJSON();
    return {
      ...base,
      survivorEssentialMultiplier:     this.survivorEssentialMultiplier,
      survivorDiscretionaryMultiplier: this.survivorDiscretionaryMultiplier,
    };
  }

  call({ state, event }) {
    const personId = event?.data?.personId;
    if (!personId) return [];

    const person = state.people?.[personId];
    if (!person) return [];

    const taxJurisdiction = person.residency ?? 'US';

    // Identify surviving spouse — any other entry still in state.people
    const survivorEntries = Object.entries(state.people ?? {})
      .filter(([k]) => k !== personId);
    const survivorId = survivorEntries.length === 1 ? survivorEntries[0][0] : null;
    const survivor   = survivorId ? survivorEntries[0][1] : null;

    const actions = [];

    // 1. Record death and remove deceased from state.people
    actions.push({
      type:            'PERSON_DIED_APPLY',
      personId,
      date:            event.date,
      taxJurisdiction,
      // Carry the deceased SS value for use by the survivor reducer (person gone after this)
      deceasedSocialSecurityMonthly: person.socialSecurityMonthly ?? 0,
    });

    if (survivorId) {
      // 2. Retitle solo-owned accounts to survivor
      actions.push({ type: 'ACCOUNT_RETITLE_APPLY', deceasedId: personId, survivorId });

      // 3. Per-slice survivor expense deltas (design/27 §10 Q2 Option B)
      const essential     = state.expenses?.essential     ?? 0;
      const discretionary = state.expenses?.discretionary ?? 0;
      actions.push({
        type:   'SPENDING_STRATEGY_APPLY',
        slice:  'essential',
        delta:  essential * (this.survivorEssentialMultiplier - 1),
        reason: 'survivor',
      });
      actions.push({
        type:   'SPENDING_STRATEGY_APPLY',
        slice:  'discretionary',
        delta:  discretionary * (this.survivorDiscretionaryMultiplier - 1),
        reason: 'survivor',
      });

      // 4. Surviving spouse SS = max(self, deceased)
      actions.push({
        type:      'SOCIAL_SECURITY_SURVIVOR_APPLY',
        survivorId,
        deceasedSocialSecurityMonthly: person.socialSecurityMonthly ?? 0,
      });
    }

    // 5. Always check whether the scenario should terminate
    actions.push({ type: 'SCENARIO_COMPLETE_CHECK' });

    return actions;
  }
}
