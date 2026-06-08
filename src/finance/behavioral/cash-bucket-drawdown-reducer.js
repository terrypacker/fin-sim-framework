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
 * CashBucketDrawdownReducer — behavioral strategy (design/29 §3.7, Increment 6).
 *
 * Sequence-of-returns protection. Toggles
 * `state.regimeActions['drawdown_source_override'] = { active: boolean }`
 * while PANIC_SELL_TRIGGER or ECONOMIC_STRESS is active.
 *
 * ReplenishSavingsReducer reads the `active` flag and, when true, re-sorts
 * withdrawal sources to prefer cash/fixed income before equities — preventing
 * equity liquidation at depressed prices.
 *
 * Apply/revert pattern mirrors RegimeAwareSpendingReducer (design-26):
 *   - active=true  when any qualifying regime enters
 *   - active=false when all qualifying regimes exit
 */
export class CashBucketDrawdownReducer extends Reducer {
  static type        = 'CashBucketDrawdownReducer';
  static description = 'Toggles drawdown_source_override active flag: cash/bonds drawn before equities while stress regime is active (design/29 §3.7).';

  constructor() {
    super('Cash Bucket Drawdown', PRIORITY.PRE_PROCESS);
    this.reducedActionTypes = ['US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE'];
  }

  reduce(state, _action) {
    const regimes   = state.activeRegimes ?? [];
    const stressed  = regimes.some(r =>
      r.tags?.includes(REGIME_TAG.PANIC_SELL_TRIGGER) ||
      r.tags?.includes(REGIME_TAG.ECONOMIC_STRESS)
    );

    const current = state.regimeActions?.drawdown_source_override?.active ?? false;
    if (stressed === current) return this.newState(state);

    return this.newState(state, {
      regimeActions: {
        ...(state.regimeActions ?? {}),
        drawdown_source_override: { active: stressed },
      },
    });
  }
}
