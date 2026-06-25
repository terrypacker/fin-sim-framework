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
import { getBirthDate, getResidency } from '../residency-utils.js';
import { Holding } from '../holdings/holding.js';
import { resolveDefaultAllocation, resolveRateKey } from '../holdings/default-allocations.js';
import { rescaleHoldingsToBalance } from '../holdings/holding-utils.js';
import { ACCOUNT_ROLES } from '../state/account-roles.js';

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
    this._nextHoldingSeq = 1;
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
    this._bootstrapDefaultHolding(account);
    this._register(account);
    this._publish('CREATE', account);
    this._wireNodeEdges(account);
    return account;
  }

  /**
   * Override BaseService.register() so the deserialize path also runs the
   * default-holding bootstrap. Idempotent — re-registering an account that
   * already has holdings is a no-op.
   *
   * @param {import('../account.js').Account} account
   * @returns {import('../account.js').Account}
   */
  register(account) {
    this._bootstrapDefaultHolding(account);
    return super.register(account);
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
    // §4.4 invariant: a balance edit that doesn't also supply holdings (e.g. a
    // param cascade or programmatic balance change) must rescale holdings to the
    // new balance, otherwise Σ marketValue drifts away from account.balance.
    if ('balance' in changes && !('holdings' in changes) &&
        Array.isArray(account.holdings) && account.holdings.length > 0) {
      rescaleHoldingsToBalance(account.holdings, account.balance);
    }
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

  // ─── Holdings ─────────────────────────────────────────────────────────────

  /**
   * Bootstrap one default Holding when an account has none. Matches the
   * scalar balance as marketValue/costBasis so the §4.4 invariant
   * (account.balance === Σ holdings[i].marketValue) holds at boot.
   *
   * Idempotent: a non-empty holdings array is left untouched.
   *
   * @param {import('../account.js').Account} account
   */
  _bootstrapDefaultHolding(account) {
    if (!account) return;
    if (!Array.isArray(account.holdings)) account.holdings = [];
    if (account.holdings.length > 0) return;
    const allocation = resolveDefaultAllocation(account);
    const rateKey    = resolveRateKey(account.country, allocation, account.role);
    const holding    = new Holding({
      id:           this._generateHoldingId(),
      allocation,
      marketValue:  account.balance ?? 0,
      costBasis:    account.balance ?? 0,
      rateKey,
      purchaseDate: null,
      label:        '',
    });
    account.holdings = [holding];
  }

  /** Service-scoped monotonic id for Holdings (`hld1`, `hld2`, …). */
  _generateHoldingId() {
    return `hld${this._nextHoldingSeq++}`;
  }

  /**
   * Add a holding to an already-registered account, assign an id, and
   * publish HOLDING_REGISTERED on the bus so the workbench/runtime can
   * react. UI-side flow — does not go through the action pipeline.
   *
   * @param {import('../account.js').Account} account
   * @param {object|import('../holdings/holding.js').Holding} holdingSpec
   * @returns {import('../holdings/holding.js').Holding}
   */
  registerHolding(account, holdingSpec) {
    const holding = holdingSpec instanceof Holding
      ? holdingSpec
      : new Holding(holdingSpec);
    if (holding.id == null) holding.id = this._generateHoldingId();
    if (holding.rateKey == null) {
      holding.rateKey = resolveRateKey(account.country, holding.allocation, account.role);
    }
    account.holdings = [...(account.holdings ?? []), holding];
    this._publish('HOLDING_REGISTERED', account);
    return holding;
  }

  /** Derived: marketValue − costBasis. Not stored on state. */
  unrealizedGainLoss(holding) {
    if (!holding) return 0;
    return (holding.marketValue ?? 0) - (holding.costBasis ?? 0);
  }

  /**
   * Return the first holding matching (allocation, rateKey) or create one
   * with marketValue=0, costBasis=0 if absent. Used by contribution handlers
   * to land deposits in the right sleeve.
   *
   * @param {import('../account.js').Account} account
   * @param {string} allocation - ALLOCATION value
   * @param {string|null} [rateKey] - Optional rateKey filter; resolved when absent
   * @returns {import('../holdings/holding.js').Holding}
   */
  findOrCreateHolding(account, allocation, rateKey = null) {
    const key = rateKey ?? resolveRateKey(account.country, allocation, account.role);
    const existing = (account.holdings ?? []).find(
      h => h.allocation === allocation && h.rateKey === key
    );
    if (existing) return existing;
    const created = new Holding({
      id:          this._generateHoldingId(),
      allocation,
      marketValue: 0,
      costBasis:   0,
      rateKey:     key,
    });
    account.holdings = [...(account.holdings ?? []), created];
    return created;
  }

  /** Convenience for handlers that don't care which sleeve they hit. */
  defaultHoldingFor(account) {
    return account?.holdings?.[0] ?? null;
  }

  /** Filtered view by ALLOCATION. */
  holdingsByAllocation(account, allocation) {
    return (account?.holdings ?? []).filter(h => h.allocation === allocation);
  }

  // ─── Ledger operations ────────────────────────────────────────────────────

  /**
   * Perform a transaction on an account.
   * Positive amount → credit; negative amount → debit.
   *
   * Maintains the §4.4 holdings invariant (balance === Σ holdings.marketValue)
   * for accounts with ANY number of holdings by pro-rating the cash movement
   * across the sleeves, weighted by each sleeve's current market value:
   *   - Debit  → reduce each sleeve's marketValue (and its costBasis, in
   *              proportion to the value removed), floored at zero.
   *   - Credit → add to each sleeve's marketValue and costBasis (deposited cash
   *              carries basis equal to its market value).
   * The last sleeve absorbs the residual so Σ marketValue changes by exactly
   * `amount`, keeping it in lockstep with the (unrounded) balance update — this
   * matters because the next earnings event re-syncs balance to Σ marketValue
   * (HoldingTransactReducer._syncBalance); without pro-rating, multi-holding
   * drawdowns desync and the year-end re-sync silently restores the balance,
   * erasing every within-year withdrawal.
   *
   * Pro-rata (rather than FIFO lot ordering) is the right default here because
   * `transaction()` is the generic cash-movement primitive and does not compute
   * realized gains; sale paths that need lot accounting use the dedicated
   * STOCK_WITHDRAWAL reducer with consumeHoldingsFifo instead.
   *
   * @param {import('../account.js').Account} account
   * @param {number}  amount
   * @param {Date}    date
   */
  transaction(account, amount, date) {
    account.balance = account.balance + amount;

    const holdings = account.holdings;
    if (!Array.isArray(holdings) || holdings.length === 0 || amount === 0) return;

    const last    = holdings.length - 1;
    const totalMv = holdings.reduce((s, h) => s + Math.max(0, h?.marketValue ?? 0), 0);

    if (amount < 0) {
      // Debit (drawdown / transfer-out): pro-rate the withdrawal across sleeves
      // by market value, consuming each sleeve's cost basis in proportion to the
      // value removed, and never drive a position (or its basis) below zero.
      if (totalMv <= 0) return;
      const toRemove = Math.min(-amount, totalMv);
      let removed = 0;
      holdings.forEach((h, i) => {
        const mv   = Math.max(0, h.marketValue ?? 0);
        const sold = i === last
          ? Math.min(mv, toRemove - removed)
          : Math.min(mv, toRemove * (mv / totalMv));
        removed += sold;
        const basisShare = mv > 0 ? (h.costBasis ?? 0) * (sold / mv) : 0;
        h.marketValue = Math.max(0, mv - sold);
        h.costBasis   = Math.max(0, (h.costBasis ?? 0) - basisShare);
      });
    } else {
      // Credit (contribution / sale proceeds / transfer-in): distribute across
      // sleeves by market value; the deposited cash carries basis equal to its
      // market value. With no market value to weight against, land the whole
      // credit in the first sleeve.
      if (totalMv <= 0) {
        const h = holdings[0];
        h.marketValue = (h.marketValue ?? 0) + amount;
        h.costBasis   = (h.costBasis   ?? 0) + amount;
        return;
      }
      let added = 0;
      holdings.forEach((h, i) => {
        const mv    = Math.max(0, h.marketValue ?? 0);
        const share = i === last ? amount - added : amount * (mv / totalMv);
        added += share;
        h.marketValue = (h.marketValue ?? 0) + share;
        h.costBasis   = (h.costBasis   ?? 0) + share;
      });
    }
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
   * @param {Function|object} [opts] - Legacy: earlyWithdrawalRulesFn. New: { personKey?, earlyWithdrawalRulesFn? }
   * @returns {{ drawnKeys: string[], pendingTaxActions: object[] }}
   * @throws {InsufficientFundsError}
   */
  replenishSavings(state, targetKey, deficit, date, opts = {}) {
    const earlyWithdrawalRulesFn = typeof opts === 'function'
      ? opts
      : (opts.earlyWithdrawalRulesFn ?? getUsEarlyWithdrawalRules);
    const targetAccount = state[targetKey];
    const country       = targetAccount.country;
    const currency      = targetAccount.currency?.code ?? country;
    const msPerYear     = 365.25 * 24 * 60 * 60 * 1000;
    const personKey     = (typeof opts === 'object' ? opts.personKey : null)
                          ?? targetAccount.ownerId
                          ?? Object.keys(state.people ?? {})[0];
    const birthDate     = getBirthDate(state, personKey);
    const ageDecimal    = birthDate ? (date - birthDate) / msPerYear : 0;
    const residency     = getResidency(state, personKey);

    // Cross-border drawdown policy (design: tax-efficient global drawdown).
    // GLOBAL lets sources in either country compete in one drawdownPriority
    // order; each cross-currency draw is converted to the target currency via
    // fxToTarget. LOCAL_FIRST (default) keeps the historical same-country gating,
    // escalating to INTL_TRANSFER once the local country is exhausted.
    const globalDrawdown = state.crossBorderDrawdown === 'GLOBAL';
    const usdAud         = state.effectiveExchangeRates?.USD_AUD ?? 1.55; // 1 USD = usdAud AUD
    // Units of the target `currency` obtained per 1 unit of `srcCcy`.
    const fxToTarget = (srcCcy) => {
      const src = srcCcy ?? currency;
      if (src === currency) return 1;
      const usdPerUnit  = c => (c === 'AUD' ? 1 / usdAud : 1); // value of 1 unit in USD
      const unitsPerUsd = c => (c === 'AUD' ? usdAud : 1);
      return usdPerUnit(src) * unitsPerUsd(currency);
    };
    const fxOf = (account) =>
      globalDrawdown ? fxToTarget(account.currency?.code ?? account.country) : 1;
    // Fixed per-transfer FX fee (same source as IntlTransferApplyReducer: a flat
    // USD amount), converted to the target currency and charged once per
    // cross-border draw. Same-currency draws (fx === 1) pay nothing.
    const fxFeeUsd  = state.effectiveFxFees?.USD_AUD ?? 15;
    const fxFeeTgt  = fxFeeUsd * (currency === 'AUD' ? usdAud : 1);
    const feeOf = (account) => (fxOf(account) !== 1 ? fxFeeTgt : 0);

    // Discover all drawdown sources in priority order.
    const cashBucketActive = state.regimeActions?.drawdown_source_override?.active ?? false;
    const _CASH_FIRST_ROLES = new Set([ACCOUNT_ROLES.FIXED_INCOME, ACCOUNT_ROLES.AU_FIXED_INCOME, ACCOUNT_ROLES.AU_SAVINGS]);
    const sources = Object.entries(state)
      .filter(([k, v]) =>
        k !== targetKey &&
        v !== null &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        'balance' in v &&
        'drawdownPriority' in v &&
        v.drawdownPriority !== null &&
        (globalDrawdown || v.country === country)
      )
      .sort(([, a], [, b]) => {
        if (cashBucketActive) {
          // Cash bucket: fixed income / savings first (tier 0), equities last (tier 1)
          const tierA = _CASH_FIRST_ROLES.has(a.role) ? 0 : 1;
          const tierB = _CASH_FIRST_ROLES.has(b.role) ? 0 : 1;
          if (tierA !== tierB) return tierA - tierB;
        }
        return a.drawdownPriority - b.drawdownPriority;
      });

    let remaining         = deficit;
    const drawnKeys       = [];
    const pendingTaxActions = [];

    // ── Phase 1: penalty-free sources ─────────────────────────────────────────
    // Resolve per-account withdrawal eligibility using the owner's birth date.
    const eligibleOf = (account) => {
      const acctBirthDate = (account.ownerId && account.ownerId !== personKey)
        ? (getBirthDate(state, account.ownerId) ?? birthDate)
        : birthDate;
      return this.isWithdrawalEligible(account, { birthDate: acctBirthDate }, date);
    };

    if (state.drawdownMode === 'PROPORTIONAL') {
      // Pro-rata: split the deficit across penalty-free available balances in
      // proportion to each source's availability. Loop because per-account caps
      // can leave a small residual after a pass; the guard + no-progress check
      // prevent an infinite loop.
      let guard = 0;
      while (remaining >= 1e-9 && guard++ < 100) {
        const avail = sources
          .map(([key, account]) => {
            const eligible = eligibleOf(account);
            const fx = fxOf(account);
            // _penaltyFreeAvailable is in the source currency; weight pro-rata by
            // the target-currency value so cross-border sources contribute fairly.
            return { key, account, eligible, fx, amt: this._penaltyFreeAvailable(account, eligible) * fx };
          })
          .filter(s => s.amt > 1e-9);
        const total = avail.reduce((sum, a) => sum + a.amt, 0);
        if (total < 1e-9) break;

        const target = Math.min(remaining, total);
        let drawnThisPass = 0;
        for (const s of avail) {
          if (remaining < 1e-9) break;
          const want = Math.min(target * (s.amt / total), remaining);
          const got  = this._drawPenaltyFree(
            targetAccount, s.account, s.key, want, date, s.eligible, residency, drawnKeys, pendingTaxActions, s.fx, feeOf(s.account)
          );
          remaining     -= got;
          drawnThisPass += got;
        }
        if (drawnThisPass < 1e-9) break;
      }
    } else {
      // Ordered: walk sources in drawdownPriority order, draining each fully.
      for (const [key, account] of sources) {
        if (remaining < 1e-9) break;
        remaining -= this._drawPenaltyFree(
          targetAccount, account, key, remaining, date, eligibleOf(account), residency, drawnKeys, pendingTaxActions, fxOf(account), feeOf(account)
        );
      }
    }

    if (remaining < 1e-9) {
      return { drawnKeys, pendingTaxActions };
    }

    // ── Phase 2: early withdrawal (with penalty) ──────────────────────────────
    for (const [key, account] of sources) {
      if (remaining < 1e-9) break;
      if (!account.allowsEarlyWithdrawal) continue;
      const acctBirthDate2 = (account.ownerId && account.ownerId !== personKey)
        ? (getBirthDate(state, account.ownerId) ?? birthDate)
        : birthDate;
      const acctAgeDecimal = acctBirthDate2 ? (date - acctBirthDate2) / msPerYear : ageDecimal;
      if (this.isWithdrawalEligible(account, { birthDate: acctBirthDate2 }, date)) continue;

      const rules = earlyWithdrawalRulesFn(account.type);
      if (!rules) continue;

      const penaltyRate = acctAgeDecimal < rules.ageThreshold ? rules.penaltyRate : 0;
      const netFactor   = 1 - penaltyRate;

      // Source amounts (gross/net/penalty/tax) stay in the account's own currency;
      // only the cash that lands in the target savings and the `remaining` it
      // covers are converted. netNeeded is the deficit (plus the cross-border fee)
      // expressed in source currency, so a full draw nets `remaining` at the target.
      const fx        = fxOf(account);
      const fee       = feeOf(account);
      const netNeeded = (remaining + fee) / fx;

      if (account.type === ACCOUNT_TYPE.ROTH) {
        // Phase 1 already drew contributions; any residual balance is earnings.
        // Use the larger of tracked earningsBasis or implied earnings (balance minus
        // remaining contributions) to handle accounts where earningsBasis was never
        // explicitly initialised but the balance exceeds the contribution basis.
        const impliedEarnings = Math.max(0, account.balance - (account.contributionBasis ?? 0));
        const earningsAvail   = Math.min(Math.max(account.earningsBasis ?? 0, impliedEarnings), account.balance);
        if (earningsAvail <= 0) continue;

        // Gross up: to net `netNeeded` (source ccy) after penalty, withdraw netNeeded/netFactor.
        const grossNeeded = netFactor > 0 ? netNeeded / netFactor : netNeeded;
        const gross       = Math.min(grossNeeded, earningsAvail);
        const net         = gross * netFactor;
        const penalty     = gross * penaltyRate;

        const credited = net * fx - fee; // target currency, net of cross-border fee
        if (credited <= 0) continue;     // draw too small to clear the cross-border fee
        this.transaction(targetAccount, +credited, date);
        this.transaction(account,       -gross,    date);
        account.earningsBasis = Math.max(0, (account.earningsBasis ?? 0) - gross);
        if (!drawnKeys.includes(key)) drawnKeys.push(key);
        pendingTaxActions.push({ type: 'ROTH_WITHDRAWAL_EARNINGS_TAX', amount: gross, penaltyAmount: penalty, residency });
        remaining -= credited;

      } else if (account.type === ACCOUNT_TYPE.TRADITIONAL_IRA) {
        if (account.balance <= 0) continue;

        const grossNeeded = netFactor > 0 ? netNeeded / netFactor : netNeeded;
        const grossCapped = Math.min(grossNeeded, account.balance);

        // Draw contributions first, then earnings.
        const contribPortion  = Math.min(grossCapped, account.contributionBasis ?? 0);
        const earningsPortion = grossCapped - contribPortion;

        const net     = grossCapped * netFactor;
        const penalty = grossCapped * penaltyRate;

        const credited = net * fx - fee; // target currency, net of cross-border fee
        if (credited <= 0) continue;     // draw too small to clear the cross-border fee
        this.transaction(targetAccount, +credited,     date);
        this.transaction(account,       -grossCapped,  date);
        account.contributionBasis = (account.contributionBasis ?? 0) - contribPortion;
        account.earningsBasis     = (account.earningsBasis     ?? 0) - earningsPortion;
        if (!drawnKeys.includes(key)) drawnKeys.push(key);

        if (contribPortion > 0) {
          pendingTaxActions.push({ type: 'IRA_WITHDRAWAL_CONTRIB_TAX', amount: contribPortion, penaltyAmount: contribPortion * penaltyRate });
        }
        if (earningsPortion > 0) {
          pendingTaxActions.push({ type: 'IRA_WITHDRAWAL_EARNINGS_TAX', amount: earningsPortion, penaltyAmount: earningsPortion * penaltyRate, residency });
        }
        remaining -= credited;

      } else if (account.type === ACCOUNT_TYPE.FOUR_OH_ONE_K) {
        if (account.balance <= 0) continue;

        const grossNeeded = netFactor > 0 ? netNeeded / netFactor : netNeeded;
        const gross       = Math.min(grossNeeded, account.balance);
        const net         = gross * netFactor;
        const penalty     = gross * penaltyRate;

        // 401k draws earnings first, then contributions (mirrors K401WithdrawalApplyReducer).
        const fromEarnings = Math.min(gross, account.earningsBasis ?? 0);
        const fromContrib  = gross - fromEarnings;

        const credited = net * fx - fee; // target currency, net of cross-border fee
        if (credited <= 0) continue;     // draw too small to clear the cross-border fee
        this.transaction(targetAccount, +credited, date);
        this.transaction(account,       -gross,    date);
        account.earningsBasis     = (account.earningsBasis     ?? 0) - fromEarnings;
        account.contributionBasis = (account.contributionBasis ?? 0) - fromContrib;
        if (!drawnKeys.includes(key)) drawnKeys.push(key);
        pendingTaxActions.push({ type: 'K401_WITHDRAWAL_TAX', amount: gross, penaltyAmount: penalty });
        remaining -= credited;
      }
    }

    if (remaining > 1e-9) {
      throw new InsufficientFundsError(country, currency, remaining);
    }
    return { drawnKeys, pendingTaxActions };
  }

  /**
   * Penalty-free amount currently withdrawable from a single account:
   *   - eligible (age-gated) accounts → full balance
   *   - Roth below minimumAge        → contribution basis (always penalty-free)
   *   - everything else              → 0 (only reachable via phase-2 early withdrawal)
   */
  _penaltyFreeAvailable(account, eligible) {
    if (eligible) return Math.max(0, account.balance);
    if (account.type === ACCOUNT_TYPE.ROTH) {
      return Math.max(0, Math.min(account.contributionBasis ?? 0, account.balance));
    }
    return 0;
  }

  /**
   * Withdraw up to `want` from one account using only penalty-free sources,
   * crediting `targetAccount`. Mirrors the legacy phase-1 logic (brokerage
   * gain/basis tracking + STOCK_WITHDRAWAL_TAX, Roth contribution access) so the
   * ordered and proportional drawdown paths share identical tax/basis handling.
   * Appends any tax actions, records the key in drawnKeys, and returns the
   * amount actually withdrawn, expressed in the TARGET account's currency.
   *
   * `fx` is the units-of-target-currency per 1 unit of the source account's
   * currency (1 for same-currency / LOCAL_FIRST draws). `want` is in target
   * currency; the source is debited in its own currency and the target credited
   * the converted amount, less `fee` — a flat per-transfer FX cost in the target
   * currency, charged only on cross-border draws (fee is 0 when fx === 1). The
   * source draw is grossed up by the fee so the target still nets `want`.
   * Source-currency figures (basis, STOCK_WITHDRAWAL_TAX proceeds/gain) are
   * recorded natively so the source country's tax computation stays correct.
   */
  _drawPenaltyFree(targetAccount, account, key, want, date, eligible, residency, drawnKeys, pendingTaxActions, fx = 1, fee = 0) {
    if (want < 1e-9) return 0;
    // Gross up the source-side need by the fee so a full draw nets `want` at the
    // target after the wire cost is paid.
    const wantSrc = (want + fee) / fx;

    if (eligible) {
      if (account.balance <= 0) return 0;
      const withdraw = Math.min(wantSrc, account.balance); // source currency
      const credited = withdraw * fx - fee;                // target currency, net of fee
      if (credited <= 0) return 0;                         // draw too small to clear the fee
      this.transaction(targetAccount, +credited, date);
      this.transaction(account,       -withdraw, date);

      // Brokerage accounts with unrealised gains: proportional capital gain,
      // basis update, and STOCK_WITHDRAWAL_TAX for Form 8949 / YTD accumulator.
      if (account.type === ACCOUNT_TYPE.BROKERAGE && 'earningsBasis' in account) {
        const totalBal  = account.balance + withdraw; // balance before transaction
        const gainRatio = totalBal > 0 ? (account.earningsBasis ?? 0) / totalBal : 0;
        const gain      = withdraw * gainRatio;
        const saleCost  = withdraw - gain;
        account.earningsBasis     = Math.max(0, (account.earningsBasis ?? 0) - gain);
        account.contributionBasis = Math.max(0, (account.contributionBasis ?? 0) - saleCost);
        pendingTaxActions.push({
          type: 'STOCK_WITHDRAWAL_TAX', gain, residency,
          proceeds: withdraw, costBasis: saleCost, description: account.name || key,
        });
      }

      if (!drawnKeys.includes(key)) drawnKeys.push(key);
      return credited;
    }

    if (account.type === ACCOUNT_TYPE.ROTH && (account.contributionBasis ?? 0) > 0) {
      // Roth contributions are always accessible without penalty (EW-2).
      const available = Math.min(account.contributionBasis, account.balance);
      if (available <= 0) return 0;
      const withdraw = Math.min(wantSrc, available); // source currency
      const credited = withdraw * fx - fee;          // target currency, net of fee
      if (credited <= 0) return 0;
      this.transaction(targetAccount, +credited, date);
      this.transaction(account,       -withdraw, date);
      account.contributionBasis -= withdraw;
      if (!drawnKeys.includes(key)) drawnKeys.push(key);
      return credited;
    }

    return 0;
  }
}
