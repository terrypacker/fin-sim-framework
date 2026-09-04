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

const ACTION_KEY = 'downturn_roth_conversion';

/**
 * DownturnRothConversionReducer — behavioral strategy (design/29 §3.6, Increment 3).
 *
 * When a PANIC_SELL_TRIGGER or ECONOMIC_STRESS regime
 * first becomes active (not previously fired for this shock), emit a
 * ROTH_CONVERSION_APPLY action for `downturnConversionAmount`. Idempotent:
 * fires once per regime entry, tracked via state.regimeActions[ACTION_KEY].
 *
 * Reuses the existing ROTH_CONVERSION_APPLY chain (RothConversionApplyReducer
 * + ROTH_CONVERSION_TAX) — no new value-movement logic. The conversion is
 * taxable ordinary income in-year (the existing chain handles that).
 *
 * Runs at PRE_PROCESS + 4 (after RegimeApplyReducer which updates activeRegimes).
 *
 * Trigger (design/29 §3): the regime's own lifecycle, not the calendar. Reducing
 * only the period advances made this fire at the next 1 Jan or 1 Jul instead —
 * measured at 1 to 5 months after the shock, and up to a year in a US-only plan.
 * `RECOMPUTE_REGIMES` is the load-bearing one of the three regime actions: it is
 * what the shock handler emits after AddRegimeReducer (CASH_FLOW) has pushed the
 * regime, and what each monthly ECONOMIC_RECOVERY_TICK emits thereafter, so it is
 * the first action on which the new stack is visible to a PRE_PROCESS reducer.
 */
export class DownturnRothConversionReducer extends Reducer {
  static type        = 'DownturnRothConversionReducer';
  static description = 'Fires a Roth conversion on regime entry (PANIC_SELL_TRIGGER or ECONOMIC_STRESS), idempotent per shock.';

  /**
   * @param {object} opts
   * @param {string}  [opts.iraKey='iraAccount']   - IRA state key to convert from
   * @param {string}  [opts.rothKey='rothAccount'] - Roth state key to convert into
   * @param {number}  [opts.downturnConversionAmount=20000] - Fixed dollar amount to convert per regime entry
   */
  constructor({ iraKey = 'iraAccount', rothKey = 'rothAccount', downturnConversionAmount = 20000 } = {}) {
    super('Downturn Roth Conversion', PRIORITY.PRE_PROCESS + 4);
    this.reducedActionTypes   = [
      'US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE',
      'ADD_REGIME_APPLY', 'REMOVE_REGIME_APPLY', 'RECOMPUTE_REGIMES',
    ];
    this.generatedActionTypes = ['ROTH_CONVERSION_APPLY'];
    this.iraKey                    = iraKey;
    this.rothKey                   = rothKey;
    this.downturnConversionAmount  = downturnConversionAmount;
  }

  reduce(state, _action) {
    const regimes = state.activeRegimes ?? [];
    const qualifying = regimes.filter(r =>
      r.tags?.includes(REGIME_TAG.PANIC_SELL_TRIGGER) ||
      r.tags?.includes(REGIME_TAG.ECONOMIC_STRESS),
    );

    if (qualifying.length === 0) return this.newState(state);

    const entry = state.regimeActions?.[ACTION_KEY] ?? { firedForShocks: [] };
    const alreadyFired = new Set(entry.firedForShocks);

    const newFires = qualifying.filter(r => !alreadyFired.has(r.shockId));
    if (newFires.length === 0) return this.newState(state);

    const residency = _primaryResidency(state);
    const iraBalance = state[this.iraKey]?.balance ?? 0;
    if (iraBalance <= 0) return this.newState(state);

    const amount = Math.min(this.downturnConversionAmount * newFires.length, iraBalance);

    const updatedEntry = {
      ...entry,
      firedForShocks: [...entry.firedForShocks, ...newFires.map(r => r.shockId)],
    };

    return this.newState(
      state,
      {
        regimeActions: {
          ...state.regimeActions,
          [ACTION_KEY]: updatedEntry,
        },
      },
      [{
        type:      'ROTH_CONVERSION_APPLY',
        amount,
        iraKey:    this.iraKey,
        rothKey:   this.rothKey,
        residency,
      }],
    );
  }
}

function _primaryResidency(state) {
  const people = state.people ?? {};
  for (const p of Object.values(people)) {
    if (p?.residency) return p.residency;
  }
  return 'US';
}
