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
import { resolveDestinationCashKey, resolveSaleDestinationKey, creditSaleProceeds } from '../cash-routing.js';
import { singleAssetTermFields } from '../../holdings/holding-period.js';
import { toMs } from '../main-residence.js';

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
    this.generatedActionTypes = ['COLLECTIBLE_SALE_TAX', 'INTL_TRANSFER_RECORD'];
  }

  reduce(state, action, date) {
    const { salePrice, costBasis, residency, stateKey, destinationKey } = action;
    const gain    = Math.max(0, salePrice - costBasis);
    const key = stateKey ?? 'collectibleAccount';
    const col = state[key];
    // Domicile, not an assumption. This reducer used to hardcode 'US' and 'USD' —
    // correct for the reference scenario's gold, and wrong for any collectible
    // actually held abroad: the proceeds of an Australian's Australian asset were
    // routed to a US cash pool that an AU-only scenario does not have, and its AUD
    // sale price was then read as USD by every downstream consumer, inflating the
    // assessable gain by the exchange rate. The record already carries both fields.
    const country  = col?.country ?? 'US';
    const currency = col?.currency?.code ?? (country === 'AU' ? 'AUD' : 'USD');
    const destKey = resolveDestinationCashKey(this.stateRegistry, country, state, destinationKey);
    const { transfer: fxLeg } = creditSaleProceeds(
      this.accountService, state, destKey, salePrice, currency, stateKey, null);
    const stateUpdate = {};
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

    // Design 90 §9 step 2 — the signed, §1222-charactered split. A collectible is held
    // for investment, so §165(c)(2) allows a loss on it; unlike a residence there is no
    // personal-use bar. (Whether the loss is deductible is a separate question from the
    // 28% rate its GAIN attracts under §1(h)(4) — the rate applies to net collectible
    // gain, while a collectible loss is an ordinary capital loss in the §1211 netting.)
    const { usShortTermGain, usLongTermGain, auShortTermGain, auLongTermGain } =
      singleAssetTermFields({
        proceeds: salePrice, usBasis: costBasis, auBasis,
        // Collectible carries no US acquisition date (only the per-country deemed one),
        // so the US arm defaults to long-term — right for a held collectible, and the
        // safe default besides. Same shape as the CompanyEquity disposal.
        acquisitionMs:   null,
        auAcquisitionMs: col?.acquisitionDateByCountry?.AU ?? null,
        // Design 83 G7 — the disposal date, not the tax period start.
        saleMs: toMs(date) ?? state.currentPeriods?.US?.startMs ?? null,
      });

    return this.newState(
      state,
      stateUpdate,
      // Design 76 Gap B: attribute the AU gain to the collectible's owner(s).
      // `proceeds` / `costBasis` are what put the disposal on the AU CGT worksheet:
      // _extractAuDisposals skips any entry without proceeds, so until design 91 §8.9 an
      // AU resident's collectible sale was assessed (it feeds auCapitalGainsYTD and is
      // taxed) yet appeared on no worksheet row — the return footed, the working that
      // justifies it silently omitted the asset. Every money field below is in
      // `currency`, the collectible's own — the `au*` ones INCLUDED, exactly as design
      // 91 §8 types a disposal: the prefix says which BASIS measured the gain, never
      // which currency states it. Consumers convert on the way in, which is why the
      // currency has to travel with the action rather than being assumed.
      [...(fxLeg ? [fxLeg] : []),
       { type: 'COLLECTIBLE_SALE_TAX', gain, auGain, auIndexedGain, isGold, residency, currency,
        usShortTermGain, usLongTermGain, auShortTermGain, auLongTermGain,
        proceeds: salePrice, costBasis,
        ownershipType: col?.ownershipType, ownerId: col?.ownerId, owners: col?.owners }]
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
