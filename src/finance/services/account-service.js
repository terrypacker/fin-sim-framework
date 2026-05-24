/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseService } from '../../services/base-service.js';
import { EventBus } from '../../simulation-framework/event-bus.js';
import { InsufficientFundsError } from '../account.js';

/**
 * AccountService — manages Account instances on the service bus and provides
 * stateless ledger operations.
 *
 * Extends BaseService so accounts are stored in a Map<id, Account> and
 * participate in the ServiceActionEvent lifecycle (CREATE / UPDATE / DELETE).
 *
 * The bus parameter is optional; if omitted an internal EventBus is created.
 * This preserves backward compatibility with code that calls
 * `new AccountService()` purely for the stateless domain methods.
 *
 * Accounts are persisted as part of the scenario configuration via
 * ScenarioSerializer.
 */
export class AccountService extends BaseService {
  /**
   * @param {import('../../simulation-framework/event-bus.js').EventBus} [bus]
   */
  constructor(bus = null) {
    super(bus ?? new EventBus(), 'ac');
  }

  // ─── Create ───────────────────────────────────────────────────────────────

  /**
   * Register a pre-built account, assign a service-generated id, and publish CREATE.
   *
   * @param {import('../account.js').Account} account
   * @returns {import('../account.js').Account}
   */
  createAccount(account) {
    account.id = this._generateId(this._idPrefix);
    this._register(account);
    this._publish('CREATE', 'Account', account);
    return account;
  }

  // ─── Update ───────────────────────────────────────────────────────────────

  /**
   * Apply `changes` to an existing account and publish UPDATE.
   *
   * @param {string|import('../account.js').Account} idOrAccount
   * @param {object} changes
   * @returns {import('../account.js').Account}
   */
  updateAccount(idOrAccount, changes = {}) {
    const account = this._resolve(idOrAccount);
    const original = { ...account };
    Object.assign(account, changes);
    this._publish('UPDATE', 'Account', account, original);
    return account;
  }

  // ─── Delete ───────────────────────────────────────────────────────────────

  /**
   * Remove an account from the service map and publish DELETE.
   *
   * @param {string|import('../account.js').Account} idOrAccount
   * @returns {import('../account.js').Account}
   */
  deleteAccount(idOrAccount) {
    const account = this._resolve(idOrAccount);
    this._unregister(account.id);
    this._publish('DELETE', 'Account', account, account);
    return account;
  }

  // ─── Ledger operations ────────────────────────────────────────────────────

  /**
   * Perform a transaction on an account.
   * Positive amount → credit; negative amount → debit.
   * @param {import('../account.js').Account} account
   * @param {number}  amount
   * @param {Date}    date
   */
  transaction(account, amount, date) {
    if (amount > 0) {
      account.credits.push({ amount, date });
    } else if (amount < 0) {
      account.debits.push({ amount, date });
    }
    account.balance = account.balance + amount;
  }

  /**
   * Returns the balance attributable to one person.
   * Joint ownership splits the balance 50/50.
   * @param {import('../account.js').Account} account
   * @returns {number}
   */
  getPersonShare(account) {
    return account.ownershipType === 'joint' ? account.balance / 2 : account.balance;
  }

  /**
   * Returns true if debiting amount would not breach minimumBalance.
   * @param {import('../account.js').Account} account
   * @param {number}  amount  - Positive value representing the debit size
   * @returns {boolean}
   */
  canDebit(account, amount) {
    return account.balance - amount >= (account.minimumBalance ?? 0);
  }

  /**
   * Applies a debit only if it won't breach minimumBalance.
   * @param {import('../account.js').Account} account
   * @param {number}  amount  - Positive value representing the debit size
   * @param {Date}    date
   * @returns {boolean} true if the debit was applied; false if rejected
   */
  safeDebit(account, amount, date) {
    if (!this.canDebit(account, amount)) return false;
    this.transaction(account, -amount, date);
    return true;
  }

  /**
   * Snapshots the current balance as balanceAtResidencyChange (one-time capture).
   * Only operates on accounts that carry the balanceAtResidencyChange field
   * (i.e. InvestmentAccount instances).  No-op on plain Account objects.
   * @param {import('../account.js').Account} account
   */
  recordResidencyChange(account) {
    if ('balanceAtResidencyChange' in account && account.balanceAtResidencyChange === null) {
      account.balanceAtResidencyChange = account.balance;
    }
  }

  /**
   * Returns true if the person meets the account's minimum age requirement.
   * If the account has no minimumAge (null or field absent) always returns true.
   * Uses decimal age to support the 59.5-year gate (401k).
   * @param {import('../account.js').Account} account
   * @param {import('../person.js').Person} person
   * @param {Date}    asOfDate
   * @returns {boolean}
   */
  isWithdrawalEligible(account, person, asOfDate) {
    if (!('minimumAge' in account) || account.minimumAge === null) return true;
    const msPerYear  = 365.25 * 24 * 60 * 60 * 1000;
    const ageDecimal = (asOfDate - person.birthDate) / msPerYear;
    return ageDecimal >= account.minimumAge;
  }

  /**
   * Draws down investment accounts in the same country as the target savings
   * account to cover a deficit, crediting the savings account as each source
   * account is debited.
   *
   * Discovery: iterates all values in `state` that are plain objects with a
   * numeric `balance`, share the target account's `country`, and have a
   * non-null `drawdownPriority`.  Accounts are processed in ascending priority
   * order.  Age-gated accounts (those with a `minimumAge` field) are skipped
   * when the person has not yet reached that age (decimal-year check).
   *
   * Throws InsufficientFundsError if the deficit cannot be fully covered after
   * exhausting all eligible accounts.  State is partially mutated up to the
   * point of exhaustion — callers should proceed with whatever was deposited.
   *
   * @param {object} state      - Current simulation state
   * @param {string} targetKey  - State key for the savings account to credit
   * @param {number} deficit    - Amount that must be deposited into targetKey
   * @param {Date}   date       - As-of date (used for age-gate checks)
   * @throws {InsufficientFundsError}
   */
  replenishSavings(state, targetKey, deficit, date) {
    const targetAccount = state[targetKey];
    const country       = targetAccount.country;
    const currency      = targetAccount.currency?.code ?? country;
    const person        = { birthDate: state.personBirthDate };

    // Discover all drawdown sources: objects in state with a drawdownPriority,
    // belonging to the same country, excluding the target account itself.
    const sources = Object.entries(state)
      .filter(([k, v]) =>
        k !== targetKey &&
        v !== null &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        'balance' in v &&
        'drawdownPriority' in v &&
        v.drawdownPriority !== null &&
        v.country === country
      )
      .sort(([, a], [, b]) => a.drawdownPriority - b.drawdownPriority);

    let remaining = deficit;
    for (const [, account] of sources) {
      if (account.balance <= 0) continue;
      if (!this.isWithdrawalEligible(account, person, date)) continue;

      const withdraw = Math.min(remaining, account.balance);
      this.transaction(targetAccount, +withdraw, date);
      this.transaction(account,       -withdraw, date);
      remaining -= withdraw;
      if (remaining < 1e-9) { remaining = 0; break; }
    }

    if (remaining > 1e-9) {
      throw new InsufficientFundsError(country, currency, remaining);
    }
  }
}
