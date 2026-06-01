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
import { RecordMetricAction, RecordBalanceAction } from '../../simulation-framework/actions.js';

/**
 * Handles OUT_OF_FUNDS actions emitted by IntlTransferApplyReducer (and
 * ReplenishSavingsReducer via the intl-transfer chain) when all funding
 * sources are exhausted.
 *
 * Chains downstream actions:
 *   RECORD_METRIC       — cumulative out_of_funds deficit metric
 *   ACCUMULATE_DEFICIT  — increments state.cumulativeDeficit + deficitMonths
 *   SET_OUT_OF_FUNDS_DATE — stamps the first-occurrence date (once only)
 *   RECORD_BALANCE      — snapshot after the event
 *
 * NOTE: OutOfFundsHandler handles the same logical event but is wired into
 * the handler registry (event pipeline).  OUT_OF_FUNDS is generated as an
 * action (from a reducer's next[]), so only a reducer sees it.  This class
 * is the correct entry point.
 */
export class OutOfFundsReducer extends Reducer {
  static description = 'Processes OUT_OF_FUNDS actions: records the deficit metric, accumulates deficit totals, and stamps the first-occurrence date in state.';
  static type        = 'OutOfFundsReducer';
  static actionType  = 'OUT_OF_FUNDS';

  constructor() {
    super('Out of Funds', PRIORITY.PRE_PROCESS);
    this.reducedActionTypes   = ['OUT_OF_FUNDS'];
    this.generatedActionTypes = ['RECORD_METRIC', 'ACCUMULATE_DEFICIT', 'SET_OUT_OF_FUNDS_DATE', 'RECORD_BALANCE'];
  }

  reduce(state, action, date) {
    const deficit = action.deficit ?? 0;
    console.warn(
      `[OUT_OF_FUNDS] ${deficit.toFixed(2)} ${action.currency ?? ''} deficit on ` +
      (date instanceof Date ? date.toISOString().slice(0, 10) : String(date))
    );

    const next = [
      new RecordMetricAction('out_of_funds', deficit),
      { type: 'ACCUMULATE_DEFICIT', amount: deficit },
    ];

    if (!state.outOfFundsDate) {
      next.push({ type: 'SET_OUT_OF_FUNDS_DATE', date });
    }

    next.push(new RecordBalanceAction());

    return this.newState(state, {}, next);
  }
}
