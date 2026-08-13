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
// Design 87: the currency leg. This is a deliberate two-module cycle — currency-basis
// delegates the shared §988 arithmetic back here so there is ONE implementation of it
// rather than two that drift. Safe because everything crossing the boundary in both
// directions is a hoisted `export function`, evaluated only at call time, never during
// module initialization. Do not add a top-level `const` that reads across it.
import { realizeCurrencyDisposition } from './currency-basis.js';

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
    // The principal the post-IO P&I payment amortises from — see scheduledLoanPayment.
    // Defaulted to the authored balance because an IO loan does not amortise inside its
    // window, so its balance at IO expiry IS its balance now. Only meaningful for an IO
    // loan; null on a P&I mortgage keeps that path byte-for-byte.
    postIoPrincipal:       (prop.mortgageInterestOnly ?? false)
      ? (prop.mortgagePostIoPrincipal ?? balance) : null,
    // §988 booking rate (design 86 G7). Without this a mortgage synthesized from a
    // property could never state when it was incurred, so a loan already outstanding
    // at t0 — which is the normal case for a real plan — would be stamped at the t0
    // rate and silently recognize no exchange gain or loss on the years of currency
    // movement that actually preceded it.
    bookingFxRate:         prop.mortgageBookingFxRate         ?? null,
    linkedPropertyKey: prop.stateKey,
    country:           prop.country ?? 'US',
    currency:          prop.currency ?? null,
    minimumBalance:    0,
    drawdownPriority:  null,
    holdings:          [],
  };
}

/**
 * Does this property's mortgage need a monthly `LOAN_PAYMENT` event scheduled?
 *
 * Lives here rather than in either real-property toolset because both of them gate on
 * it, and a term field honoured on one side only would change behaviour depending on
 * which country owned the property.
 *
 * The `monthlyMortgage > 0` half is the original design-54 gate. It is not sufficient
 * once design 86 exists: an interest-only loan DERIVES its payment, and a loan with a
 * maturity year is discharged from the term, so both leave `monthlyMortgage` inert —
 * and a UI that offers "interest only" while the event stays unscheduled would silently
 * model a loan that is never paid at all. (`scripts/lib/variant.mjs` worked around this
 * by seeding a placeholder `monthlyMortgage = 1`; that hack is no longer needed.)
 */
export function propertyNeedsLoanPayment(prop) {
  if (!((prop?.mortgageBalance ?? 0) > 0)) return false;
  return (prop.monthlyMortgage ?? 0) > 0
      || !!prop.mortgageInterestOnly
      || prop.mortgageMaturityYear != null;
}

/**
 * Does this authored account need a monthly `LOAN_PAYMENT` event in `country`?
 *
 * A standalone `LoanAccount` (design 54, no `linkedPropertyKey`) is paid by exactly the
 * same country-filtered handler as a mortgage — but nothing schedules the event for it,
 * because the real-property toolsets only ever looked at properties. Same gate as
 * {@link propertyNeedsLoanPayment}: a balance, plus SOMETHING that determines a payment.
 */
export function accountNeedsLoanPayment(account, country) {
  if (account?.type !== 'loan') return false;
  if ((account.country ?? 'US') !== country) return false;
  if (!((account.balance ?? 0) > 0)) return false;
  return (account.monthlyPayment ?? 0) > 0
      || !!account.interestOnly
      || account.maturityYear != null;
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
 *   3. **after IO expiry, with a maturity year** — the amortising payment, ANCHORED on
 *      `postIoPrincipal` (the balance at IO expiry) over the FULL post-IO term, and
 *      recomputed at the live rate. See below for why the anchor matters.
 *   4. **otherwise** — the authored fixed `monthlyPayment`, capped at payoff. This is
 *      the pre-86 path and every term-less loan takes it, byte-for-byte.
 *
 * ─── why branch 3 is anchored (design 86 G6, corrected) ──────────────────────
 *
 * This originally re-amortised the LIVE balance over the months remaining, on the
 * reasoning that a variable-rate P&I loan really is re-amortised when the rate moves.
 * That reasoning is sound and the implementation still honours it — the payment tracks
 * Prime — but re-amortising the *live* balance every month is only harmless while the
 * balance tracks its own schedule.
 *
 * It does not, the moment an OFFSET is involved. A fully offset loan accrues no
 * interest, so the entire payment is principal and the balance runs ahead of schedule;
 * re-amortising it then cuts next month's payment, which lets the balance run further
 * ahead, which cuts the payment again. The schedule self-damps and **the loan never
 * retires early — it drifts all the way to its stated maturity.** No lender behaves
 * this way: the payment is set once when the IO period ends and held, so overpaying
 * SHORTENS the loan.
 *
 * The difference is not cosmetic. On the plan this was found on, it decided the sign of
 * a whole refinance study: the same loan modelled to 2056 rather than retiring in 2042
 * was still forcing liquidations during the plan's largest tax years, and the answer
 * moved by ~7% of terminal wealth.
 *
 * Anchoring on the principal at IO expiry fixes it without giving up rate-tracking:
 * that principal is a constant (a loan in its IO window does not amortise by
 * construction), so the payment is constant at a constant rate, moves when Prime moves,
 * and is immune to extra principal. `postIoPrincipal` is defaulted at construction for
 * every interest-only loan; when it is absent — a legacy state entry authored before
 * this field existed — the pre-existing live-balance behaviour is kept exactly, so no
 * stored scenario changes underneath itself.
 *
 * Edge case, documented rather than guarded: a loan authored with `interestOnly` true
 * and an IO expiry ALREADY in the past anchors on its authored (part-amortised) balance
 * over the full original post-IO term, so its payment runs slightly low and the
 * maturity branch discharges the remainder. Author such a loan as `interestOnly: false`
 * with a `monthlyPayment` instead — that is what it is.
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

  // Reverted from IO to P&I.
  if (loan?.interestOnly && maturityYear != null && year != null) {
    const anchor = loan.postIoPrincipal;
    // Anchored: fixed schedule from the IO-expiry principal over the full post-IO term.
    // Unanchored (legacy): the pre-correction live-balance / months-remaining path.
    const base   = anchor ?? balance;
    const months = anchor != null && interestOnlyUntilYear != null
      ? Math.max(1, (maturityYear - interestOnlyUntilYear) * 12)
      : Math.max(1, (maturityYear - year) * 12);
    const i = rate / 12;
    const payment = i > 0
      ? base * i / (1 - Math.pow(1 + i, -months))
      : base / months;
    return Math.min(payment, balance + interest);
  }

  return Math.min(loan?.monthlyPayment ?? 0, balance + interest);
}

// ─── §988 exchange gain/loss on foreign-currency debt (design 86 G7 / P8) ──────

/**
 * §988(e)(2) de minimis: a personal-transaction exchange GAIN of $200 or less is not
 * recognized. Statutory, not inflation-indexed, and **per transaction**.
 *
 * Exported because design 87 moved its application to the leg the provision is actually
 * written for. §988(e)(2) is by its terms confined to cases where "nonfunctional
 * currency **is disposed of** by an individual" — spending foreign cash — which is the
 * currency-pool leg in currency-basis.js, not the retirement of a debt. Retiring a
 * mortgage disposes of no currency by the obligor, so the floor has no home here.
 * Design 87 G4.
 */
export const SECTION_988_PERSONAL_DE_MINIMIS_USD = 200;

/**
 * The income-producing share of a loan for §988(e) purposes.
 *
 * §988(e)(1) switches §988 off for an individual's **personal** transactions, and
 * §988(e)(3) defines a transaction as personal "except to the extent that expenses
 * properly allocable to such transaction meet the requirements of section 162 or
 * 212". That "to the extent" is a FRACTION, and it is the same fraction design 86 G3
 * already made authorable for s8-1 deductibility — the business/income-producing use
 * of the borrowed money. So this reuses `deductibleFraction` rather than inventing a
 * second, independently-wrong knob.
 *
 * `null` (every pre-86 loan) keeps the pre-86 rule: fully income-producing iff the
 * loan finances a property that is currently renting, otherwise fully personal.
 *
 * @returns {number} 0..1
 */
export function section988BusinessFraction(state, loan) {
  const stated = loan?.deductibleFraction;
  if (stated != null) return Math.min(1, Math.max(0, stated));
  const prop = loan?.linkedPropertyKey ? state?.[loan.linkedPropertyKey] : null;
  return prop?.rentalEnabled ? 1 : 0;
}

/**
 * Exchange gain or loss under §988 on a repayment of foreign-currency principal.
 *
 * A US individual's functional currency is the dollar (§985(b)(1)), so a debt
 * denominated in anything else is a §988 transaction (§988(c)(1)(B)(i) — "becoming
 * the obligor under a debt instrument") and the gain or loss is **ordinary**
 * (§988(a)(1)(A)). The OBLIGOR realizes it on each payment of principal
 * (Reg. §1.988-2(b)(6); (b)(5) is the holder's mirror), measured against the rate on
 * the booking date — the date the taxpayer became the obligor, §988(c)(2)(A):
 *
 *     gain(USD) = principalPaid × (1/bookingRate − 1/spotRate)
 *
 * with rates quoted as foreign units per USD. The sign follows the borrower's
 * economics: if the foreign currency has WEAKENED (more units per USD, spot >
 * booking) the borrower discharges the debt with fewer dollars than it was booked
 * at, which is a gain.
 *
 * §988(e) then splits the result, and the two halves are NOT symmetric — this is
 * the notorious foreign-mortgage trap and it is deliberately reproduced:
 *   · the income-producing share recognizes gain AND loss;
 *   · the personal share recognizes GAIN ONLY. A personal exchange loss is a
 *     nondeductible personal loss under §165(c) — Quijano v. United States, 93 F.3d
 *     26 (1st Cir. 1996), a sterling mortgage on a UK residence — so a US person can
 *     owe tax on a currency move that cost them money.
 *
 * ON THE $200 FLOOR — design 87 G4. §988(e)(2) is by its terms confined to cases where
 * "nonfunctional currency **is disposed of** by an individual". Retiring a DEBT
 * disposes of no currency by the obligor, so the de minimis has no home on the debt
 * leg; it belongs to the currency-pool leg in currency-basis.js, which is the
 * transaction the provision was written for. Hence `applyDeMinimis`: the currency leg
 * passes it (default), the LOAN path passes false. It only ever reduced recognized
 * gain, so removing it from the debt leg is a small increase in taxable income.
 *
 * Pure and rate-agnostic so it can be tested without a sim, and shared with the
 * currency leg — {@link computeCurrencyDisposition} delegates here with the rates
 * transposed, since a deposit is the exact mirror of a debt.
 *
 * @param {number} principalPaid  principal repaid, in the LOAN's currency (> 0)
 * @param {number} bookingRate    foreign units per USD when the debt was incurred
 * @param {number} spotRate       foreign units per USD on the payment date
 * @param {number} businessFrac   0..1, from {@link section988BusinessFraction}
 * @param {boolean} [applyDeMinimis=true]  apply the §988(e)(2) per-transaction floor
 * @returns {{ recognized: number, gross: number, disallowedLoss: number, deMinimis: number }}
 *          all USD; `recognized` is signed (the amount that reaches the return).
 */
export function computeSection988Gain(principalPaid, bookingRate, spotRate, businessFrac,
                                      applyDeMinimis = true) {
  const zero = { recognized: 0, gross: 0, disallowedLoss: 0, deMinimis: 0 };
  if (!(principalPaid > 0) || !(bookingRate > 0) || !(spotRate > 0)) return zero;

  const gross    = principalPaid * (1 / bookingRate - 1 / spotRate);
  const frac     = Math.min(1, Math.max(0, businessFrac));
  const business = gross * frac;
  const personal = gross * (1 - frac);

  // `+ 0` normalizes -0, which `gross * 0` produces for a negative gross and which
  // then leaks into state and JSON as "-0".
  if (personal >= 0) {
    // Personal GAIN: recognized, unless the whole personal piece is de minimis.
    const deMinimis = (applyDeMinimis && personal <= SECTION_988_PERSONAL_DE_MINIMIS_USD)
      ? personal : 0;
    return {
      recognized: business + (personal - deMinimis) + 0,
      gross, disallowedLoss: 0, deMinimis,
    };
  }
  // Personal LOSS: disallowed outright. No de minimis floor applies to a loss —
  // §988(e)(2) is written for gain only.
  return { recognized: business + 0, gross, disallowedLoss: -personal, deMinimis: 0 };
}

/**
 * Re-book a loan's §988 booking rate when principal is ADDED (negative
 * amortization, or a redraw): the debt becomes a blend of dollars borrowed at two
 * different rates.
 *
 * The blend must preserve the debt's total USD booking value, so it is a
 * balance-weighted HARMONIC mean, not an arithmetic one:
 *
 *     newBalance / r_new  =  oldBalance / r_old  +  added / r_spot
 *
 * Getting this wrong is not cosmetic. Leaving the original rate in place would
 * later measure the repayment of newly-borrowed dollars against a rate that never
 * applied to them, manufacturing §988 gain or loss out of an accounting choice.
 */
export function blendSection988BookingRate(oldBalance, bookingRate, added, spotRate) {
  if (!(added > 0) || !(spotRate > 0)) return bookingRate;
  if (!(bookingRate > 0)) return spotRate;
  const usdValue = oldBalance / bookingRate + added / spotRate;
  return usdValue > 0 ? (oldBalance + added) / usdValue : spotRate;
}

/** First-person residency, mirroring the rental and income handlers. */
const firstResidency = (state) =>
  state?.people?.[Object.keys(state?.people ?? {})[0]]?.residency ?? null;

/**
 * The investment-interest deduction action for one loan-month — design 86 G3, the
 * half that was deferred at P4.
 *
 * **Which loans.** A loan with a `linkedPropertyKey` is already handled: its interest
 * reaches the return through `computeRentalMonth`'s `deductibleInterest`, scaled by
 * the same `deductibleFraction`. Emitting here as well would deduct it twice. So this
 * fires only for a **standalone** loan — no linked property — which is precisely the
 * borrow-to-invest case §10.2 records as unmodellable.
 *
 * **Only when stated.** `deductibleFraction: null` is the pre-86 default and every
 * legacy loan, and it means "unstated". Deductibility follows the USE of the borrowed
 * funds (s8-1; *Munro*; TR 95/33), and nothing in the engine traces a loan's proceeds
 * into what they bought — so an unstated fraction deducts nothing, exactly as before.
 * `0` is a real, authored answer ("purely private borrowing") and also deducts
 * nothing; the two agree on the number and differ on what they claim.
 *
 * **How much.** `min(interest, payment)`: an individual is a cash-basis taxpayer and
 * deducts interest when PAID (§163(a); s8-1 incurred-and-paid). On a negatively
 * amortising loan the unpaid interest is capitalised into the balance and is not yet
 * deductible — deducting the full accrual there would relieve tax on money that never
 * left the borrower.
 *
 * Country-keyed action type, mirroring the rental pair, because the two classifiers
 * differ in currency and in which per-person AU pool they reach — and because a
 * US-only scenario never loads the AU tax module.
 *
 * @returns {?object} the action, or null when this loan deducts nothing
 */
export function investmentInterestAction(loan, loanKey, interest, payment, residency) {
  if (loan?.linkedPropertyKey) return null;
  const fraction = loan?.deductibleFraction;
  if (fraction == null) return null;
  const share = Math.min(1, Math.max(0, fraction));
  const paidInterest = Math.min(Math.max(0, interest), Math.max(0, payment));
  const amount = +(paidInterest * share).toFixed(2);
  if (!(amount > 0)) return null;
  return {
    type: loan.country === 'AU' ? 'AU_INVESTMENT_INTEREST_DEDUCTION' : 'US_INVESTMENT_INTEREST_DEDUCTION',
    loanKey, amount, residency,
    currency:      currencyCode(loan) ?? (loan.country === 'AU' ? 'AUD' : 'USD'),
    ownerId:       loan.ownerId       ?? null,
    ownershipType: loan.ownershipType ?? null,
    owners:        loan.owners        ?? null,
  };
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
    this.generatedActionTypes = ['REPLENISH_SAVINGS', 'LOAN_PAYMENT_APPLY', 'RECORD_FIELD_VALUE', 'RECORD_BALANCE',
                                 'US_INVESTMENT_INTEREST_DEDUCTION', 'AU_INVESTMENT_INTEREST_DEDUCTION'];
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
      const deduction = investmentInterestAction(loan, loanKey, interest, payment,
                                                 firstResidency(state));
      if (deduction) actions.push(deduction);
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
    // Design 87 G3 — the OTHER leg. When a foreign-currency loan is serviced from a
    // same-currency pool (an offset, which resolveLoanCashKey makes the default), the
    // payment is simultaneously a repayment of principal AND a disposition of
    // nonfunctional currency (§988(c)(1)(C)(i)). Realized against the pool's basis
    // BEFORE the debit, for the same reason as the transfer leg.
    //
    // On a matched facility this is the near-exact mirror of the debt leg computed
    // below, so the two largely cancel — which is the finding, not a bug. See design
    // 87 §3 for the three cases where they do NOT cancel.
    const cashS988 = (actualCash > 0 && cash)
      ? realizeCurrencyDisposition(state, cashKey, cash, actualCash, section988Residence(state, loan))
      : { patch: {}, actions: [] };
    if (actualCash > 0 && cash) this.accountService.transaction(cash, -actualCash, null);

    // Value delivered to the loan, converted back into the LOAN's currency. When the
    // cash pool can't cover the full payment, only the funded portion pays down debt.
    const deliveredLoanCcy = actualCash / fx;

    // Principal reduction = delivered − accrued interest. Negative ⇒ balance grows
    // (negative amortization). Clamp only at payoff (0), never at growth.
    const principalPart = deliveredLoanCcy - interest;
    const oldBalance    = loan?.balance ?? 0;
    const newBalance    = Math.max(0, oldBalance - principalPart);

    // §988 (design 86 G7 / P8) is computed HERE rather than in the handler, because
    // the handler's `payment` is only the SCHEDULED one — when the cash pool is short
    // the reducer funds less, and only principal that is actually repaid realizes
    // exchange gain or loss. Computing it upstream would book §988 on money that was
    // never paid.
    const { patch: s988Patch, actions: s988Actions } =
      _section988ForPayment(state, loanKey, loan, oldBalance, principalPart);

    // The cash pool's entry is spread AFTER transaction() mutated its balance in place,
    // so only `fxBasisRate` is being added; writing a pre-debit copy back would undo
    // the payment.
    const cashPatch = (cash && Object.keys(cashS988.patch).length)
      ? { [cashKey]: { ...cash, ...cashS988.patch } } : {};

    return this.newState(state, {
      [loanKey]: { ...loan, ...s988Patch, balance: +newBalance.toFixed(2) },
      ...cashPatch,
    }, [...s988Actions, ...cashS988.actions]);
  }
}

/**
 * The §988 leg of a loan payment: what to stamp on the loan, and what to book.
 *
 * A non-USD loan held by a US person (functional currency USD, §985(b)(1)) is a §988
 * transaction (§988(c)(1)(B)(i)); exchange gain or loss is ordinary (§988(a)(1)(A))
 * and the obligor realizes it on each payment of PRINCIPAL (Reg. §1.988-2(b)(6)).
 * Interest carries its own §988 item between accrual and payment
 * (Reg. §1.988-2(b)(4) for the obligor), but here accrual and payment are
 * simultaneous, so that piece is identically zero and is deliberately not modelled.
 *
 * Consequences that are the whole reason this matters to the offset question rather
 * than being a rounding error:
 *   · an INTEREST-ONLY loan repays no principal, so it recognizes NOTHING until it
 *     amortises or matures — deferring decades of currency movement into whichever
 *     year the balloon lands in, as a single lump of ordinary income;
 *   · an offset suppresses INTEREST without repaying principal, so merely holding a
 *     fully-offset facility realizes nothing. §988 bites on repayment, not on
 *     holding the debt.
 *   · but "offset" and "silent" are NOT the same claim, and combining the two above
 *     inverts the result. On a fully-offset AMORTIZING loan the interest is zero, so
 *     100% of every payment is principal — the MAXIMUM §988 realization rate, not
 *     zero. That is the live scenario's AU house (P&I, offset ≥ balance): §988 fires
 *     on every payment until the loan closes.
 *
 * NOT modelled, and each is a full realization of the accumulated position with no
 * cash repayment: Reg. §1.988-2(b)(6) also fires when the obligation is "transferred
 * or extinguished" — a refinance that is a significant modification under
 * Reg. §1.1001-3, or a buyer assuming the mortgage on sale.
 *
 * @returns {{ patch: object, actions: object[] }} fields to merge onto the loan, and
 *          any SECTION_988_GAIN to emit.
 */
function _section988ForPayment(state, loanKey, loan, oldBalance, principalPart) {
  const none = { patch: {}, actions: [] };
  const ccy  = currencyCode(loan);
  if (!ccy || ccy === 'USD') return none;

  const spot = state?.effectiveExchangeRates?.USD_AUD ?? 1.55;
  if (!(spot > 0)) return none;

  // An unstamped loan is booked at today's rate and recognizes nothing this period.
  // For a loan already outstanding at t0 the true booking rate is historical and
  // unknowable to the model, so treating it as incurred now is the honest default —
  // it UNDERSTATES §988 rather than inventing it. Author `bookingFxRate` to state
  // the real one.
  if (loan.bookingFxRate == null) return { patch: { bookingFxRate: spot }, actions: [] };

  // Principal ADDED (negative amortization / redraw) re-books the debt as a blend of
  // dollars borrowed at two rates; nothing is realized.
  if (principalPart < 0) {
    return {
      patch: { bookingFxRate: blendSection988BookingRate(oldBalance, loan.bookingFxRate, -principalPart, spot) },
      actions: [],
    };
  }
  if (!(principalPart > 0)) return none;

  // `false` — no §988(e)(2) de minimis on the debt leg. Design 87 G4: the provision
  // reaches dispositions of nonfunctional CURRENCY, and retiring a debt is not one.
  const r = computeSection988Gain(
    principalPart, loan.bookingFxRate, spot, section988BusinessFraction(state, loan), false);
  if (Math.abs(r.recognized) <= 1e-9 && r.disallowedLoss <= 1e-9) return none;

  return {
    patch: {},
    actions: [{
      type: 'SECTION_988_GAIN', loanKey, currency: ccy,
      amount: r.recognized, gross: r.gross,
      disallowedLoss: r.disallowedLoss, deMinimis: r.deMinimis,
      residency: section988Residence(state, loan),
    }],
  };
}

/**
 * The taxpayer's **residence** for §988(a)(3) sourcing — which is a tax-home test,
 * not a citizenship one.
 *
 * §988(a)(3)(A) sources exchange gain or loss "by reference to the residence of the
 * taxpayer … on whose books the … liability … is properly reflected", and
 * §988(a)(3)(B)(i)(I) defines an individual's residence as "the country in which such
 * individual's **tax home** (as defined in section 911(d)(3)) is located". A US
 * citizen whose tax home is Australia is therefore *foreign* for this purpose, and
 * the same gain that was US-source before the move becomes foreign-source after it.
 *
 * The model's per-person `residency` (flipped at `moveYear` by ChangeResidencyHandler)
 * is exactly that concept, so it is read directly rather than re-derived. A loan is
 * attributed to its own `ownerId`, else its linked property's, else the first person —
 * the fallback chain the earnings handlers already use. Both spouses move together in
 * this model, so the joint-return case is not sensitive to which one is picked.
 *
 * @returns {string|null} 'US' | 'AU' | null when no people are configured
 */
export function section988Residence(state, loan) {
  const people = state?.people;
  if (!people) return null;
  const prop    = loan?.linkedPropertyKey ? state?.[loan.linkedPropertyKey] : null;
  const ownerId = loan?.ownerId ?? prop?.ownerId ?? Object.keys(people)[0];
  return people[ownerId]?.residency ?? null;
}
