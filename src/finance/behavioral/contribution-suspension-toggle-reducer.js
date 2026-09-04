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
import { isStressed }        from '../economic-regimes/regime-stress.js';

/**
 * ContributionSuspensionToggleReducer — behavioral strategy (design/29 §3.2, Increment 6).
 *
 * Sets `state.contributionsSuspended = true` whenever an active regime carries the
 * `ECONOMIC_STRESS` tag AND clears `minSeverity`; clears it when none do. The threshold is
 * the household's own — see design 21 §24 for why intensity is a scalar beside the tag
 * rather than a rung inside it.
 *
 * Forward-only resume (§10 Q3): no missed-contribution tracking, no back-fill.
 * Contribution handlers short-circuit on `state.contributionsSuspended`.
 *
 * Trigger (design/29 §3): the regime's own lifecycle, not the calendar. Reducing
 * only the period advances made this fire at the next 1 Jan or 1 Jul instead —
 * measured at 1 to 5 months after the shock, and up to a year in a US-only plan.
 * `RECOMPUTE_REGIMES` is the load-bearing one of the three regime actions: it is
 * what the shock handler emits after AddRegimeReducer (CASH_FLOW) has pushed the
 * regime, and what each monthly ECONOMIC_RECOVERY_TICK emits thereafter, so it is
 * the first action on which the new stack is visible to a PRE_PROCESS reducer.
 */
export class ContributionSuspensionToggleReducer extends Reducer {
  static type        = 'ContributionSuspensionToggleReducer';
  static description = 'Toggles state.contributionsSuspended while an ECONOMIC_STRESS regime at or above minSeverity is active; forward-only (no catch-up).';

  /**
   * @param {object}      [opts]
   * @param {number|null} [opts.minSeverity] - the trough depth this household needs to see
   *   before it stops contributing (design 21 §24). Not every downturn is a
   *   contribution-stopping event: at the default 0.25 a mild correction and even COVID's
   *   measured 19 % pass through untouched, while a GFC or a lost decade does not. Null
   *   disables the gate and restores the pre-threshold "any stress tag" behaviour.
   */
  constructor({ minSeverity = null } = {}) {
    // PRE_PROCESS + 2, not PRE_PROCESS: RegimeApplyReducer owns `activeRegimes` at
    // PRE_PROCESS + 1, and it is the reducer that DROPS a recovered regime. Sitting
    // ahead of it meant reading the pre-drop stack and resuming contributions a tick
    // late — and on the final recovery tick, which is the last one scheduled, a tick
    // late means waiting for the next period boundary. Nothing between PRE_PROCESS
    // and here reads `contributionsSuspended`: its readers are the contribution
    // handlers and account rules, which run at CASH_FLOW and later.
    super('Contribution Suspension Toggle', PRIORITY.PRE_PROCESS + 2);
    this.reducedActionTypes = [
      'US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE',
      'ADD_REGIME_APPLY', 'REMOVE_REGIME_APPLY', 'RECOMPUTE_REGIMES',
    ];
    this.minSeverity = minSeverity;
  }

  reduce(state, _action) {
    const regimes  = state.activeRegimes ?? [];
    // ECONOMIC_STRESS only — a PANIC_SELL_TRIGGER-only regime is a sharp entry reaction,
    // not a statement that the household's income posture changed.
    const stressed = isStressed(regimes, {
      tags: [REGIME_TAG.ECONOMIC_STRESS], minSeverity: this.minSeverity,
    });
    const current  = state.contributionsSuspended ?? false;

    if (stressed === current) return this.newState(state);

    return this.newState(state, { contributionsSuspended: stressed });
  }
}
