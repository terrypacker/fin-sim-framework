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
import { ALLOCATION }        from '../holdings/allocation.js';
import { ACCOUNT_ROLES }    from '../state/account-roles.js';

const ACTION_KEY = 'panic_sell';

const TAX_ADVANTAGED_ROLES = new Set([
  ACCOUNT_ROLES.K401,
  ACCOUNT_ROLES.IRA,
  ACCOUNT_ROLES.ROTH,
  ACCOUNT_ROLES.SUPER,
]);

/**
 * PanicSellReducer — behavioral strategy (design/29 §3.1, Increment 5).
 *
 * When a PANIC_SELL_TRIGGER regime first becomes active,
 * rotates `panicFraction × severity × marketValue` of each EQUITY holding
 * to CASH — once per regime entry (idempotent via state.regimeActions).
 *
 * Per-role branch (§10 Q2):
 *   - Tax-advantaged accounts (K401, IRA, ROTH, SUPER): emit
 *     BEHAVIORAL_PANIC_SELL_APPLY (raw holding move, no tax).
 *   - Taxable accounts (US_STOCK, AU_STOCK): emit STOCK_WITHDRAWAL_APPLY
 *     so FIFO basis + YTD capital-gain tax apply. Cash credited to US savings.
 *
 * MVP uses BEHAVIORAL_PANIC_SELL_APPLY for all accounts to keep the
 * implementation self-contained. The taxable path is wired structurally
 * but deferred to a follow-up (requires AccountService + cash-pool wiring).
 *
 * Trigger (design/29 §3): the regime's own lifecycle, not the calendar. Reducing
 * only the period advances made this fire at the next 1 Jan or 1 Jul instead —
 * measured at 1 to 5 months after the shock, and up to a year in a US-only plan.
 * `RECOMPUTE_REGIMES` is the load-bearing one of the three regime actions: it is
 * what the shock handler emits after AddRegimeReducer (CASH_FLOW) has pushed the
 * regime, and what each monthly ECONOMIC_RECOVERY_TICK emits thereafter, so it is
 * the first action on which the new stack is visible to a PRE_PROCESS reducer.
 */
export class PanicSellReducer extends Reducer {
  static type        = 'PanicSellReducer';
  static description = 'Rotates panicFraction of EQUITY holdings to CASH on PANIC_SELL_TRIGGER regime entry; idempotent per shock.';

  /**
   * @param {object}   opts
   * @param {object[]} opts.allAccounts - [{stateKey, role}] of all accounts
   * @param {number}   [opts.panicFraction=0.30] - fraction of EQUITY to rotate to CASH
   */
  constructor({ allAccounts = [], panicFraction = 0.30 } = {}) {
    super('Panic Sell', PRIORITY.PRE_PROCESS + 4);
    this.reducedActionTypes   = [
      'US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE',
      'ADD_REGIME_APPLY', 'REMOVE_REGIME_APPLY', 'RECOMPUTE_REGIMES',
    ];
    this.generatedActionTypes = ['BEHAVIORAL_PANIC_SELL_APPLY'];
    this.allAccounts  = allAccounts;
    this.panicFraction = panicFraction;
  }

  reduce(state, _action) {
    const regimes = state.activeRegimes ?? [];
    const qualifying = regimes.filter(r => r.tags?.includes(REGIME_TAG.PANIC_SELL_TRIGGER));
    if (qualifying.length === 0) return this.newState(state);

    const entry = state.regimeActions?.[ACTION_KEY] ?? { firedForShocks: [] };
    const alreadyFired = new Set(entry.firedForShocks);

    const newFires = qualifying.filter(r => !alreadyFired.has(r.shockId));
    if (newFires.length === 0) return this.newState(state);

    const severity = newFires.reduce((max, r) => Math.max(max, Math.abs(r.currentFactor ?? 0.3)), 0.3);
    const fraction = this.panicFraction * severity;

    const sellActions = [];

    for (const { stateKey } of this.allAccounts) {
      const account = state[stateKey];
      if (!account || !Array.isArray(account.holdings)) continue;

      const equityHoldings = account.holdings.filter(h => h.allocation === ALLOCATION.EQUITY && (h.marketValue ?? 0) > 0);
      if (equityHoldings.length === 0) continue;

      for (const holding of equityHoldings) {
        const sellAmount = +(holding.marketValue * fraction).toFixed(2);
        if (sellAmount < 0.01) continue;

        sellActions.push({
          type:            'BEHAVIORAL_PANIC_SELL_APPLY',
          stateKey,
          sourceHoldingId: holding.id,
          sellAmount,
        });
      }
    }

    if (sellActions.length === 0) return this.newState(state);

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
      sellActions,
    );
  }
}
