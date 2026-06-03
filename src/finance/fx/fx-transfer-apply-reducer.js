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

/**
 * Pure ledger operation for FX_TRANSFER_APPLY actions.
 *
 * All math (rate, fee, replenishment) was resolved by FxTransferToHandler
 * before this action was emitted.  This reducer only executes the two
 * accountService.transaction() calls and optionally chains OUT_OF_FUNDS.
 *
 * Runs at PRIORITY.CASH_FLOW (20).
 *
 * Action fields consumed: from, to, srcKey, dstKey, fromAmount, toAmount,
 *   rate, fee, targetDeficit (optional — emits OUT_OF_FUNDS if toAmount < targetDeficit).
 */
export class FxTransferApplyReducer extends Reducer {
  static description = 'Pure ledger op: debits srcKey by fromAmount, credits dstKey by toAmount. Emits OUT_OF_FUNDS when toAmount falls short of targetDeficit.';
  static type        = 'FxTransferApplyReducer';
  static actionType  = 'FX_TRANSFER_APPLY';

  constructor({ accountService } = {}) {
    super('FX Transfer Apply', PRIORITY.CASH_FLOW);
    this.accountService       = accountService;
    this.reducedActionTypes   = ['FX_TRANSFER_APPLY'];
    this.generatedActionTypes = ['OUT_OF_FUNDS'];
  }

  static fromJSON(d, { accountService }) {
    const r = new this({ accountService });
    r.id = d.id;
    return r;
  }

  toJSON() {
    return { ...super.toJSON() };
  }

  reduce(state, action, date) {
    const { srcKey, dstKey, fromAmount = 0, toAmount = 0 } = action;
    const srcAcc = state[srcKey];
    const dstAcc = state[dstKey];

    if (fromAmount > 0 && srcAcc && dstAcc) {
      this.accountService.transaction(srcAcc, -fromAmount, date);
      this.accountService.transaction(dstAcc, +toAmount,   date);
    }

    const deficit = action.targetDeficit != null ? action.targetDeficit - toAmount : 0;
    if (deficit > 0.01) {
      return this.newState(state, {}, [{ type: 'OUT_OF_FUNDS', deficit, currency: action.to }]);
    }

    return this.newState(state);
  }
}
