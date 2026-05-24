/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { OneOffEvent }           from '../../simulation-framework/events/one-off-event.js';
import { UsHouseSaleHandler }    from '../../finance/account-rules/us/us-real-property-classes.js';
import { UsHouseSaleApplyReducer } from '../../finance/account-rules/us/us-real-property-classes.js';

/**
 * US_REAL_PROPERTY toolset — wires US house sale machinery.
 *
 * Capabilities: real-property
 * Depends on: US_TAX (UsHouseSaleApplyReducer chains US_HOUSE_SALE_TAX)
 *
 * Schedules:
 *   One-off US_HOUSE_SALE event for each US real property whose
 *   plannedSaleYear is set.  The sale price is baked in at the property's
 *   initial value; users who need appreciation-adjusted pricing should
 *   register their own one-off event instead.
 *
 * Handlers:  UsHouseSaleHandler  (handles US_HOUSE_SALE events)
 * Reducers:  UsHouseSaleApplyReducer (handles US_HOUSE_SALE_APPLY)
 */
export const US_REAL_PROPERTY = {
  id: 'US_REAL_PROPERTY',
  capabilities: ['real-property'],
  dependencies: ['US_TAX'],

  paramSchema(context) {
    return [];
  },

  state(context) {
    return {};
  },

  schedules(context) {
    return (context.realProperties ?? [])
      .filter(p => p.country === 'US' && p.plannedSaleYear != null)
      .map(p => new OneOffEvent({
        name:    `Sell ${p.name}`,
        type:    'US_HOUSE_SALE',
        date:    new Date(Date.UTC(p.plannedSaleYear, 0, 15)),
        data:    { salePrice: p.value, costBasis: p.costBasis },
        enabled: true,
        color:   '#795548',
      }));
  },

  handlers(context) {
    const props = (context.realProperties ?? []).filter(p => p.country === 'US');
    if (props.length === 0) return [];
    return [new UsHouseSaleHandler()];
  },

  reducers(context) {
    const props = (context.realProperties ?? []).filter(p => p.country === 'US');
    if (props.length === 0) return [];
    return [new UsHouseSaleApplyReducer({ accountService: context.accountService })];
  },
};
