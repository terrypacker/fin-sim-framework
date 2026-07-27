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
import { deriveEarningsBasis } from '../assets/investment-account.js';
import { consumeHoldings } from '../holdings/holdings-fifo.js';
import { resolveDrawdownSelection, withRebalanceCoupling } from '../holdings/holdings-selection.js';
import { ACCOUNT_ROLES } from '../state/account-roles.js';
import { fxRate, fxFeeIn } from '../fx/fx-conversion.js';

// Cash/savings roles: drawn before investments (cash band) and liquid across the
// currency border in replenishSavings, and only ever drawn down to minimumBalance.
// Offset accounts (design 53 §3) are cash-like and liquid — they participate in
// the country cash pool for drawdown/replenish exactly like savings.
const SAVINGS_ROLES = new Set([
  ACCOUNT_ROLES.US_SAVINGS, ACCOUNT_ROLES.AU_SAVINGS,
  ACCOUNT_ROLES.US_OFFSET,  ACCOUNT_ROLES.AU_OFFSET,
]);

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
      account.holdings = rescaleHoldingsToBalance(account.holdings, account.balance);
    }
    // design 53 §8: on a retirement account, `earningsBasis` is DERIVED from
    // `balance − contributionBasis`, never hand-set. Re-derive the seed whenever an
    // edit moves either input (a config-time edit, not a runtime ledger mutation —
    // reducers evolve the ledger via sim.state, not updateAccount). Gated on the
    // ledger signature, like reconcileLedgerToBalance.
    if ('contributionBasis' in account &&
        ('balance' in changes || 'contributionBasis' in changes)) {
      deriveEarningsBasis(account);
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
    // Loans are scalar liabilities (design 54) — no asset allocation / holdings.
    if (account.type === ACCOUNT_TYPE.LOAN) return;
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

    // Copy-on-write: build a NEW array of NEW holding objects and reassign
    // account.holdings, never mutating the existing objects in place. A holding
    // already captured by a prior journal diff (stateDiff.after) stays frozen, so
    // the ledger's Holdings-Activity deltas can't be silently rewritten to a later
    // value (the journal-aliasing invariant; formerly papered over by state-utils'
    // _snapshot clone). `.map` runs its callback in index order, so the removed/
    // added running totals accumulate exactly as the prior in-place loop did.
    if (amount < 0) {
      // Debit (drawdown / transfer-out): pro-rate the withdrawal across sleeves
      // by market value, consuming each sleeve's cost basis in proportion to the
      // value removed, and never drive a position (or its basis) below zero.
      if (totalMv <= 0) return;
      const toRemove = Math.min(-amount, totalMv);
      let removed = 0;
      account.holdings = holdings.map((h, i) => {
        const mv   = Math.max(0, h.marketValue ?? 0);
        const sold = i === last
          ? Math.min(mv, toRemove - removed)
          : Math.min(mv, toRemove * (mv / totalMv));
        removed += sold;
        const basisShare = mv > 0 ? (h.costBasis ?? 0) * (sold / mv) : 0;
        return {
          ...h,
          marketValue: Math.max(0, mv - sold),
          costBasis:   Math.max(0, (h.costBasis ?? 0) - basisShare),
        };
      });
    } else {
      // Credit (contribution / sale proceeds / transfer-in): distribute across
      // sleeves by market value; the deposited cash carries basis equal to its
      // market value. With no market value to weight against, land the whole
      // credit in the first sleeve.
      if (totalMv <= 0) {
        account.holdings = holdings.map((h, i) => i === 0
          ? { ...h, marketValue: (h.marketValue ?? 0) + amount, costBasis: (h.costBasis ?? 0) + amount }
          : h);
        return;
      }
      let added = 0;
      account.holdings = holdings.map((h, i) => {
        const mv    = Math.max(0, h.marketValue ?? 0);
        const share = i === last ? amount - added : amount * (mv / totalMv);
        added += share;
        return {
          ...h,
          marketValue: (h.marketValue ?? 0) + share,
          costBasis:   (h.costBasis   ?? 0) + share,
        };
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
   *
   * When the destination country steps up the cost base on becoming resident
   * (`opts.stepUp`, e.g. AU ITAA97 s855-45), also resets the AU-style cost base
   * for non-TAP CGT assets — i.e. taxable BROKERAGE accounts only — to market
   * value at the move (design 36 §12.2). The step-up is stamped per-lot as
   * `holding.costBaseByCountry[country] = marketValue`; both the FIFO reducers and
   * the auto-liquidation drawdown path (design 53 Phase 1) read that per-lot base.
   * Retirement accounts (not CGT-taxed) and real property in the destination
   * country (TAP — handled by the RealPropertyService override) are not stepped up.
   *
   * @param {import('../account.js').Account} account
   * @param {{ country?: string, stepUp?: boolean, priceLevel?: number, asOfMs?: number }} [opts]
   *   destination country, its step-up policy, the destination country's price
   *   level at the move (for the AU CGT-reform indexation base, design 57 §6.3), and
   *   the move date in epoch ms (the CGT deemed-acquisition date — the ≥12-month
   *   discount/indexation clock restarts here, design 62 §4).
   */
  recordResidencyChange(account, { country, stepUp, priceLevel, asOfMs } = {}) {
    if ('balanceAtResidencyChange' in account && account.balanceAtResidencyChange === null) {
      account.balanceAtResidencyChange = account.balance;
    }
    if (stepUp && country && account.type === ACCOUNT_TYPE.BROKERAGE && Array.isArray(account.holdings)) {
      // Copy-on-write: build new holding objects rather than mutating each lot in
      // place, so a holdings array already recorded in the journal is never
      // rewritten after the fact (journal-immutability, enforced by state-utils'
      // freeze in dev/test). Unchanged lots pass through by reference.
      account.holdings = account.holdings.map(h => {
        if (!h) return h;
        const existing = h.costBaseByCountry ?? {};
        if (existing[country] != null) return h; // already stepped up for this country
        const next = { ...h, costBaseByCountry: { ...existing, [country]: h.marketValue ?? 0 } };
        // AU CGT reform (design 57 §6.3): the s855-45 step-up is the AU-deemed
        // acquisition, so the indexation base level is the AU price level at the
        // move. Stamp it alongside the stepped-up cost base (both gated on the
        // one-time step-up) so a later post-2027 sale indexes each cross-border
        // (US-brokerage equity + gold) sleeve from the residency date. Only stamp
        // when a level is supplied and none is already recorded.
        if (priceLevel != null && h.acquisitionPriceLevel == null) {
          next.acquisitionPriceLevel = priceLevel;
        }
        // Deemed-acquisition date (design 62 §4): the ≥12-month CGT-discount /
        // indexation clock for the destination country restarts at the move. Stamp
        // it per country so a later sale measures the holding period from the move,
        // not the (unchanged) purchaseDate. Only stamp when a move date is supplied
        // and none is already recorded for this country.
        if (asOfMs != null) {
          const existingDates = h.acquisitionDateByCountry ?? {};
          if (existingDates[country] == null) {
            next.acquisitionDateByCountry = { ...existingDates, [country]: asOfMs };
          }
        }
        return next;
      });
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
   * mutated up to the point of exhaustion — so the error carries a `partial`
   * field with the same `{drawnKeys, pendingTaxActions, crossBorderTransfers}`
   * shape as the success return.  A caller that swallows the error must still
   * drain `e.partial.pendingTaxActions`, or the gains the failed draw realized
   * escape tax entirely.
   *
   * @param {object}   state      - Current simulation state
   * @param {string}   targetKey  - State key for the savings account to credit
   * @param {number}   deficit    - Amount that must be deposited into targetKey
   * @param {Date}     date       - As-of date (used for age-gate checks)
   * @param {Function|object} [opts] - Legacy: earlyWithdrawalRulesFn. New: { personKey?, earlyWithdrawalRulesFn? }
   * @returns {{ drawnKeys: string[], pendingTaxActions: object[], crossBorderTransfers: object[] }}
   *   crossBorderTransfers are INTL_TRANSFER_RECORD action objects for each
   *   cross-currency cash leg swept inline (design 44 Gap A / A2).
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
    // Allocation-aware liquidation policy (design 65): which sleeve/lots each
    // penalty-free brokerage draw sells. Null (the default FIFO/FIFO) makes the
    // downstream consume byte-identical to the historic blind purchase-date FIFO.
    const drawSelection = resolveDrawdownSelection({
      sleeveOrderMode: state.drawdownSleeveOrder,
      lotStrategy:     state.drawdownLotStrategy,
      sleeveWeights:   state.drawdownSleeveWeights,
      rebalanceWeight: state.drawdownRebalanceWeight,
    });
    const usdAud         = state.effectiveExchangeRates?.USD_AUD ?? 1.55; // 1 USD = usdAud AUD
    const fxFeeUsd       = state.effectiveFxFees?.USD_AUD ?? 15;          // flat per-transfer fee, USD
    const srcCcyOf       = (account) => account.currency?.code ?? account.country;
    // Shared USD↔AUD conversion (design 44 §5a): units of the target `currency`
    // per 1 unit of the source, and the flat fee in target currency (0 for a
    // same-currency draw). Identical math to IntlTransferApplyReducer.
    const fxOf  = (account) => fxRate(srcCcyOf(account), currency, usdAud);
    const feeOf = (account) => fxFeeIn(currency, srcCcyOf(account), usdAud, fxFeeUsd);

    // Cash/savings roles are liquid everywhere: idle cash is spent before
    // investments (cash band, drawdownPriority 0) and is reachable across the
    // currency border even under LOCAL_FIRST — the non-residence cash pool is
    // repatriated (fxOf/feeOf apply) rather than left to strand. The active
    // target savings is still excluded below (k !== targetKey).
    const isCashRole = (v) => SAVINGS_ROLES.has(v.role);

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
        v.type !== ACCOUNT_TYPE.LOAN &&   // liabilities are never a source of cash (design 54 §8)
        'drawdownPriority' in v &&
        v.drawdownPriority !== null &&
        (globalDrawdown || v.country === country || isCashRole(v))
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
    // Cross-border cash sweeps are executed INLINE here (the stranding fix keeps
    // idle foreign cash spent before domestic investments). Collect a journalable
    // record for each cross-currency leg so the transfer is visible — emitted as
    // INTL_TRANSFER_RECORD by ReplenishSavingsReducer (design 44 Gap A / A2).
    const crossBorderTransfers = [];
    const pushTransfer = (srcAccount, srcKey, sourceAmount, targetAmount, fee) => {
      const fromCcy = srcAccount.currency?.code ?? srcAccount.country;
      if (fromCcy === currency) return; // same-currency draw is not a transfer
      crossBorderTransfers.push({
        type:       'INTL_TRANSFER_RECORD',
        direction:  fromCcy === 'AUD' ? 'AU_TO_US' : 'US_TO_AU',
        srcKey,
        dstKey:     targetKey,
        from:       fromCcy,
        to:         currency,
        fromAmount: +(+sourceAmount).toFixed(2),
        toAmount:   +(+targetAmount).toFixed(2),
        fee:        +(+fee).toFixed(2),
      });
    };

    // Early-withdrawal-before-brokerage (design 45 (B), §7). When set, hold
    // taxable brokerage back from the penalty-free Phase 1 so the Phase 2 early
    // withdrawal (10% penalty) runs FIRST — trading the penalty for NOT realizing
    // capital gains / draining the buffer. The held-back taxable accounts then
    // backstop in Phase 3 if the penalty draw can't cover the deficit. Default off
    // (brokerage drawn first, the historical strictly-last early-withdrawal order).
    // `type === BROKERAGE` covers the gain-realizing taxable bucket (us-stock and
    // fixed-income), the accounts whose Phase-1 draw emits STOCK_WITHDRAWAL_TAX.
    const earlyBeforeBrokerage = state.earlyWithdrawalBeforeBrokerage === true;
    const isDeferredTaxable    = (account) => earlyBeforeBrokerage && account.type === ACCOUNT_TYPE.BROKERAGE;

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
          .filter(s => s.amt > 1e-9 && !isDeferredTaxable(s.account));
        const total = avail.reduce((sum, a) => sum + a.amt, 0);
        if (total < 1e-9) break;

        const target = Math.min(remaining, total);
        let drawnThisPass = 0;
        for (const s of avail) {
          if (remaining < 1e-9) break;
          const want = Math.min(target * (s.amt / total), remaining);
          const got  = this._drawPenaltyFree(
            targetAccount, s.account, s.key, want, date, s.eligible, residency, drawnKeys, pendingTaxActions, pushTransfer, s.fx, feeOf(s.account), drawSelection
          );
          remaining     -= got;
          drawnThisPass += got;
        }
        if (drawnThisPass < 1e-9) break;
      }
    } else if ((state.withinTierDraw ?? 'SEQUENTIAL') === 'SEQUENTIAL') {
      // Ordered, SEQUENTIAL within a tier (default): walk sources in
      // drawdownPriority order, draining each fully before the next. Byte-identical
      // to the pre-Lever-C behavior.
      for (const [key, account] of sources) {
        if (remaining < 1e-9) break;
        if (isDeferredTaxable(account)) continue;   // held back for Phase 3 (design 45 (B))
        remaining -= this._drawPenaltyFree(
          targetAccount, account, key, remaining, date, eligibleOf(account), residency, drawnKeys, pendingTaxActions, pushTransfer, fxOf(account), feeOf(account), drawSelection
        );
      }
    } else {
      // Ordered, but split each priority tier per `withinTierDraw` (design 58
      // Lever C). Tiers are maximal runs of already-sorted sources sharing an
      // effective priority (same cash-bucket band + drawdownPriority — e.g. two
      // Roths under POOLED, or two roles tied by a Lever-B weight). EQUAL splits the
      // tier's target evenly across members; PROPORTIONAL splits by available
      // balance at draw time. Both cap each leg at its availability and redistribute
      // the residual (loop) — and each leg still runs through _drawPenaltyFree, so
      // per-account eligibility, minimumBalance floors, cross-border fx/fee, and the
      // per-account tax actions all apply per leg. Tiers advance in order, so the
      // policy only reshuffles *within* a tier, never across tiers. (RMDs are
      // event-driven per-account distributions, independent of this deficit path, so
      // OQ4's per-account RMD floor is unaffected.)
      const equal = state.withinTierDraw === 'EQUAL';
      const tierKeyOf = ([, v]) => {
        const cashTier = cashBucketActive ? (_CASH_FIRST_ROLES.has(v.role) ? 0 : 1) : 0;
        return `${cashTier}:${v.drawdownPriority}`;
      };
      for (let i = 0; i < sources.length && remaining >= 1e-9;) {
        // Gather the maximal run of same-tier sources starting at i.
        const key0 = tierKeyOf(sources[i]);
        let j = i;
        while (j < sources.length && tierKeyOf(sources[j]) === key0) j++;
        const tier = sources.slice(i, j);
        i = j;

        // Split this tier's draw across its members, redistributing the residual
        // left by capped members. Mirrors the global PROPORTIONAL loop's guard.
        let guard = 0;
        while (remaining >= 1e-9 && guard++ < 100) {
          const avail = tier
            .map(([key, account]) => {
              const eligible = eligibleOf(account);
              const fx = fxOf(account);
              // Availability weighted to target currency so cross-border members
              // contribute fairly (identical to the global PROPORTIONAL path).
              return { key, account, eligible, fx, amt: this._penaltyFreeAvailable(account, eligible) * fx };
            })
            .filter(s => s.amt > 1e-9 && !isDeferredTaxable(s.account));
          const total = avail.reduce((sum, a) => sum + a.amt, 0);
          if (total < 1e-9) break;

          const target = Math.min(remaining, total);
          let drawnThisPass = 0;
          for (const s of avail) {
            if (remaining < 1e-9) break;
            const weight = equal ? (1 / avail.length) : (s.amt / total);
            const want = Math.min(target * weight, remaining);
            const got  = this._drawPenaltyFree(
              targetAccount, s.account, s.key, want, date, s.eligible, residency, drawnKeys, pendingTaxActions, pushTransfer, s.fx, feeOf(s.account), drawSelection
            );
            remaining     -= got;
            drawnThisPass += got;
          }
          if (drawnThisPass < 1e-9) break;
        }
      }
    }

    if (remaining < 1e-9) {
      return { drawnKeys, pendingTaxActions, crossBorderTransfers };
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

        const credited = net * fx - fee; // target currency, net of cross-border fee
        if (credited <= 0) continue;     // draw too small to clear the cross-border fee
        this.transaction(targetAccount, +credited, date);
        this.transaction(account,       -gross,    date);
        pushTransfer(account, key, gross, credited, fee);
        account.earningsBasis = Math.max(0, (account.earningsBasis ?? 0) - gross);
        if (!drawnKeys.includes(key)) drawnKeys.push(key);
        // Phase 2 Roth draws earnings only (contributions went in Phase 1), so the
        // whole gross is the earnings portion (design 45 §6 shared shapes).
        pendingTaxActions.push(...this.earlyWithdrawalTaxActions(account, { fromEarnings: gross, penaltyRate, residency }).taxActions);
        remaining -= credited;

      } else if (account.type === ACCOUNT_TYPE.TRADITIONAL_IRA) {
        if (account.balance <= 0) continue;

        const grossNeeded = netFactor > 0 ? netNeeded / netFactor : netNeeded;
        const grossCapped = Math.min(grossNeeded, account.balance);

        // Draw contributions first, then earnings.
        const contribPortion  = Math.min(grossCapped, account.contributionBasis ?? 0);
        const earningsPortion = grossCapped - contribPortion;

        const net     = grossCapped * netFactor;

        const credited = net * fx - fee; // target currency, net of cross-border fee
        if (credited <= 0) continue;     // draw too small to clear the cross-border fee
        this.transaction(targetAccount, +credited,     date);
        this.transaction(account,       -grossCapped,  date);
        pushTransfer(account, key, grossCapped, credited, fee);
        account.contributionBasis = (account.contributionBasis ?? 0) - contribPortion;
        account.earningsBasis     = (account.earningsBasis     ?? 0) - earningsPortion;
        if (!drawnKeys.includes(key)) drawnKeys.push(key);

        pendingTaxActions.push(...this.earlyWithdrawalTaxActions(account, { fromContrib: contribPortion, fromEarnings: earningsPortion, penaltyRate, residency }).taxActions);
        remaining -= credited;

      } else if (account.type === ACCOUNT_TYPE.FOUR_OH_ONE_K) {
        if (account.balance <= 0) continue;

        const grossNeeded = netFactor > 0 ? netNeeded / netFactor : netNeeded;
        const gross       = Math.min(grossNeeded, account.balance);
        const net         = gross * netFactor;

        // 401k draws earnings first, then contributions (mirrors K401WithdrawalApplyReducer).
        const fromEarnings = Math.min(gross, account.earningsBasis ?? 0);
        const fromContrib  = gross - fromEarnings;

        const credited = net * fx - fee; // target currency, net of cross-border fee
        if (credited <= 0) continue;     // draw too small to clear the cross-border fee
        this.transaction(targetAccount, +credited, date);
        this.transaction(account,       -gross,    date);
        pushTransfer(account, key, gross, credited, fee);
        account.earningsBasis     = (account.earningsBasis     ?? 0) - fromEarnings;
        account.contributionBasis = (account.contributionBasis ?? 0) - fromContrib;
        if (!drawnKeys.includes(key)) drawnKeys.push(key);
        pendingTaxActions.push(...this.earlyWithdrawalTaxActions(account, { fromContrib, fromEarnings, penaltyRate }).taxActions);
        remaining -= credited;
      }
    }

    // ── Phase 3: deferred taxable backstop (design 45 (B), §7) ────────────────
    // Reached only when early-withdrawal-before-brokerage held taxable accounts
    // back from Phase 1: now that the penalty draw is exhausted, realize gains to
    // cover any residual deficit, via the same penalty-free path Phase 1 uses.
    // (B) is deficit-sized against post-Phase-2 balances, so it never double-draws
    // what the scheduled decant (A) or the penalty draw already took (§9 Q3).
    if (earlyBeforeBrokerage && remaining >= 1e-9) {
      for (const [key, account] of sources) {
        if (remaining < 1e-9) break;
        if (!isDeferredTaxable(account)) continue;
        remaining -= this._drawPenaltyFree(
          targetAccount, account, key, remaining, date, eligibleOf(account), residency, drawnKeys, pendingTaxActions, pushTransfer, fxOf(account), feeOf(account), drawSelection
        );
      }
    }

    if (remaining > 1e-9) {
      // Hand the caller what the draw already did. Phases 1–3 debited every
      // eligible account on the way to running dry, so `pendingTaxActions` here is
      // non-empty whenever those draws realized gains or taxable distributions —
      // tax the household genuinely owes even though the deficit went unmet.
      throw new InsufficientFundsError(country, currency, remaining,
        { drawnKeys, pendingTaxActions, crossBorderTransfers });
    }
    return { drawnKeys, pendingTaxActions, crossBorderTransfers };
  }

  /**
   * Reduce a ledger-bearing account's contribution/earnings basis to reflect a
   * withdrawal of `amount` (in the account's own currency), using the same
   * per-type ordering the dedicated withdrawal reducers apply (design 43 §3):
   *   - ROTH / TRADITIONAL_IRA → contributions first, then earnings
   *   - FOUR_OH_ONE_K          → earnings first, then contributions
   *   - SUPER / default        → proportional (pro-rata across both components)
   *
   * No-op for accounts without the ledger fields (plain cash/savings). This is
   * for the GENERIC drawdown paths (replenishSavings eligible draws) that bypass
   * the type-specific reducers; those reducers remain the authority where
   * withdrawals flow through them and must NOT also call this (double-count).
   * BROKERAGE is handled inline in `_drawPenaltyFree` (gain ratio + step-up).
   *
   * Keeps invariant 1 (contributionBasis + earningsBasis == balance): when the
   * ledger ties to balance before the draw, reducing both by the same `amount`
   * the balance fell by preserves it.
   *
   * @param {import('../account.js').Account} account
   * @param {number} amount - positive withdrawal size, account currency
   * @returns {{ fromContrib: number, fromEarnings: number }} the split actually
   *          applied (zeros when there is no ledger to reduce) — callers use it
   *          to emit matching withdrawal-tax actions (design 44 Gap B).
   */
  reduceLedgerForWithdrawal(account, amount) {
    const none = { fromContrib: 0, fromEarnings: 0 };
    if (!account || !(amount > 0)) return none;
    if (!('contributionBasis' in account) || !('earningsBasis' in account)) return none;
    const contrib  = account.contributionBasis ?? 0;
    const earnings = account.earningsBasis ?? 0;
    const total    = contrib + earnings;
    if (total <= 0) return none;
    const draw = Math.min(amount, total);

    let fromContrib;
    let fromEarnings;
    switch (account.type) {
      case ACCOUNT_TYPE.ROTH:
      case ACCOUNT_TYPE.TRADITIONAL_IRA:
        fromContrib  = Math.min(draw, contrib);
        fromEarnings = draw - fromContrib;
        break;
      case ACCOUNT_TYPE.FOUR_OH_ONE_K:
        fromEarnings = Math.min(draw, earnings);
        fromContrib  = draw - fromEarnings;
        break;
      default: // SUPER and any other ledger-bearing account → proportional
        fromContrib  = draw * (contrib / total);
        fromEarnings = draw - fromContrib;
    }
    // Unrounded (like the type-specific reducers): the reduction sums to exactly
    // `draw`, so when the ledger tied to balance before the draw it still ties
    // after (inv-1), with no per-withdrawal cent drift.
    account.contributionBasis = Math.max(0, contrib  - fromContrib);
    account.earningsBasis     = Math.max(0, earnings - fromEarnings);
    return { fromContrib, fromEarnings };
  }

  /**
   * Early-withdrawal penalty + withdrawal-tax action core (design 45 §6).
   *
   * Given a gross early withdrawal already split into its contribution and
   * earnings portions (the type's ordering — see `reduceLedgerForWithdrawal`),
   * build the penalty and the `*_WITHDRAWAL_*` tax action(s) to chain. This is
   * the single source for the action SHAPES (design 44 Gap B) shared by the
   * involuntary `replenishSavings` Phase 2 fallback and the scheduled decant
   * reducer (design 45) so the two can NEVER diverge on what tax/penalty a given
   * early draw emits. Pure: it moves no cash and mutates no ledger — callers cap
   * the draw and reduce the basis their own way, then pass the split here.
   *
   * Penalty rule by type:
   *   - ROTH          → contributions are penalty/tax free; only the earnings
   *                     portion is penalized + reported (ROTH_WITHDRAWAL_EARNINGS_TAX).
   *   - TRADITIONAL_IRA → whole gross is ordinary income + penalty, reported as
   *                     CONTRIB + EARNINGS actions (each carrying its own penalty).
   *   - FOUR_OH_ONE_K  → whole gross is ordinary income + penalty, one action.
   *
   * @param {import('../account.js').Account} account
   * @param {object} split
   * @param {number} split.fromContrib  - contribution portion of the gross (account ccy)
   * @param {number} split.fromEarnings - earnings portion of the gross (account ccy)
   * @param {number} split.penaltyRate  - 0..1 (0 above the age gate)
   * @param {string} [split.residency]  - stamped on the AU-assessable earnings actions
   * @returns {{ penalty: number, taxActions: Array<object> }}
   */
  earlyWithdrawalTaxActions(account, { fromContrib = 0, fromEarnings = 0, penaltyRate = 0, residency } = {}) {
    const gross      = fromContrib + fromEarnings;
    const taxActions = [];
    let   penalty    = 0;
    switch (account?.type) {
      case ACCOUNT_TYPE.ROTH:
        // Contributions out first are penalty/tax free; earnings carry the penalty.
        penalty = fromEarnings * penaltyRate;
        if (fromEarnings > 0) {
          taxActions.push({ type: 'ROTH_WITHDRAWAL_EARNINGS_TAX', amount: fromEarnings, penaltyAmount: penalty, residency });
        }
        break;
      case ACCOUNT_TYPE.TRADITIONAL_IRA:
        penalty = gross * penaltyRate;
        if (fromContrib > 0) {
          taxActions.push({ type: 'IRA_WITHDRAWAL_CONTRIB_TAX',  amount: fromContrib,  penaltyAmount: fromContrib  * penaltyRate });
        }
        if (fromEarnings > 0) {
          taxActions.push({ type: 'IRA_WITHDRAWAL_EARNINGS_TAX', amount: fromEarnings, penaltyAmount: fromEarnings * penaltyRate, residency });
        }
        break;
      case ACCOUNT_TYPE.FOUR_OH_ONE_K:
        penalty = gross * penaltyRate;
        taxActions.push({ type: 'K401_WITHDRAWAL_TAX', amount: gross, penaltyAmount: penalty });
        break;
    }
    return { penalty, taxActions };
  }

  /**
   * Penalty-free amount currently withdrawable from a single account:
   *   - eligible (age-gated) accounts → full balance
   *   - Roth below minimumAge        → contribution basis (always penalty-free)
   *   - everything else              → 0 (only reachable via phase-2 early withdrawal)
   */
  _penaltyFreeAvailable(account, eligible) {
    // Cash/savings keep their minimumBalance buffer; investments have min 0 so
    // this is a no-op for them. `_drawableBalance` applies the same floor.
    const drawable = this._drawableBalance(account);
    if (eligible) return Math.max(0, drawable);
    if (account.type === ACCOUNT_TYPE.ROTH) {
      return Math.max(0, Math.min(account.contributionBasis ?? 0, drawable));
    }
    return 0;
  }

  /** Balance a source may give up: everything above its minimumBalance floor. */
  _drawableBalance(account) {
    return Math.max(0, (account.balance ?? 0) - (account.minimumBalance ?? 0));
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
  _drawPenaltyFree(targetAccount, account, key, want, date, eligible, residency, drawnKeys, pendingTaxActions, pushTransfer, fx = 1, fee = 0, selection = null) {
    if (want < 1e-9) return 0;
    // Gross up the source-side need by the fee so a full draw nets `want` at the
    // target after the wire cost is paid.
    const wantSrc = (want + fee) / fx;

    if (eligible) {
      const drawable = this._drawableBalance(account); // floored at minimumBalance (cash buffer)
      if (drawable <= 0) return 0;
      const withdraw = Math.min(wantSrc, drawable); // source currency
      const credited = withdraw * fx - fee;                // target currency, net of fee
      if (credited <= 0) return 0;                         // draw too small to clear the fee

      // Brokerage CGT is realized from holdings FIFO (design 53 Phase 1) — the same
      // basis source the event-driven STOCK_WITHDRAWAL_APPLY reducer uses. Snapshot
      // the FIFO consumption BEFORE the debit, because transaction() below pro-rata-
      // consumes the lots in place; we then overwrite holdings with the FIFO result so
      // the remaining lots reflect FIFO (and their per-country cost bases deplete
      // correctly). `withdraw` is the sale proceeds in the source account's currency.
      // Pass the AU CGT context only for AU residents, so US-only runs keep the
      // exact prior FIFO output. The context (sale date + country) lets the FIFO
      // tally the discountable-gain split (design 62 §4) — the ≥12-month test runs
      // from each lot's AU deemed-acquisition date. No `level` ⇒ index factor 1.
      const auCtx = residency === 'AU'
        ? { asOfMs: date instanceof Date ? date.getTime() : (typeof date === 'number' ? date : null), country: 'AU' }
        : null;
      // Design 65: the allocation-aware selection policy steers *which* sleeve/lots
      // are sold; when `selection` is null this is byte-identical to the prior FIFO.
      // Lever C (design 65 §4-C): if rebalance coupling is on and this account carries
      // a stamped design-61 target, bias the sleeve order toward its over-weight class.
      const acctSelection = withRebalanceCoupling(selection, account);
      const brokerageFifo = account.type === ACCOUNT_TYPE.BROKERAGE
        ? consumeHoldings(account.holdings ?? [], withdraw, { indexation: auCtx, selection: acctSelection })
        : null;

      this.transaction(targetAccount, +credited, date);
      this.transaction(account,       -withdraw, date);
      pushTransfer(account, key, withdraw, credited, fee); // journal the cross-currency leg (no-op same-ccy)

      // Brokerage accounts: realize the FIFO capital gain and emit STOCK_WITHDRAWAL_TAX
      // for Form 8949 / YTD accumulator.
      if (account.type === ACCOUNT_TYPE.BROKERAGE) {
        const realizedBasis   = brokerageFifo.realizedBasis;
        // AU CGT cost-base reset (design 36 §12.2): the realized AU basis sums each
        // lot's stepped-up cost base (per-lot costBaseByCountry, stamped at the move by
        // recordResidencyChange); no step-up ⇒ falls back to realizedBasis (auGain === gain).
        const realizedAuBasis = brokerageFifo.realizedBasisByCountry?.AU ?? realizedBasis;
        // Collectible split (design 56 §7.2): GOLD lots consumed in this draw are taxed
        // at the US 28% collectibles rate (COLLECTIBLE_SALE_TAX) — and AU CGT if resident
        // — while the rest keeps ordinary brokerage CGT. Mirror the STOCK_WITHDRAWAL_APPLY
        // reducer so the engine and event-driven disposal paths agree.
        const collProceeds = brokerageFifo.collectibleProceeds ?? 0;
        const collBasis    = brokerageFifo.collectibleBasis    ?? 0;
        const collGain     = Math.max(0, collProceeds - collBasis);
        const equityProceeds = +(withdraw - collProceeds).toFixed(2);
        const gain   = Math.max(0, equityProceeds - (realizedBasis   - collBasis));
        const auGain = Math.max(0, equityProceeds - (realizedAuBasis - collBasis));
        // CGT 50%-discount-eligible slice (design 62 §4): equity gain from lots held
        // ≥12 months from the AU deemed-acquisition date (excludes the gold sleeve,
        // which the collectible split handles), capped at auGain.
        const auDiscountableGain = Math.min(auGain, brokerageFifo.realizedDiscountableGainByCountry?.AU ?? auGain);
        account.holdings = brokerageFifo.newHoldings; // FIFO-consumed lots override transaction()'s pro-rata pass
        pendingTaxActions.push({
          type: 'STOCK_WITHDRAWAL_TAX', gain, auGain, auDiscountableGain, residency,
          proceeds: equityProceeds, costBasis: +(realizedBasis - collBasis).toFixed(2), description: account.name || key,
          // Design 76 Gap B: attribute the AU gain to this account's owner.
          stateKey: account.stateKey ?? key,
        });
        if (collGain > 0) {
          // Design 76 Gap B — gold sleeve inside the account ⇒ attribute by account.
          pendingTaxActions.push({ type: 'COLLECTIBLE_SALE_TAX', gain: collGain, residency, stateKey: account.stateKey ?? key });
        }
      } else if ('contributionBasis' in account && 'earningsBasis' in account) {
        // Ledger-bearing retirement/super account drawn while age-eligible (super
        // ≥60, IRA ≥60, 401k ≥59.5). Keep the contribution/earnings ledger in
        // step with the balance (design 43 §2/§5) AND emit the withdrawal-tax
        // action the type-specific reducers would (design 44 Gap B) — otherwise
        // an eligible IRA/401k/super drawn by the engine escapes income tax.
        // Amounts are in the source account's currency, matching Phase 2 below
        // and the STOCK_WITHDRAWAL_TAX path above.
        //
        // Every case here emits and passes `residency`, leaving the cross-border
        // consequence to the tax module. That division of labour is the point: a
        // service deciding for itself that a distribution is untaxed is how design 84
        // G7 happened — the Roth case was omitted on the strength of "a qualified Roth
        // withdrawal is tax-free", which is true in the US and false in Australia,
        // where the wrapper is a foreign trust and the earnings are s99B ordinary
        // income. Because the age gate makes a Roth penalty-free-ELIGIBLE at 59½, this
        // branch is precisely where an AU resident's Roth gets drained by ordinary
        // spending and tax-bill funding, so the omission zeroed the entire s99B charge
        // on the involuntary path.
        const { fromContrib, fromEarnings } = this.reduceLedgerForWithdrawal(account, withdraw);
        switch (account.type) {
          case ACCOUNT_TYPE.TRADITIONAL_IRA:
            if (fromContrib > 0)  pendingTaxActions.push({ type: 'IRA_WITHDRAWAL_CONTRIB_TAX',   amount: fromContrib,  penaltyAmount: 0 });
            if (fromEarnings > 0) pendingTaxActions.push({ type: 'IRA_WITHDRAWAL_EARNINGS_TAX',  amount: fromEarnings, penaltyAmount: 0, residency });
            break;
          case ACCOUNT_TYPE.FOUR_OH_ONE_K:
            pendingTaxActions.push({ type: 'K401_WITHDRAWAL_TAX', amount: withdraw, penaltyAmount: 0 });
            break;
          case ACCOUNT_TYPE.SUPER:
            if (fromEarnings > 0) pendingTaxActions.push({ type: 'SUPER_WITHDRAWAL_EARNINGS_TAX', amount: fromEarnings });
            break;
          case ACCOUNT_TYPE.ROTH:
            // Corpus is silent under s99B(2)(a) and never US-taxable, so only the
            // earnings slice is emitted. `penaltyAmount: 0` because this branch is by
            // definition the age-eligible one — §72(t) does not reach it. For a US
            // resident the reducer books nothing at all, so this stays a no-op there.
            if (fromEarnings > 0) pendingTaxActions.push({
              type: 'ROTH_WITHDRAWAL_EARNINGS_TAX', amount: fromEarnings, penaltyAmount: 0, residency,
              // Design 76 Gap B: attribute to the wrapper's owner, not the household.
              stateKey: account.stateKey ?? key,
            });
            break;
        }
      }

      if (!drawnKeys.includes(key)) drawnKeys.push(key);
      return credited;
    }

    if (account.type === ACCOUNT_TYPE.ROTH && (account.contributionBasis ?? 0) > 0) {
      // Roth contributions are always accessible without penalty (EW-2).
      const available = Math.min(account.contributionBasis, this._drawableBalance(account));
      if (available <= 0) return 0;
      const withdraw = Math.min(wantSrc, available); // source currency
      const credited = withdraw * fx - fee;          // target currency, net of fee
      if (credited <= 0) return 0;
      this.transaction(targetAccount, +credited, date);
      this.transaction(account,       -withdraw, date);
      pushTransfer(account, key, withdraw, credited, fee);
      account.contributionBasis -= withdraw;
      if (!drawnKeys.includes(key)) drawnKeys.push(key);
      return credited;
    }

    return 0;
  }
}
