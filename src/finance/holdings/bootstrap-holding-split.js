/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { OneOffEvent }   from '../../simulation-framework/events/one-off-event.js';
import { HandlerEntry }  from '../../simulation-framework/handlers.js';
import { HoldingSplitAction } from './holding-actions.js';
import { resolveRateKey }     from './default-allocations.js';

/**
 * Build a OneOffEvent + handler that emits a HOLDING_SPLIT at simStart to
 * materialize a toolset-declared multi-sleeve allocation on an account
 * (design 25 §6.7).
 *
 * `splits` is an array of `{ allocation, fraction, label?, rateKey? }`.
 * Fractions are interpreted as a share of the account's current balance and
 * cost basis (single-holding default at bootstrap time). The fractions
 * should sum to 1; the implementation does not enforce or rebalance —
 * the caller is responsible.
 *
 * Returned object:
 *   { event, handler }
 *
 * Usage in a toolset's schedules():
 *
 *   schedules(context) {
 *     const k401 = context.accounts.find(a => a.role === ACCOUNT_ROLES.K401);
 *     if (context.parameters.k401AllocationBondsPct > 0) {
 *       const { event, handler } = bootstrapHoldingSplit(k401, [
 *         { allocation: ALLOCATION.EQUITY, fraction: 1 - p.bondsPct },
 *         { allocation: ALLOCATION.BOND,   fraction:     p.bondsPct },
 *       ], context.startDate);
 *       this._splitHandlers = [...(this._splitHandlers ?? []), handler];
 *       return [event];
 *     }
 *     return [];
 *   }
 *
 * @param {object} account       - Account being split (must already be registered)
 * @param {Array}  splits        - [{ allocation, fraction, label?, rateKey? }, ...]
 * @param {Date}   simStartDate  - When to fire the SPLIT (use the scenario's simStart)
 * @returns {{ event: OneOffEvent, handler: HandlerEntry }}
 */
export function bootstrapHoldingSplit(account, splits, simStartDate) {
  if (!account) throw new Error('bootstrapHoldingSplit: account is required');
  if (!Array.isArray(splits) || splits.length === 0) {
    throw new Error('bootstrapHoldingSplit: splits must be a non-empty array');
  }
  const stateKey = account.stateKey;
  const eventType = `BOOTSTRAP_HOLDING_SPLIT_${stateKey ?? account.id}`;

  const event = new OneOffEvent({
    name: `Bootstrap holding split (${stateKey ?? account.id})`,
    type: eventType,
    date: simStartDate ?? new Date(),
    enabled: true,
  });

  const handler = new HandlerEntry(null, `Holding Split Handler (${stateKey ?? account.id})`);
  handler.handledEvents.push(event);
  handler.generatedActionTypes = ['HOLDING_SPLIT'];
  // Capture the account reference + splits on the handler so call() can
  // build the action lazily (the holding ids are stable post-bootstrap).
  handler.call = ({ state }) => {
    const stateAccount = state[stateKey];
    if (!stateAccount || !Array.isArray(stateAccount.holdings) || stateAccount.holdings.length !== 1) {
      // Only operate when the account is in the post-bootstrap default
      // single-holding shape; otherwise some other handler already split it.
      return [];
    }
    const source     = stateAccount.holdings[0];
    const totalMv    = source.marketValue ?? 0;
    const totalBasis = source.costBasis   ?? 0;
    const splitSpecs = splits.map(s => ({
      allocation:       s.allocation,
      rateKey:          s.rateKey ?? resolveRateKey(stateAccount.country, s.allocation, stateAccount.role),
      label:            s.label ?? '',
      marketValueDelta: +(totalMv    * (s.fraction ?? 0)).toFixed(2),
      costBasisDelta:   +(totalBasis * (s.fraction ?? 0)).toFixed(2),
    }));
    return [new HoldingSplitAction({
      stateKey,
      holdingId: source.id,
      splits:    splitSpecs,
    })];
  };

  return { event, handler };
}
