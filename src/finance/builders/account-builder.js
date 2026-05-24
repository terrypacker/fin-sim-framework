/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { USD, AUD, CheckingAccount, SavingsAccount } from '../account.js';
import {
  BrokerageAccount,
  FourOhOneKAccount,
  RothAccount,
  TraditionalIRAAccount,
  SuperannuationAccount,
} from '../investment-account.js';

/**
 * Base fluent builder shared by all account builder types.
 * Subclass sets _AccountClass and type-appropriate defaults in its constructor.
 */
class BaseAccountBuilder {
  constructor() {
    this._id               = null;
    this._name             = '';
    this._initialValue     = 0;
    this._ownershipType    = 'sole';
    this._ownerId          = null;
    this._minimumBalance   = 0;
    this._drawdownPriority = null;
    this._country          = null;
    this._currency         = null;
  }

  id(v)               { this._id               = v; return this; }
  name(v)             { this._name             = v; return this; }
  initialValue(v)     { this._initialValue     = v; return this; }
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
    return new CheckingAccount(this._initialValue, this._baseOpts());
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
    return new SavingsAccount(this._initialValue, this._baseOpts());
  }
}

// ─── Investment base builder (adds investment-specific fields) ────────────────

class BaseInvestmentBuilder extends BaseAccountBuilder {
  constructor() {
    super();
    this._contributionBasis = null; // defaults to initialValue in InvestmentAccount
    this._earningsBasis     = 0;
    this._loanBalance       = 0;
    this._minimumAge        = null;
  }

  contributionBasis(v) { this._contributionBasis = v; return this; }
  earningsBasis(v)     { this._earningsBasis     = v; return this; }
  loanBalance(v)       { this._loanBalance       = v; return this; }
  minimumAge(v)        { this._minimumAge        = v; return this; }

  _investmentOpts() {
    const opts = this._baseOpts();
    if (this._contributionBasis !== null) opts.contributionBasis = this._contributionBasis;
    opts.earningsBasis = this._earningsBasis;
    opts.loanBalance   = this._loanBalance;
    if (this._minimumAge !== null) opts.minimumAge = this._minimumAge;
    return opts;
  }
}

// ─── Brokerage ────────────────────────────────────────────────────────────────

class BrokerageAccountBuilder extends BaseInvestmentBuilder {
  build() {
    return new BrokerageAccount(this._initialValue, this._investmentOpts());
  }
}

// ─── 401k ─────────────────────────────────────────────────────────────────────

class FourOhOneKAccountBuilder extends BaseInvestmentBuilder {
  constructor() {
    super();
    this._country    = 'US';
    this._currency   = USD;
    this._minimumAge = 59.5;
  }

  build() {
    return new FourOhOneKAccount(this._initialValue, this._investmentOpts());
  }
}

// ─── Roth ─────────────────────────────────────────────────────────────────────

class RothAccountBuilder extends BaseInvestmentBuilder {
  constructor() {
    super();
    this._country    = 'US';
    this._currency   = USD;
    this._minimumAge = 60;
  }

  build() {
    return new RothAccount(this._initialValue, this._investmentOpts());
  }
}

// ─── Traditional IRA ──────────────────────────────────────────────────────────

class TraditionalIRAAccountBuilder extends BaseInvestmentBuilder {
  constructor() {
    super();
    this._country    = 'US';
    this._currency   = USD;
    this._minimumAge = 60;
  }

  build() {
    return new TraditionalIRAAccount(this._initialValue, this._investmentOpts());
  }
}

// ─── Superannuation ───────────────────────────────────────────────────────────

class SuperannuationAccountBuilder extends BaseInvestmentBuilder {
  constructor() {
    super();
    this._country    = 'AU';
    this._currency   = AUD;
    this._minimumAge = 60;
  }

  build() {
    return new SuperannuationAccount(this._initialValue, this._investmentOpts());
  }
}

// ─── Public factory ───────────────────────────────────────────────────────────

/**
 * Fluent builder factory for all account types.
 *
 * Usage:
 *   const acct = AccountBuilder.checking()
 *     .name('Primary Checking')
 *     .initialValue(5000)
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

  /** US Roth IRA after-tax retirement account (minimumAge 60). */
  static roth()           { return new RothAccountBuilder();           }

  /** US Traditional IRA pre-tax retirement account (minimumAge 60). */
  static traditionalIRA() { return new TraditionalIRAAccountBuilder(); }

  /** AU Superannuation retirement account (minimumAge 60). */
  static super()          { return new SuperannuationAccountBuilder(); }
}
