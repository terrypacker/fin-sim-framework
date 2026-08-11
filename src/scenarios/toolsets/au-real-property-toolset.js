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
import { AuPropertyPurchaseHandler, PropertyPurchaseApplyReducer,
         propertyNeedsPurchase, PROPERTY_PURCHASE_ORDER } from '../../finance/account-rules/property-purchase.js';
import { EventSeries }             from '../../simulation-framework/events/event-series.js';
import { AuHouseSaleHandler, AuHouseSaleApplyReducer } from '../../finance/account-rules/au/au-real-property-classes.js';
import { SuperDownsizerContributionApplyReducer } from '../../finance/account-rules/au/downsizer-contribution.js';
import { AuLoanPaymentHandler, LoanPaymentApplyReducer, synthesizeLoanForProperty,
         propertyNeedsLoanPayment, accountNeedsLoanPayment } from '../../finance/account-rules/loan-classes.js';
import { AuRentalIncomeHandler, AuRentalIncomeApplyReducer } from '../../finance/account-rules/rental-income-classes.js';
import { AssetAppreciationHandler } from '../../finance/handlers/asset-appreciation-handler.js';
import { ValueType } from '../../simulation-framework/type-registry.js';
import { USD, AUD } from '../../finance/assets/account.js';

const AU_REAL_PROPERTY_APPRECIATE_TYPE = 'AU_REAL_PROPERTY_APPRECIATE';

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

  types: {
    handlers: [AuHouseSaleHandler, AuLoanPaymentHandler, AuRentalIncomeHandler, AssetAppreciationHandler, AuPropertyPurchaseHandler],
    reducers: [AuHouseSaleApplyReducer, SuperDownsizerContributionApplyReducer, LoanPaymentApplyReducer, AuRentalIncomeApplyReducer, PropertyPurchaseApplyReducer],
    actions: [
      // Buying a dwelling mid-run (design 83 §10 follow-on). cc: null — one shared
      // action/reducer for both countries' purchase events, declared by both
      // toolsets because registerActionType is idempotent.
      { type: 'PROPERTY_PURCHASE_APPLY', family: 'REAL_PROPERTY_CASH', cc: null,
        fields: { stateKey: ValueType.text(), price: ValueType.number(), cashDue: ValueType.number() } },
      { type: 'AU_HOUSE_SALE_APPLY', family: 'REAL_PROPERTY_CASH', cc: 'AU',
        fields: { salePrice: ValueType.number(), costBasis: ValueType.number(), stateKey: ValueType.text() } },
      // ITAA97 s292-102 downsizer contribution — a CASH movement into super, not a tax.
      { type: 'SUPER_DOWNSIZER_CONTRIBUTION_APPLY', family: 'REAL_PROPERTY_CASH', cc: 'AU',
        fields: { personKey: ValueType.text(), amount: ValueType.number(), reason: ValueType.text() } },
      // Everything after `description` is the design 83 G7 main-residence working:
      // auTaxableFraction is the s118-185 apportionment, auExemptionReason names the
      // rule that produced it, and the acquisition/sale/occupation dates are the
      // inputs that justify the fraction. Undeclared, a G7 report could show the
      // apportioned gain with no way to explain it. The ownership trio (design 76
      // Gap B) attributes the gain to the owner(s) rather than splitting it 50/50.
      { type: 'AU_HOUSE_SALE_TAX', family: 'CAPITAL_GAINS', cc: 'AU',
        fields: { usShortTermGain: ValueType.number(), usLongTermGain: ValueType.number(), auShortTermGain: ValueType.number(), auLongTermGain: ValueType.number(), gain: ValueType.number(), depreciationGain: ValueType.number(), residency: ValueType.text(), proceeds: ValueType.number(), costBasis: ValueType.number(), description: ValueType.text(),
                  ownershipType: ValueType.text(), ownerId: ValueType.text(), owners: ValueType.any(),
                  auTaxableFraction: ValueType.number(), auExemptionReason: ValueType.text(),
                  acquisitionMs: ValueType.number(), saleMs: ValueType.number(),
                  mainResidenceFrom: ValueType.text(), mainResidenceUntil: ValueType.text(),
                  isPrimaryResidence: ValueType.boolean() } },
      // Country-agnostic loan payment (design 54 P2): one shared action/reducer for
      // US_LOAN_PAYMENT + AU_LOAN_PAYMENT, declared by both real-property toolsets
      // (registerActionType is idempotent). cc: null so it stays in REAL_PROPERTY_CASH
      // regardless of which country's loan it settles.
      { type: 'LOAN_PAYMENT_APPLY', family: 'REAL_PROPERTY_CASH', cc: null,
        fields: { loanKey: ValueType.text(), payment: ValueType.number(), interest: ValueType.number() } },
      // §988 exchange gain/loss on foreign-currency debt (design 86 G7 / P8). Declared
      // by both real-property toolsets alongside LOAN_PAYMENT_APPLY, which emits it;
      // registerActionType is idempotent. cc: null — it is realized on a loan in any
      // country, and its US tax character is decided by the US classifier.
      // `residency` is the §988(a)(3)(B) tax-home test that decides SOURCE, and it must
      // be declared or pickPayload drops it and every gain reverts to US-source.
      { type: 'SECTION_988_GAIN', cc: null,
        fields: { loanKey: ValueType.text(), accountKey: ValueType.text(),
                  currency: ValueType.text(), amount: ValueType.number(),
                  gross: ValueType.number(), disallowedLoss: ValueType.number(), deMinimis: ValueType.number(),
                  residency: ValueType.text() } },
      { type: 'AU_RENTAL_INCOME_APPLY', family: 'REAL_PROPERTY_CASH', cc: 'AU',
        fields: { netCash: ValueType.currency('AUD'), taxableRental: ValueType.number(), monthlyDepreciation: ValueType.number(), stateKey: ValueType.text(), residency: ValueType.text() } },
      { type: 'AU_RENTAL_INCOME_TAX', cc: 'AU',
        fields: { amount: ValueType.number(), residency: ValueType.text() } },
    ],
  },

  paramSchema(context) {
    return [];
  },

  state(context) {
    const patches = {};
    for (const prop of (context.realProperties ?? [])) {
      if (prop.stateKey && prop.country === 'AU') {
        const plain = _propertyToStatePlain(prop, _startYear(context));
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
    const auProps = (context.realProperties ?? []).filter(p => p.country === 'AU');
    const schedules = auProps
      .filter(p => p.plannedSaleYear != null)
      .map(p => new OneOffEvent({
        name:    `Sell ${p.name}`,
        type:    'AU_HOUSE_SALE',
        date:    new Date(Date.UTC(p.plannedSaleYear, 0, 15)),
        data:    { costBasis: p.costBasis, ownershipType: p.ownershipType, ownerId: p.ownerId, owners: p.owners, stateKey: p.stateKey, saleDestinationAccount: p.saleDestinationAccount },
        enabled: true,
        color:   '#5D4037',
      }));
    // A monthly payment event is needed for a mortgage OR for a standalone AU
    // LoanAccount (design 54); the handler pays every `type: 'loan'` state entry in
    // the country, so one event covers both (design 86 G6 UI).
    // Buying a dwelling part-way through the run. `order` puts it AFTER the sale
    // events, which are authored at the default 0 — so selling and buying in the same
    // January settles in the only sequence that works: proceeds land, cheque clears.
    for (const p of auProps.filter(propertyNeedsPurchase)) {
      schedules.push(new OneOffEvent({
        name:    `Buy ${p.name}`,
        type:    'AU_HOUSE_PURCHASE',
        date:    new Date(Date.UTC(p.purchaseYear, 0, 15)),
        order:   PROPERTY_PURCHASE_ORDER,
        data:    { stateKey: p.stateKey, purchaseYear: p.purchaseYear,
                   startYear: new Date(context.startDate ?? Date.UTC(p.purchaseYear, 0, 1)).getUTCFullYear() },
        enabled: true,
        color:   '#6D4C41',
      }));
    }

    const needsLoanPayment = auProps.some(propertyNeedsLoanPayment)
      || (context.accounts ?? []).some(a => accountNeedsLoanPayment(a, 'AU'));
    if (needsLoanPayment) {
      schedules.push(new EventSeries({
        name:     'AU Loan Payment',
        type:     'AU_LOAN_PAYMENT',
        interval: 'month-end',
        enabled:  true,
        color:    '#4E342E',
      }));
    }
    const rentalProps = auProps.filter(p => p.stateKey && p.rentalEnabled && (p.monthlyRent ?? 0) > 0);
    if (rentalProps.length > 0) {
      schedules.push(new EventSeries({
        name:     'AU Rental Income',
        type:     'AU_RENTAL_INCOME',
        interval: 'month-end',
        enabled:  true,
        color:    '#2E7D32',
      }));
    }
    const appreciableProps = auProps.filter(p => p.stateKey && ((p.appreciationRate ?? 0) !== 0 || p.appreciationSchedule));
    if (appreciableProps.length > 0) {
      schedules.push(new EventSeries({
        name:     'AU Real Property Appreciation',
        type:     AU_REAL_PROPERTY_APPRECIATE_TYPE,
        interval: 'annually',
        enabled:  true,
        color:    '#558B2F',
      }));
    }
    return schedules;
  },

  handlers(context) {
    const props = (context.realProperties ?? []).filter(p => p.country === 'AU');
    // A standalone LoanAccount needs the payment handler even with no AU property at
    // all, so the loan gate is evaluated before the no-property early return.
    const needsLoanPayment = props.some(propertyNeedsLoanPayment)
      || (context.accounts ?? []).some(a => accountNeedsLoanPayment(a, 'AU'));
    if (props.length === 0) {
      // Country-filtered so it pays only AU loans; the shared LoanPaymentApplyReducer
      // is registered once by the compiler substrate (design 54 P2).
      return needsLoanPayment ? [new AuLoanPaymentHandler({ stateRegistry: context.stateRegistry })] : [];
    }
    const handlers = [new AuHouseSaleHandler()];
    if (props.some(propertyNeedsPurchase)) {
      handlers.push(new AuPropertyPurchaseHandler({ stateRegistry: context.stateRegistry }));
    }
    if (needsLoanPayment) {
      handlers.push(new AuLoanPaymentHandler({ stateRegistry: context.stateRegistry }));
    }
    const rentalProps = props.filter(p => p.stateKey && p.rentalEnabled && (p.monthlyRent ?? 0) > 0);
    if (rentalProps.length > 0) {
      handlers.push(new AuRentalIncomeHandler({ properties: rentalProps.map(_rentalParams), stateRegistry: context.stateRegistry }));
    }
    const appreciableProps = props.filter(p => p.stateKey && ((p.appreciationRate ?? 0) !== 0 || p.appreciationSchedule));
    const appreciateEvent  = context.schedulesById?.[AU_REAL_PROPERTY_APPRECIATE_TYPE];
    if (appreciableProps.length > 0 && appreciateEvent) {
      const handler = new AssetAppreciationHandler({
        assets: appreciableProps.map(p => ({
          stateKey:            p.stateKey,
          appreciationRate:    p.appreciationRate ?? 0,
          appreciationSchedule: p.appreciationSchedule ?? null,
          // Real-estate sleeve for the stochastic property return path (design 75 §4.2).
          reKey:               'REAL_ESTATE_AU',
        })),
      });
      handler.handledEvents = [appreciateEvent];
      handlers.push(handler);
    }
    return handlers;
  },

  reducers(context) {
    const props = (context.realProperties ?? []).filter(p => p.country === 'AU');
    if (props.length === 0) return [];
    const reducers = [new AuHouseSaleApplyReducer({ accountService: context.accountService, stateRegistry: context.stateRegistry })];
    // Declared cc: null and shared by both countries' purchase events, so it is
    // registered by whichever toolset has a property to buy — and only when there is
    // one, which keeps a plan with no purchase byte-identical.
    if (props.some(propertyNeedsPurchase)) {
      reducers.push(new PropertyPurchaseApplyReducer({ accountService: context.accountService, stateRegistry: context.stateRegistry }));
    }
    if (props.some(p => p.claimDownsizerContribution === true)) {
      reducers.push(new SuperDownsizerContributionApplyReducer({ accountService: context.accountService, stateRegistry: context.stateRegistry }));
    }
    // Loan payments apply via the shared LoanPaymentApplyReducer registered once
    // by the compiler substrate (design 54 P2) — not per toolset, which would
    // double-reduce every LOAN_PAYMENT_APPLY.
    const rentalProps = props.filter(p => p.stateKey && p.rentalEnabled && (p.monthlyRent ?? 0) > 0);
    if (rentalProps.length > 0) {
      reducers.push(new AuRentalIncomeApplyReducer({ accountService: context.accountService, stateRegistry: context.stateRegistry }));
    }
    return reducers;
  },
};

/** The simulation's start year, for deciding whether a purchase is still ahead. */
function _startYear(context) {
  const d = context?.startDate ? new Date(context.startDate) : null;
  return d && !Number.isNaN(d.getTime()) ? d.getUTCFullYear() : null;
}

/**
 * Is this dwelling not yet owned when the run begins? A purchase year at or after the
 * start means the property is bought DURING the run and must project dormant; a
 * purchase year in the past describes a house already owned, whose event would never
 * fire, so it projects at its authored value as before.
 */
function _dormantAtStart(prop, startYear) {
  return prop?.purchaseYear != null && (prop?.purchasePrice ?? 0) > 0
      && (startYear == null || prop.purchaseYear >= startYear);
}

function _propertyToStatePlain(prop, startYear) {
  return {
    kind:                'real-property',
    stateKey:            prop.stateKey,
    value:               _dormantAtStart(prop, startYear) ? 0 : (prop.value              ?? 0),
    costBasis:           prop.costBasis          ?? 0,
    // Design 54 P2: the mortgage now lives on the linked Loan (see state()); the
    // property scalars are zeroed so net worth counts `value` alone and the loan's
    // `−balance` is the sole debt (no double-count, no §7 guard).
    mortgageBalance:     0,
    monthlyMortgage:     0,
    appreciationRate:    prop.appreciationRate   ?? 0,
    // Regular running cost (design 75 §5.1). Default 0 ⇒ inert.
    annualRunningCost:   prop.annualRunningCost   ?? 0,
    runningCostValuePct: prop.runningCostValuePct ?? 0,
    runningCostGrowth:   prop.runningCostGrowth   ?? 0,
    // Stochastic repairs (design 75 §5.2). Default NONE ⇒ inert.
    repairModel:         prop.repairModel         ?? 'NONE',
    repairProb:          prop.repairProb          ?? 0,
    repairLambda:        prop.repairLambda        ?? 0,
    repairMedian:        prop.repairMedian         ?? 0,
    repairSigma:         prop.repairSigma         ?? 0.6,
    repairValuePct:      prop.repairValuePct      ?? 0,
    capitalizeRepairs:   prop.capitalizeRepairs   ?? 0,
    capitalizedImprovements: prop.capitalizedImprovements ?? 0,
    isPrimaryResidence:  prop.isPrimaryResidence ?? false,
    // Main-residence history (design 83 G7). The sale reducers read the runtime STATE
    // entry, not the record, so a field missing here makes an authored history invisible
    // and silently reverts the dwelling to the boolean's coarse answer.
    // A dwelling with a FUTURE purchase year projects at value 0 — dormant. Forced
    // here rather than trusted to the author: a record that states both a purchase
    // year and a starting value would otherwise be counted in net worth for years
    // before it was bought AND bought again later, which reads as a windfall rather
    // than as the authoring slip it is.
    mainResidenceFrom:   prop.mainResidenceFrom  ?? null,
    mainResidenceUntil:  prop.mainResidenceUntil ?? null,
    acquisitionDate:     prop.acquisitionDate    ?? null,
    purchaseYear:        prop.purchaseYear       ?? null,
    purchasePrice:       prop.purchasePrice      ?? null,
    purchaseFundFrom:    prop.purchaseFundFrom   ?? null,
    purchasePriceIsNominal: prop.purchasePriceIsNominal ?? false,
    claimDownsizerContribution: prop.claimDownsizerContribution ?? false,
    plannedSaleYear:     prop.plannedSaleYear    ?? null,
    ownershipType:       prop.ownershipType      ?? 'sole',
    ownerId:             prop.ownerId            ?? null,
    // Design 76 Gap A: carry the explicit per-person breakdown too — it is the
    // FIRST branch of ownershipFractions and outranks sole/joint. Dropping it left
    // design 73's rental attribution (which reads owners off propState) unable to
    // see anything but the coarse sole/joint split.
    owners:              prop.owners             ?? [],
    country:             prop.country            ?? 'AU',
    // Tag the FX currency so net-worth / net-liquidity / spending guardrails
    // convert an AUD-denominated property instead of counting it 1:1 as USD.
    currency:            prop.currency           ?? (prop.country === 'US' ? USD : AUD),
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
    // Design 88 — see the US sibling. Projected only when TRUE (D2 byte-identity).
    ...(prop.speculative === true ? { speculative: true } : {}),
  };
}
