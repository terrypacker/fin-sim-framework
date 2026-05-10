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

// ─── Reducers ─────────────────────────────────────────────────────────────────

/**
 * EVT-36/46: Collectible Sale — credit US cash pool, zero out collectibleAccount
 * value (if present in state), chain COLLECTIBLE_SALE_TAX.
 * Gain = salePrice - costBasis; taxed at the 28% collectibles rate (US).
 */
export class CollectibleSaleApplyReducer extends Reducer {
  static description = 'Credits the US cash pool with collectible sale proceeds and chains COLLECTIBLE_SALE_TAX with the gain.';
  static actionType  = 'COLLECTIBLE_SALE_APPLY';

  constructor({ accountService }) {
    super('Collectible Sale Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes   = ['COLLECTIBLE_SALE_APPLY'];
    this.generatedActionTypes = ['COLLECTIBLE_SALE_TAX'];
  }

  reduce(state, action) {
    const { salePrice, costBasis, isAuResident } = action;
    const gain = Math.max(0, salePrice - costBasis);
    this.accountService.transaction(usCash(state), salePrice, null);
    const stateUpdate = {};
    if (state.collectibleAccount != null) {
      stateUpdate.collectibleAccount = { ...state.collectibleAccount, value: 0 };
    }
    return this.newState(
      state,
      stateUpdate,
      [{ type: 'COLLECTIBLE_SALE_TAX', gain, isAuResident }]
    );
  }
}

/**
 * EVT-45/47: Collectible Value Change — apply +/− change to collectibleAccount.value.
 * No tax effect (unrealized appreciation/depreciation).
 */
export class CollectibleValueChangeApplyReducer extends Reducer {
  static description = 'Applies a +/− change to collectibleAccount.value; no tax effect.';
  static actionType  = 'COLLECTIBLE_VALUE_CHANGE_APPLY';

  constructor({ accountService }) {  // accountService unused but accepted for API symmetry
    super('Collectible Value Change Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes = ['COLLECTIBLE_VALUE_CHANGE_APPLY'];
  }

  reduce(state, action) {
    const ca = state.collectibleAccount;
    return this.newState(state, {
      collectibleAccount: { ...ca, value: ca.value + action.change },
    });
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export class CollectibleSaleHandler extends HandlerEntry {
  static description = 'Dispatches COLLECTIBLE_SALE_APPLY with sale price, cost basis, and AU residency flag.';
  static eventType   = 'COLLECTIBLE_SALE';

  constructor() {
    super(null, 'Collectible Sale');
    this.generatedActionTypes = ['COLLECTIBLE_SALE_APPLY', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    const cashKey = state.usSavingsAccount != null ? 'usSavingsAccount' : 'checkingAccount';
    return [
      {
        type:         'COLLECTIBLE_SALE_APPLY',
        salePrice:    data.salePrice,
        costBasis:    data.costBasis,
        isAuResident: state.isAuResident,
      },
      new RecordBalanceAction(`${cashKey}.balance`, cashKey),
    ];
  }
}

export class CollectibleValueChangeHandler extends HandlerEntry {
  static description = 'Dispatches COLLECTIBLE_VALUE_CHANGE_APPLY with the +/− change amount.';
  static eventType   = 'COLLECTIBLE_VALUE_CHANGE';

  constructor() {
    super(null, 'Collectible Value Change');
    this.generatedActionTypes = ['COLLECTIBLE_VALUE_CHANGE_APPLY'];
  }

  call({ data }) {
    return [
      { type: 'COLLECTIBLE_VALUE_CHANGE_APPLY', change: data.change },
    ];
  }
}
