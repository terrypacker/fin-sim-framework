/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY } from '../../../simulation-framework/reducers.js';
import { HandlerEntry }       from '../../../simulation-framework/handlers.js';
import { RecordBalanceAction } from '../../../simulation-framework/actions.js';

/** Resolve the US cash pool. */
const usCash = (state) => state.usSavingsAccount ?? state.checkingAccount;

const US_PRIMARY_HOME_EXEMPTION = 500_000;

// ─── Reducer ──────────────────────────────────────────────────────────────────

/**
 * EVT-34: US house sale — credit US cash pool, compute taxable gain after the
 * $500K primary-home exemption, chain US_HOUSE_SALE_TAX.
 */
export class UsHouseSaleApplyReducer extends Reducer {
  static description = 'Credits the US cash pool with sale proceeds and chains US_HOUSE_SALE_TAX with the post-exemption taxable gain.';
  static actionType  = 'US_HOUSE_SALE_APPLY';

  constructor({ accountService }) {
    super('US House Sale Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes   = ['US_HOUSE_SALE_APPLY'];
    this.generatedActionTypes = ['US_HOUSE_SALE_TAX'];
  }

  reduce(state, action) {
    const { salePrice, costBasis } = action;
    const rawGain     = Math.max(0, salePrice - costBasis);
    const taxableGain = Math.max(0, rawGain - US_PRIMARY_HOME_EXEMPTION);
    this.accountService.transaction(usCash(state), salePrice, null);
    return this.newState(
      state,
      {},
      [{ type: 'US_HOUSE_SALE_TAX', taxableGain }]
    );
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export class UsHouseSaleHandler extends HandlerEntry {
  static description = 'Dispatches US_HOUSE_SALE_APPLY with sale price, cost basis, and AU residency flag.';
  static eventType   = 'US_HOUSE_SALE';

  constructor() {
    super(null, 'US House Sale');
    this.generatedActionTypes = ['US_HOUSE_SALE_APPLY', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    return [
      {
        type:         'US_HOUSE_SALE_APPLY',
        salePrice:    data.salePrice,
        costBasis:    data.costBasis,
        isAuResident: state.isAuResident,
      },
      new RecordBalanceAction(),
    ];
  }
}
