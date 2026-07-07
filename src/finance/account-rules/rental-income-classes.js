/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { PRIORITY, AccountServiceReducer } from '../../simulation-framework/reducers.js';
import { HandlerEntry }       from '../../simulation-framework/handlers.js';
import { RecordBalanceAction, FieldValueAction } from '../../simulation-framework/actions.js';
import { findLoanForProperty, effectivePrincipal } from './loan-classes.js';

/** Resolve the US / AU cash pools (savings first, checking fallback). */
const usCashKey = (state) => (state.usSavingsAccount != null ? 'usSavingsAccount' : 'checkingAccount');
const auCashKey = (state) => (state.auSavingsAccount != null ? 'auSavingsAccount' : 'checkingAccount');

/** First-person residency flag, mirroring the income handlers. */
const firstResidency = (state) =>
  state.people?.[Object.keys(state.people ?? {})[0]]?.residency ?? null;

/**
 * Rental-income arithmetic for one property-month (design 48 §4).
 *
 * `netCash` is the cash credited to the pool (mortgage P&I is handled by the
 * separate mortgage series — not subtracted here). `taxableRental` is the
 * ordinary-income figure, net of the non-cash depreciation and mortgage-interest
 * wedges; it may be NEGATIVE (a taxable loss that offsets other income).
 *
 * `monthlyRent` is a **base-year nominal** input (like `person.monthlyWage`).
 * It is scaled by `inflationFactor` — the property country's cumulative
 * inflation accumulator (`state.inflationAccumulator[cc]`), which compounds the
 * *effective* (regime-adjusted) inflation rate each year (design 48 §4.6). So
 * rent rises through an inflationary regime and flattens / falls under a
 * deflationary one. Only rent is indexed: `cashOpex` is a ratio of the (already
 * indexed) effective rent; `deductibleInterest` tracks the linked loan's live
 * (offset-reduced) principal; depreciation is on the *historical* `costBasis` and
 * must not inflate.
 *
 * The mortgage-interest deduction reads the linked Loan (design 54 P2) — its
 * effective principal × the loan's rate — not the retired `propState.mortgageBalance`
 * scalar (now always 0). `loan` is null when the property has no mortgage, giving
 * a 0 deduction, identical to the pre-migration zero-balance case.
 *
 * @param {object} p        Per-property rental params from the handler projection
 * @param {object} propState Live property state (reads costBasis)
 * @param {'US'|'AU'} country
 * @param {number} inflationFactor  Cumulative effective-inflation factor (default 1 = no indexing)
 * @param {object|null} loan  Linked loan state entry (findLoanForProperty), or null
 * @param {object} [state]    Full runtime state, for the Phase-3 offset hook in effectivePrincipal
 */
export function computeRentalMonth(p, propState, country, inflationFactor = 1, loan = null, state = null) {
  const monthlyRent   = (p.monthlyRent         ?? 0) * (inflationFactor || 1);
  const occupancy     = p.occupancyRate         ?? 0.95;
  const expenseRatio  = p.rentalExpenseRatio    ?? 0.25;
  const landRatio     = p.landValueRatio        ?? 0.2;
  const override      = p.annualDepreciationOverride ?? null;

  const effectiveRent = monthlyRent * occupancy;
  const cashOpex      = effectiveRent * expenseRatio;
  const netCash       = effectiveRent - cashOpex;

  const loanPrincipal      = loan ? effectivePrincipal(state, loan.stateKey, loan) : 0;
  const deductibleInterest = Math.max(0, loanPrincipal * (loan?.interestRate ?? 0) / 12);

  const buildingBasis = Math.max(0, (propState.costBasis ?? 0) * (1 - landRatio));
  const annualDep     = override != null
    ? override
    : (country === 'US' ? buildingBasis / 27.5 : buildingBasis * 0.025);
  const monthlyDepreciation = annualDep / 12;

  const taxableRental = effectiveRent - cashOpex - deductibleInterest - monthlyDepreciation;
  return { effectiveRent, cashOpex, netCash, deductibleInterest, monthlyDepreciation, taxableRental };
}

// ─── US Rental Income ──────────────────────────────────────────────────────────

/**
 * Handles US_RENTAL_INCOME events. For each enabled US property with a live
 * state entry and positive rent, credits the US cash pool with the net cash rent
 * and chains US_RENTAL_INCOME_TAX with the taxable net (design 48).
 *
 * @param {object} opts
 * @param {Array<object>} opts.properties  Per-property rental param projection.
 */
export class UsRentalIncomeHandler extends HandlerEntry {
  static type        = 'UsRentalIncomeHandler';
  static category    = 'handler';
  static description = 'Credits the US cash pool with net rental cash and chains US_RENTAL_INCOME_TAX (taxable net of interest + depreciation) for each enabled US property.';
  static eventType   = 'US_RENTAL_INCOME';

  constructor({ properties = [] } = {}) {
    super(null, 'US Rental Income');
    this.properties = properties;
    this.generatedActionTypes = ['US_RENTAL_INCOME_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  static fromJSON(d, _services) {
    const h = new this({ properties: d.properties ?? [] });
    h.id = d.id;
    return h;
  }

  call({ state }) {
    const cashKey   = usCashKey(state);
    const residency = firstResidency(state);
    // Index rent to the effective (regime-adjusted) US inflation path.
    const inflationFactor = state.inflationAccumulator?.US ?? 1;
    const actions   = [];
    let anyRent = 0;

    for (const p of this.properties) {
      const propState = state[p.stateKey];
      // Skip when there is no rent, or the property has been sold (value zeroed).
      if (!propState || (propState.value ?? 0) <= 0 || (p.monthlyRent ?? 0) <= 0) continue;
      const loan = findLoanForProperty(state, p.stateKey);
      const m = computeRentalMonth(p, propState, 'US', inflationFactor, loan, state);
      anyRent += m.netCash;
      actions.push({
        type:                'US_RENTAL_INCOME_APPLY',
        stateKey:            p.stateKey,
        netCash:             m.netCash,
        taxableRental:       m.taxableRental,
        monthlyDepreciation: m.monthlyDepreciation,
        cashKey,
        residency,
      });
    }

    if (actions.length > 0) {
      actions.push(new FieldValueAction('us_rental_income', 'US Rental Income', anyRent));
      actions.push(new RecordBalanceAction(`${cashKey}.balance`, cashKey));
    }
    return actions;
  }
}

/**
 * Handles US_RENTAL_INCOME_APPLY: credits the cash pool by netCash, accrues the
 * property's accumulatedDepreciation, and chains US_RENTAL_INCOME_TAX.
 */
export class UsRentalIncomeApplyReducer extends AccountServiceReducer {
  static type        = 'UsRentalIncomeApplyReducer';
  static category    = 'reducer';
  static description = 'Credits the US cash pool with net rental cash, accrues accumulatedDepreciation, and chains US_RENTAL_INCOME_TAX.';
  static actionType  = 'US_RENTAL_INCOME_APPLY';

  constructor({ accountService }) {
    super('US Rental Income Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes   = ['US_RENTAL_INCOME_APPLY'];
    this.generatedActionTypes = ['US_RENTAL_INCOME_TAX'];
  }

  reduce(state, action) {
    const { stateKey, netCash, taxableRental, monthlyDepreciation, cashKey, residency } = action;
    this.accountService.transaction(state[cashKey] ?? state[usCashKey(state)], netCash, null);
    const updates = {};
    const propState = state[stateKey];
    if (propState) {
      updates[stateKey] = {
        ...propState,
        accumulatedDepreciation: (propState.accumulatedDepreciation ?? 0) + (monthlyDepreciation ?? 0),
      };
    }
    return this.newState(state, updates, [
      { type: 'US_RENTAL_INCOME_TAX', amount: taxableRental, residency },
    ]);
  }
}

// ─── AU Rental Income ──────────────────────────────────────────────────────────

export class AuRentalIncomeHandler extends HandlerEntry {
  static type        = 'AuRentalIncomeHandler';
  static category    = 'handler';
  static description = 'Credits the AU cash pool with net rental cash and chains AU_RENTAL_INCOME_TAX (taxable net of interest + depreciation) for each enabled AU property.';
  static eventType   = 'AU_RENTAL_INCOME';

  constructor({ properties = [] } = {}) {
    super(null, 'AU Rental Income');
    this.properties = properties;
    this.generatedActionTypes = ['AU_RENTAL_INCOME_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  static fromJSON(d, _services) {
    const h = new this({ properties: d.properties ?? [] });
    h.id = d.id;
    return h;
  }

  call({ state }) {
    const cashKey   = auCashKey(state);
    const residency = firstResidency(state);
    // Index rent to the effective (regime-adjusted) AU inflation path.
    const inflationFactor = state.inflationAccumulator?.AU ?? 1;
    const actions   = [];
    let anyRent = 0;

    for (const p of this.properties) {
      const propState = state[p.stateKey];
      // Skip when there is no rent, or the property has been sold (value zeroed).
      if (!propState || (propState.value ?? 0) <= 0 || (p.monthlyRent ?? 0) <= 0) continue;
      const loan = findLoanForProperty(state, p.stateKey);
      const m = computeRentalMonth(p, propState, 'AU', inflationFactor, loan, state);
      anyRent += m.netCash;
      actions.push({
        type:                'AU_RENTAL_INCOME_APPLY',
        stateKey:            p.stateKey,
        netCash:             m.netCash,
        taxableRental:       m.taxableRental,
        monthlyDepreciation: m.monthlyDepreciation,
        cashKey,
        residency,
      });
    }

    if (actions.length > 0) {
      actions.push(new FieldValueAction('au_rental_income', 'AU Rental Income', anyRent));
      actions.push(new RecordBalanceAction(`${cashKey}.balance`, cashKey));
    }
    return actions;
  }
}

export class AuRentalIncomeApplyReducer extends AccountServiceReducer {
  static type        = 'AuRentalIncomeApplyReducer';
  static category    = 'reducer';
  static description = 'Credits the AU cash pool with net rental cash, accrues accumulatedDepreciation, and chains AU_RENTAL_INCOME_TAX.';
  static actionType  = 'AU_RENTAL_INCOME_APPLY';

  constructor({ accountService }) {
    super('AU Rental Income Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes   = ['AU_RENTAL_INCOME_APPLY'];
    this.generatedActionTypes = ['AU_RENTAL_INCOME_TAX'];
  }

  reduce(state, action) {
    const { stateKey, netCash, taxableRental, monthlyDepreciation, cashKey, residency } = action;
    this.accountService.transaction(state[cashKey] ?? state[auCashKey(state)], netCash, null);
    const updates = {};
    const propState = state[stateKey];
    if (propState) {
      updates[stateKey] = {
        ...propState,
        accumulatedDepreciation: (propState.accumulatedDepreciation ?? 0) + (monthlyDepreciation ?? 0),
      };
    }
    return this.newState(state, updates, [
      { type: 'AU_RENTAL_INCOME_TAX', amount: taxableRental, residency },
    ]);
  }
}
