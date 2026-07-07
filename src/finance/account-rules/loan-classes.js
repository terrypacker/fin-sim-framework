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

/**
 * The interest-bearing principal of a loan. In design 54 Phase 1 this is simply
 * the outstanding balance; Phase 3 subtracts the linked offset account balance
 * here (`effPrincipal = max(0, balance − offsetBalanceForLoan(state, loanKey))`).
 */
export function effectivePrincipal(state, _loanKey, loan) {
  // Phase 3 hook: subtract offsetBalanceForLoan(state, _loanKey) once offsets link to loans.
  return Math.max(0, loan.balance ?? 0);
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

  constructor() {
    super(null, 'Loan Payment');
    this.generatedActionTypes = ['REPLENISH_SAVINGS', 'LOAN_PAYMENT_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  static fromJSON(d, _services) {
    const h = new this();
    h.id = d.id;
    return h;
  }

  call({ state }) {
    const actions = [];
    for (const [loanKey, loan] of Object.entries(state)) {
      if (!loan || typeof loan !== 'object' || loan.type !== 'loan') continue;
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
