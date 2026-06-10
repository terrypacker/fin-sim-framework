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
import { EventSeries }           from '../../simulation-framework/events/event-series.js';
import { UsHouseSaleHandler, UsHouseSaleApplyReducer } from '../../finance/account-rules/us/us-real-property-classes.js';
import { UsMortgagePaymentHandler, UsMortgagePaymentApplyReducer } from '../../finance/account-rules/mortgage-payment-classes.js';
import { AssetAppreciationHandler } from '../../finance/handlers/asset-appreciation-handler.js';
import { ValueType } from '../../simulation-framework/type-registry.js';

const US_REAL_PROPERTY_APPRECIATE_TYPE = 'US_REAL_PROPERTY_APPRECIATE';

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

  types: {
    handlers: [UsHouseSaleHandler, UsMortgagePaymentHandler, AssetAppreciationHandler],
    reducers: [UsHouseSaleApplyReducer, UsMortgagePaymentApplyReducer],
    actions: [
      { type: 'US_HOUSE_SALE_APPLY', family: 'REAL_PROPERTY_CASH', cc: 'US',
        fields: { salePrice: ValueType.number(), costBasis: ValueType.number(), stateKey: ValueType.text() } },
      { type: 'US_HOUSE_SALE_TAX', family: 'CAPITAL_GAINS', cc: 'US',
        fields: { taxableGain: ValueType.number() } },
      { type: 'US_MORTGAGE_PAYMENT_APPLY', family: 'REAL_PROPERTY_CASH', cc: 'US',
        fields: { amount: ValueType.currency('USD') } },
      { type: 'ASSET_APPRECIATE_APPLY', family: 'REAL_PROPERTY_CASH', cc: null,
        fields: { stateKey: ValueType.text(), delta: ValueType.number() } },
    ],
  },

  paramSchema(context) {
    return [];
  },

  state(context) {
    const patches = {};
    for (const prop of (context.realProperties ?? [])) {
      if (prop.stateKey && prop.country === 'US') {
        patches[prop.stateKey] = _propertyToStatePlain(prop);
      }
    }
    return patches;
  },

  schedules(context) {
    const usProps = (context.realProperties ?? []).filter(p => p.country === 'US');
    const schedules = usProps
      .filter(p => p.plannedSaleYear != null)
      .map(p => new OneOffEvent({
        name:    `Sell ${p.name}`,
        type:    'US_HOUSE_SALE',
        date:    new Date(Date.UTC(p.plannedSaleYear, 0, 15)),
        data:    { costBasis: p.costBasis, stateKey: p.stateKey, saleDestinationAccount: p.saleDestinationAccount },
        enabled: true,
        color:   '#795548',
      }));
    const mortgagedProps = usProps.filter(p => (p.mortgageBalance ?? 0) > 0 && (p.monthlyMortgage ?? 0) > 0);
    if (mortgagedProps.length > 0) {
      schedules.push(new EventSeries({
        name:     'US Mortgage Payment',
        type:     'US_MORTGAGE_PAYMENT',
        interval: 'month-end',
        enabled:  true,
        color:    '#6D4C41',
      }));
    }
    const appreciableProps = usProps.filter(p => p.stateKey && ((p.appreciationRate ?? 0) !== 0 || p.appreciationSchedule));
    if (appreciableProps.length > 0) {
      schedules.push(new EventSeries({
        name:     'US Real Property Appreciation',
        type:     US_REAL_PROPERTY_APPRECIATE_TYPE,
        interval: 'annually',
        enabled:  true,
        color:    '#558B2F',
      }));
    }
    return schedules;
  },

  handlers(context) {
    const props = (context.realProperties ?? []).filter(p => p.country === 'US');
    if (props.length === 0) return [];
    const handlers = [new UsHouseSaleHandler()];
    const mortgagedProps = props.filter(p => (p.mortgageBalance ?? 0) > 0 && (p.monthlyMortgage ?? 0) > 0);
    if (mortgagedProps.length > 0) {
      handlers.push(new UsMortgagePaymentHandler({
        properties: mortgagedProps.map(p => ({ stateKey: p.stateKey, monthlyMortgage: p.monthlyMortgage })),
      }));
    }
    const appreciableProps = props.filter(p => p.stateKey && ((p.appreciationRate ?? 0) !== 0 || p.appreciationSchedule));
    const appreciateEvent  = context.schedulesById?.[US_REAL_PROPERTY_APPRECIATE_TYPE];
    if (appreciableProps.length > 0 && appreciateEvent) {
      const handler = new AssetAppreciationHandler({
        assets: appreciableProps.map(p => ({
          stateKey:            p.stateKey,
          appreciationRate:    p.appreciationRate ?? 0,
          appreciationSchedule: p.appreciationSchedule ?? null,
        })),
      });
      handler.handledEvents = [appreciateEvent];
      handlers.push(handler);
    }
    return handlers;
  },

  reducers(context) {
    const props = (context.realProperties ?? []).filter(p => p.country === 'US');
    if (props.length === 0) return [];
    const reducers = [new UsHouseSaleApplyReducer({ accountService: context.accountService })];
    const mortgagedProps = props.filter(p => (p.mortgageBalance ?? 0) > 0 && (p.monthlyMortgage ?? 0) > 0);
    if (mortgagedProps.length > 0) {
      reducers.push(new UsMortgagePaymentApplyReducer({ accountService: context.accountService }));
    }
    return reducers;
  },
};

function _propertyToStatePlain(prop) {
  return {
    kind:                'real-property',
    stateKey:            prop.stateKey,
    value:               prop.value              ?? 0,
    costBasis:           prop.costBasis          ?? 0,
    mortgageBalance:     prop.mortgageBalance    ?? 0,
    monthlyMortgage:     prop.monthlyMortgage    ?? 0,
    appreciationRate:    prop.appreciationRate   ?? 0,
    isPrimaryResidence:  prop.isPrimaryResidence ?? false,
    plannedSaleYear:     prop.plannedSaleYear    ?? null,
    ownershipType:       prop.ownershipType      ?? 'sole',
    ownerId:             prop.ownerId            ?? null,
    country:             prop.country            ?? 'US',
    appreciationSchedule: prop.appreciationSchedule ?? null,
    market:              prop.market             ?? null,
  };
}
