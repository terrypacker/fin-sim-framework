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
import { ALLOCATION }        from '../holdings/allocation.js';
import { resize, addValue } from '../holdings/holding-utils.js';

/**
 * BehavioralPanicSellApplyReducer — applies an equity-to-cash rotation within
 * a tax-advantaged account (design/29 §3.1, §5, Increment 5).
 *
 * For tax-advantaged accounts, no capital-gain tax is realized — the rotation
 * is a raw holding adjustment. A find-or-create CASH holding receives the
 * proceeds from the sold equity holding.
 *
 * Action fields:
 *   stateKey        - account state key
 *   sourceHoldingId - id of the EQUITY holding to sell
 *   sellAmount      - dollar amount to rotate to CASH
 *
 * If no CASH holding exists, one is created inline with the same rateKey
 * as the source holding (it will earn zero growth unless a CASH rateKey is set).
 */
export class BehavioralPanicSellApplyReducer extends Reducer {
  static type        = 'BehavioralPanicSellApplyReducer';
  static description = 'Rotates equity to CASH within a tax-advantaged account; no tax event emitted.';

  constructor() {
    super('Behavioral Panic Sell Apply', PRIORITY.POSITION_UPDATE);
    this.reducedActionTypes = ['BEHAVIORAL_PANIC_SELL_APPLY'];
  }

  reduce(state, action) {
    const { stateKey, sourceHoldingId, sellAmount } = action;
    const account = state[stateKey];
    if (!account || !Array.isArray(account.holdings)) return state;

    const sourceIdx = account.holdings.findIndex(h => h.id === sourceHoldingId);
    if (sourceIdx === -1) return state;

    const source  = account.holdings[sourceIdx];
    const consume = +Math.min(sellAmount, source.marketValue).toFixed(2);
    if (consume <= 0) return state;

    const basisFrac  = source.marketValue > 0 ? consume / source.marketValue : 0;
    const basisShare = +((source.costBasis ?? 0) * basisFrac).toFixed(2);

    // Reduce equity holding
    let holdings = account.holdings.map((h, i) => {
      if (i !== sourceIdx) return h;
      const mv    = +(h.marketValue   - consume).toFixed(2);
      if (mv < 0.001) return null;
      return resize(h, mv / Math.max(h.marketValue ?? 0, 0.001));   // design 93 §4
    }).filter(Boolean);

    // Find or create a CASH holding
    const cashIdx = holdings.findIndex(h => h.allocation === ALLOCATION.CASH);
    if (cashIdx >= 0) {
      holdings = holdings.map((h, i) => {
        if (i !== cashIdx) return h;
        return addValue(h, consume);
      });
    } else {
      // Create new CASH holding
      holdings = [
        ...holdings,
        {
          id:          `${stateKey}-cash-${Date.now()}`,
          allocation:  ALLOCATION.CASH,
          marketValue: consume,
          costBasis:   consume,
          rateKey:     null,
          label:       'Cash (Panic Sell)',
        },
      ];
    }

    const newBalance = +holdings.reduce((s, h) => s + (h?.marketValue ?? 0), 0).toFixed(2);

    return this.newState(state, {
      [stateKey]: { ...account, holdings, balance: newBalance },
    });
  }
}
