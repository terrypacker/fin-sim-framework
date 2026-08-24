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
import { computeConversionRecapture } from '../account-rules/us/roth-conversion-lots.js';
import { getBirthDate, getResidency } from '../residency-utils.js';
import { Holding } from '../holdings/holding.js';
import { resolveDefaultAllocation, resolveRateKey, resolveEquityMarketMix } from '../holdings/default-allocations.js';
import { rescaleHoldingsToBalance } from '../holdings/holding-utils.js';
import { deriveEarningsBasis } from '../assets/investment-account.js';
import { consumeHoldings } from '../holdings/holdings-fifo.js';
import { disposalTermFields } from '../holdings/holding-period.js';
import { resolveDrawdownSelection, withRebalanceCoupling } from '../holdings/holdings-selection.js';
import { ACCOUNT_ROLES } from '../state/account-roles.js';
import { fxRate, fxFeeIn } from '../fx/fx-conversion.js';
import { realizeCurrencyDisposition } from '../account-rules/currency-basis.js';
import { section988ForBondPrincipal } from '../account-rules/bond-currency-basis.js';

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
/**
 * Draw a wrapper's derived-income pool down alongside an earnings withdrawal, and
 * return the slice of that withdrawal which is s99B-assessable (design 84 G2).
 *
 * Pro-rata on the wrapper's own composition, matching `drawDerivedProRata` and the
 * G11 provenance split: a distribution carries derived income and pure appreciation
 * in the proportion the wrapper holds them.
 *
 * Returns `undefined` — not 0 — for an account with no pool, so the tax action omits
 * `auAssessableAmount` and the tax module falls back to assessing the whole amount.
 * Returning 0 there would silently zero the s99B charge on every legacy save.
 */
function _drawDerived(account, fromEarnings, preDrawEarnings) {
  const d = account?.derivedIncomeBasis;
  if (!Number.isFinite(d)) return undefined;
  if (!(fromEarnings > 0) || !(preDrawEarnings > 0)) return 0;
  const share = Math.min(1, fromEarnings / preDrawEarnings);
  const drawn = +(d * share).toFixed(2);
  account.derivedIncomeBasis = Math.max(0, +(d - drawn).toFixed(2));
  return drawn;
}

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
    const balance    = account.balance ?? 0;

    // Equity market sub-axis (design 90 §7.3). An account carrying an `equityMarketMix`
    // bootstraps one sleeve PER MARKET rather than a single sleeve on its domestic one —
    // which is how a Super balance says "60% AU, 40% ex-AU" instead of inheriting AU
    // wholesale and having the difference papered over by a beta.
    //
    // `resolveEquityMarketMix` returns a single-market mix when nothing is authored, so
    // the common path still produces exactly one holding and the §4.4 invariant
    // (balance === Σ marketValue) holds either way — the split below is value-exact
    // because the LAST sleeve absorbs the rounding remainder rather than each sleeve
    // rounding independently.
    const mix     = resolveEquityMarketMix(account, allocation);
    const markets = mix ? Object.entries(mix).filter(([, w]) => w > 0) : [];
    if (markets.length > 1) {
      const holdings = [];
      let allocated = 0;
      markets.forEach(([mk, weight], i) => {
        const value = (i === markets.length - 1)
          ? +(balance - allocated).toFixed(2)
          : +(balance * weight).toFixed(2);
        allocated = +(allocated + value).toFixed(2);
        holdings.push(new Holding({
          id:           this._generateHoldingId(),
          allocation,
          marketValue:  value,
          costBasis:    value,
          rateKey:      mk,
          purchaseDate: null,
          label:        '',
        }));
      });
      account.holdings = holdings;
      return;
    }

    const holding    = new Holding({
      id:           this._generateHoldingId(),
      allocation,
      // A single-entry mix still names the market explicitly; `rateKey` is the fallback
      // for allocations that have no market axis at all (BOND, CASH, GOLD).
      marketValue:  balance,
      costBasis:    balance,
      rateKey:      markets.length === 1 ? markets[0][0] : rateKey,
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
        // par-reviewed: par scales by the same ratio as the units, by hand rather than via
        // `resize`, because this loop's arithmetic is deliberately UNROUNDED — `sold` is
        // apportioned with a last-lot remainder so the parts sum to the requested amount
        // exactly, and rounding each lot to cents here shifts whole-portfolio totals by
        // ~20c over a long run. Converting it was tried and reverted for that reason; the
        // rounding inconsistency between this path and the primitives is real and is
        // recorded as its own decision in design 93 §9.
        //
        // `units` scales by that SAME ratio (design 93 §5b), and it is not optional: a
        // unitised lot derives its value from the count, so a raw `marketValue` write that
        // leaves the count behind is undone by the next `syncHolding` — measured at 40% of
        // a 401(k) evaporating on the bond golden when this one loop was left out. Left
        // unrounded like everything else here, which keeps `units x pricePerUnit` equal to
        // the value this loop apportions rather than to a re-rounded version of it.
        const ratio     = mv > 0 ? Math.max(0, 1 - sold / mv) : 0;
        const faceShare = (h.faceValue == null || mv <= 0) ? null
          : Math.max(0, (h.faceValue ?? 0) * ratio);
        // par-reviewed: par AND units both scale by the same ratio the position moved by,
        // by hand rather than via `resize` for the unrounded-arithmetic reason above.
        return {
          ...h,
          marketValue: Math.max(0, mv - sold),
          costBasis:   Math.max(0, (h.costBasis ?? 0) - basisShare),
          ...(faceShare == null ? {} : { faceValue: +faceShare.toFixed(2) }),
          ...(h.units == null ? {} : { units: h.units * ratio }),
        };
      });
    } else {
      // Credit (contribution / sale proceeds / transfer-in): distribute across
      // sleeves by market value; the deposited cash carries basis equal to its
      // market value. With no market value to weight against, land the whole
      // credit in the first sleeve.
      if (totalMv <= 0) {
        account.holdings = holdings.map((h, i) => {
          if (i !== 0) return h;
          const value = (h.marketValue ?? 0) + amount;
          // Zero market value to weight against — the credit BECOMES the position, which
          // is `establish`'s statement (design 93 §5b). Spelled out rather than delegated
          // because `establish` rounds to cents and this loop deliberately does not: `sold`
          // and `share` are apportioned with a last-lot remainder so the parts sum to the
          // requested amount exactly. Rounding here moved every golden's cash sleeve by a
          // few thousandths of a cent — harmless, but it is the §9.5 inconsistency and
          // this path is the side of it that stays unrounded.
          // par-reviewed: there are no units to scale, so the money IS the position; units
          // are established at the going price (par for a lot whose price is stale) and par
          // follows the count, so nothing can fall out of step.
          const price = (h.pricePerUnit ?? 0) > 0 ? h.pricePerUnit : (h.parPerUnit ?? 0);
          const units = h.units == null ? null : (price > 0 ? value / price : 0);
          return {
            ...h,
            marketValue: value,
            costBasis:   (h.costBasis ?? 0) + amount,
            ...(units == null ? {} : { units }),
            ...(units == null || h.parPerUnit == null
              ? {}
              : { faceValue: +(units * h.parPerUnit).toFixed(2) }),
          };
        });
        return;
      }
      let added = 0;
      account.holdings = holdings.map((h, i) => {
        const mv    = Math.max(0, h.marketValue ?? 0);
        const share = i === last ? amount - added : amount * (mv / totalMv);
        added += share;
        // par-reviewed: as the debit branch above — unrounded on purpose, par and units
        // both scaled by the same value ratio the position moved by.
        const ratio  = mv > 0 ? (mv + share) / mv : 1;
        const faceUp = (h.faceValue == null || mv <= 0) ? null : (h.faceValue ?? 0) * ratio;
        return {
          ...h,
          marketValue: (h.marketValue ?? 0) + share,
          costBasis:   (h.costBasis   ?? 0) + share,
          ...(faceUp == null ? {} : { faceValue: +faceUp.toFixed(2) }),
          ...(h.units == null ? {} : { units: h.units * ratio }),
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
        // (US-brokerage equity + gold) sleeve from the residency date.
        //
        // This OVERWRITES any level the lot already carried, and must: a lot bought
        // during the simulation records the CPI level at its purchase (design 62 §9.5),
        // but the step-up replaces its AU cost base with market value at the move, so
        // indexing that new base from the older, lower purchase level would relieve the
        // same inflation twice. The step-up is the AU acquisition; its level governs.
        // Re-entry is not a concern — a lot already stepped up for this country returns
        // above, before reaching here.
        if (priceLevel != null) {
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
    // AU CPI level for design-57 basis indexation. The event-driven disposal
    // reducers read exactly this pair (cpiAccumulator.AU, falling back to
    // inflationAccumulator.AU, then 1); the drawdown path used to pass no level at
    // all, which silently pinned its index factor to 1 and dropped `auIndexedGain`
    // from every STOCK_WITHDRAWAL_TAX it raised — 98% of the disposals on a real
    // plan. See design/inconsistencies.md §4.11.
    const auCpiLevel     = state.cpiAccumulator?.AU ?? state.inflationAccumulator?.AU ?? 1;
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
      // Design 87 G2 — THE SECOND CONVERSION PATH. The stranding fix (design 44) spends
      // idle foreign cash inline here rather than routing through INTL_TRANSFER_APPLY,
      // so a §988 disposition realized only in that reducer would silently depend on
      // which drawdown branch ran. This is the one seam every inline cross-currency leg
      // passes through, which is why the realization hangs off it rather than off each
      // of the three draw orderings above.
      //
      // Stamping `fxBasisRate` mutates the live account object, matching how this
      // service already mutates balances via transaction().
      //
      // `0` — PERSONAL, stated rather than read off the account. §988(e)(3) asks whether
      // expenses properly allocable to the transaction meet §162 or §212, and converting
      // your own savings into your home currency has none. The other two conversion paths
      // (`IntlTransferToUsHandler`, `FxTransferToHandler`) both declare 0, and all three
      // must agree: a pool with an authored `deductibleFraction` would otherwise make the
      // §988 character of a conversion depend on which drawdown branch happened to run,
      // which is precisely the defect G2 exists to prevent. Design 87 §8 Q1.
      const s988 = realizeCurrencyDisposition(state, srcKey, srcAccount, sourceAmount, residency, 0);
      if (s988.patch.fxBasisRate != null) srcAccount.fxBasisRate = s988.patch.fxBasisRate;
      pendingTaxActions.push(...s988.actions);
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
            targetAccount, s.account, s.key, want, date, s.eligible, residency, drawnKeys, pendingTaxActions, pushTransfer, s.fx, feeOf(s.account), drawSelection, auCpiLevel, state
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
          targetAccount, account, key, remaining, date, eligibleOf(account), residency, drawnKeys, pendingTaxActions, pushTransfer, fxOf(account), feeOf(account), drawSelection, auCpiLevel, state
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
              targetAccount, s.account, s.key, want, date, s.eligible, residency, drawnKeys, pendingTaxActions, pushTransfer, s.fx, feeOf(s.account), drawSelection, auCpiLevel, state
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
        // Phase 1 already drew contributions; any residual balance is converted
        // principal and earnings. Use the larger of the tracked non-contribution
        // ledger or the implied residue (balance minus remaining contributions) to
        // handle accounts whose basis was never explicitly initialised.
        const impliedEarnings = Math.max(0, account.balance - (account.contributionBasis ?? 0));
        const earningsAvail   = Math.min(Math.max(account.earningsBasis ?? 0, impliedEarnings), account.balance);
        if (earningsAvail <= 0) continue;

        // Gross up: to net `netNeeded` (source ccy) after penalty, withdraw
        // `netNeeded + penalty(gross)`. Design 84 G9 made that a fixed point rather
        // than a division: on a Roth carrying conversions the penalised FRACTION of
        // a draw is no longer 1 — regular contributions and conversion lots past
        // their five-year window come out clean — so `netNeeded / netFactor`
        // over-draws by up to the penalty rate on the unpenalised part. The penalty
        // is monotone in the gross with slope ≤ penaltyRate, so iterating is a
        // contraction and converges to the cent in a handful of passes. Where the
        // whole draw IS penalised (a Roth with no conversions, or an
        // un-initialised ledger) the fixed point is exactly `netNeeded / netFactor`,
        // so nothing about the old behaviour moves.
        let gross = Math.min(netFactor > 0 ? netNeeded / netFactor : netNeeded, earningsAvail);
        for (let i = 0; i < 12; i++) {
          const next = Math.min(netNeeded + this._rothEarlyPenalty(account, gross, penaltyRate, date), earningsAvail);
          if (Math.abs(next - gross) < 1e-9) break;
          gross = next;
        }
        // Bail out BEFORE touching the ledger. `netFactor` penalises the whole
        // gross, so it is a lower bound on the net: clearing the fee here
        // guarantees clearing it below, and no ledger is consumed on a draw that
        // never happens.
        if (gross * netFactor * fx - fee <= 0) continue;

        // Design 84 G9, the mirror image of the age-eligible leak: this branch used
        // to declare the WHOLE residue "earnings", which on a Roth carrying
        // conversions charged §72(t) and full s99B against money that is mostly
        // corpus, and decremented only `earningsBasis` (floored at 0) so the
        // rollover buckets were left stranded on the account. Split it properly
        // instead — §408A(d)(4)(B) order, dated lots consumed, recapture per lot —
        // and take the penalty from the split rather than from `netFactor`, so the
        // cash that leaves and the penalty that is charged are the same number.
        const split = this.reduceLedgerForWithdrawal(account, gross, { underAge: true, date });
        // An un-initialised ledger under-states the balance; charge the residue as
        // earnings, which is the conservative reading this branch always took.
        const ledgered = split.fromContrib + split.fromEarnings
                       + split.fromRolloverContrib + split.fromRolloverEarnings;
        split.fromEarnings += Math.max(0, gross - ledgered);

        const { penalty, taxActions } = this.earlyWithdrawalTaxActions(account, {
          ...split, penaltyRate, residency, stateKey: account.stateKey ?? key,
        });
        const net      = gross - penalty;
        const credited = net * fx - fee; // target currency, net of cross-border fee
        this.transaction(targetAccount, +credited, date);
        this.transaction(account,       -gross,    date);
        pushTransfer(account, key, gross, credited, fee);
        if (!drawnKeys.includes(key)) drawnKeys.push(key);
        pendingTaxActions.push(...taxActions);
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
          targetAccount, account, key, remaining, date, eligibleOf(account), residency, drawnKeys, pendingTaxActions, pushTransfer, fxOf(account), feeOf(account), drawSelection, auCpiLevel, state
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
   *   - TRADITIONAL_IRA → contributions first, then earnings
   *   - FOUR_OH_ONE_K   → earnings first, then contributions
   *   - SUPER / default → proportional (pro-rata across both components)
   *   - ROTH            → the statutory order of IRC §408A(d)(4)(B): regular
   *     contributions, then CONVERTED principal (FIFO across the dated lots),
   *     then earnings. See below.
   *
   * No-op for accounts without the ledger fields (plain cash/savings). This is
   * for the GENERIC drawdown paths (replenishSavings eligible draws) that bypass
   * the type-specific reducers; those reducers remain the authority where
   * withdrawals flow through them and must NOT also call this (double-count).
   * BROKERAGE is handled inline in `_drawPenaltyFree` (gain ratio + step-up).
   *
   * **The Roth has FOUR layers, not two** (design 84 G9). The full design 53 §8
   * invariant is
   *   `balance == contributionBasis + earningsBasis
   *             + rolloverContribBasis + rolloverEarningsBasis`
   * — the rollover buckets (design 36) are converted principal and the growth on
   * it. This function used to know only the first two and cap the draw at their
   * sum, so on a Roth carrying conversions the balance exceeded the ledger and the
   * excess left the wrapper represented NOWHERE: no basis reduction, no action, no
   * assessment. Most converted principal genuinely is s99B corpus and comes out
   * free, but the portion attributable to the source IRA's earnings does not — it
   * is pre-tax money that "would have been included in assessable income if
   * derived by a resident", so s99B(2)(a) denies it the corpus exemption. Each lot
   * carries that figure as `taxableAmount`, stamped at conversion for exactly this
   * purpose, and the shared `computeConversionRecapture` consumes it here on the
   * identical terms EVT-43 uses on the event path — including the
   * §408A(d)(3)(F) five-year recapture window.
   *
   * `rolloverEarningsBasis` is drawn BEFORE `earningsBasis`. Under design 84
   * Option 2b it holds conversion-sourced money — the source IRA's earnings,
   * carried across at conversion because a conversion does not launder them into
   * corpus — and §408A(d)(4)(B) puts everything that arrived by conversion ahead of
   * the wrapper's own earnings.
   *
   * Keeps the invariant: the four reductions sum to exactly `draw`, so a ledger
   * that tied to balance before the draw still ties after.
   *
   * @param {import('../account.js').Account} account
   * @param {number} amount - positive withdrawal size, account currency
   * @param {object} [opts]
   * @param {boolean} [opts.underAge] - owner below the Roth 59½ gate; drives the
   *        §408A(d)(3)(F) recapture on the converted-principal slice. Default
   *        false — the age-eligible case, where §72(t) does not reach.
   * @param {Date|number|null} [opts.date] - withdrawal date, for the five-year
   *        window test. Absent ⇒ no window test (never penalise on a guess).
   * @returns {{ fromContrib: number, fromEarnings: number,
   *             fromRolloverContrib: number, fromRolloverEarnings: number,
   *             rolloverPenalty: number, rolloverAuAssessable: number }}
   *          the split actually applied (zeros when there is no ledger to reduce)
   *          — callers use it to emit matching withdrawal-tax actions (design 44
   *          Gap B). The rollover fields are always 0 for a non-Roth.
   */
  reduceLedgerForWithdrawal(account, amount, { underAge = false, date = null } = {}) {
    const split = this._splitLedgerForWithdrawal(account, amount);
    const {
      contrib, earnings, rollContrib, rollEarnings,
      fromContrib, fromEarnings, fromRolloverContrib, fromRolloverEarnings,
    } = split;
    if (split.draw <= 0) return split.result;

    // Consume the dated conversion lots for the converted-principal slice, on the
    // same terms EVT-43 applies: the FIFO order, the per-lot five-year window, and
    // the pro-rata `taxableAmount` that is the s99B-assessable share.
    let rolloverPenalty      = 0;
    let rolloverAuAssessable = 0;
    if (fromRolloverContrib > 0) {
      const { penaltyAmount, auAssessableAmount, newLots } = computeConversionRecapture(
        account.rolloverConversions, fromRolloverContrib, date, { underAge }
      );
      rolloverPenalty      = penaltyAmount;
      rolloverAuAssessable = auAssessableAmount;
      account.rolloverConversions = newLots;
    }

    // Unrounded (like the type-specific reducers): the reduction sums to exactly
    // `draw`, so when the ledger tied to balance before the draw it still ties
    // after (inv-1), with no per-withdrawal cent drift.
    account.contributionBasis = Math.max(0, contrib  - fromContrib);
    // Design 84 G2 — the s99B-assessable pool leaves with the earnings it belongs to,
    // pro-rata, and `derivedDrawn` is the assessable slice of THIS withdrawal.
    // Computed against the PRE-draw earnings, so it must happen before the line below.
    //
    // This is the third time a design 84 gap has been "the ordinary drawdown path did
    // not see it" (G7 emitted no action, G9 could not see the rollover buckets). The
    // event-driven reducers in roth-classes.js are not this path: retirement spending
    // drains the wrapper HERE, so anything taught to those reducers has to be taught
    // to this function too or it is inert on every real plan.
    const derivedDrawn = _drawDerived(account, fromEarnings, earnings);
    account.earningsBasis     = Math.max(0, earnings - fromEarnings);
    // Only ever write the rollover buckets on an account that has them — a Roth
    // with no conversions must not sprout a `rolloverContribBasis: 0` field that
    // the serializer would then persist.
    if (fromRolloverContrib  > 0) account.rolloverContribBasis  = Math.max(0, rollContrib  - fromRolloverContrib);
    if (fromRolloverEarnings > 0) account.rolloverEarningsBasis = Math.max(0, rollEarnings - fromRolloverEarnings);
    return {
      fromContrib, fromEarnings, fromRolloverContrib, fromRolloverEarnings,
      rolloverPenalty, rolloverAuAssessable, derivedDrawn,
    };
  }

  /**
   * The per-type ordering of `reduceLedgerForWithdrawal`, with nothing mutated.
   *
   * Split out so the involuntary early-withdrawal path can ask "how much of a
   * hypothetical draw would be penalised?" before committing to a draw size —
   * a gross-up needs the answer, and answering it by consuming the ledger and
   * putting it back is how a rounding bug gets written.
   *
   * @returns the four portions, the pre-draw bucket values (so the caller can
   *          write back without re-reading), the capped `draw`, and a zeroed
   *          `result` for the no-ledger case.
   */
  _splitLedgerForWithdrawal(account, amount) {
    const zero = {
      contrib: 0, earnings: 0, rollContrib: 0, rollEarnings: 0,
      fromContrib: 0, fromEarnings: 0, fromRolloverContrib: 0, fromRolloverEarnings: 0,
      draw: 0,
      result: {
        fromContrib: 0, fromEarnings: 0, fromRolloverContrib: 0, fromRolloverEarnings: 0,
        rolloverPenalty: 0, rolloverAuAssessable: 0,
      },
    };
    if (!account || !(amount > 0)) return zero;
    if (!('contributionBasis' in account) || !('earningsBasis' in account)) return zero;
    const contrib  = account.contributionBasis ?? 0;
    const earnings = account.earningsBasis ?? 0;
    const isRoth       = account.type === ACCOUNT_TYPE.ROTH;
    const rollContrib  = isRoth ? (account.rolloverContribBasis  ?? 0) : 0;
    const rollEarnings = isRoth ? (account.rolloverEarningsBasis ?? 0) : 0;
    const total    = contrib + earnings + rollContrib + rollEarnings;
    if (total <= 0) return zero;
    const draw = Math.min(amount, total);

    let fromContrib          = 0;
    let fromEarnings         = 0;
    let fromRolloverContrib  = 0;
    let fromRolloverEarnings = 0;
    switch (account.type) {
      case ACCOUNT_TYPE.ROTH: {
        // §408A(d)(4)(B): regular contributions → conversions → earnings, where
        // "conversions" is ALL the money that arrived by conversion — both legs of
        // the design 84 Option 2b split, since the US made the whole conversion
        // includible income and runs one five-year clock over it. So the rollover
        // EARNINGS pool is drawn ahead of the wrapper's own earnings, not after.
        //
        // G9 originally ordered these the other way round and documented the choice
        // as arbitrary, which was true while a conversion's assessable leg lived on
        // a lot stamp: both pools were then plain earnings and nothing turned on it.
        // Under 2b `rolloverEarningsBasis` carries conversion-sourced money, so the
        // order is a real US-ordering question and this is the answer to it.
        let rest = draw;
        fromContrib          = Math.min(rest, contrib);       rest -= fromContrib;
        fromRolloverContrib  = Math.min(rest, rollContrib);   rest -= fromRolloverContrib;
        fromRolloverEarnings = Math.min(rest, rollEarnings);  rest -= fromRolloverEarnings;
        fromEarnings         = rest;
        break;
      }
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
    return {
      contrib, earnings, rollContrib, rollEarnings,
      fromContrib, fromEarnings, fromRolloverContrib, fromRolloverEarnings,
      draw, result: zero.result,
    };
  }

  /**
   * §72(t) + §408A(d)(3)(F) charge on a hypothetical early Roth draw of `gross`,
   * computed without touching the account. Pure — the gross-up below calls it
   * repeatedly.
   *
   * A ledger that under-states the balance (never initialised) has its residue
   * charged as earnings, which is the conservative reading the involuntary path
   * has always taken.
   */
  _rothEarlyPenalty(account, gross, penaltyRate, date) {
    if (!(gross > 0) || !(penaltyRate > 0)) return 0;
    const s = this._splitLedgerForWithdrawal(account, gross);
    const ledgered = s.fromContrib + s.fromEarnings + s.fromRolloverContrib + s.fromRolloverEarnings;
    const residue  = Math.max(0, gross - ledgered);
    const recapture = s.fromRolloverContrib > 0
      ? computeConversionRecapture(account.rolloverConversions, s.fromRolloverContrib, date, { underAge: true }).penaltyAmount
      : 0;
    return (s.fromEarnings + s.fromRolloverEarnings + residue) * penaltyRate + recapture;
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
   *   - ROTH          → regular contributions are penalty/tax free. Converted
   *                     principal carries the §408A(d)(3)(F) recapture penalty
   *                     computed per lot upstream, and its IRA-earnings-sourced
   *                     share is s99B-assessable (ROTH_ROLLOVER_WITHDRAWAL_CONTRIB_TAX).
   *                     Both earnings pools are penalized + reported
   *                     (ROTH_WITHDRAWAL_EARNINGS_TAX and its rollover twin).
   *   - TRADITIONAL_IRA → whole gross is ordinary income + penalty, reported as
   *                     CONTRIB + EARNINGS actions (each carrying its own penalty).
   *   - FOUR_OH_ONE_K  → whole gross is ordinary income + penalty, one action.
   *
   * @param {import('../account.js').Account} account
   * @param {object} split - as returned by `reduceLedgerForWithdrawal`, plus the rate
   * @param {number} split.fromContrib  - contribution portion of the gross (account ccy)
   * @param {number} split.fromEarnings - earnings portion of the gross (account ccy)
   * @param {number} [split.fromRolloverContrib]  - converted-principal portion (Roth)
   * @param {number} [split.fromRolloverEarnings] - growth-on-converted portion (Roth)
   * @param {number} [split.rolloverPenalty]      - §408A(d)(3)(F) recapture, per lot
   * @param {number} [split.rolloverAuAssessable] - s99B share of the converted principal
   * @param {number} split.penaltyRate  - 0..1 (0 above the age gate)
   * @param {string} [split.residency]  - stamped on the AU-assessable earnings actions
   * @param {string} [split.stateKey]   - design 76 per-person attribution for the
   *        rollover actions; omitted ⇒ the tax module's canonical fallback
   * @returns {{ penalty: number, taxActions: Array<object> }}
   */
  earlyWithdrawalTaxActions(account, {
    fromContrib = 0, fromEarnings = 0,
    fromRolloverContrib = 0, fromRolloverEarnings = 0,
    rolloverPenalty = 0, rolloverAuAssessable = 0, derivedDrawn = undefined,
    penaltyRate = 0, residency, stateKey,
  } = {}) {
    const gross      = fromContrib + fromEarnings;
    const taxActions = [];
    let   penalty    = 0;
    switch (account?.type) {
      case ACCOUNT_TYPE.ROTH: {
        // Contributions out first are penalty/tax free; earnings carry the penalty.
        const earningsPenalty        = fromEarnings         * penaltyRate;
        const rolloverEarnPenalty    = fromRolloverEarnings * penaltyRate;
        penalty = earningsPenalty + rolloverEarnPenalty + rolloverPenalty;
        if (fromEarnings > 0) {
          // Design 84 G2 — `auAssessableAmount` is the DERIVED slice; absent ⇒ the tax
          // module assesses the whole amount, i.e. pre-G2 behaviour.
          taxActions.push({ type: 'ROTH_WITHDRAWAL_EARNINGS_TAX', amount: fromEarnings, penaltyAmount: earningsPenalty, auAssessableAmount: derivedDrawn, residency, stateKey });
        }
        // Converted principal: mostly s99B corpus, so this action only exists when
        // there is something to charge — the recapture penalty, or the slice
        // s99B(2)(a) denies the exemption to. Same emit test as EVT-43, so the two
        // paths put the same rows in the journal.
        if (rolloverPenalty > 0 || (residency === 'AU' && rolloverAuAssessable > 0)) {
          taxActions.push({
            type: 'ROTH_ROLLOVER_WITHDRAWAL_CONTRIB_TAX', amount: fromRolloverContrib,
            penaltyAmount: rolloverPenalty, auAssessableAmount: rolloverAuAssessable, residency, stateKey,
          });
        }
        if (fromRolloverEarnings > 0) {
          taxActions.push({ type: 'ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_TAX', amount: fromRolloverEarnings, penaltyAmount: rolloverEarnPenalty, residency, stateKey });
        }
        break;
      }
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
  _drawPenaltyFree(targetAccount, account, key, want, date, eligible, residency, drawnKeys, pendingTaxActions, pushTransfer, fx = 1, fee = 0, selection = null, auCpiLevel = 1, state = null) {
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
      // basis source the event-driven STOCK_WITHDRAWAL_APPLY reducer uses. "Same basis
      // source" is not the same as "same tax action": these two paths, plus the
      // rebalancer and the harvester, are four independent constructors of the same
      // STOCK_WITHDRAWAL_TAX / COLLECTIBLE_SALE_TAX pair, and they had silently drifted
      // apart on the au* fields (design/inconsistencies §4.11). Keep them in step —
      // tests/unit/disposal-tax-payload-parity.test.mjs enforces it. Snapshot
      // the FIFO consumption BEFORE the debit, because transaction() below pro-rata-
      // consumes the lots in place; we then overwrite holdings with the FIFO result so
      // the remaining lots reflect FIFO (and their per-country cost bases deplete
      // correctly). `withdraw` is the sale proceeds in the source account's currency.
      // Pass the AU CGT context only for AU residents, so US-only runs keep the
      // exact prior FIFO output. The context (sale date + country) lets the FIFO
      // tally the discountable-gain split (design 62 §4) — the ≥12-month test runs
      // from each lot's AU deemed-acquisition date — and `level` lets it CPI-index
      // each lot's AU cost base (design 57 §6.3), exactly as the event-driven
      // reducers do. Omitting `level` here used to pin the index factor to 1 on the
      // path that raises 98% of a real plan's disposals.
      const saleMs = date instanceof Date ? date.getTime() : (typeof date === 'number' ? date : null);
      const auCtx = residency === 'AU'
        ? { asOfMs: saleMs, country: 'AU', level: auCpiLevel }
        : null;
      // Signed, charactered gain (design 90 §9 step 2). Note this is NOT gated on
      // residency the way `auCtx` above is: the US §1222 short/long split applies to
      // every disposal this household makes, wherever they live, because they are US
      // citizens taxed on worldwide gains. Gating it would have left the US character
      // unknown on exactly the years an AU-resident run cares about.
      const termCtx = saleMs != null ? { asOfMs: saleMs, countries: ['US', 'AU'] } : null;
      // Design 65: the allocation-aware selection policy steers *which* sleeve/lots
      // are sold; when `selection` is null this is byte-identical to the prior FIFO.
      // Lever C (design 65 §4-C): if rebalance coupling is on and this account carries
      // a stamped design-61 target, bias the sleeve order toward its over-weight class.
      const acctSelection = withRebalanceCoupling(selection, account);
      const brokerageFifo = account.type === ACCOUNT_TYPE.BROKERAGE
        ? consumeHoldings(account.holdings ?? [], withdraw, { indexation: auCtx, selection: acctSelection, terms: termCtx })
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
        // CPI-indexed AU basis (design 57 §6.3) — the "real" cost base the FY2027 AU
        // module assesses against. Falls back to the un-indexed stepped-up basis when
        // no indexation context was supplied (US-resident draw), so a US-only run is
        // byte-identical to before.
        const realizedIndexedAuBasis = brokerageFifo.realizedIndexedBasisByCountry?.AU ?? realizedAuBasis;
        // Collectible split (design 56 §7.2): GOLD lots consumed in this draw are taxed
        // at the US 28% collectibles rate (COLLECTIBLE_SALE_TAX) — and AU CGT if resident
        // — while the rest keeps ordinary brokerage CGT. Mirror the STOCK_WITHDRAWAL_APPLY
        // reducer so the engine and event-driven disposal paths agree.
        const collProceeds = brokerageFifo.collectibleProceeds ?? 0;
        const collBasis    = brokerageFifo.collectibleBasis    ?? 0;
        const collGain     = Math.max(0, collProceeds - collBasis);
        // Per-country AU bases for the gold slice — bullion is an ordinary AU CGT asset,
        // so it takes both the residency step-up and CPI indexation.
        const collAuBasis        = brokerageFifo.collectibleBasisByCountry?.AU        ?? collBasis;
        const collIndexedAuBasis = brokerageFifo.collectibleIndexedBasisByCountry?.AU ?? collAuBasis;
        const collAuGain         = Math.max(0, collProceeds - collAuBasis);
        const collIndexedAuGain  = Math.max(0, collProceeds - collIndexedAuBasis);
        const equityProceeds = +(withdraw - collProceeds).toFixed(2);
        const gain   = Math.max(0, equityProceeds - (realizedBasis   - collBasis));
        const auGain = Math.max(0, equityProceeds - (realizedAuBasis - collAuBasis));
        const auIndexedGain = Math.max(0, equityProceeds - (realizedIndexedAuBasis - collIndexedAuBasis));
        // CGT 50%-discount-eligible slice (design 62 §4): equity gain from lots held
        // ≥12 months from the AU deemed-acquisition date (excludes the gold sleeve,
        // which the collectible split handles), capped at auGain.
        const auDiscountableGain = Math.min(auGain, brokerageFifo.realizedDiscountableGainByCountry?.AU ?? auGain);
        // Design 90 §9 step 2 — the SIGNED, §1222-charactered gain, riding alongside the
        // floored `gain`/`auGain` above rather than replacing them. Nothing consumes
        // these until step 3, which is what makes this commit behaviour-preserving.
        // Written as explicit keys (not a spread) so the parity test's static AST scan
        // can see them; see `disposalTermFields`.
        const { usShortTermGain, usLongTermGain, auShortTermGain, auLongTermGain } =
          disposalTermFields(brokerageFifo.realizedGainByCountryAndTerm);
        account.holdings = brokerageFifo.newHoldings; // FIFO-consumed lots override transaction()'s pro-rata pass
        pendingTaxActions.push({
          // The SOURCE account's currency. Every money field on this action is native
          // to the account drawn (see the method comment above), so a consumer that
          // assumes USD reads an AUD gain as USD and converts it a second time —
          // overstating an AU-domiciled brokerage disposal by the exchange rate.
          currency: account.currency?.code ?? (account.country === 'AU' ? 'AUD' : 'USD'),
          type: 'STOCK_WITHDRAWAL_TAX', gain, auGain, auIndexedGain, auDiscountableGain, residency,
          usShortTermGain, usLongTermGain, auShortTermGain, auLongTermGain,
          proceeds: equityProceeds, costBasis: +(realizedBasis - collBasis).toFixed(2), description: account.name || key,
          // Design 76 Gap B: attribute the AU gain to this account's owner.
          stateKey: account.stateKey ?? key,
        });
        const collTerms = disposalTermFields(brokerageFifo.collectibleGainByCountryAndTerm);
        const collSigned = collTerms.usShortTermGain + collTerms.usLongTermGain;
        // `collGain > 0` alone would have made a gold sleeve sold BELOW basis emit no
        // action at all — the loss did not merely floor to zero, the disposal became
        // invisible. Widened to fire on a signed loss too. Behaviour is unchanged for
        // the tax modules, which read the still-floored `gain`; what changes is that a
        // collectible loss now exists to be netted in step 3.
        if (collGain > 0 || collSigned !== 0) {
          // Design 76 Gap B — gold sleeve inside the account ⇒ attribute by account.
          // `isGold` and the au* pair are NOT optional: the FY2027 AU module reads
          // `isGold ? (auIndexedGain ?? auGain ?? gain) : (auGain ?? gain)`, so a bare
          // {gain, residency, stateKey} does not mean "unknown" — it means "a true
          // collectible, assessed on its US cost base, un-indexed". This path raised
          // 93% of a real plan's collectible disposals with exactly that shape while
          // the rebalancer taxed the SAME gold lots correctly (design/inconsistencies §4.11).
          const { usShortTermGain, usLongTermGain, auShortTermGain, auLongTermGain } = collTerms;
          pendingTaxActions.push({
            type: 'COLLECTIBLE_SALE_TAX', gain: collGain, auGain: collAuGain,
            auIndexedGain: collIndexedAuGain, isGold: true, residency,
            usShortTermGain, usLongTermGain, auShortTermGain, auLongTermGain,
            // Design 91 §8.9's reasoning, applied to the two emitters it did not reach:
            // every disposal register skips an entry with no `proceeds`, so without
            // these the gold slice was assessed and taxed while appearing on no
            // Schedule D, Form 8949 or AU CGT worksheet row. The equity leg above has
            // carried them all along, off the same FIFO tally.
            proceeds: collProceeds, costBasis: collBasis,
            description: account.name || key,
            stateKey: account.stateKey ?? key,
          });
        }
        // Design 87 G9 — the second Reg. §1.988-2(b)(5) trigger, "or the instrument is
        // disposed of". This is the path that raises the large majority of a real plan's
        // disposals, so leaving it out would have made the bond leg fire almost only at
        // maturity. `section988` is null unless the draw actually consumed a foreign
        // BOND lot carrying an authored `fxBasisRate`.
        // `state` is optional on this method's signature (several unit tests call it
        // directly), and absent it the §988 leg is skipped rather than guessed at — an
        // understatement, matching design 87's default everywhere else.
        if (state) {
          pendingTaxActions.push(...section988ForBondPrincipal(
            state, account.stateKey ?? key, account, brokerageFifo.section988 ?? {}));
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
        // `underAge: false` — this whole branch is the age-eligible one, so the
        // §408A(d)(3)(F) recapture on converted principal is switched off by the
        // §72(t) 59½ exception.
        const {
          fromContrib, fromEarnings, fromRolloverContrib, fromRolloverEarnings, rolloverAuAssessable,
          derivedDrawn,
        } = this.reduceLedgerForWithdrawal(account, withdraw, { underAge: false, date });
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
          case ACCOUNT_TYPE.ROTH: {
            // Corpus is silent under s99B(2)(a) and never US-taxable, so only the
            // assessable slices are emitted. Every `penaltyAmount` is 0 because this
            // branch is by definition the age-eligible one — §72(t) does not reach
            // it, and nor does the §408A(d)(3)(F) recapture. For a US resident the
            // reducers book nothing at all, so this stays a no-op there.
            //
            // Design 76 Gap B: every action carries the wrapper's own key, so the AU
            // return attributes to its owner rather than the household.
            const sk = account.stateKey ?? key;
            if (fromEarnings > 0) pendingTaxActions.push({
              // Design 84 G2 — assess the DERIVED slice, not all the earnings.
              type: 'ROTH_WITHDRAWAL_EARNINGS_TAX', amount: fromEarnings, penaltyAmount: 0,
              auAssessableAmount: derivedDrawn, residency, stateKey: sk,
            });
            // Design 84 G9: converted principal drawn on this path used to be
            // invisible — the ledger did not know the rollover buckets, so the slice
            // left the wrapper with no basis reduction and no action, and the
            // s99B-assessable share of it (the source IRA's earnings, denied the
            // corpus exemption by s99B(2)(a)) escaped assessment entirely. Emitted on
            // exactly EVT-43's terms: only when there is something to charge.
            if (residency === 'AU' && rolloverAuAssessable > 0) pendingTaxActions.push({
              type: 'ROTH_ROLLOVER_WITHDRAWAL_CONTRIB_TAX', amount: fromRolloverContrib,
              penaltyAmount: 0, auAssessableAmount: rolloverAuAssessable, residency, stateKey: sk,
            });
            if (fromRolloverEarnings > 0) pendingTaxActions.push({
              type: 'ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_TAX', amount: fromRolloverEarnings,
              penaltyAmount: 0, residency, stateKey: sk,
            });
            break;
          }
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
