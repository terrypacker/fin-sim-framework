/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Account, AUD, USD, ACCOUNT_TYPE } from './account.js';

/**
 * InvestmentAccount — extends Account with fields for investment-type accounts
 * (Roth, IRA, 401k, US/AU brokerage stocks, Superannuation).
 *
 * No methods; safe for structuredClone snapshots.
 * Logic lives in AccountService (src/finance/services/account-service.js).
 */
export class InvestmentAccount extends Account {
  /**
   * @param {number} initialValue - Starting balance (default 0)
   * @param {object} [opts]       - All Account opts, plus:
   * @param {number}      [opts.contributionBasis]       - Defaults to initialValue
   * @param {number}      [opts.earningsBasis=0]
   * @param {number}      [opts.loanBalance=0]           - Outstanding loan (AR-5, AR-8 if applicable)
   * @param {number|null} [opts.minimumAge=null]         - Age gate in decimal years (e.g. 59.5, 60)
   */
  constructor(initialValue = 0, opts = {}) {
    super(initialValue, opts);
    this.contributionBasis        = opts.contributionBasis ?? initialValue;
    this.earningsBasis            = opts.earningsBasis     ?? 0;
    this.balanceAtResidencyChange = null;   // set by AccountService.recordResidencyChange
    this.loanBalance              = opts.loanBalance       ?? 0;
    this.minimumAge               = opts.minimumAge        ?? null;
  }
}

/**
 * BrokerageAccount — taxable investment account holding stocks/funds.
 * Available in US and AU.
 * AU brokerage supports taking a loan against the balance (AR-5).
 * Tracks balance at residency change.
 */
export class BrokerageAccount extends InvestmentAccount {
  /**
   * @param {number} initialValue
   * @param {object} [opts] - All InvestmentAccount opts; type is set automatically
   */
  constructor(initialValue = 0, opts = {}) {
    super(initialValue, { ...opts, type: ACCOUNT_TYPE.BROKERAGE });
  }
}

/**
 * FourOhOneKAccount — US employer-sponsored retirement account.
 * US only. Penalty-free withdrawals from age 59.5.
 * Contributions are pre-tax (reduce ordinary income); earnings are ordinary income on withdrawal.
 * Tracks balance at residency change.
 */
export class FourOhOneKAccount extends InvestmentAccount {
  /**
   * @param {number} initialValue
   * @param {object} [opts] - All InvestmentAccount opts; type, country, currency, minimumAge set automatically
   */
  constructor(initialValue = 0, opts = {}) {
    super(initialValue, {
      country:    opts.country    ?? 'US',
      currency:   opts.currency   ?? USD,
      minimumAge: opts.minimumAge ?? 59.5,
      ...opts,
      type: ACCOUNT_TYPE.FOUR_OH_ONE_K,
    });
  }
}

/**
 * RothAccount — US after-tax retirement account.
 * US only. Penalty-free withdrawals from age 59.5 (modeled as 60 per sim convention).
 * Contributions are post-tax; qualified withdrawals are tax-free.
 * Tracks balance at residency change.
 */
export class RothAccount extends InvestmentAccount {
  /**
   * @param {number} initialValue
   * @param {object} [opts] - All InvestmentAccount opts; type, country, currency, minimumAge set automatically
   */
  constructor(initialValue = 0, opts = {}) {
    super(initialValue, {
      country:    opts.country    ?? 'US',
      currency:   opts.currency   ?? USD,
      minimumAge: opts.minimumAge ?? 60,
      ...opts,
      type: ACCOUNT_TYPE.ROTH,
    });
  }
}

/**
 * TraditionalIRAAccount — US individual retirement account (pre-tax).
 * US only. Penalty-free withdrawals from age 59.5 (modeled as 60 per sim convention).
 * Contributions may be tax-deductible; withdrawals are ordinary income.
 * Tracks balance at residency change.
 */
export class TraditionalIRAAccount extends InvestmentAccount {
  /**
   * @param {number} initialValue
   * @param {object} [opts] - All InvestmentAccount opts; type, country, currency, minimumAge set automatically
   */
  constructor(initialValue = 0, opts = {}) {
    super(initialValue, {
      country:    opts.country    ?? 'US',
      currency:   opts.currency   ?? USD,
      minimumAge: opts.minimumAge ?? 60,
      ...opts,
      type: ACCOUNT_TYPE.TRADITIONAL_IRA,
    });
  }
}

/**
 * SuperannuationAccount — AU compulsory retirement savings account.
 * AU only. Penalty-free access from age 60 (preservation age in AU).
 * Does NOT track balance at residency change (AR-10).
 */
export class SuperannuationAccount extends InvestmentAccount {
  /**
   * @param {number} initialValue
   * @param {object} [opts] - All InvestmentAccount opts; type, country, currency, minimumAge set automatically
   */
  constructor(initialValue = 0, opts = {}) {
    super(initialValue, {
      country:    opts.country    ?? 'AU',
      currency:   opts.currency   ?? AUD,
      minimumAge: opts.minimumAge ?? 60,
      ...opts,
      type: ACCOUNT_TYPE.SUPER,
    });
  }
}
