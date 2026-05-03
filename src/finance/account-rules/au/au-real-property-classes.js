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

/** Resolve the AU cash pool. */
const auCash = (state) => state.auSavingsAccount ?? state.checkingAccount;

// ─── Reducer ──────────────────────────────────────────────────────────────────

/**
 * EVT-33: AU house sale — credit AU cash pool, compute gain, chain AU_HOUSE_SALE_TAX.
 */
export class AuHouseSaleApplyReducer extends Reducer {
  static description = 'Credits the AU cash pool with sale proceeds and chains AU_HOUSE_SALE_TAX with the capital gain.';
  static actionType  = 'AU_HOUSE_SALE_APPLY';

  constructor({ accountService }) {
    super('AU House Sale Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes   = ['AU_HOUSE_SALE_APPLY'];
    this.generatedActionTypes = ['AU_HOUSE_SALE_TAX'];
  }

  reduce(state, action) {
    const { salePrice, costBasis } = action;
    const gain = Math.max(0, salePrice - costBasis);
    this.accountService.transaction(auCash(state), salePrice, null);
    return this.newState(
      state,
      {},
      [{ type: 'AU_HOUSE_SALE_TAX', gain }]
    );
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export class AuHouseSaleHandler extends HandlerEntry {
  static description = 'Dispatches AU_HOUSE_SALE_APPLY with sale price and cost basis.';
  static eventType   = 'AU_HOUSE_SALE';

  constructor() {
    super(null, 'AU House Sale');
    this.generatedActionTypes = ['AU_HOUSE_SALE_APPLY', 'RECORD_BALANCE'];
  }

  call({ data }) {
    return [
      { type: 'AU_HOUSE_SALE_APPLY', salePrice: data.salePrice, costBasis: data.costBasis },
      new RecordBalanceAction(),
    ];
  }
}
