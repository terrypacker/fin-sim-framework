/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { USD, AUD, CheckingAccount, SavingsAccount, LoanAccount, OffsetAccount } from '../assets/account.js';
import {
  BrokerageAccount,
  FourOhOneKAccount,
  RothAccount,
  TraditionalIRAAccount,
  SuperannuationAccount,
  MsbsAccount,
} from '../assets/investment-account.js';

/**
 * Base fluent builder shared by all account builder types.
 * Subclass sets _AccountClass and type-appropriate defaults in its constructor.
 */
class BaseAccountBuilder {
  constructor() {
    this._id               = null;
    this._name             = '';
    this._balance          = 0;
    this._ownershipType    = 'sole';
    this._ownerId          = null;
    this._minimumBalance   = 0;
    this._drawdownPriority = null;
    this._country          = null;
    this._currency         = null;
  }

  id(v)               { this._id               = v; return this; }
  name(v)             { this._name             = v; return this; }
  balance(v)          { this._balance          = v; return this; }
  ownershipType(v)    { this._ownershipType    = v; return this; }
  ownerId(v)          { this._ownerId          = v; return this; }
  minimumBalance(v)   { this._minimumBalance   = v; return this; }
  drawdownPriority(v) { this._drawdownPriority = v; return this; }
  country(v)          { this._country          = v; return this; }
  currency(v)         { this._currency         = v; return this; }

  _baseOpts() {
    return {
      id:               this._id,
      name:             this._name,
      ownershipType:    this._ownershipType,
      ownerId:          this._ownerId,
      minimumBalance:   this._minimumBalance,
      drawdownPriority: this._drawdownPriority,
      country:          this._country,
      currency:         this._currency,
    };
  }
}

// ─── Checking ─────────────────────────────────────────────────────────────────

class CheckingAccountBuilder extends BaseAccountBuilder {
  constructor() {
    super();
    this._country  = null; // US or AU — caller sets
    this._currency = null;
  }

  build() {
    return new CheckingAccount(this._balance, this._baseOpts());
  }
}

// ─── Savings ──────────────────────────────────────────────────────────────────

class SavingsAccountBuilder extends BaseAccountBuilder {
  constructor() {
    super();
    this._country  = null; // US or AU — caller sets
    this._currency = null;
  }

  build() {
    return new SavingsAccount(this._balance, this._baseOpts());
  }
}

// ─── Loan (liability) ─────────────────────────────────────────────────────────

class LoanAccountBuilder extends BaseAccountBuilder {
  constructor() {
    super();
    this._interestRate      = 0;
    this._monthlyPayment    = 0;
    this._linkedPropertyKey = null;
    this._paymentSourceKey  = null;
    this._interestOnly      = false;
    this._deductibleFraction = null;
    this._interestOnlyUntil     = null;
    this._maturityDate          = null;
    this._bookingFxRate         = null;
    this._postIoPrincipal       = null;
    this._rateTerms             = {};
  }

  interestRate(v)      { this._interestRate      = v; return this; }
  monthlyPayment(v)    { this._monthlyPayment    = v; return this; }
  linkedPropertyKey(v) { this._linkedPropertyKey = v; return this; }
  paymentSourceKey(v)  { this._paymentSourceKey  = v; return this; }
  /** Interest-only: the payment is derived as the accrued interest (design 86 G2). */
  interestOnly(v = true) { this._interestOnly    = v; return this; }
  /** Income-producing share of the loan's purpose, 0..1 (design 86 G3). */
  deductibleFraction(v) { this._deductibleFraction = v; return this; }
  /** Calendar year the IO period ends and the loan reverts to P&I (design 86 G6). */
  /** 'YYYY-MM-DD' (design 117). */
  interestOnlyUntil(v) { this._interestOnlyUntil = v; return this; }
  /** Calendar year the loan must be discharged (design 86 G6). */
  /** 'YYYY-MM-DD' (design 117). */
  maturityDate(v) { this._maturityDate = v; return this; }
  /** Foreign units per USD when the debt was incurred — the §988 basis (design 86 G7). */
  bookingFxRate(v) { this._bookingFxRate = v; return this; }
  /** Principal the post-IO P&I payment amortises from; defaults to the opening balance. */
  postIoPrincipal(v) { this._postIoPrincipal = v; return this; }
  /** VARIABLE | FIXED | FIXED_PERIOD (design 113 §4). */
  rateType(v) { this._rateTerms.rateType = v; return this; }
  /** Calendar year a FIXED_PERIOD loan's fixed rate ends (design 113 §4). */
  /** 'YYYY-MM-DD' (design 117). */
  fixedRateUntil(v) { this._rateTerms.fixedRateUntil = v; return this; }
  /** Absolute revert rate, used only when no Prime is configured (design 113 §4). */
  revertInterestRate(v) { this._rateTerms.revertInterestRate = v; return this; }
  /** Whether a linked offset works inside the fixed window (design 113 §5). */
  offsetWhileFixed(v = true) { this._rateTerms.offsetWhileFixed = v; return this; }
  /** Whether a sale inside the fixed window pays a break cost (design 113 §7.1). */
  breakCostOnPayoff(v = true) { this._rateTerms.breakCostOnPayoff = v; return this; }
  /** Yearly cap on extra repayments inside the fixed window (design 113 §7.2). */
  fixedExtraRepaymentCap(v) { this._rateTerms.fixedExtraRepaymentCap = v; return this; }
  /** Prime when the rate was fixed — the break cost's reference (design 113 §7.1). */
  fixedAtPrimeRate(v) { this._rateTerms.fixedAtPrimeRate = v; return this; }

  build() {
    return new LoanAccount(this._balance, {
      ...this._baseOpts(),
      interestRate:      this._interestRate,
      monthlyPayment:    this._monthlyPayment,
      linkedPropertyKey: this._linkedPropertyKey,
      paymentSourceKey:  this._paymentSourceKey,
      interestOnly:      this._interestOnly,
      deductibleFraction: this._deductibleFraction,
      interestOnlyUntil:     this._interestOnlyUntil,
      maturityDate:          this._maturityDate,
      bookingFxRate:         this._bookingFxRate,
      postIoPrincipal:       this._postIoPrincipal,
      ...this._rateTerms,
    });
  }
}

// ─── Offset (cash-like, linked) ───────────────────────────────────────────────

class OffsetAccountBuilder extends BaseAccountBuilder {
  constructor() {
    super();
    this._offsetsPropertyKey = null;
  }

  offsetsPropertyKey(v) { this._offsetsPropertyKey = v; return this; }

  build() {
    return new OffsetAccount(this._balance, {
      ...this._baseOpts(),
      offsetsPropertyKey: this._offsetsPropertyKey,
    });
  }
}

// ─── Investment base builder (adds investment-specific fields) ────────────────

class BaseInvestmentBuilder extends BaseAccountBuilder {
  constructor() {
    super();
    this._loanBalance = 0;
  }

  loanBalance(v) { this._loanBalance = v; return this; }

  _investmentOpts() {
    const opts = this._baseOpts();
    opts.loanBalance = this._loanBalance;
    return opts;
  }
}

/**
 * RetirementBuilder — adds the contribution/earnings ledger and age-gate setters
 * that live on RetirementAccount (design 53 §2). Brokerage extends the lean
 * BaseInvestmentBuilder and carries none of these.
 */
class RetirementBuilder extends BaseInvestmentBuilder {
  constructor() {
    super();
    this._contributionBasis     = null; // defaults to balance in RetirementAccount
    this._earningsBasis         = 0;
    this._derivedIncomeBasis    = 0;
    this._minimumAge            = null;
    this._allowsEarlyWithdrawal = null; // null = defer to account class default
  }

  contributionBasis(v)     { this._contributionBasis     = v; return this; }
  earningsBasis(v)         { this._earningsBasis         = v; return this; }
  derivedIncomeBasis(v)    { this._derivedIncomeBasis    = v; return this; }
  minimumAge(v)            { this._minimumAge            = v; return this; }
  allowsEarlyWithdrawal(v) { this._allowsEarlyWithdrawal = v; return this; }

  _retirementOpts() {
    const opts = this._investmentOpts();
    if (this._contributionBasis !== null) opts.contributionBasis = this._contributionBasis;
    opts.earningsBasis = this._earningsBasis;
    opts.derivedIncomeBasis = this._derivedIncomeBasis;
    if (this._minimumAge !== null) opts.minimumAge = this._minimumAge;
    if (this._allowsEarlyWithdrawal !== null) opts.allowsEarlyWithdrawal = this._allowsEarlyWithdrawal;
    return opts;
  }
}

// ─── Brokerage ────────────────────────────────────────────────────────────────

class BrokerageAccountBuilder extends BaseInvestmentBuilder {
  constructor() {
    super();
    this._reinvestDividends = null; // null = inherit the household default (design 106)
    this._reinvestDividendsBySecurity = null; // null = no per-security overrides
  }

  /** Dividend-reinvestment election for this broker: true / false / null = inherit. */
  reinvestDividends(v) { this._reinvestDividends = v; return this; }

  /** Per-security overrides of that election: `{ [securityId]: boolean }` (design 106 §5). */
  reinvestDividendsBySecurity(v) { this._reinvestDividendsBySecurity = v; return this; }

  build() {
    const opts = this._investmentOpts();
    // Only passed when the household has an opinion, so an unelected account keeps
    // taking the toolset default (design 106 §4) and serializes to nothing.
    if (this._reinvestDividends !== null) opts.reinvestDividends = this._reinvestDividends;
    if (this._reinvestDividendsBySecurity !== null) {
      opts.reinvestDividendsBySecurity = this._reinvestDividendsBySecurity;
    }
    return new BrokerageAccount(this._balance, opts);
  }
}

// ─── 401k ─────────────────────────────────────────────────────────────────────

class FourOhOneKAccountBuilder extends RetirementBuilder {
  constructor() {
    super();
    this._country    = 'US';
    this._currency   = USD;
    this._minimumAge = 59.5;
  }

  build() {
    return new FourOhOneKAccount(this._balance, this._retirementOpts());
  }
}

// ─── Roth ─────────────────────────────────────────────────────────────────────

class RothAccountBuilder extends RetirementBuilder {
  constructor() {
    super();
    this._country    = 'US';
    this._currency   = USD;
    this._minimumAge = 59.5;
  }

  build() {
    return new RothAccount(this._balance, this._retirementOpts());
  }
}

// ─── Traditional IRA ──────────────────────────────────────────────────────────

class TraditionalIRAAccountBuilder extends RetirementBuilder {
  constructor() {
    super();
    this._country    = 'US';
    this._currency   = USD;
    this._minimumAge = 60;
  }

  build() {
    return new TraditionalIRAAccount(this._balance, this._retirementOpts());
  }
}

// ─── Superannuation ───────────────────────────────────────────────────────────

class SuperannuationAccountBuilder extends RetirementBuilder {
  constructor() {
    super();
    this._country    = 'AU';
    this._currency   = AUD;
    this._minimumAge = 60;
    this._msbs       = null;
  }

  /** Build a preserved MSBS benefit (design 119 §6.4) with these statement fields. */
  msbs(fields = {}) { this._msbs = { ...fields }; return this; }

  build() {
    return this._msbs
      ? new MsbsAccount(this._balance, { ...this._retirementOpts(), ...this._msbs })
      : new SuperannuationAccount(this._balance, this._retirementOpts());
  }
}

// ─── Public factory ───────────────────────────────────────────────────────────

/**
 * Fluent builder factory for all account types.
 *
 * Usage:
 *   const acct = AccountBuilder.checking()
 *     .name('Primary Checking')
 *     .balance(5000)
 *     .country('US')
 *     .currency(USD)
 *     .minimumBalance(500)
 *     .drawdownPriority(1)
 *     .build();
 *
 *   // Register with AccountService to get a service-assigned id:
 *   const saved = accountService.createAccount(acct);
 */
export class AccountBuilder {
  /** Checking account (US or AU). */
  static checking()       { return new CheckingAccountBuilder();       }

  /** Savings account (US or AU). */
  static savings()        { return new SavingsAccountBuilder();        }

  /** Taxable brokerage account (US or AU). */
  static brokerage()      { return new BrokerageAccountBuilder();      }

  /** US 401(k) employer-sponsored retirement account (minimumAge 59.5). */
  static fourOhOneK()     { return new FourOhOneKAccountBuilder();     }

  /** US Roth IRA after-tax retirement account (minimumAge 59.5). */
  static roth()           { return new RothAccountBuilder();           }

  /** US Traditional IRA pre-tax retirement account (minimumAge 60). */
  static traditionalIRA() { return new TraditionalIRAAccountBuilder(); }

  /** AU Superannuation retirement account (minimumAge 60). */
  static super()          { return new SuperannuationAccountBuilder(); }

  /** Loan (liability) account — accrues interest, amortizes (design 54). */
  static loan()           { return new LoanAccountBuilder();           }

  /** Offset account — cash-like, suppresses a linked loan's interest (design 53 §3 / 54 P3). */
  static offset()         { return new OffsetAccountBuilder();         }
}
