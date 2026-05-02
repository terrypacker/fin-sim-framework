/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HandlerEntry } from '../../simulation-framework/handlers.js';
import { RecordMetricAction, RecordBalanceAction } from '../../simulation-framework/actions.js';

/**
 * Handles OUT_OF_FUNDS events.
 *
 * Fired by ReplenishSavingsReducer / IntlTransferApplyReducer when a spending
 * deficit could not be covered from any account or international transfer.
 *
 * On each occurrence:
 *   1. Records a 'out_of_funds' metric with the deficit amount.
 *   2. On the first occurrence (state.outOfFundsDate is null/undefined), emits
 *      SET_OUT_OF_FUNDS_DATE to stamp the date permanently in state.
 *   3. Emits RecordBalanceAction to capture a post-event snapshot.
 *
 * @example
 * // data shape expected: { deficit: number, currency: 'USD'|'AUD' }
 */
export class OutOfFundsHandler extends HandlerEntry {
  static description = 'Records an out-of-funds metric and stamps the first occurrence date in state.';

  static eventType = 'OUT_OF_FUNDS';

  constructor() {
    super(null, 'Out of Funds');
  }

  call({ data, date, state }) {
    console.warn(
      `[OUT_OF_FUNDS] ${(data.deficit ?? 0).toFixed(2)} ${data.currency ?? ''} deficit on ` +
      (date instanceof Date ? date.toISOString().slice(0, 10) : String(date))
    );
    const actions = [new RecordMetricAction('out_of_funds', data.deficit ?? 0)];
    if (!state.outOfFundsDate) {
      actions.push({ type: 'SET_OUT_OF_FUNDS_DATE', date });
    }
    actions.push(new RecordBalanceAction());
    return actions;
  }
}
