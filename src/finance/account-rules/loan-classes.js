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
import { resolveCashKey } from './cash-routing.js';
import { fxRate }         from '../fx/fx-conversion.js';
import { PRIME_KEY_BY_COUNTRY } from '../economic-regimes/rate-keys.js';

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
    // Prime-relative loan rate (design 56 Phase 3): when the mortgage carries a
    // `mortgagePrimeSpread`, the loan tracks `Prime(country,t) + spread` (resolveLoanRate);
    // null keeps the fixed absolute `interestRate` (back-compat).
    primeSpread:       prop.mortgagePrimeSpread ?? null,
    monthlyPayment:    prop.monthlyMortgage      ?? 0,
    // Interest-only mortgage (design 86 G2). Absent ⇒ false ⇒ the P&I path, byte-for-byte.
    interestOnly:      prop.mortgageInterestOnly ?? false,
    deductibleFraction: prop.mortgageDeductibleFraction ?? null,
    // Loan term (design 86 G6). Absolute calendar years, like plannedSaleYear /
    // moveYear elsewhere — a real offset loan has an IO period of ~5 years and a
    // 25–30 year term, and both are dates the borrower knows, not durations.
    interestOnlyUntilYear: prop.mortgageInterestOnlyUntilYear ?? null,
    maturityYear:          prop.mortgageMaturityYear          ?? null,
    linkedPropertyKey: prop.stateKey,
    country:           prop.country ?? 'US',
    currency:          prop.currency ?? null,
    minimumBalance:    0,
    drawdownPriority:  null,
    holdings:          [],
  };
}

/**
 * The calendar year of the loan country's current tax period, or null when the state
 * carries no period (synthetic states in unit tests). `PERIOD_ADVANCE` actions have no
 * usable date at runtime, so the period's `startMs` is the reliable clock here.
 */
function periodYear(state, country) {
  const ms = state?.currentPeriods?.[country === 'AU' ? 'AU' : 'US']?.startMs;
  return ms != null ? new Date(ms).getUTCFullYear() : null;
}

/** Currency code of an account/loan state entry ('USD'/'AUD'), tolerant of shape. */
function currencyCode(entry) {
  return entry?.currency?.code ?? entry?.currency ?? null;
}

/**
 * The state key of a same-currency offset account linked to this loan's property
 * (design 54 P4), or null. An offset links to a *property* (`offsetsPropertyKey`)
 * and the loan links to the same property (`linkedPropertyKey`), so the join is
 * property-keyed — mirroring {@link offsetBalanceForLoan}. The same-currency guard
 * keeps a misconfigured cross-currency offset from being drained 1:1 (ignoring FX);
 * such an offset falls through to the normal cash pool. Returns the first match.
 */
function resolveLinkedOffsetKey(state, loan) {
  const propKey = loan?.linkedPropertyKey;
  if (!propKey || !state) return null;
  const loanCcy = currencyCode(loan);
  for (const [k, v] of Object.entries(state)) {
    if (v && typeof v === 'object' && v.type === 'offset'
        && v.offsetsPropertyKey === propKey
        && (loanCcy == null || currencyCode(v) === loanCcy)) {
      return k;
    }
  }
  return null;
}

/**
 * Resolve the cash pool a loan's payment is drawn from (design 54 P4). Precedence:
 *   1. an explicit `paymentSourceKey` (a user override) — wins over everything;
 *   2. a same-currency **offset** linked to the loan's property — an AU offset is the
 *      everyday account the mortgage direct-debits, so paying from it is the default
 *      when one exists (paying the P&I from the offset depletes it, which raises the
 *      effective principal next period — realistic, and the whole point of the link);
 *   3. otherwise the shared cash resolver so a flagged transaction account is honored
 *      (design 55 Phase 6b), falling back to the loan country's savings pool then checking.
 */
function resolveLoanCashKey(stateRegistry, state, loan) {
  if (loan.paymentSourceKey && state[loan.paymentSourceKey]) return loan.paymentSourceKey;
  const offsetKey = resolveLinkedOffsetKey(state, loan);
  if (offsetKey) return offsetKey;
  return resolveCashKey(stateRegistry, loan.country === 'AU' ? 'AU' : 'US', state);
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
 * The loan's effective annual interest rate (design 56 Phase 3). A Prime-linked loan
 * (non-null `primeSpread`) tracks `Prime(country,t) + primeSpread`, read live from
 * `state.effectiveInterestRates[PRIME_{country}]` — so a variable-rate mortgage moves
 * with the central bank period-by-period (time-varying Prime comes free from Phase 2b,
 * which keeps `PRIME_*` current in the effective map). Absent a spread (or a missing
 * Prime series) it falls back to the fixed absolute `interestRate`, so a spread-less
 * loan is byte-for-byte the pre-56 fixed loan.
 */
export function resolveLoanRate(state, loan) {
  const primeKey = PRIME_KEY_BY_COUNTRY[loan?.country] ?? PRIME_KEY_BY_COUNTRY.US;
  const prime    = state?.effectiveInterestRates?.[primeKey];
  if (loan?.primeSpread != null && prime != null) return prime + loan.primeSpread;
  return loan?.interestRate ?? 0;
}

/**
 * The scheduled monthly payment for a loan, at this point in its life (design 86 G6).
 *
 * Real offset loans are not interest-only forever. A lender grants an IO period —
 * typically five years — after which the loan **reverts to P&I amortised over the
 * REMAINING term**, which is a payment step-up precisely when a "hold the leverage
 * into later life" plan is relying on the low payment. A plan that assumes indefinite
 * interest-only has assumed away the main risk of the strategy, so the reversion has
 * to be expressible.
 *
 * Precedence, given the current year:
 *   1. **past maturity** — the whole balance plus this month's interest, so the loan
 *      is discharged. Funding it is the cash pool's problem, and a shortfall runs
 *      through the existing replenish/insufficient-funds path rather than a new one.
 *   2. **inside the IO period** (or `interestOnly` with no term) — exactly the
 *      accrued interest; the balance is flat by construction.
 *   3. **after IO expiry, with a maturity year** — the amortising payment over the
 *      months remaining, recomputed each month at the live rate. Recomputing is
 *      deliberate: a variable-rate P&I loan really is re-amortised when the rate
 *      moves, so this tracks Prime the way the IO payment does.
 *   4. **otherwise** — the authored fixed `monthlyPayment`, capped at payoff. This is
 *      the pre-86 path and every term-less loan takes it, byte-for-byte.
 *
 * @param {object} loan      loan state entry
 * @param {number} balance   outstanding principal (loan currency)
 * @param {number} interest  interest accrued this month on the EFFECTIVE principal
 * @param {number} rate      the loan's live annual rate
 * @param {?number} year     current calendar year, or null when unknown
 */
export function scheduledLoanPayment(loan, balance, interest, rate, year) {
  const { interestOnlyUntilYear = null, maturityYear = null } = loan ?? {};

  if (year != null && maturityYear != null && year >= maturityYear) {
    return balance + interest;
  }

  const inIoWindow = loan?.interestOnly
    && (interestOnlyUntilYear == null || year == null || year < interestOnlyUntilYear);
  if (inIoWindow) return interest;

  // Reverted from IO to P&I: amortise what is left over the months that remain.
  if (loan?.interestOnly && maturityYear != null && year != null) {
    const monthsLeft = Math.max(1, (maturityYear - year) * 12);
    const i = rate / 12;
    const payment = i > 0
      ? balance * i / (1 - Math.pow(1 + i, -monthsLeft))
      : balance / monthsLeft;
    return Math.min(payment, balance + interest);
  }

  return Math.min(loan?.monthlyPayment ?? 0, balance + interest);
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
  constructor({ country = null, stateRegistry = null } = {}) {
    super(null, 'Loan Payment');
    this.country = country;
    this.stateRegistry = stateRegistry;
    this.generatedActionTypes = ['REPLENISH_SAVINGS', 'LOAN_PAYMENT_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE'];
  }

  static fromJSON(d, services) {
    const h = new this({ country: d.country ?? null, stateRegistry: services?.stateRegistry });
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

      const cashKey   = resolveLoanCashKey(this.stateRegistry, state, loan);
      const cash      = state[cashKey];
      const interest  = Math.max(0, effectivePrincipal(state, loanKey, loan) * resolveLoanRate(state, loan) / 12);
      // The scheduled payment for this point in the loan's life (design 86 G2 + G6):
      // interest-only inside the IO window, re-amortised P&I after it expires, the
      // whole balance at maturity, and the authored fixed payment for a term-less
      // loan. A FULLY offset IO loan accrues nothing and therefore costs nothing —
      // payment 0 falls through the guard below, which is the correct cash flow, not
      // a skipped payment. All loan-side figures are in the LOAN's currency.
      const year      = periodYear(state, loan.country);
      const payment   = scheduledLoanPayment(loan, balance, interest, resolveLoanRate(state, loan), year);
      if (payment <= 0) continue;

      // FX (design 54 P4): the payment is denominated in the loan's currency, but the
      // debit lands in the cash account's currency. When they differ, convert — an
      // A$2,000 mortgage paid from a USD account draws payment ÷ (AUD-per-USD), not 1:1.
      // Both currencies must be known to convert; a missing code means legacy 1:1.
      const loanCcy = currencyCode(loan);
      const cashCcy = currencyCode(cash);
      const fx      = (loanCcy && cashCcy)
        ? fxRate(loanCcy, cashCcy, state.effectiveExchangeRates?.USD_AUD ?? 1.55)
        : 1;
      const cashDue = payment * fx; // what leaves the cash pool, in cash currency

      const deficit   = (cash?.minimumBalance ?? 0) - ((cash?.balance ?? 0) - cashDue);
      if (deficit > 0) actions.push({ type: 'REPLENISH_SAVINGS', deficit, targetKey: cashKey });

      // Negative amortization: a payment below the accrued interest grows the balance.
      // Not clamped (a real interest-only / underwater loan); flagged so the UI can
      // surface it rather than reading as a silent bug (design 54 §4). Loan currency.
      const principalPart = payment - interest;
      if (principalPart < 0) {
        actions.push(new FieldValueAction('loan_negative_amortization', 'Loan Negative Amortization', -principalPart));
      }

      actions.push({ type: 'LOAN_PAYMENT_APPLY', loanKey, cashKey, payment, interest, cashDue, fx });
      actions.push(new RecordBalanceAction(`${loanKey}.balance`, loanKey));
      // Snapshot the debited cash pool too (design 54 P4): the payment mutates its
      // balance, and its charted `metrics.<cashKey>` series only updates when a
      // RECORD_BALANCE is emitted. A savings pool gets snapshotted by its own monthly
      // events (interest/wages/expenses), but a linked OFFSET has no other event
      // touching it once it's the payment source — without this its metric freezes
      // while state.<cashKey>.balance correctly drops. (BalanceSnapshotReducer runs at
      // PRIORITY.METRICS, reading the post-debit/post-replenish balance.)
      actions.push(new RecordBalanceAction(`${cashKey}.balance`, cashKey));
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

  constructor({ stateRegistry = null } = {}) {
    super({ country: 'US', stateRegistry });
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

  constructor({ stateRegistry = null } = {}) {
    super({ country: 'AU', stateRegistry });
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

    // `cashDue`/`fx` are the cash-currency debit and the loan→cash rate (design 54 P4);
    // absent on legacy actions ⇒ same-currency 1:1 (byte-for-byte with the old path).
    const cashDue = action.cashDue ?? payment;
    const fx      = action.fx || 1;

    // The debit happens in the CASH account's currency, capped to its balance.
    const actualCash = Math.min(cashDue, Math.max(0, cash?.balance ?? 0));
    if (actualCash > 0 && cash) this.accountService.transaction(cash, -actualCash, null);

    // Value delivered to the loan, converted back into the LOAN's currency. When the
    // cash pool can't cover the full payment, only the funded portion pays down debt.
    const deliveredLoanCcy = actualCash / fx;

    // Principal reduction = delivered − accrued interest. Negative ⇒ balance grows
    // (negative amortization). Clamp only at payoff (0), never at growth.
    const principalPart = deliveredLoanCcy - interest;
    const newBalance    = Math.max(0, (loan?.balance ?? 0) - principalPart);

    return this.newState(state, {
      [loanKey]: { ...loan, balance: +newBalance.toFixed(2) },
    }, []);
  }
}
