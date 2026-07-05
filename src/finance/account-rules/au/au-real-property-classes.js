/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY, AccountServiceReducer } from '../../../simulation-framework/reducers.js';
import { HandlerEntry }       from '../../../simulation-framework/handlers.js';
import { RecordBalanceAction } from '../../../simulation-framework/actions.js';

/** Default AU cash pool key when no saleDestinationAccount is provided. */
const defaultAuCashKey = (state) =>
  state.auSavingsAccount != null ? 'auSavingsAccount' : 'checkingAccount';

/** Resolve the destination state key, falling back to the default AU cash pool. */
const resolveDestinationKey = (state, saleDestinationAccount) => {
  if (saleDestinationAccount && state[saleDestinationAccount] != null) {
    return saleDestinationAccount;
  }
  return defaultAuCashKey(state);
};

// ─── Reducer ──────────────────────────────────────────────────────────────────

/**
 * EVT-33: AU house sale — credit destination account with sale proceeds net of
 * mortgage payoff, compute capital gain (unaffected by mortgage), and chain
 * AU_HOUSE_SALE_TAX.
 */
export class AuHouseSaleApplyReducer extends AccountServiceReducer {
  static type        = 'AuHouseSaleApplyReducer';
  static description = 'Credits the destination account with net proceeds (salePrice − mortgage), zeroes mortgageBalance, and chains AU_HOUSE_SALE_TAX with the capital gain.';
  static actionType  = 'AU_HOUSE_SALE_APPLY';

  constructor({ accountService }) {
    super('AU House Sale Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes   = ['AU_HOUSE_SALE_APPLY'];
    this.generatedActionTypes = ['AU_HOUSE_SALE_TAX'];
  }

  reduce(state, action) {
    const { salePrice, costBasis, mortgageBalance, residency, ownershipType, ownerId, owners, stateKey, destinationKey } = action;
    const mortgage    = mortgageBalance ?? 0;
    const netProceeds = Math.max(0, salePrice - mortgage);
    // Div 43 capital-works deductions taken during the hold reduce the CGT cost
    // base, so the gain is larger (design 48 §4.5). accumulatedDepreciation is 0
    // for non-rental properties, so this is a no-op there.
    const accumulatedDep = (stateKey && state[stateKey]?.accumulatedDepreciation) ?? 0;
    const adjustedBasis  = Math.max(0, costBasis - accumulatedDep);
    const gain        = Math.max(0, salePrice - adjustedBasis);
    const destKey     = destinationKey ?? defaultAuCashKey(state);
    this.accountService.transaction(state[destKey], netProceeds, null);
    const updates = {};
    if (stateKey && state[stateKey]) {
      updates[stateKey] = { ...state[stateKey], mortgageBalance: 0, value: 0 };
    }
    const description = stateKey && state[stateKey]?.name
      ? state[stateKey].name
      : (stateKey ?? 'AU Real Property');
    return this.newState(
      state,
      updates,
      [{ type: 'AU_HOUSE_SALE_TAX', gain, residency, ownershipType, ownerId, owners, proceeds: salePrice, costBasis: adjustedBasis, description }]
    );
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export class AuHouseSaleHandler extends HandlerEntry {
  static type        = 'AuHouseSaleHandler';
  static description = 'Dispatches AU_HOUSE_SALE_APPLY with sale price, cost basis, current mortgage balance, and resolved destination account.';
  static eventType   = 'AU_HOUSE_SALE';

  constructor() {
    super(null, 'AU House Sale');
    this.generatedActionTypes = ['AU_HOUSE_SALE_APPLY', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    const propState       = data.stateKey ? state[data.stateKey] : null;
    const mortgageBalance = propState?.mortgageBalance ?? 0;
    const destinationKey  = resolveDestinationKey(state, data.saleDestinationAccount);
    return [
      {
        type:            'AU_HOUSE_SALE_APPLY',
        salePrice:       data.salePrice ?? propState?.value ?? 0,
        costBasis:       data.costBasis,
        mortgageBalance,
        residency:       state.people?.[Object.keys(state.people ?? {})[0]]?.residency ?? null,
        ownershipType:   data.ownershipType,
        ownerId:         data.ownerId,
        owners:          data.owners,
        stateKey:        data.stateKey ?? null,
        destinationKey,
      },
      new RecordBalanceAction(`${destinationKey}.balance`, destinationKey),
    ];
  }
}
