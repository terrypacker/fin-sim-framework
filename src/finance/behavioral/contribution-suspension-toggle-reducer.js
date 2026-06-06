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
import { REGIME_TAG }        from '../economic-regimes/regime-tag.js';

/**
 * ContributionSuspensionToggleReducer — behavioral strategy (design/29 §3.2, Increment 6).
 *
 * Sets `state.contributionsSuspended = true` whenever any active regime carries
 * the `ECONOMIC_STRESS` tag; clears it when none do.
 *
 * Forward-only resume (§10 Q3): no missed-contribution tracking, no back-fill.
 * Contribution handlers short-circuit on `state.contributionsSuspended`.
 */
export class ContributionSuspensionToggleReducer extends Reducer {
  static type        = 'ContributionSuspensionToggleReducer';
  static description = 'Toggles state.contributionsSuspended based on ECONOMIC_STRESS regime presence; forward-only (no catch-up).';

  constructor() {
    super('Contribution Suspension Toggle', PRIORITY.PRE_PROCESS);
    this.reducedActionTypes = ['US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE'];
  }

  reduce(state, _action) {
    const regimes  = state.activeRegimes ?? [];
    const stressed = regimes.some(r => r.tags?.includes(REGIME_TAG.ECONOMIC_STRESS));
    const current  = state.contributionsSuspended ?? false;

    if (stressed === current) return this.newState(state);

    return this.newState(state, { contributionsSuspended: stressed });
  }
}
