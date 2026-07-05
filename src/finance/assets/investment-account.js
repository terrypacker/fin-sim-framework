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
 * Reconcile a ledger-bearing account's contribution/earnings basis to balance
 * (design 43 §4 invariant 1, §5 Phase 3), preserving the earnings fraction.
 * Repairs already-drifted SAVED states on load — e.g. a super account left at
 * `contributionBasis 180k` after a drawdown took `balance` to 39k.
 *
 * Scoped to the corruption signature: only fires when the ledger OVER-states
 * balance (`contributionBasis + earningsBasis > balance`), which is what a
 * drawdown that moved balance but not the ledger produces. An UNDER-stated
 * ledger (`total < balance`) is the benign "earnings not yet recorded" case the
 * after-tax metric already tolerates, so it is left untouched. No-op for
 * accounts without the ledger fields (plain cash/savings).
 *
 * @param {object} account - account record ({ balance, contributionBasis, earningsBasis })
 * @returns {boolean} true if a correction was applied
 */
export function reconcileLedgerToBalance(account) {
  if (!account) return false;
  if (!('contributionBasis' in account) || !('earningsBasis' in account)) return false;
  const balance  = account.balance ?? 0;
  const contrib  = account.contributionBasis ?? 0;
  const earnings = account.earningsBasis ?? 0;
  const total    = contrib + earnings;
  if (total <= balance + 0.01) return false;
  if (balance <= 0) {
    account.contributionBasis = 0;
    account.earningsBasis     = 0;
    return true;
  }
  const earningsFraction = total > 0 ? Math.max(0, earnings) / total : 0;
  account.earningsBasis     = +(balance * earningsFraction).toFixed(2);
  account.contributionBasis = +(balance - account.earningsBasis).toFixed(2);
  return true;
}

/**
 * InvestmentAccount — extends Account with fields common to holdings-bearing
 * investment accounts (US/AU brokerage stocks + the retirement subclasses).
 *
 * The contribution/earnings ledger and age gates live on the `RetirementAccount`
 * subclass (design 53 §2) — brokerage extends this base directly and carries
 * neither. Brokerage CGT comes from holdings FIFO (design 53 Phase 1).
 *
 * No methods; safe for structuredClone snapshots.
 * Logic lives in AccountService (src/finance/services/account-service.js).
 */
export class InvestmentAccount extends Account {
  /**
   * @param {number} balance - Starting balance (default 0)
   * @param {object} [opts]  - All Account opts, plus:
   * @param {number}      [opts.loanBalance=0]           - Outstanding loan (AR-5, AR-8 if applicable)
   */
  constructor(balance = 0, opts = {}) {
    super(balance, opts);
    this.balanceAtResidencyChange = null;   // set by AccountService.recordResidencyChange
    // Retained for serialization back-compat; no longer drives logic. The AU
    // residency cost-base step-up now stamps per-lot `Holding.costBaseByCountry`
    // and both the FIFO reducers and the auto-liquidation drawdown read that
    // (design 53 Phase 1 retired the account-level snapshot). Always null.
    this.costBaseStepUpByCountry  = null;
    this.loanBalance              = opts.loanBalance          ?? 0;
  }
}

/**
 * BrokerageAccount — taxable investment account holding stocks/funds.
 * Available in US and AU. Holdings-only: no contribution/earnings ledger — CGT is
 * realized from holdings FIFO (design 53 Phase 1).
 * AU brokerage supports taking a loan against the balance (AR-5).
 * Tracks balance at residency change.
 */
export class BrokerageAccount extends InvestmentAccount {
  /**
   * @param {number} balance
   * @param {object} [opts] - All InvestmentAccount opts; type is set automatically
   */
  constructor(balance = 0, opts = {}) {
    super(balance, { ...opts, type: ACCOUNT_TYPE.BROKERAGE });
  }
}

/**
 * RetirementAccount — tax-advantaged account with an ordinary-income
 * contribution/earnings ledger and an age-based withdrawal gate (design 53 §2).
 * Base for FourOhOneKAccount / RothAccount / TraditionalIRAAccount /
 * SuperannuationAccount. Withdrawals draw contribution basis (tax-free / already
 * taxed) before earnings (taxed) — the split brokerage does not have.
 *
 * No methods; safe for structuredClone snapshots.
 */
export class RetirementAccount extends InvestmentAccount {
  /**
   * @param {number} balance - Starting balance (default 0)
   * @param {object} [opts]  - All InvestmentAccount opts, plus:
   * @param {number}      [opts.contributionBasis]       - Defaults to balance
   * @param {number}      [opts.earningsBasis=0]
   * @param {number|null} [opts.minimumAge=null]         - Age gate in decimal years (e.g. 59.5, 60)
   * @param {boolean}     [opts.allowsEarlyWithdrawal=false] - True if pre-minimumAge drawdown is permitted (with penalty)
   */
  constructor(balance = 0, opts = {}) {
    super(balance, opts);
    this.contributionBasis     = opts.contributionBasis     ?? balance;
    this.earningsBasis         = opts.earningsBasis         ?? 0;
    this.minimumAge            = opts.minimumAge            ?? null;
    this.allowsEarlyWithdrawal = opts.allowsEarlyWithdrawal ?? false;
  }
}

/**
 * FourOhOneKAccount — US employer-sponsored retirement account.
 * US only. Penalty-free withdrawals from age 59.5.
 * Contributions are pre-tax (reduce ordinary income); earnings are ordinary income on withdrawal.
 * Tracks balance at residency change.
 */
export class FourOhOneKAccount extends RetirementAccount {
  /**
   * @param {number} balance
   * @param {object} [opts] - All RetirementAccount opts; type, country, currency, minimumAge set automatically
   */
  constructor(balance = 0, opts = {}) {
    super(balance, {
      country:               opts.country               ?? 'US',
      currency:              opts.currency              ?? USD,
      minimumAge:            opts.minimumAge            ?? 59.5,
      allowsEarlyWithdrawal: opts.allowsEarlyWithdrawal ?? true,
      ...opts,
      type: ACCOUNT_TYPE.FOUR_OH_ONE_K,
    });
  }
}

/**
 * RothAccount — US after-tax retirement account.
 * US only. Penalty-free withdrawals from age 59.5 (IRS rule).
 * Contributions are post-tax; qualified withdrawals are tax-free.
 * Tracks balance at residency change.
 */
export class RothAccount extends RetirementAccount {
  /**
   * @param {number} balance
   * @param {object} [opts] - All RetirementAccount opts; type, country, currency, minimumAge set automatically
   */
  constructor(balance = 0, opts = {}) {
    super(balance, {
      country:               opts.country               ?? 'US',
      currency:              opts.currency              ?? USD,
      minimumAge:            opts.minimumAge            ?? 59.5,
      allowsEarlyWithdrawal: opts.allowsEarlyWithdrawal ?? true,
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
export class TraditionalIRAAccount extends RetirementAccount {
  /**
   * @param {number} balance
   * @param {object} [opts] - All RetirementAccount opts; type, country, currency, minimumAge set automatically
   */
  constructor(balance = 0, opts = {}) {
    super(balance, {
      country:               opts.country               ?? 'US',
      currency:              opts.currency              ?? USD,
      minimumAge:            opts.minimumAge            ?? 60,
      allowsEarlyWithdrawal: opts.allowsEarlyWithdrawal ?? true,
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
export class SuperannuationAccount extends RetirementAccount {
  /**
   * @param {number} balance
   * @param {object} [opts] - All RetirementAccount opts; type, country, currency, minimumAge set automatically
   */
  constructor(balance = 0, opts = {}) {
    super(balance, {
      country:    opts.country    ?? 'AU',
      currency:   opts.currency   ?? AUD,
      minimumAge: opts.minimumAge ?? 60,
      ...opts,
      type: ACCOUNT_TYPE.SUPER,
    });
  }
}
