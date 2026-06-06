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

const ACTION_KEY = 'opportunistic_rebalance';

/**
 * OpportunisticRebalanceReducer — behavioral strategy (design/29 §3.5, Increment 5).
 *
 * The rational counterpart to PanicSell. On period advance, computes each
 * tax-advantaged account's allocation fractions. If any drift beyond
 * `rebalanceDriftBand` vs `targetAllocation`, emits OPPORTUNISTIC_REBALANCE_APPLY
 * to move value from over-weight to under-weight allocations within that account.
 *
 * Also triggers on PANIC_SELL_TRIGGER / ECONOMIC_STRESS regime entry
 * (idempotent via state.regimeActions[ACTION_KEY].firedForShocks).
 *
 * MVP scope: within-account rebalance only for tax-advantaged accounts (free).
 * Taxable rebalancing is deferred (would realize gains).
 */
export class OpportunisticRebalanceReducer extends Reducer {
  static type        = 'OpportunisticRebalanceReducer';
  static description = 'Rebalances tax-advantaged account holdings toward targetAllocation when drift exceeds rebalanceDriftBand.';

  /**
   * @param {object}     opts
   * @param {object[]}   opts.taxAdvantaged         - [{stateKey, role}]
   * @param {object}     [opts.targetAllocation]    - { EQUITY: 0.60, BOND: 0.30, CASH: 0.10 }
   * @param {number}     [opts.rebalanceDriftBand]  - fraction drift before triggering (default 0.05)
   */
  constructor({ taxAdvantaged = [], targetAllocation = { EQUITY: 0.60, BOND: 0.40 }, rebalanceDriftBand = 0.05 } = {}) {
    super('Opportunistic Rebalance', PRIORITY.PRE_PROCESS + 4);
    this.reducedActionTypes   = ['US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE'];
    this.generatedActionTypes = ['OPPORTUNISTIC_REBALANCE_APPLY'];
    this.taxAdvantaged        = taxAdvantaged;
    this.targetAllocation     = targetAllocation;
    this.rebalanceDriftBand   = rebalanceDriftBand;
  }

  reduce(state, _action) {
    const regimes = state.activeRegimes ?? [];
    const entry   = state.regimeActions?.[ACTION_KEY] ?? { firedForShocks: [] };
    const alreadyFired = new Set(entry.firedForShocks);

    const qualifyingRegimes = regimes.filter(r =>
      (r.tags?.includes(REGIME_TAG.PANIC_SELL_TRIGGER) ||
       r.tags?.includes(REGIME_TAG.ECONOMIC_STRESS)) &&
      !alreadyFired.has(r.shockId),
    );

    const rebalanceActions = [];
    const newFiredShocks   = [];

    for (const { stateKey } of this.taxAdvantaged) {
      const account = state[stateKey];
      if (!account || !Array.isArray(account.holdings)) continue;

      const total = account.holdings.reduce((s, h) => s + (h?.marketValue ?? 0), 0);
      if (total <= 0) continue;

      // Compute actual allocation fractions
      const actual = {};
      for (const h of account.holdings) {
        const alloc = h.allocation ?? ALLOCATION.OTHER;
        actual[alloc] = (actual[alloc] ?? 0) + (h?.marketValue ?? 0);
      }

      // Check if any allocation drifts past the band
      const target = this.targetAllocation;
      const needsRebalance = Object.entries(target).some(([alloc, tgt]) => {
        const actualFrac = (actual[alloc] ?? 0) / total;
        return Math.abs(actualFrac - tgt) > this.rebalanceDriftBand;
      });

      // Also rebalance if a qualifying regime entered
      if (!needsRebalance && qualifyingRegimes.length === 0) continue;

      // Compute legs: delta per allocation
      const legs = Object.entries(target).map(([alloc, tgt]) => {
        const targetMv = tgt * total;
        const actualMv = actual[alloc] ?? 0;
        return { allocation: alloc, delta: +(targetMv - actualMv).toFixed(2) };
      }).filter(l => Math.abs(l.delta) > 0.01);

      if (legs.length === 0) continue;

      rebalanceActions.push({ type: 'OPPORTUNISTIC_REBALANCE_APPLY', stateKey, legs });
    }

    for (const r of qualifyingRegimes) {
      newFiredShocks.push(r.shockId);
    }

    if (rebalanceActions.length === 0 && newFiredShocks.length === 0) {
      return this.newState(state);
    }

    const updatedEntry = newFiredShocks.length > 0
      ? { ...entry, firedForShocks: [...entry.firedForShocks, ...newFiredShocks] }
      : entry;

    return this.newState(
      state,
      newFiredShocks.length > 0
        ? { regimeActions: { ...state.regimeActions, [ACTION_KEY]: updatedEntry } }
        : {},
      rebalanceActions,
    );
  }
}
