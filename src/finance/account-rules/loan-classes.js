/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY } from '../../simulation-framework/reducers.js';
import { HandlerEntry }      from '../../simulation-framework/handlers.js';
import { RecordBalanceAction, FieldValueAction } from '../../simulation-framework/actions.js';

/** Deterministic state key for the loan synthesized from a property's mortgage (design 54 P2). */
export function loanKeyForProperty(propStateKey) {
  return `${propStateKey}Loan`;
}

/**
 * The loan financing a given property, or null. Prefers the deterministic
 * `${propKey}Loan` slot, then falls back to scanning for any loan whose
 * `linkedPropertyKey` matches (design 54 P2).
 */
export function findLoanForProperty(state, propStateKey) {
  const direct = state[loanKeyForProperty(propStateKey)];
  if (direct && direct.type === 'loan') return direct;
  for (const v of Object.values(state)) {
    if (v && typeof v === 'object' && v.type === 'loan' && v.linkedPropertyKey === propStateKey) return v;
  }
  return null;
}

/**
 * Build the plain loan state entry that replaces a property's scalar mortgage
 * (design 54 P2). Returns null when the property has no mortgage.
 */
export function synthesizeLoanForProperty(prop) {
  const balance = prop.mortgageBalance ?? 0;
  if (balance <= 0) return null;
  return {
    type:              'loan',
    kind:              'account',
    stateKey:          loanKeyForProperty(prop.stateKey),
    balance,
    interestRate:      prop.mortgageInterestRate ?? 0,
    monthlyPayment:    prop.monthlyMortgage      ?? 0,
    linkedPropertyKey: prop.stateKey,
    country:           prop.country ?? 'US',
    currency:          prop.currency ?? null,
    minimumBalance:    0,
    drawdownPriority:  null,
    holdings:          [],
  };
}

/**
 * Resolve the cash pool a loan's payment is drawn from: an explicit
 * `paymentSourceKey`, else the loan country's savings pool (checking fallback).
 */
function resolveCashKey(state, loan) {
  if (loan.paymentSourceKey && state[loan.paymentSourceKey]) return loan.paymentSourceKey;
  if (loan.country === 'AU') return state.auSavingsAccount != null ? 'auSavingsAccount' : 'checkingAccount';
  return state.usSavingsAccount != null ? 'usSavingsAccount' : 'checkingAccount';
}

/** Currency code of an account/loan state entry ('USD'/'AUD'), tolerant of shape. */
function currencyCode(entry) {
  return entry?.currency?.code ?? entry?.currency ?? null;
}

/**
 * Σ balances of the offset accounts that reduce a given loan's interest-bearing
 * principal (design 53 §3 / 54 P3). An `OffsetAccount` links to a *property*
 * (`offsetsPropertyKey`); a loan links to the same property (`linkedPropertyKey`),
 * so the join is property-keyed. Only same-currency offsets count — an offset and
 * its linked loan share a currency by construction, and the guard stops a
 * misconfigured cross-currency offset from wrongly suppressing principal 1:1
 * (ignoring FX). Multiple offsets on one property sum; the caller clamps at the
 * loan balance.
 *
 * @param {object} state
 * @param {object} loan   The loan state entry (reads linkedPropertyKey + currency)
 * @returns {number} total offsetting cash (>= 0)
 */
export function offsetBalanceForLoan(state, loan) {
  const propKey = loan?.linkedPropertyKey;
  if (!propKey || !state) return 0;
  const loanCcy = currencyCode(loan);
  let total = 0;
  for (const v of Object.values(state)) {
    if (v && typeof v === 'object' && v.type === 'offset'
        && v.offsetsPropertyKey === propKey
        && (loanCcy == null || currencyCode(v) === loanCcy)) {
      total += Math.max(0, v.balance ?? 0);
    }
  }
  return total;
}

/**
 * The interest-bearing principal of a loan: outstanding balance less the linked
 * offset accounts' cash (design 53 §3 / 54 P3), clamped at 0. Read by BOTH the
 * rental deductible-interest line (`computeRentalMonth`) and the monthly
 * `LOAN_PAYMENT` interest accrual, so an offset lowers interest on rental *and*
 * owner-occupied loans and speeds owner-occupied payoff.
 */
export function effectivePrincipal(state, _loanKey, loan) {
  const offset = offsetBalanceForLoan(state, loan);
  return Math.max(0, (loan.balance ?? 0) - offset);
}

/**
 * Handles LOAN_PAYMENT events (design 54 §4). For each liability account with a
 * positive balance, accrues one month of interest on the effective (offset-reduced)
 * principal, computes the fixed payment (capped so the last payment never overpays
 * past payoff), replenishes the cash pool if the payment would breach its minimum,
 * flags negative amortization (payment < interest), and dispatches LOAN_PAYMENT_APPLY.
 */
export class LoanPaymentHandler extends HandlerEntry {
  static type        = 'LoanPaymentHandler';
  static category    = 'handler';
  static description = 'For each loan with a positive balance: accrues monthly interest, dispatches REPLENISH_SAVINGS (if needed) then LOAN_PAYMENT_APPLY, and flags negative amortization when the payment is below the accrued interest.';
  static eventType   = 'LOAN_PAYMENT';

  /**
   * @param {object} [opts]
   * @param {string|null} [opts.country=null] - ISO country code; when set, only loans
   *   whose `country` matches are paid. Null pays every loan (P1 behavior). Per-country
   *   filtering lets the US and AU real-property toolsets each schedule their own
   *   `US_LOAN_PAYMENT` / `AU_LOAN_PAYMENT` event without double-paying (design 54 P2).
   */
  constructor({ country = null } = {}) {
    super(null, 'Loan Payment');
    this.country = country;
    this.generatedActionTypes = ['REPLENISH_SAVINGS', 'LOAN_PAYMENT_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  static fromJSON(d, _services) {
    const h = new this({ country: d.country ?? null });
    h.id = d.id;
    return h;
  }

  call({ state }) {
    const actions = [];
    for (const [loanKey, loan] of Object.entries(state)) {
      if (!loan || typeof loan !== 'object' || loan.type !== 'loan') continue;
      if (this.country && loan.country !== this.country) continue;
      const balance = loan.balance ?? 0;
      if (balance <= 0) continue;

      const cashKey   = resolveCashKey(state, loan);
      const interest  = Math.max(0, effectivePrincipal(state, loanKey, loan) * (loan.interestRate ?? 0) / 12);
      // Never pay past payoff: cap at the balance plus this month's interest.
      const payment   = Math.min(loan.monthlyPayment ?? 0, balance + interest);
      if (payment <= 0) continue;

      const cash      = state[cashKey];
      const deficit   = (cash?.minimumBalance ?? 0) - ((cash?.balance ?? 0) - payment);
      if (deficit > 0) actions.push({ type: 'REPLENISH_SAVINGS', deficit, targetKey: cashKey });

      // Negative amortization: a payment below the accrued interest grows the balance.
      // Not clamped (a real interest-only / underwater loan); flagged so the UI can
      // surface it rather than reading as a silent bug (design 54 §4).
      const principalPart = payment - interest;
      if (principalPart < 0) {
        actions.push(new FieldValueAction('loan_negative_amortization', 'Loan Negative Amortization', -principalPart));
      }

      actions.push({ type: 'LOAN_PAYMENT_APPLY', loanKey, cashKey, payment, interest });
      actions.push(new RecordBalanceAction(`${loanKey}.balance`, loanKey));
    }
    return actions;
  }
}

/**
 * US-scoped LoanPaymentHandler (design 54 P2). Fires on `US_LOAN_PAYMENT` and pays
 * only US loans, so the US real-property toolset can schedule loan payments without
 * touching AU loans. Shares the base scan/amortization and `LoanPaymentApplyReducer`.
 */
export class UsLoanPaymentHandler extends LoanPaymentHandler {
  static type        = 'UsLoanPaymentHandler';
  static category    = 'handler';
  static description = 'Pays US loans (design 54 P2): the shared LoanPaymentHandler scan filtered to country === US, fired by US_LOAN_PAYMENT.';
  static eventType   = 'US_LOAN_PAYMENT';

  constructor() {
    super({ country: 'US' });
    this.name = 'US Loan Payment';
  }
}

/**
 * AU-scoped LoanPaymentHandler (design 54 P2). Mirrors {@link UsLoanPaymentHandler}
 * for AU loans; fires on `AU_LOAN_PAYMENT`.
 */
export class AuLoanPaymentHandler extends LoanPaymentHandler {
  static type        = 'AuLoanPaymentHandler';
  static category    = 'handler';
  static description = 'Pays AU loans (design 54 P2): the shared LoanPaymentHandler scan filtered to country === AU, fired by AU_LOAN_PAYMENT.';
  static eventType   = 'AU_LOAN_PAYMENT';

  constructor() {
    super({ country: 'AU' });
    this.name = 'AU Loan Payment';
  }
}

/**
 * Handles LOAN_PAYMENT_APPLY (design 54 §4). Debits the cash pool by the payment
 * (capped to available balance so cash never goes negative) and reduces the loan
 * balance by the principal portion (payment − interest). A payment below interest
 * yields a negative principal portion, so the balance grows (negative amortization).
 */
export class LoanPaymentApplyReducer extends Reducer {
  static type        = 'LoanPaymentApplyReducer';
  static category    = 'reducer';
  static description = 'Debits the cash pool (capped to available balance) and reduces the loan balance by the principal portion (payment − interest); a payment below interest grows the balance.';
  static actionType  = 'LOAN_PAYMENT_APPLY';

  constructor({ accountService }) {
    super('Loan Payment Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.reducedActionTypes   = ['LOAN_PAYMENT_APPLY'];
    this.generatedActionTypes = [];
  }

  static fromJSON(d, services) {
    const r = new this({ accountService: services?.accountService });
    r.id = d.id;
    return r;
  }

  reduce(state, action) {
    const { loanKey, cashKey, payment, interest } = action;
    const loan = state[loanKey];
    const cash = state[cashKey];

    const actualPay = Math.min(payment, Math.max(0, cash?.balance ?? 0));
    if (actualPay > 0 && cash) this.accountService.transaction(cash, -actualPay, null);

    // Principal reduction = paid − accrued interest. Negative ⇒ balance grows
    // (negative amortization). Clamp only at payoff (0), never at growth.
    const principalPart = actualPay - interest;
    const newBalance    = Math.max(0, (loan?.balance ?? 0) - principalPart);

    return this.newState(state, {
      [loanKey]: { ...loan, balance: +newBalance.toFixed(2) },
    }, []);
  }
}
