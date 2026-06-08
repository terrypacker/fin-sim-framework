/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { OneOffEvent }               from '../../simulation-framework/events/one-off-event.js';
import {
  CollectibleSaleHandler, CollectibleSaleApplyReducer,
  CollectibleValueChangeHandler, CollectibleValueChangeApplyReducer,
} from '../../finance/account-rules/us/us-collectible-classes.js';
import { ValueType } from '../../simulation-framework/type-registry.js';

/**
 * US_COLLECTIBLES toolset — wires US collectible sale machinery.
 *
 * Capabilities: collectibles
 * Depends on: US_TAX (CollectibleSaleApplyReducer chains COLLECTIBLE_SALE_TAX,
 *   which is taxed at the 28% collectibles rate inside the US tax module)
 *
 * Schedules:
 *   One-off COLLECTIBLE_SALE event for each collectible whose plannedSaleYear
 *   is set.  The sale price is baked in at the collectible's initial value;
 *   users who need appreciation-adjusted pricing should register their own
 *   one-off event instead.
 *
 * Handlers:  CollectibleSaleHandler  (handles COLLECTIBLE_SALE events)
 * Reducers:  CollectibleSaleApplyReducer (handles COLLECTIBLE_SALE_APPLY)
 */
export const US_COLLECTIBLES = {
  id: 'US_COLLECTIBLES',
  capabilities: ['collectibles'],
  dependencies: ['US_TAX'],

  types: {
    handlers: [CollectibleSaleHandler, CollectibleValueChangeHandler],
    reducers: [CollectibleSaleApplyReducer, CollectibleValueChangeApplyReducer],
    actions: [
      { type: 'COLLECTIBLE_SALE_APPLY',
        fields: { salePrice: ValueType.number(), costBasis: ValueType.number() } },
      { type: 'COLLECTIBLE_SALE_TAX', family: 'CAPITAL_GAINS', cc: 'US',
        fields: { gain: ValueType.number(), isAuResident: ValueType.boolean() } },
      { type: 'COLLECTIBLE_VALUE_CHANGE_APPLY', fields: { amount: ValueType.number() } },
    ],
  },

  paramSchema(context) {
    return [];
  },

  state(context) {
    const patches = { usCollectibleGainsYTD: 0 };
    for (const col of (context.collectibles ?? [])) {
      if (col.stateKey) {
        patches[col.stateKey] = _collectibleToStatePlain(col);
      }
    }
    return patches;
  },

  schedules(context) {
    return (context.collectibles ?? [])
      .filter(c => c.plannedSaleYear != null)
      .map(c => new OneOffEvent({
        name:    `Sell ${c.name}`,
        type:    'COLLECTIBLE_SALE',
        date:    new Date(Date.UTC(c.plannedSaleYear, 0, 15)),
        data:    { salePrice: c.value, costBasis: c.costBasis, stateKey: c.stateKey, saleDestinationAccount: c.saleDestinationAccount },
        enabled: true,
        color:   '#FF8F00',
      }));
  },

  handlers(context) {
    if ((context.collectibles ?? []).length === 0) return [];
    return [new CollectibleSaleHandler(), new CollectibleValueChangeHandler()];
  },

  reducers(context) {
    if ((context.collectibles ?? []).length === 0) return [];
    return [
      new CollectibleSaleApplyReducer({ accountService: context.accountService }),
      new CollectibleValueChangeApplyReducer({ accountService: context.accountService }),
    ];
  },
};

function _collectibleToStatePlain(col) {
  return {
    stateKey:         col.stateKey,
    value:            col.value            ?? 0,
    costBasis:        col.costBasis        ?? 0,
    appreciationRate: col.appreciationRate ?? 0,
    plannedSaleYear:  col.plannedSaleYear  ?? null,
    ownershipType:    col.ownershipType    ?? 'sole',
    ownerId:          col.ownerId          ?? null,
    country:          col.country          ?? 'US',
  };
}
