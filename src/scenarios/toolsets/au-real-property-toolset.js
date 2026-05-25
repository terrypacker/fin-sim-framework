/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { OneOffEvent }             from '../../simulation-framework/events/one-off-event.js';
import { EventSeries }             from '../../simulation-framework/events/event-series.js';
import { AuHouseSaleHandler, AuHouseSaleApplyReducer } from '../../finance/account-rules/au/au-real-property-classes.js';
import { AuMortgagePaymentHandler, AuMortgagePaymentApplyReducer } from '../../finance/account-rules/mortgage-payment-classes.js';

/**
 * AU_REAL_PROPERTY toolset — wires AU house sale machinery.
 *
 * Capabilities: real-property
 * Depends on: AU_TAX (AuHouseSaleApplyReducer chains AU_HOUSE_SALE_TAX)
 *
 * Schedules:
 *   One-off AU_HOUSE_SALE event for each AU real property whose
 *   plannedSaleYear is set.  The sale price is baked in at the property's
 *   initial value; users who need appreciation-adjusted pricing should
 *   register their own one-off event instead.
 *
 * Handlers:  AuHouseSaleHandler  (handles AU_HOUSE_SALE events)
 * Reducers:  AuHouseSaleApplyReducer (handles AU_HOUSE_SALE_APPLY)
 */
export const AU_REAL_PROPERTY = {
  id: 'AU_REAL_PROPERTY',
  capabilities: ['real-property'],
  dependencies: ['AU_TAX'],

  paramSchema(context) {
    return [];
  },

  state(context) {
    const patches = {};
    for (const prop of (context.realProperties ?? [])) {
      if (prop.stateKey && prop.country === 'AU') {
        patches[prop.stateKey] = _propertyToStatePlain(prop);
      }
    }
    return patches;
  },

  schedules(context) {
    const auProps = (context.realProperties ?? []).filter(p => p.country === 'AU');
    const schedules = auProps
      .filter(p => p.plannedSaleYear != null)
      .map(p => new OneOffEvent({
        name:    `Sell ${p.name}`,
        type:    'AU_HOUSE_SALE',
        date:    new Date(Date.UTC(p.plannedSaleYear, 0, 15)),
        data:    { salePrice: p.value, costBasis: p.costBasis, ownershipType: p.ownershipType, ownerId: p.ownerId, owners: p.owners, stateKey: p.stateKey },
        enabled: true,
        color:   '#5D4037',
      }));
    const mortgagedProps = auProps.filter(p => (p.mortgageBalance ?? 0) > 0 && (p.monthlyMortgage ?? 0) > 0);
    if (mortgagedProps.length > 0) {
      schedules.push(new EventSeries({
        name:     'AU Mortgage Payment',
        type:     'AU_MORTGAGE_PAYMENT',
        interval: 'month-end',
        enabled:  true,
        color:    '#4E342E',
      }));
    }
    return schedules;
  },

  handlers(context) {
    const props = (context.realProperties ?? []).filter(p => p.country === 'AU');
    if (props.length === 0) return [];
    const handlers = [new AuHouseSaleHandler()];
    const mortgagedProps = props.filter(p => (p.mortgageBalance ?? 0) > 0 && (p.monthlyMortgage ?? 0) > 0);
    if (mortgagedProps.length > 0) {
      handlers.push(new AuMortgagePaymentHandler({
        properties: mortgagedProps.map(p => ({ stateKey: p.stateKey, monthlyMortgage: p.monthlyMortgage })),
      }));
    }
    return handlers;
  },

  reducers(context) {
    const props = (context.realProperties ?? []).filter(p => p.country === 'AU');
    if (props.length === 0) return [];
    const reducers = [new AuHouseSaleApplyReducer({ accountService: context.accountService })];
    const mortgagedProps = props.filter(p => (p.mortgageBalance ?? 0) > 0 && (p.monthlyMortgage ?? 0) > 0);
    if (mortgagedProps.length > 0) {
      reducers.push(new AuMortgagePaymentApplyReducer({ accountService: context.accountService }));
    }
    return reducers;
  },
};

function _propertyToStatePlain(prop) {
  return {
    stateKey:           prop.stateKey,
    value:              prop.value              ?? 0,
    costBasis:          prop.costBasis          ?? 0,
    mortgageBalance:    prop.mortgageBalance    ?? 0,
    monthlyMortgage:    prop.monthlyMortgage    ?? 0,
    appreciationRate:   prop.appreciationRate   ?? 0,
    isPrimaryResidence: prop.isPrimaryResidence ?? false,
    plannedSaleYear:    prop.plannedSaleYear    ?? null,
    ownershipType:      prop.ownershipType      ?? 'sole',
    ownerId:            prop.ownerId            ?? null,
    country:            prop.country            ?? 'AU',
  };
}
