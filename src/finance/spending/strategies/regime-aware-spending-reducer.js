/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY } from '../../../simulation-framework/reducers.js';
import { REGIME_TAG }        from '../../economic-regimes/regime-tag.js';

const ACTION_KEY = 'spending_discretionary_cut';

/**
 * RegimeAwareSpendingReducer — on each annual period advance, checks whether
 * any active economic regime is tagged ECONOMIC_STRESS and adjusts the
 * discretionary expense slice accordingly.
 *
 * The cut is applied once when the regime becomes active and reversed once
 * when it ends (division by the stored multiplier avoids compounding across
 * periods while the regime is sustained).
 *
 * Tracking lives in state.regimeActions[ACTION_KEY] so all regime-driven
 * strategies share a single general map rather than adding bespoke top-level
 * state fields.
 *
 * Runs at PRE_PROCESS + 3, after InflationAdjustReducer (PRE_PROCESS + 2),
 * so it sees the already-inflated discretionary value for the new year.
 */
export class RegimeAwareSpendingReducer extends Reducer {
  static description = 'Cuts discretionary spending while any ECONOMIC_STRESS-tagged regime is active; reverts on regime end.';
  static type        = 'RegimeAwareSpendingReducer';
  static actionType  = null;

  /**
   * @param {object} [opts]
   * @param {number} [opts.regimeAwareCutPct=0.15] Fraction of discretionary to cut (0.15 = 15% cut).
   */
  constructor({ regimeAwareCutPct = 0.15 } = {}) {
    super('Regime-Aware Spending', PRIORITY.PRE_PROCESS + 3);
    this.reducedActionTypes = ['US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE'];
    this.regimeAwareCutPct  = regimeAwareCutPct;
  }

  reduce(state, _action) {
    if (!state.expenses) return this.newState(state);

    const isActive = (state.activeRegimes ?? [])
      .some(r => r.tags?.includes(REGIME_TAG.ECONOMIC_STRESS));

    const entry = state.regimeActions?.[ACTION_KEY] ?? { active: false, appliedMultiplier: null };

    if (isActive === entry.active) return this.newState(state);

    const expenses = { ...state.expenses };

    let newEntry;
    if (isActive && !entry.active) {
      const multiplier         = 1 - this.regimeAwareCutPct;
      expenses.discretionary  *= multiplier;
      newEntry = { active: true, appliedMultiplier: multiplier };
    } else {
      expenses.discretionary  /= entry.appliedMultiplier;
      newEntry = { active: false, appliedMultiplier: null };
    }

    return this.newState(state, {
      expenses,
      monthlyExpenses: expenses.essential + expenses.discretionary,
      regimeActions: {
        ...(state.regimeActions ?? {}),
        [ACTION_KEY]: newEntry,
      },
    });
  }
}
