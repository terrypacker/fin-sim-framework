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
import { EventSeries }               from '../../simulation-framework/events/event-series.js';
import {
  CollectibleSaleHandler, CollectibleSaleApplyReducer,
  CollectibleValueChangeHandler, CollectibleValueChangeApplyReducer,
} from '../../finance/account-rules/us/us-collectible-classes.js';
import { AssetAppreciationHandler } from '../../finance/handlers/asset-appreciation-handler.js';
import { ValueType } from '../../simulation-framework/type-registry.js';

const COLLECTIBLE_APPRECIATE_TYPE = 'COLLECTIBLE_APPRECIATE';

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
    handlers: [CollectibleSaleHandler, CollectibleValueChangeHandler, AssetAppreciationHandler],
    reducers: [CollectibleSaleApplyReducer, CollectibleValueChangeApplyReducer],
    actions: [
      { type: 'COLLECTIBLE_SALE_APPLY',
        fields: { salePrice: ValueType.currency('USD'), costBasis: ValueType.currency('USD'),
                  residency: ValueType.text(), stateKey: ValueType.text() } },
      // isGold separates bullion (an ordinary AU CGT asset, indexed) from a true
      // collectible; the au* pair carries the AU-resident assessment of the same
      // disposal. All three are emitted by the gold sleeve inside a brokerage
      // account as well as by a standalone collectible.
      // Currency on the disposal money (design 91 §8). Every money field here is the
      // COLLECTIBLE'S OWN currency — the `au*` ones INCLUDED. The prefix means
      // "measured on the AU basis" (the s855-45 stepped-up cost base, the 12-month
      // discount test), NOT "denominated in AUD": the emitter works in the asset's
      // currency and the consumer converts, e.g. `toAUD(auGain, action.currency, state)`
      // in us-tax-module-2026. Typing auGain as AUD would be precisely the error this
      // declaration exists to prevent.
      //
      // The static `currency('USD')` below is right for a US-domiciled collectible and
      // is what every collectible was until an AU-domiciled one became expressible. The
      // `currency` FIELD carries the actual denomination for consumers; the manifest has
      // no way to say "whatever this row's currency field says", so an AU-domiciled
      // disposal is mislabelled USD in the journal's display layer while every
      // computation on it is correct.
      { type: 'COLLECTIBLE_SALE_TAX', family: 'CAPITAL_GAINS', cc: 'US',
        fields: { gain: ValueType.currency('USD'), auGain: ValueType.currency('USD'), auIndexedGain: ValueType.currency('USD'), isGold: ValueType.boolean(), currency: ValueType.text(), usShortTermGain: ValueType.currency('USD'), usLongTermGain: ValueType.currency('USD'), auShortTermGain: ValueType.currency('USD'), auLongTermGain: ValueType.currency('USD'), residency: ValueType.text() , stateKey: ValueType.text(), ownershipType: ValueType.text(), ownerId: ValueType.text(), owners: ValueType.any(),
                  proceeds: ValueType.currency('USD'), costBasis: ValueType.currency('USD'),
                  // Form 8949 column (a). The gold-sleeve emitters live inside a
                  // brokerage account, so without a name the disposal register falls back
                  // to DEFAULT_DISPOSAL_DESCRIPTION and every rebalanced gold lot reads
                  // "Collectible" instead of the account it came out of.
                  description: ValueType.text()} },
      // `change` (the signed revaluation) and `stateKey` (which collectible), the two
      // fields CollectibleValueChangeHandler actually emits. The manifest previously
      // declared `amount`, a name nothing sends — so pickPayload kept nothing and every
      // revaluation reached the journal with an empty payload, invisible to any report
      // even though the reducer applied it correctly to the collectible's value.
      { type: 'COLLECTIBLE_VALUE_CHANGE_APPLY',
        fields: { change: ValueType.currency('USD'), stateKey: ValueType.text() } },
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
    const schedules = (context.collectibles ?? [])
      .filter(c => c.plannedSaleYear != null)
      .map(c => new OneOffEvent({
        name:    `Sell ${c.name}`,
        type:    'COLLECTIBLE_SALE',
        date:    new Date(Date.UTC(c.plannedSaleYear, 0, 15)),
        data:    { costBasis: c.costBasis, stateKey: c.stateKey, saleDestinationAccount: c.saleDestinationAccount },
        enabled: true,
        color:   '#FF8F00',
      }));
    const appreciableCols = (context.collectibles ?? []).filter(c => c.stateKey && ((c.appreciationRate ?? 0) !== 0 || c.appreciationSchedule));
    if (appreciableCols.length > 0) {
      schedules.push(new EventSeries({
        name:     'Collectible Appreciation',
        type:     COLLECTIBLE_APPRECIATE_TYPE,
        interval: 'annually',
        enabled:  true,
        color:    '#FF8F00',
      }));
    }
    return schedules;
  },

  handlers(context) {
    if ((context.collectibles ?? []).length === 0) return [];
    const handlers = [new CollectibleSaleHandler(), new CollectibleValueChangeHandler()];
    const appreciableCols = (context.collectibles ?? []).filter(c => c.stateKey && ((c.appreciationRate ?? 0) !== 0 || c.appreciationSchedule));
    const appreciateEvent = context.schedulesById?.[COLLECTIBLE_APPRECIATE_TYPE];
    if (appreciableCols.length > 0 && appreciateEvent) {
      const handler = new AssetAppreciationHandler({
        assets: appreciableCols.map(c => ({
          stateKey:            c.stateKey,
          appreciationRate:    c.appreciationRate ?? 0,
          appreciationSchedule: c.appreciationSchedule ?? null,
        })),
      });
      handler.handledEvents = [appreciateEvent];
      handlers.push(handler);
    }
    return handlers;
  },

  reducers(context) {
    if ((context.collectibles ?? []).length === 0) return [];
    return [
      new CollectibleSaleApplyReducer({ accountService: context.accountService, stateRegistry: context.stateRegistry }),
      new CollectibleValueChangeApplyReducer({ accountService: context.accountService, stateRegistry: context.stateRegistry }),
    ];
  },
};

function _collectibleToStatePlain(col) {
  return {
    kind:                'collectible',
    stateKey:            col.stateKey,
    value:               col.value            ?? 0,
    costBasis:           col.costBasis        ?? 0,
    appreciationRate:    col.appreciationRate ?? 0,
    plannedSaleYear:     col.plannedSaleYear  ?? null,
    ownershipType:       col.ownershipType    ?? 'sole',
    ownerId:             col.ownerId          ?? null,
    // Design 76 Gap A — owners[] outranks sole/joint; needed by P3's gain attribution.
    owners:              col.owners           ?? [],
    country:             col.country          ?? 'US',
    appreciationSchedule: col.appreciationSchedule ?? null,
    // AU CGT reform (design 57 Part 2, Item C): bullion marker + AU basis/level,
    // stamped at the residency step-up and read by the sale reducer to index the
    // AU gain. Projected here so the live state entry carries them.
    isGold:              col.isGold           ?? false,
    costBaseByCountry:   col.costBaseByCountry ?? null,
    acquisitionPriceLevel: col.acquisitionPriceLevel ?? null,
    acquisitionDateByCountry: col.acquisitionDateByCountry ?? null,
    // Design 88: the metrics read STATE, not the config record, so a field dropped
    // here makes the flag completely inert while the editor shows it set — exactly
    // how design 76 Gap A lost `ownershipType`. Projected only when TRUE so an
    // unflagged plan's state (and the golden fixture) is byte-identical (D2).
    ...(col.speculative === true ? { speculative: true } : {}),
  };
}
