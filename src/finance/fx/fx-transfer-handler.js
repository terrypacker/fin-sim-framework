/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HandlerEntry }                            from '../../simulation-framework/handlers.js';
import { RecordBalanceAction, RecordMetricAction } from '../../simulation-framework/actions.js';
import { InsufficientFundsError }                  from '../assets/account.js';

/**
 * Direction-agnostic FX transfer handler.
 *
 * Handles FX_TRANSFER events with data: { from, to, amount }.
 *   - `from` / `to` are ISO currency codes ('USD', 'AUD', …).
 *   - `amount` is the quantity of `from` currency to send.
 *
 * Resolves the effective rate and fee from state via FxEngine, checks the
 * source settlement balance, optionally calls accountService.replenishSavings
 * when short, then emits FX_TRANSFER_APPLY so FxTransferApplyReducer handles
 * the ledger ops.
 *
 * All math is pre-resolved here so the reducer is purely a ledger operation.
 */
export class FxTransferToHandler extends HandlerEntry {
  static description = 'Direction-agnostic FX transfer: resolves rate/fee/settlement, replenishes if short, emits FX_TRANSFER_APPLY.';
  static type        = 'FxTransferToHandler';
  static eventType   = 'FX_TRANSFER';

  constructor({ fxService, accountService } = {}) {
    super(null, 'FX Transfer');
    this.fxService      = fxService;
    this.accountService = accountService;
    this.generatedActionTypes = ['FX_TRANSFER_APPLY', 'RECORD_METRIC', 'RECORD_BALANCE', 'INTL_TRANSFER_RECORD'];
  }

  static fromJSON(d, { fxService, accountService }) {
    const h = new this({ fxService, accountService });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return { ...super.toJSON() };
  }

  call({ state, data, date }) {
    const { from, to, amount = 0 } = data ?? {};
    const dir    = { from, to };
    const pair   = this.fxService.fxEngine.getPair(from, to);
    const rate   = pair.rate(state, dir);
    const fee    = pair.fee(state, amount, dir);
    const srcKey = this.fxService.settlement(from);
    const dstKey = this.fxService.settlement(to);
    const srcBal = state[srcKey]?.balance ?? 0;

    const pendingTax = [];
    const transferRecords = [];
    if (amount > srcBal) {
      try {
        const r = this.accountService.replenishSavings(state, srcKey, amount - srcBal, date);
        pendingTax.push(...r.pendingTaxActions);
        // A cross-currency leg of the source top-up is journaled too (design 44 Gap A).
        transferRecords.push(...(r.crossBorderTransfers ?? []));
      } catch (e) {
        if (!(e instanceof InsufficientFundsError)) throw e;
        // Keep what the exhausted draw already realized (see
        // InsufficientFundsError.partial) — those sales are taxable regardless.
        pendingTax.push(...e.partial.pendingTaxActions);
        transferRecords.push(...e.partial.crossBorderTransfers);
      }
    }

    const fromActual = Math.min(amount, state[srcKey]?.balance ?? 0);
    const toCredit   = Math.max(0, (fromActual - fee) * rate);

    return [
      {
        type: 'FX_TRANSFER_APPLY',
        from, to, srcKey, dstKey,
        fromAmount: fromActual,
        toAmount:   toCredit,
        rate,
        fee,
      },
      new RecordMetricAction(`fx_transfer_${from}_${to}`, toCredit),
      new RecordBalanceAction(`${dstKey}.balance`, dstKey),
      ...transferRecords,
      ...pendingTax,
    ];
  }
}
