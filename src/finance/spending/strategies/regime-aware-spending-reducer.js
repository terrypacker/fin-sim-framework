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
 * Undo the cut recorded in `entry` against the CURRENT expense slices.
 *
 * Dividing by the stored multiplier is the preferred path: it composes with any
 * other multiplicative move on the slice (inflation, an age-band glide, a
 * guardrail cut) that happened while the regime was live, because those moves
 * scale the cut and un-cut values alike.
 *
 * That only works while the multiplier is a positive finite number. At a 100%
 * cut it is zero and the pre-cut level is not recoverable from the slice, so we
 * fall back to the stored basis, rescaled by essential's own growth over the
 * same window — essential is the one slice this reducer never touches, which
 * makes it the available yardstick. If essential is unusable (zero, absent, or
 * itself moved to something non-finite) the raw stored amount is the best
 * remaining answer; returning it un-scaled loses the inflation accrued during
 * the regime, but keeps the run in real dollars rather than NaN.
 *
 * @param {{essential?: number, discretionary?: number}} expenses current slices
 * @param {{appliedMultiplier: ?number, basis?: {discretionary: number, essential: number}}} entry
 * @returns {number} the restored discretionary slice
 */
function _restore(expenses, entry) {
  const m       = entry.appliedMultiplier;
  const current = expenses.discretionary ?? 0;

  if (Number.isFinite(m) && m > 0) return current / m;

  const basis = entry.basis;
  if (!basis || !Number.isFinite(basis.discretionary)) return current;

  const nowEssential = expenses.essential;
  const wasEssential = basis.essential;
  const scalable = Number.isFinite(nowEssential) && Number.isFinite(wasEssential)
    && nowEssential > 0 && wasEssential > 0;

  return scalable
    ? basis.discretionary * (nowEssential / wasEssential)
    : basis.discretionary;
}

/**
 * RegimeAwareSpendingReducer — on each annual period advance, checks whether
 * any active economic regime is tagged ECONOMIC_STRESS and adjusts the
 * discretionary expense slice accordingly.
 *
 * The cut is applied once when the regime becomes active and reversed once
 * when it ends (division by the stored multiplier avoids compounding across
 * periods while the regime is sustained).
 *
 * A FULL cut (regimeAwareCutPct = 1) is a legal setting — "stop all
 * discretionary spending while the regime lasts" — but it multiplies the slice
 * by zero, and zero cannot be divided back out: the revert produced 0/0 = NaN,
 * which then propagated into monthlyExpenses and stayed there for the rest of
 * the run. So the entry also carries a `basis` — the pre-cut discretionary and
 * the essential slice it sat beside — and the revert falls back to rescaling
 * that basis by how far essential has since moved. Both slices are inflated by
 * the same residence rate (InflationAdjustReducer), so for the inflation-only
 * case that restoration is exact.
 *
 * Tracking lives in state.regimeActions[ACTION_KEY] so all regime-driven
 * strategies share a single general map rather than adding bespoke top-level
 * state fields.
 *
 * Runs at PRE_PROCESS + 3, after InflationAdjustReducer (PRE_PROCESS + 2),
 * so it sees the already-inflated discretionary value for the new year.
 *
 * It also reduces the three regime-mutation actions, and not only the annual
 * period advance. Listening to the advance alone made the cut land LATE, by up
 * to the gap to the next period boundary — 1 Jan (US) or 1 Jul (AU), so up to
 * six months in a two-country plan and up to a year in a US-only one. A shock
 * dated 1 Jan is the sharpest case: it puts its regime on the stack via
 * ADD_REGIME_APPLY, dispatched from the shock's own event, and that event and
 * PERIOD_ADVANCE_US share a date and an `order` of 0 — so which runs first is a
 * queue tiebreak rather than a decision. Lose the tiebreak and the household
 * spends its pre-crash budget through the first half of its own crash, waiting
 * on the AU boundary in July to notice.
 *
 * Reducing the regime actions makes the trigger the regime's own lifecycle:
 * ADD_REGIME_APPLY cuts the moment the stack changes, and the monthly
 * ECONOMIC_RECOVERY_TICK's RECOMPUTE_REGIMES reverts in the month the regime
 * actually drops out rather than at the next 1 Jan. RegimeApplyReducer owns
 * `activeRegimes` at PRE_PROCESS + 1 on all five of these actions, two steps
 * ahead of this one, so the stack read here is always the settled one.
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
    this.reducedActionTypes = [
      'US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE',
      'ADD_REGIME_APPLY', 'REMOVE_REGIME_APPLY', 'RECOMPUTE_REGIMES',
    ];
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
      const basis              = { discretionary: expenses.discretionary ?? 0, essential: expenses.essential ?? 0 };
      expenses.discretionary   = (expenses.discretionary ?? 0) * multiplier;
      newEntry = { active: true, appliedMultiplier: multiplier, basis };
    } else {
      expenses.discretionary = _restore(expenses, entry);
      newEntry = { active: false, appliedMultiplier: null, basis: null };
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
