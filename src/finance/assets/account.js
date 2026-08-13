/*
 * Copyright (c) 2026 Terry Packer.
 *
 * This file is part of Terry Packer's Work.
 * See www.terrypacker.com for further info.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Currency descriptor — code and display symbol.
 * @typedef {{ code: string, symbol: string }} Currency
 */

import { Asset } from './asset.js';
import { applyInheritanceMeta } from './inheritance-meta.js';

/** US Dollar */
export const USD = { code: 'USD', symbol: '$' };

/** Australian Dollar */
export const AUD = { code: 'AUD', symbol: 'A$' };

/**
 * Discriminator strings for all supported account types.
 * Used for UI display, serialization, and type-guarded builder methods.
 *
 * Country availability:
 *   US only:  FOUR_OH_ONE_K, ROTH, TRADITIONAL_IRA
 *   AU only:  SUPER
 *   US + AU:  CHECKING, SAVINGS, BROKERAGE
 */
export const ACCOUNT_TYPE = Object.freeze({
  CHECKING:        'checking',
  SAVINGS:         'savings',
  BROKERAGE:       'brokerage',
  FOUR_OH_ONE_K:   '401k',
  ROTH:            'roth',
  TRADITIONAL_IRA: 'ira',
  SUPER:           'super',
  LOAN:            'loan',
  OFFSET:          'offset',
});

/**
 * Thrown by AccountService.replenishSavings when all eligible accounts in a
 * country are exhausted and the requested deficit could not be fully covered.
 */
export class InsufficientFundsError extends Error {
  /**
   * @param {string} country   - ISO country code (e.g. 'US', 'AU')
   * @param {string} currency  - Currency code (e.g. 'USD', 'AUD')
   * @param {number} remaining - Amount still unmet after exhausting all accounts
   * @param {{drawnKeys: string[], pendingTaxActions: object[], crossBorderTransfers: object[]}} [partial]
   *   What the draw DID accomplish before running dry — the same shape
   *   replenishSavings returns on success. A failed replenish is not a no-op: it
   *   drained every eligible account on the way down, and those sales/distributions
   *   realized real gains and real income. Callers catch this error and carry on,
   *   so unless they drain `partial` those accruals never reach the tax engine and
   *   the household is taxed on less than it actually realized.
   */
  constructor(country, currency, remaining, partial = null) {
    super(
      `Insufficient funds: ${remaining.toFixed(2)} ${currency} still needed ` +
      `after exhausting all eligible ${country} accounts`
    );
    this.name      = 'InsufficientFundsError';
    this.country   = country;
    this.currency  = currency;
    this.remaining = remaining;
    this.partial   = partial ?? { drawnKeys: [], pendingTaxActions: [], crossBorderTransfers: [] };
  }
}

/**
 * Account — ledger-based Asset with balance, credits, and debits.
 * Extends Asset (SimGraphNode → Asset → Account).
 * No methods; safe for structuredClone snapshots.
 * Logic lives in AccountService (src/finance/services/account-service.js).
 * Ownership fields (ownershipType, ownerId, drawdownPriority) are inherited from Asset.
 */
export class Account extends Asset {
  /**
   * @param {number} balance - Starting balance (default 0)
   * @param {object} [opts]
   * @param {string|null}   [opts.id=null]               - Assigned by AccountService; null until registered
   * @param {string}        [opts.name='']               - Display name for UI
   * @param {string|null}   [opts.role=null]             - Semantic role (ACCOUNT_ROLES value); used by StateRegistry lookups
   * @param {string|null}   [opts.type=null]             - Account type discriminator (ACCOUNT_TYPE value)
   * @param {string}        [opts.ownershipType='sole']  - 'sole' | 'joint' (inherited from Asset)
   * @param {string|null}   [opts.ownerId=null]          - Person id of primary owner (inherited from Asset)
   * @param {number}        [opts.minimumBalance=0]      - Lowest allowed balance
   * @param {number|null]   [opts.drawdownPriority=null] - Liquidation order; null = exclude from drawdown (inherited from Asset)
   * @param {string|null}   [opts.country=null]          - ISO country code (e.g. 'US', 'AU')
   * @param {Currency|null} [opts.currency=null]         - Currency descriptor (e.g. USD, AUD)
   * @param {number|null}   [opts.growthRate=null]       - Per-account annual equity growth rate (design 55 §8);
   *                                                       null = fall back to the toolset's global rate.
   * @param {number|null}   [opts.dividendRate=null]     - Per-account annual dividend yield (design 55 §8); null = global.
   * @param {number|null}   [opts.interestRate=null]     - Per-account annual interest rate for cash/fixed-income earnings
   *                                                       (design 55 §8); null = global. NOTE: LoanAccount reuses
   *                                                       `interestRate` for its *loan* rate (a different meaning).
   * @param {number|null}   [opts.primeSpread=null]      - Prime-relative rate spread (design 56); null = not
   *                                                       Prime-linked (absolute `interestRate` applies). When set,
   *                                                       the effective rate is `Prime(country) + primeSpread`.
   * @param {boolean}       [opts.isTransactionAccount=false] - Marks this account as the withdraw-from ("transaction")
   *                                                       account for its country of residence (design 55 §7). Exactly
   *                                                       one per country should carry it; MonthlyExpensesHandler /
   *                                                       IntlTransferApplyReducer resolve the debit/replenish target
   *                                                       from it, falling back to the SAVINGS role when none is flagged.
   */
  constructor(balance = 0, opts = {}) {
    super(opts.name ?? '', { ...opts, kind: 'account' });
    this.role           = opts.role           ?? null;
    this.type           = opts.type           ?? null;
    this.balance        = balance;
    // Holdings — populated by AccountService.register() default-holding bootstrap
    // (see design 25 §5.4). Source of truth for asset allocation; balance is
    // a denormalized scalar synced by holdings reducers (§4.4 invariant).
    this.holdings       = opts.holdings ?? [];
    this.minimumBalance = opts.minimumBalance ?? 0;
    this.country        = opts.country        ?? null;
    this.currency       = opts.currency       ?? null;
    // Per-account earnings rates (design 55 §8). Default null → the earnings
    // handler falls back to the toolset's global rate, so legacy accounts are
    // byte-for-byte unchanged. When set, the account grows/earns at its own rate
    // (still regime-adjusted via the per-account rate key). LoanAccount overrides
    // `interestRate` in its own constructor with a loan-specific default.
    this.growthRate     = opts.growthRate     ?? null;
    this.dividendRate   = opts.dividendRate   ?? null;
    this.interestRate   = opts.interestRate   ?? null;
    // Prime-relative cash/loan rate (design 56). When set, the account's effective
    // rate is `Prime(country) + primeSpread` (seedPerAccountRates for cash; the loan
    // payment handler for loans, Phase 3), overriding the absolute `interestRate`.
    // null → not Prime-linked → the absolute `interestRate` path applies (back-compat).
    this.primeSpread    = opts.primeSpread    ?? null;
    // Equity market MIX (design 90 §7.3) — the sub-axis under ALLOCATION.EQUITY:
    // `{ EQUITY_US: 0.6, EQUITY_INTL_EX_US: 0.4 }`. null ⇒ the account's domestic market
    // alone, which is exactly what `resolveRateKey` produced before the axis existed, so
    // an un-authored account bootstraps byte-identically. Weights are proportions and are
    // renormalised on read (`resolveEquityMarketMix`); only EQUITY-class keys are honoured.
    this.equityMarketMix = opts.equityMarketMix ?? null;
    // §988 currency basis (design 87). The rate at which this pool's foreign currency
    // was acquired, in foreign units per USD. Applies to ANY non-USD cash account —
    // §988(c)(1)(C)(ii) reaches every bank deposit denominated in nonfunctional
    // currency, so savings, transaction and offset accounts are on the same footing.
    // null ⇒ stamped at the first disposition, which understates §988 rather than
    // inventing it; author the real rate to fix that.
    this.fxBasisRate    = opts.fxBasisRate    ?? null;
    // §988(e)(3) / s8-1 income-producing share. Shared with LoanAccount, which has
    // used it since design 86 G3 — the two provisions ask the same question, so a
    // second knob would mean maintaining two independently-wrong ones. On a currency
    // pool it decides whether an exchange LOSS is deductible at all (§165(c)).
    this.deductibleFraction = opts.deductibleFraction ?? null;
    // Transaction-account flag (design 55 §7). Default false → the debit/replenish
    // target resolver falls back to the SAVINGS role, so legacy scenarios are
    // unchanged. Serialized only when true (see ScenarioSerializer._serializeAccount).
    this.isTransactionAccount = opts.isTransactionAccount ?? false;
    // Inheritance metadata (design 63 §14) — set only on promoted inherited records
    // (brokerage); defaults keep every owned account byte-for-byte unchanged.
    applyInheritanceMeta(this, opts);
  }
}

/**
 * CheckingAccount — liquid cash account for everyday transactions.
 * Available in US and AU.
 * Enforces a minimum balance (default 0; set via opts.minimumBalance).
 */
export class CheckingAccount extends Account {
  /**
   * @param {number} balance
   * @param {object} [opts] - All Account opts; type is set automatically
   */
  constructor(balance = 0, opts = {}) {
    super(balance, { ...opts, type: ACCOUNT_TYPE.CHECKING });
  }
}

/**
 * SavingsAccount — interest-bearing deposit account.
 * Available in US and AU.
 * Enforces a minimum balance (default 0; set via opts.minimumBalance).
 */
export class SavingsAccount extends Account {
  /**
   * @param {number} balance
   * @param {object} [opts] - All Account opts; type is set automatically
   */
  constructor(balance = 0, opts = {}) {
    super(balance, { ...opts, type: ACCOUNT_TYPE.SAVINGS });
  }
}

/**
 * LoanAccount — a *liability* account (design 54). `balance` holds the outstanding
 * principal as a POSITIVE number (owed); the sign is applied by the wealth metrics,
 * which subtract a `type === 'loan'` account's balance (design 54 §2/§7). Accrues
 * interest each period and amortizes into interest vs principal (LOAN_PAYMENT).
 *
 * Never a source of drawdown cash: `drawdownPriority` is forced null and the
 * drawdown/replenish pools exclude loans by type (design 54 §8).
 *
 * No methods; safe for structuredClone snapshots.
 */
export class LoanAccount extends Account {
  /**
   * @param {number} balance - Outstanding principal (positive; default 0)
   * @param {object} [opts]  - All Account opts, plus:
   * @param {number}      [opts.interestRate=0]        - Annual interest rate (decimal)
   * @param {number}      [opts.monthlyPayment=0]      - Fixed monthly P&I payment
   * @param {string|null} [opts.linkedPropertyKey=null] - stateKey of a property this loan finances (design 54 P2)
   * @param {string|null} [opts.paymentSourceKey=null]  - cash pool the payment debits (default: country cash)
   * @param {boolean}     [opts.interestOnly=false]     - pay exactly the accrued interest (design 86 G2)
   * @param {?number}     [opts.deductibleFraction=null] - income-producing share of the loan's purpose (design 86 G3)
   */
  constructor(balance = 0, opts = {}) {
    super(balance, { ...opts, type: ACCOUNT_TYPE.LOAN });
    this.interestRate      = opts.interestRate      ?? 0;
    this.monthlyPayment    = opts.monthlyPayment    ?? 0;
    this.linkedPropertyKey = opts.linkedPropertyKey ?? null;
    this.paymentSourceKey  = opts.paymentSourceKey  ?? null;
    // Interest-only (design 86 G2): the payment is DERIVED each month as the accrued
    // interest on the effective (offset-reduced) principal at the live rate, so the
    // balance is flat by construction and a variable Prime-linked rate is tracked
    // automatically. `monthlyPayment` is inert while this is on — with a variable
    // rate, a fixed number cannot express "pay exactly the interest", and guessing
    // one low enough silently produces unbounded negative amortization instead.
    this.interestOnly      = opts.interestOnly      ?? false;
    // Deductibility follows the USE the borrowed funds are put to, not the security
    // taken over them (s8-1; Munro; TR 95/33) — design 86 G3. `null` keeps the
    // pre-86 rule (deductible in full iff the loan finances a renting property);
    // a number in [0,1] states the income-producing share explicitly, which is how
    // a part-private redraw or a loan drawn down to buy something private is
    // expressed. Stated rather than traced: mixed-purpose accounts have no clean
    // tracing model, and a stated fraction is both honest and sufficient.
    this.deductibleFraction = opts.deductibleFraction ?? null;
    // Loan term (design 86 G6), absolute calendar years. An IO loan reverts to P&I
    // amortised over the remaining term at `interestOnlyUntilYear`, and must be
    // discharged by `maturityYear`. Both null ⇒ no term: the loan amortises (or stays
    // interest-only) forever, which is the pre-86 behaviour.
    this.interestOnlyUntilYear = opts.interestOnlyUntilYear ?? null;
    this.maturityYear          = opts.maturityYear          ?? null;
    // The principal the post-IO P&I payment amortises from (see scheduledLoanPayment).
    // A real lender fixes that payment when the IO period ends and holds it, so extra
    // principal — an offset paying the loan down faster than schedule — shortens the
    // loan instead of shrinking the payment. Defaulted to the opening balance because
    // an IO loan does not amortise inside its window, so the two are the same number.
    // Null on a non-IO loan: that path never reads it.
    this.postIoPrincipal       = opts.postIoPrincipal
      ?? (this.interestOnly ? (opts.balance ?? this.balance ?? null) : null);
    // §988 booking rate (design 86 G7 / P8): foreign units per USD on the date the
    // debt was incurred. A non-USD loan held by a US person realizes ordinary
    // exchange gain or loss on each PRINCIPAL repayment, measured against this rate.
    // `null` ⇒ stamped at the first payment from the live rate, i.e. the loan is
    // treated as incurred then. That understates §988 for a loan already outstanding
    // at t0 rather than inventing a history; state the real rate to model it properly.
    this.bookingFxRate      = opts.bookingFxRate      ?? null;
    this.drawdownPriority   = null; // a liability is never a source of drawdown cash
  }
}

/**
 * OffsetAccount — a cash-like *asset* account (design 53 §3) whose balance
 * suppresses the interest-bearing principal of a linked home loan without paying
 * it down: `effectivePrincipal = max(0, loanBalance − offsetBalance)`. The cash
 * stays fully liquid and spendable; while parked it "earns" the loan rate by
 * reducing accrued interest (rental deduction and, for owner-occupied loans, the
 * monthly interest/payoff — design 54 P3).
 *
 * Extends Account (NOT InvestmentAccount): it holds cash, has no holdings-driven
 * allocation and no contribution/earnings split. It behaves like a savings account
 * for drawdown/replenish (liquid, participates in the country cash pool), plus one
 * extra field `offsetsPropertyKey` linking it to the property whose loan it offsets.
 *
 * Currency-agnostic: defaults to AU/AUD (the original AU offset use case) but a
 * US/USD offset against a US owner-occupied loan is equally valid (design 54 P3).
 *
 * No methods; safe for structuredClone snapshots.
 */
export class OffsetAccount extends Account {
  /**
   * @param {number} balance - Cash balance (default 0)
   * @param {object} [opts]  - All Account opts, plus:
   * @param {string|null} [opts.offsetsPropertyKey=null] - stateKey of the property whose loan this offsets
   */
  constructor(balance = 0, opts = {}) {
    super(balance, {
      country:  opts.country  ?? 'AU',
      currency: opts.currency ?? AUD,
      ...opts,
      type: ACCOUNT_TYPE.OFFSET,
    });
    this.offsetsPropertyKey = opts.offsetsPropertyKey ?? null;
  }
}
