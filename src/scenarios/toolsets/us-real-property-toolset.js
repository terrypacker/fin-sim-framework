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
import { UsLoanPaymentHandler, LoanPaymentApplyReducer, synthesizeLoanForProperty } from '../../finance/account-rules/loan-classes.js';
import { UsRentalIncomeHandler, UsRentalIncomeApplyReducer } from '../../finance/account-rules/rental-income-classes.js';
import { AssetAppreciationHandler } from '../../finance/handlers/asset-appreciation-handler.js';
import { ValueType } from '../../simulation-framework/type-registry.js';
import { USD, AUD } from '../../finance/assets/account.js';

const US_REAL_PROPERTY_APPRECIATE_TYPE = 'US_REAL_PROPERTY_APPRECIATE';

/** Per-property rental param projection consumed by the rental handler. */
const _rentalParams = (p) => ({
  stateKey:                   p.stateKey,
  monthlyRent:                p.monthlyRent                ?? 0,
  occupancyRate:              p.occupancyRate              ?? 0.95,
  rentalExpenseRatio:         p.rentalExpenseRatio         ?? 0.25,
  mortgageInterestRate:       p.mortgageInterestRate       ?? 0,
  landValueRatio:             p.landValueRatio             ?? 0.2,
  annualDepreciationOverride: p.annualDepreciationOverride ?? null,
});

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
    handlers: [UsHouseSaleHandler, UsLoanPaymentHandler, UsRentalIncomeHandler, AssetAppreciationHandler],
    reducers: [UsHouseSaleApplyReducer, LoanPaymentApplyReducer, UsRentalIncomeApplyReducer],
    actions: [
      { type: 'US_HOUSE_SALE_APPLY', family: 'REAL_PROPERTY_CASH', cc: 'US',
        fields: { salePrice: ValueType.number(), costBasis: ValueType.number(), stateKey: ValueType.text() } },
      { type: 'US_HOUSE_SALE_TAX', family: 'CAPITAL_GAINS', cc: 'US',
        fields: { gain: ValueType.number(), proceeds: ValueType.number(), costBasis: ValueType.number(), description: ValueType.text() } },
      // Country-agnostic loan payment (design 54 P2): one shared action/reducer for
      // US_LOAN_PAYMENT + AU_LOAN_PAYMENT, declared by both real-property toolsets
      // (registerActionType is idempotent). cc: null so it stays in REAL_PROPERTY_CASH
      // regardless of which country's loan it settles.
      { type: 'LOAN_PAYMENT_APPLY', family: 'REAL_PROPERTY_CASH', cc: null,
        fields: { loanKey: ValueType.text(), payment: ValueType.number(), interest: ValueType.number() } },
      { type: 'US_RENTAL_INCOME_APPLY', family: 'REAL_PROPERTY_CASH', cc: 'US',
        fields: { netCash: ValueType.currency('USD'), taxableRental: ValueType.number(), monthlyDepreciation: ValueType.number(), stateKey: ValueType.text(), residency: ValueType.text() } },
      { type: 'US_RENTAL_INCOME_TAX', cc: 'US',
        fields: { amount: ValueType.number(), residency: ValueType.text() } },
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
        const plain = _propertyToStatePlain(prop);
        patches[prop.stateKey] = plain;
        // Design 54 P2: the mortgage is a linked Loan liability, not a property
        // scalar. Synthesize it as a plain `type: 'loan'` state entry and stamp
        // the property's currency so net worth (value − 0) + loan (−balance)
        // equals the pre-migration equity (value − mortgageBalance) exactly.
        const loan = synthesizeLoanForProperty(prop);
        if (loan) {
          loan.currency = plain.currency;
          loan.name     = `${prop.name ?? prop.stateKey} Loan`;
          patches[loan.stateKey] = loan;
        }
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
        name:     'US Loan Payment',
        type:     'US_LOAN_PAYMENT',
        interval: 'month-end',
        enabled:  true,
        color:    '#6D4C41',
      }));
    }
    const rentalProps = usProps.filter(p => p.stateKey && p.rentalEnabled && (p.monthlyRent ?? 0) > 0);
    if (rentalProps.length > 0) {
      schedules.push(new EventSeries({
        name:     'US Rental Income',
        type:     'US_RENTAL_INCOME',
        interval: 'month-end',
        enabled:  true,
        color:    '#2E7D32',
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
      // Country-filtered so it pays only US loans; the shared LoanPaymentApplyReducer
      // is registered once by the compiler substrate (design 54 P2).
      handlers.push(new UsLoanPaymentHandler({ stateRegistry: context.stateRegistry }));
    }
    const rentalProps = props.filter(p => p.stateKey && p.rentalEnabled && (p.monthlyRent ?? 0) > 0);
    if (rentalProps.length > 0) {
      handlers.push(new UsRentalIncomeHandler({ properties: rentalProps.map(_rentalParams), stateRegistry: context.stateRegistry }));
    }
    const appreciableProps = props.filter(p => p.stateKey && ((p.appreciationRate ?? 0) !== 0 || p.appreciationSchedule));
    const appreciateEvent  = context.schedulesById?.[US_REAL_PROPERTY_APPRECIATE_TYPE];
    if (appreciableProps.length > 0 && appreciateEvent) {
      const handler = new AssetAppreciationHandler({
        assets: appreciableProps.map(p => ({
          stateKey:            p.stateKey,
          appreciationRate:    p.appreciationRate ?? 0,
          appreciationSchedule: p.appreciationSchedule ?? null,
          // Real-estate sleeve for the stochastic property return path (design 75 §4.2).
          reKey:               'REAL_ESTATE_US',
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
    const reducers = [new UsHouseSaleApplyReducer({ accountService: context.accountService, stateRegistry: context.stateRegistry })];
    // Loan payments apply via the shared LoanPaymentApplyReducer registered once
    // by the compiler substrate (design 54 P2) — not per toolset, which would
    // double-reduce every LOAN_PAYMENT_APPLY.
    const rentalProps = props.filter(p => p.stateKey && p.rentalEnabled && (p.monthlyRent ?? 0) > 0);
    if (rentalProps.length > 0) {
      reducers.push(new UsRentalIncomeApplyReducer({ accountService: context.accountService, stateRegistry: context.stateRegistry }));
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
    // Design 54 P2: the mortgage now lives on the linked Loan (see state()); the
    // property scalars are zeroed so net worth counts `value` alone and the loan's
    // `−balance` is the sole debt (no double-count, no §7 guard).
    mortgageBalance:     0,
    monthlyMortgage:     0,
    appreciationRate:    prop.appreciationRate   ?? 0,
    isPrimaryResidence:  prop.isPrimaryResidence ?? false,
    plannedSaleYear:     prop.plannedSaleYear    ?? null,
    ownershipType:       prop.ownershipType      ?? 'sole',
    ownerId:             prop.ownerId            ?? null,
    country:             prop.country            ?? 'US',
    // Tag the FX currency so net-worth / net-liquidity / spending guardrails
    // convert a non-USD property instead of counting it 1:1 as USD.
    currency:            prop.currency           ?? (prop.country === 'AU' ? AUD : USD),
    appreciationSchedule: prop.appreciationSchedule ?? null,
    market:              prop.market             ?? null,
    // Rental income (design 48)
    rentalEnabled:              prop.rentalEnabled              ?? false,
    monthlyRent:                prop.monthlyRent                ?? 0,
    occupancyRate:              prop.occupancyRate              ?? 0.95,
    rentalExpenseRatio:         prop.rentalExpenseRatio         ?? 0.25,
    mortgageInterestRate:       prop.mortgageInterestRate       ?? 0,
    landValueRatio:             prop.landValueRatio             ?? 0.2,
    annualDepreciationOverride: prop.annualDepreciationOverride ?? null,
    accumulatedDepreciation:    prop.accumulatedDepreciation    ?? 0,
    // Cross-border CGT step-up (design 62 §5): stamped at the AU move by
    // RealPropertyService.recordResidencyChange (foreign/non-TAP property only),
    // read by US_HOUSE_SALE_APPLY to measure the AU gain + main-residence exemption.
    costBaseByCountry:          prop.costBaseByCountry          ?? null,
    acquisitionPriceLevel:      prop.acquisitionPriceLevel      ?? null,
    acquisitionDateByCountry:   prop.acquisitionDateByCountry   ?? null,
  };
}
