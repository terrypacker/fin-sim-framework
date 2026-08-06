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
    this._interestOnlyUntilYear = null;
    this._maturityYear          = null;
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
  interestOnlyUntilYear(v) { this._interestOnlyUntilYear = v; return this; }
  /** Calendar year the loan must be discharged (design 86 G6). */
  maturityYear(v) { this._maturityYear = v; return this; }

  build() {
    return new LoanAccount(this._balance, {
      ...this._baseOpts(),
      interestRate:      this._interestRate,
      monthlyPayment:    this._monthlyPayment,
      linkedPropertyKey: this._linkedPropertyKey,
      paymentSourceKey:  this._paymentSourceKey,
      interestOnly:      this._interestOnly,
      deductibleFraction: this._deductibleFraction,
      interestOnlyUntilYear: this._interestOnlyUntilYear,
      maturityYear:          this._maturityYear,
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
  build() {
    return new BrokerageAccount(this._balance, this._investmentOpts());
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
  }

  build() {
    return new SuperannuationAccount(this._balance, this._retirementOpts());
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
