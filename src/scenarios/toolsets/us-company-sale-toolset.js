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
import { AssetAppreciationHandler } from '../../finance/handlers/asset-appreciation-handler.js';

const COMPANY_EQUITY_APPRECIATE_TYPE = 'COMPANY_EQUITY_APPRECIATE';

/**
 * US_COMPANY_SALE toolset — wires a CompanyEquity asset (a private/public
 * company stake) into the balance sheet and schedules its liquidity event.
 *
 * Capabilities: company-sale
 * Depends on:
 *   - US_TAX     — COMPANY_SALE_TAX is taxed as a US capital gain (+ AU CGT when resident)
 *   - US_INCOME  — owns CompanySaleHandler (COMPANY_SALE) + CompanySaleApplyReducer
 *                  (COMPANY_SALE_APPLY). This toolset does NOT re-register them.
 *
 * This toolset contributes only:
 *   - state()     — seeds each CompanyEquity's stateKey (kind: 'company') so it
 *                   shows on the balance sheet / net worth before the sale.
 *   - schedules() — a one-off COMPANY_SALE per equity with a plannedSaleYear, plus
 *                   a toolset-private annual COMPANY_EQUITY_APPRECIATE series.
 *   - handlers()  — an AssetAppreciationHandler bound to that series. The shared
 *                   AssetAppreciateReducer (ASSET_APPRECIATE_APPLY) is registered
 *                   centrally by ScenarioCompiler, so there is no reducers() step.
 */
export const US_COMPANY_SALE = {
  id: 'US_COMPANY_SALE',
  capabilities: ['company-sale'],
  dependencies: ['US_TAX', 'US_INCOME'],

  types: {
    handlers: [AssetAppreciationHandler],
    reducers: [],
    actions: [],
  },

  paramSchema(context) {
    return [];
  },

  state(context) {
    const patches = {};
    for (const eq of (context.companyEquities ?? [])) {
      if (eq.stateKey) {
        patches[eq.stateKey] = _companyEquityToStatePlain(eq);
      }
    }
    return patches;
  },

  schedules(context) {
    const schedules = (context.companyEquities ?? [])
      .filter(e => e.plannedSaleYear != null)
      .map(e => new OneOffEvent({
        name:    `Sell ${e.name}`,
        type:    'COMPANY_SALE',
        date:    new Date(Date.UTC(e.plannedSaleYear, 0, 15)),
        data:    { costBasis: e.costBasis, stateKey: e.stateKey, saleDestinationAccount: e.saleDestinationAccount },
        enabled: true,
        color:   '#6A1B9A',
      }));
    const appreciable = (context.companyEquities ?? [])
      .filter(e => e.stateKey && ((e.appreciationRate ?? 0) !== 0 || e.appreciationSchedule));
    if (appreciable.length > 0) {
      schedules.push(new EventSeries({
        name:     'Company Equity Appreciation',
        type:     COMPANY_EQUITY_APPRECIATE_TYPE,
        interval: 'annually',
        enabled:  true,
        color:    '#6A1B9A',
      }));
    }
    return schedules;
  },

  handlers(context) {
    const appreciable = (context.companyEquities ?? [])
      .filter(e => e.stateKey && ((e.appreciationRate ?? 0) !== 0 || e.appreciationSchedule));
    const appreciateEvent = context.schedulesById?.[COMPANY_EQUITY_APPRECIATE_TYPE];
    if (appreciable.length === 0 || !appreciateEvent) return [];
    const handler = new AssetAppreciationHandler({
      assets: appreciable.map(e => ({
        stateKey:             e.stateKey,
        appreciationRate:     e.appreciationRate ?? 0,
        appreciationSchedule: e.appreciationSchedule ?? null,
      })),
    });
    handler.handledEvents = [appreciateEvent];
    return [handler];
  },

  reducers(context) {
    return [];
  },
};

function _companyEquityToStatePlain(eq) {
  return {
    kind:                 'company',
    stateKey:             eq.stateKey,
    value:                eq.value            ?? 0,
    costBasis:            eq.costBasis         ?? 0,
    appreciationRate:     eq.appreciationRate  ?? 0,
    plannedSaleYear:      eq.plannedSaleYear   ?? null,
    ownershipType:        eq.ownershipType     ?? 'sole',
    ownerId:              eq.ownerId           ?? null,
    country:              eq.country           ?? 'US',
    appreciationSchedule: eq.appreciationSchedule ?? null,
    // Per-country cost base + indexation stamps (design 72 §3). Null until the
    // residency step-up writes them; carried on state so the sale reducer can read
    // the AU basis without reaching back into the service.
    costBaseByCountry:        eq.costBaseByCountry        ?? null,
    acquisitionPriceLevel:    eq.acquisitionPriceLevel    ?? null,
    acquisitionDateByCountry: eq.acquisitionDateByCountry ?? null,
  };
}
