/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { AssetService } from './asset-service.js';
import { EventBus } from '../../simulation-framework/event-bus.js';
import { InsufficientFundsError, ACCOUNT_TYPE } from '../assets/account.js';
import { getUsEarlyWithdrawalRules } from '../account-rules/us/us-early-withdrawal-rules.js';

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
export class AccountService extends AssetService {
  /**
   * @param {import('../../graph/graph.js').Graph} [graph]
   * @param query - graph query api
   * @param {import('../../simulation-framework/event-bus.js').EventBus} [bus]
   */
  constructor(graph, query, bus) {
    super(graph, query, bus, 'account', 2, false);
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
    this._publish('CREATE', account);
    this._wireNodeEdges(account);
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
    this.mergeChanges(account, changes);
    this._publish('UPDATE', account, original);
    this._wireNodeEdges(account);
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
    this._publish('DELETE', account);
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
    account.balance = account.balance + amount;
  }

  /**
   * Reconstruct the transaction history for an account from the simulation journal.
   * Accepts either an account ID or a state key (the property name on the state object,
   * e.g. 'usSavingsAccount'). When given an ID, resolves to the stateKey via the
   * account's stamped stateKey property (set by SimulationState._assignAccount).
   *
   * @param {string}  accountIdOrKey  - Account ID or state key
   * @param {import('../../simulation-framework/journal.js').Journal} journal
   * @returns {{ date: Date, amount: number, eventType: string, reducer: string }[]}
   */
  getAccountHistory(accountIdOrKey, journal) {
    let stateKey = accountIdOrKey;
    const byId = this.getAll().find(a => a.id === accountIdOrKey);
    if (byId?.stateKey) stateKey = byId.stateKey;

    const field = `${stateKey}.balance`;
    const results = [];
    for (const entry of journal.journal) {
      if (!entry.stateDiff) continue;
      const diff = entry.stateDiff.find(d => d.field === field);
      if (diff?.delta != null) {
        results.push({
          date: entry.date,
          amount: diff.delta,
          balanceAfter: diff.after,
          event: entry.event,
          reducer: entry.reducer
        });
      }
    }
    return results;
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
   * Two-phase drawdown (EW requirements):
   *
   * Phase 1 — penalty-free sources, in drawdownPriority order:
   *   a) Age-eligible accounts (isWithdrawalEligible → true): full balance drawn normally.
   *   b) Roth accounts below minimumAge: contributionBasis drawn first — contributions
   *      are always accessible without penalty or tax (EVT-2 / EW-2).
   *
   * Phase 2 — early withdrawal, in drawdownPriority order:
   *   Only when phase 1 cannot cover the deficit.  Draws from accounts where
   *   allowsEarlyWithdrawal is true and the person is below minimumAge.
   *   - Roth: earningsBasis only (contributions already exhausted in phase 1).
   *   - IRA: contributions then earnings — same tax treatment, different basis fields.
   *   - 401k: full balance — earnings then contributions for basis tracking.
   *   Penalty is deducted from the cash deposited to the target (EW-6).
   *   Basis fields (contributionBasis, earningsBasis) are updated alongside balance.
   *   Tax action objects are collected and returned for callers to chain (EW-7).
   *
   * Throws InsufficientFundsError if the deficit cannot be fully covered after
   * exhausting all eligible and early-withdrawal accounts.  State is partially
   * mutated up to the point of exhaustion.
   *
   * @param {object}   state      - Current simulation state
   * @param {string}   targetKey  - State key for the savings account to credit
   * @param {number}   deficit    - Amount that must be deposited into targetKey
   * @param {Date}     date       - As-of date (used for age-gate checks)
   * @param {Function} [earlyWithdrawalRulesFn] - (accountType) → { penaltyRate, ageThreshold } | null
   * @returns {{ drawnKeys: string[], pendingTaxActions: object[] }}
   * @throws {InsufficientFundsError}
   */
  replenishSavings(state, targetKey, deficit, date, earlyWithdrawalRulesFn = getUsEarlyWithdrawalRules) {
    const targetAccount = state[targetKey];
    const country       = targetAccount.country;
    const currency      = targetAccount.currency?.code ?? country;
    const msPerYear     = 365.25 * 24 * 60 * 60 * 1000;
    const ageDecimal    = (date - state.personBirthDate) / msPerYear;
    const isAuResident  = state.isAuResident ?? false;

    // Discover all drawdown sources in priority order.
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

    let remaining         = deficit;
    const drawnKeys       = [];
    const pendingTaxActions = [];

    // ── Phase 1: penalty-free sources ─────────────────────────────────────────
    for (const [key, account] of sources) {
      if (remaining < 1e-9) break;

      if (this.isWithdrawalEligible(account, { birthDate: state.personBirthDate }, date)) {
        // Normal eligible withdrawal.
        if (account.balance <= 0) continue;
        const withdraw = Math.min(remaining, account.balance);
        this.transaction(targetAccount, +withdraw, date);
        this.transaction(account,       -withdraw, date);

        // For brokerage accounts with unrealised gains: compute proportional
        // capital gain, update basis, and emit STOCK_WITHDRAWAL_TAX so the gain
        // is tracked for Form 8949 and the YTD capital-gains accumulator.
        if (account.type === ACCOUNT_TYPE.BROKERAGE && 'earningsBasis' in account) {
          const totalBal  = account.balance + withdraw; // balance before transaction
          const gainRatio = totalBal > 0 ? (account.earningsBasis ?? 0) / totalBal : 0;
          const gain      = withdraw * gainRatio;
          const saleCost  = withdraw - gain;
          account.earningsBasis     = Math.max(0, (account.earningsBasis ?? 0) - gain);
          account.contributionBasis = Math.max(0, (account.contributionBasis ?? 0) - saleCost);
          pendingTaxActions.push({
            type: 'STOCK_WITHDRAWAL_TAX', gain, isAuResident,
            proceeds: withdraw, costBasis: saleCost, description: account.name ?? key,
          });
        }

        drawnKeys.push(key);
        remaining -= withdraw;

      } else if (account.type === ACCOUNT_TYPE.ROTH && (account.contributionBasis ?? 0) > 0) {
        // Roth contributions are always accessible without penalty (EW-2).
        const available = Math.min(account.contributionBasis, account.balance);
        if (available <= 0) continue;
        const withdraw = Math.min(remaining, available);
        this.transaction(targetAccount, +withdraw, date);
        this.transaction(account,       -withdraw, date);
        account.contributionBasis -= withdraw;
        if (!drawnKeys.includes(key)) drawnKeys.push(key);
        remaining -= withdraw;
      }
    }

    if (remaining < 1e-9) {
      return { drawnKeys, pendingTaxActions };
    }

    // ── Phase 2: early withdrawal (with penalty) ──────────────────────────────
    for (const [key, account] of sources) {
      if (remaining < 1e-9) break;
      if (!account.allowsEarlyWithdrawal) continue;
      if (this.isWithdrawalEligible(account, { birthDate: state.personBirthDate }, date)) continue;

      const rules = earlyWithdrawalRulesFn(account.type);
      if (!rules) continue;

      const penaltyRate = ageDecimal < rules.ageThreshold ? rules.penaltyRate : 0;
      const netFactor   = 1 - penaltyRate;

      if (account.type === ACCOUNT_TYPE.ROTH) {
        // Phase 1 already drew contributions; only earningsBasis remains.
        const earningsAvail = Math.min(account.earningsBasis ?? 0, account.balance);
        if (earningsAvail <= 0) continue;

        // Gross up: to net `remaining` after penalty, we must withdraw remaining/netFactor.
        const grossNeeded = netFactor > 0 ? remaining / netFactor : remaining;
        const gross       = Math.min(grossNeeded, earningsAvail);
        const net         = gross * netFactor;
        const penalty     = gross * penaltyRate;

        this.transaction(targetAccount, +net,   date);
        this.transaction(account,       -gross, date);
        account.earningsBasis = (account.earningsBasis ?? 0) - gross;
        if (!drawnKeys.includes(key)) drawnKeys.push(key);
        pendingTaxActions.push({ type: 'ROTH_WITHDRAWAL_EARNINGS_TAX', amount: gross, penaltyAmount: penalty, isAuResident });
        remaining -= net;

      } else if (account.type === ACCOUNT_TYPE.TRADITIONAL_IRA) {
        if (account.balance <= 0) continue;

        const grossNeeded = netFactor > 0 ? remaining / netFactor : remaining;
        const grossCapped = Math.min(grossNeeded, account.balance);

        // Draw contributions first, then earnings.
        const contribPortion  = Math.min(grossCapped, account.contributionBasis ?? 0);
        const earningsPortion = grossCapped - contribPortion;

        const net     = grossCapped * netFactor;
        const penalty = grossCapped * penaltyRate;

        this.transaction(targetAccount, +net,        date);
        this.transaction(account,       -grossCapped, date);
        account.contributionBasis = (account.contributionBasis ?? 0) - contribPortion;
        account.earningsBasis     = (account.earningsBasis     ?? 0) - earningsPortion;
        if (!drawnKeys.includes(key)) drawnKeys.push(key);

        if (contribPortion > 0) {
          pendingTaxActions.push({ type: 'IRA_WITHDRAWAL_CONTRIB_TAX', amount: contribPortion, penaltyAmount: contribPortion * penaltyRate });
        }
        if (earningsPortion > 0) {
          pendingTaxActions.push({ type: 'IRA_WITHDRAWAL_EARNINGS_TAX', amount: earningsPortion, penaltyAmount: earningsPortion * penaltyRate, isAuResident });
        }
        remaining -= net;

      } else if (account.type === ACCOUNT_TYPE.FOUR_OH_ONE_K) {
        if (account.balance <= 0) continue;

        const grossNeeded = netFactor > 0 ? remaining / netFactor : remaining;
        const gross       = Math.min(grossNeeded, account.balance);
        const net         = gross * netFactor;
        const penalty     = gross * penaltyRate;

        // 401k draws earnings first, then contributions (mirrors K401WithdrawalApplyReducer).
        const fromEarnings = Math.min(gross, account.earningsBasis ?? 0);
        const fromContrib  = gross - fromEarnings;

        this.transaction(targetAccount, +net,   date);
        this.transaction(account,       -gross, date);
        account.earningsBasis     = (account.earningsBasis     ?? 0) - fromEarnings;
        account.contributionBasis = (account.contributionBasis ?? 0) - fromContrib;
        if (!drawnKeys.includes(key)) drawnKeys.push(key);
        pendingTaxActions.push({ type: 'K401_WITHDRAWAL_TAX', amount: gross, penaltyAmount: penalty });
        remaining -= net;
      }
    }

    if (remaining > 1e-9) {
      throw new InsufficientFundsError(country, currency, remaining);
    }
    return { drawnKeys, pendingTaxActions };
  }
}
