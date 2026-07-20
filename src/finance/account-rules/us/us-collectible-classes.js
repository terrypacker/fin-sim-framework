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
import { resolveDestinationCashKey, resolveSaleDestinationKey } from '../cash-routing.js';

/** Default US cash pool key when no saleDestinationAccount is provided. */
const defaultUsCashKey = (state) =>
  state.usSavingsAccount != null ? 'usSavingsAccount' : 'checkingAccount';

/**
 * Resolve the destination state key, falling back to the default US cash pool.
 * Delegates to the shared resolver so a `saleDestinationAccount` persisted as an
 * account *id* rather than a state key still finds its account (design 72 §2).
 */
const resolveDestinationKey = (state, saleDestinationAccount) =>
  resolveSaleDestinationKey(state, saleDestinationAccount, defaultUsCashKey(state));

// ─── Reducers ─────────────────────────────────────────────────────────────────

/**
 * EVT-36/46: Collectible Sale — credit destination account with sale proceeds,
 * zero out the collectible's stateKey value (if present), and chain
 * COLLECTIBLE_SALE_TAX. Gain = salePrice - costBasis; taxed at the 28%
 * collectibles rate (US) and/or as AU capital gain when resident in AU.
 */
export class CollectibleSaleApplyReducer extends AccountServiceReducer {
  static type        = 'CollectibleSaleApplyReducer';
  static description = 'Credits the destination account with collectible sale proceeds, zeroes the collectible value, and chains COLLECTIBLE_SALE_TAX with the gain.';
  static actionType  = 'COLLECTIBLE_SALE_APPLY';

  constructor({ accountService, stateRegistry }) {
    super('Collectible Sale Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes   = ['COLLECTIBLE_SALE_APPLY'];
    this.generatedActionTypes = ['COLLECTIBLE_SALE_TAX'];
  }

  reduce(state, action) {
    const { salePrice, costBasis, residency, stateKey, destinationKey } = action;
    const gain    = Math.max(0, salePrice - costBasis);
    const destKey = resolveDestinationCashKey(this.stateRegistry, 'US', state, destinationKey);
    this.accountService.transaction(state[destKey], salePrice, null);
    const stateUpdate = {};
    const key = stateKey ?? 'collectibleAccount';
    const col = state[key];
    if (col != null) {
      stateUpdate[key] = { ...col, value: 0 };
    }

    // AU CGT reform (design 57 Part 2, Item C): investment bullion (isGold) is an
    // ordinary AU CGT asset, so its AU gain is cost-base indexed like equity; a
    // true collectible is not. The AU-deemed cost base (costBaseByCountry.AU) and
    // the indexation level (acquisitionPriceLevel) were stamped at the residency
    // step-up. auGain falls back to the raw gain when no AU basis was stamped, so
    // non-gold and pre-move sales are unchanged.
    const isGold   = col?.isGold === true;
    const auBasis  = col?.costBaseByCountry?.AU ?? costBasis;
    const auGain   = Math.max(0, salePrice - auBasis);
    let auIndexedGain = auGain;
    if (isGold && col?.acquisitionPriceLevel != null) {
      const nowLevel = state.cpiAccumulator?.AU ?? state.inflationAccumulator?.AU ?? 1;
      const indexedBasis = auBasis * (nowLevel / col.acquisitionPriceLevel);
      auIndexedGain = Math.max(0, salePrice - indexedBasis);
    }

    return this.newState(
      state,
      stateUpdate,
      [{ type: 'COLLECTIBLE_SALE_TAX', gain, auGain, auIndexedGain, isGold, residency }]
    );
  }
}

/**
 * EVT-45/47: Collectible Value Change — apply +/− change to the targeted
 * collectible's state entry.  action.stateKey identifies the collectible;
 * falls back to 'collectibleAccount' for backward compatibility with manually
 * scheduled events that pre-date multi-collectible support.
 * No tax effect (unrealized appreciation/depreciation).
 */
export class CollectibleValueChangeApplyReducer extends AccountServiceReducer {
  static type        = 'CollectibleValueChangeApplyReducer';
  static description = 'Applies a +/− change to the targeted collectible state entry; no tax effect.';
  static actionType  = 'COLLECTIBLE_VALUE_CHANGE_APPLY';

  constructor({ accountService }) {  // accountService unused but accepted for API symmetry
    super('Collectible Value Change Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes = ['COLLECTIBLE_VALUE_CHANGE_APPLY'];
  }

  reduce(state, action) {
    const key = action.stateKey ?? 'collectibleAccount';
    const ca  = state[key];
    if (!ca) return this.newState(state);
    return this.newState(state, {
      [key]: { ...ca, value: ca.value + action.change },
    });
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export class CollectibleSaleHandler extends HandlerEntry {
  static type        = 'CollectibleSaleHandler';
  static description = 'Dispatches COLLECTIBLE_SALE_APPLY with sale price, cost basis, AU residency flag, and resolved destination account.';
  static eventType   = 'COLLECTIBLE_SALE';

  constructor() {
    super(null, 'Collectible Sale');
    this.generatedActionTypes = ['COLLECTIBLE_SALE_APPLY', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    const colState       = data.stateKey ? state[data.stateKey] : null;
    const destinationKey = resolveDestinationKey(state, data.saleDestinationAccount);
    return [
      {
        type:         'COLLECTIBLE_SALE_APPLY',
        salePrice:    data.salePrice ?? colState?.value ?? 0,
        costBasis:    data.costBasis,
        residency: state.people?.[Object.keys(state.people ?? {})[0]]?.residency ?? null,
        stateKey:     data.stateKey ?? null,
        destinationKey,
      },
      new RecordBalanceAction(`${destinationKey}.balance`, destinationKey),
    ];
  }
}

export class CollectibleValueChangeHandler extends HandlerEntry {
  static type        = 'CollectibleValueChangeHandler';
  static description = 'Dispatches COLLECTIBLE_VALUE_CHANGE_APPLY with the +/− change amount.';
  static eventType   = 'COLLECTIBLE_VALUE_CHANGE';

  constructor() {
    super(null, 'Collectible Value Change');
    this.generatedActionTypes = ['COLLECTIBLE_VALUE_CHANGE_APPLY'];
  }

  call({ data }) {
    return [
      { type: 'COLLECTIBLE_VALUE_CHANGE_APPLY', change: data.change, stateKey: data.stateKey ?? null },
    ];
  }
}
