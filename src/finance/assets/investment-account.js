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
 * Charge an investment LOSS against the contribution/earnings ledger, earnings
 * first (design 84 G12).
 *
 * A losing year shrinks the account, and the shrinkage has to fall on somebody.
 * It falls on the GAIN first: earnings are drawn down to zero before any of the
 * contributed principal is touched. That ordering is not cosmetic for a Roth held
 * by an Australian resident — `earningsBasis` is the s99B-assessable slice, so
 * charging a loss to corpus instead would leave assessable earnings standing that
 * the market has already taken away, and over-assess every later withdrawal. It is
 * also the mirror of `reduceLedgerForWithdrawal`, which draws contributions first
 * on the way out.
 *
 * Both components floor at zero. When the loss exceeds `contributionBasis +
 * earningsBasis` the ledger lands at 0/0 while `balance` may remain positive —
 * that is the benign UNDER-stated case `reconcileLedgerToBalance` documents and
 * deliberately leaves alone, not a corruption.
 *
 * Pure: returns the new components, mutates nothing, so reducers can spread it
 * into the next state.
 *
 * @param {object} account - anything carrying { contributionBasis, earningsBasis }
 * @param {number} loss    - POSITIVE magnitude of the loss
 * @returns {{contributionBasis: number, earningsBasis: number}}
 */
export function debitLedgerForLoss(account, loss) {
  const contrib  = Math.max(0, account?.contributionBasis ?? 0);
  const earnings = Math.max(0, account?.earningsBasis     ?? 0);
  const l        = Math.max(0, +(loss ?? 0).toFixed(2));
  const fromEarnings = Math.min(l, earnings);
  const fromContrib  = Math.min(l - fromEarnings, contrib);
  const nextEarnings = +(earnings - fromEarnings).toFixed(2);
  return {
    earningsBasis:     nextEarnings,
    contributionBasis: +(contrib  - fromContrib).toFixed(2),
    ...clampDerived(account, nextEarnings),
  };
}

/**
 * Hold `derivedIncomeBasis <= earningsBasis` after the earnings side moves
 * (design 84 G2).
 *
 * A capital loss consumes the accumulated derived pool along with the rest of the
 * gain. The alternative reading — derived income stays assessable forever once
 * derived, regardless of what the market later did to it — is arguably closer to the
 * statute, but it produces a pool the account cannot actually distribute, and
 * `_s99bAssessable` would clamp it to balance anyway. Clamping here instead keeps the
 * invariant local and visible. Stated as an assumption in design 84 §G2 rather than
 * buried.
 *
 * Returns {} for an account with no derived pool, so callers can spread
 * unconditionally without inventing the field on wrappers that do not carry it.
 */
function clampDerived(account, nextEarningsBasis) {
  const d = account?.derivedIncomeBasis;
  if (!Number.isFinite(d)) return {};
  return { derivedIncomeBasis: Math.min(Math.max(0, d), Math.max(0, nextEarningsBasis)) };
}

/**
 * Credit genuinely DERIVED income into a wrapper's ledger (design 84 G2).
 *
 * Interest, coupons, accretion and realised gains are amounts the trust estate has
 * actually derived, so they raise BOTH `earningsBasis` (the deferred-tax split, which
 * is what IRA/401k/super are taxed on) and `derivedIncomeBasis` (the narrower slice
 * s99B reaches). Unrealised appreciation raises only the former — that asymmetry is
 * the whole of G2.
 *
 * These reducers previously credited `balance` alone, leaving the ledger behind by the
 * full amount of every coupon and every month of cash-sleeve interest. That drift is
 * in the "under-stated" direction `reconcileLedgerToBalance` tolerates, which is why
 * nothing caught it, but it silently shrank the taxable earnings of every deferred
 * wrapper over a lifetime.
 *
 * Returns {} for an account with no ledger, so callers spread unconditionally.
 *
 * @param {object} account
 * @param {number} amount - POSITIVE derived amount
 * @returns {{earningsBasis?: number, derivedIncomeBasis?: number}}
 */
export function creditDerivedIncome(account, amount) {
  const a = Math.max(0, +(amount ?? 0).toFixed(2));
  if (!a || !account) return {};
  const out = {};
  if (Number.isFinite(account.earningsBasis)) {
    out.earningsBasis = +((account.earningsBasis + a)).toFixed(2);
  }
  if (Number.isFinite(account.derivedIncomeBasis)) {
    out.derivedIncomeBasis = +((account.derivedIncomeBasis + a)).toFixed(2);
  }
  return out;
}

/**
 * Draw the derived pool down alongside an EARNINGS withdrawal (design 84 G2).
 *
 * A distribution of earnings carries derived income and pure appreciation in the
 * proportion the wrapper holds them, so the pool falls pro-rata rather than
 * derived-first. That matches the provenance split design 84 G11 settled for
 * conversions (ATO PBR 1051558091470) — a wrapper does not get to nominate which of
 * its own dollars leave first, in either direction.
 *
 * Derived-FIRST would be the ATO-conservative reading and would keep the assessable
 * slice higher for longer. It is rejected only for consistency with G11; if that
 * choice is ever revisited, revisit both together.
 *
 * @param {object} account
 * @param {number} earningsDrawn - POSITIVE earnings amount leaving the wrapper
 * @returns {{derivedIncomeBasis?: number}}
 */
export function drawDerivedProRata(account, earningsDrawn) {
  const d = account?.derivedIncomeBasis;
  if (!Number.isFinite(d) || d <= 0) return {};
  const earnings = Math.max(0, account?.earningsBasis ?? 0);
  const drawn    = Math.max(0, +(earningsDrawn ?? 0).toFixed(2));
  if (earnings <= 0 || drawn <= 0) return {};
  const share = Math.min(1, drawn / earnings);
  return { derivedIncomeBasis: Math.max(0, +((d - d * share)).toFixed(2)) };
}

/**
 * RECLASSIFY an already-booked gain as derived, on realisation (design 84 G2).
 *
 * Distinct from `creditDerivedIncome`, and the distinction matters. A coupon is NEW
 * money arriving in the wrapper, so it raises `earningsBasis` and the derived pool
 * together. A realised capital gain is not new money: the appreciation was booked
 * into `earningsBasis` year by year as it accrued, and selling merely converts it
 * from unrealised into *derived*. Raising `earningsBasis` again here would double it.
 *
 * So this moves the slice sideways — derived pool up, earnings untouched — capped at
 * `earningsBasis`, because the pool is a subset of it.
 *
 * This is what makes `rebalanceDriftBandSheltered` a real lever for an Australian
 * resident: a tighter band churns the sheltered wrapper more, each churn realises
 * gain, and realised gain is assessable under s99B where the unrealised appreciation
 * it came from was not.
 *
 * @param {object} account
 * @param {number} gain - POSITIVE realised gain
 * @returns {{derivedIncomeBasis?: number}}
 */
export function realiseDerivedGain(account, gain) {
  const g = Math.max(0, +(gain ?? 0).toFixed(2));
  if (!g || !account || !Number.isFinite(account.derivedIncomeBasis)) return {};
  const cap = Math.max(0, account.earningsBasis ?? 0);
  return { derivedIncomeBasis: Math.min(+((account.derivedIncomeBasis + g)).toFixed(2), cap) };
}

/**
 * Carry a pure REVALUATION through the contribution/earnings ledger (design 84 G8).
 *
 * A revaluation moves an account's market value with no cash crossing the account
 * boundary: a shock's level effect, a bond marked to a new rate curve. Both paths
 * used to rewrite `balance` (via Σ holdings) and leave the ledger where it was, so
 * `contributionBasis + earningsBasis` drifted away from `balance` — the design 53 §8
 * invariant — and the drift was permanent. On the Roth it stranded `earningsBasis`
 * above the balance it belonged to, which misclassifies later withdrawals as earnings
 * when part of them is corpus and over-assesses s99B on an Australian resident.
 *
 * Direction follows the same rule as G12: a fall lands on the GAIN first
 * (`debitLedgerForLoss`), a rise is appreciation and is credited entirely to
 * `earningsBasis` — mirroring what the *EarningsApplyReducer family does with growth.
 *
 * Returns null when the account carries no ledger (plain cash/savings, and brokerage,
 * whose CGT basis lives per-holding), so callers can spread-or-skip. The presence
 * test is the same one `reconcileLedgerToBalance` uses.
 *
 * @param {object} account     - account record
 * @param {number} prevBalance - balance before the revaluation
 * @param {number} nextBalance - balance after it
 * @returns {{contributionBasis: number, earningsBasis: number}|null}
 */
export function revalueLedger(account, prevBalance, nextBalance) {
  if (!account) return null;
  if (!('contributionBasis' in account) || !('earningsBasis' in account)) return null;
  const delta = +((nextBalance ?? 0) - (prevBalance ?? 0)).toFixed(2);
  if (delta === 0) return null;
  if (delta < 0) return debitLedgerForLoss(account, -delta);
  // A rise is unrealised appreciation — nobody derived it — so `earningsBasis` grows
  // and the derived pool does NOT (design 84 G2). That asymmetry is the whole point
  // of the split: a revaluation can never manufacture s99B-assessable income.
  return {
    contributionBasis: account.contributionBasis ?? 0,
    earningsBasis:     +(((account.earningsBasis ?? 0) + delta)).toFixed(2),
  };
}

/**
 * Derive `earningsBasis` from the seed `balance` and `contributionBasis`
 * (design 53 §8): `earningsBasis = max(0, balance − contributionBasis)`. Earnings
 * is the *remainder* the user cannot know directly — the same way a
 * holdings-bearing account's `balance` is the remainder of Σ holdings — so the
 * invariant `contributionBasis + earningsBasis == balance` holds by construction
 * at entry and `reconcileLedgerToBalance` never has to rebase a fresh edit.
 *
 * Applies to the INITIAL / edited seed only (§8.3). The runtime reducers evolve
 * `contributionBasis`/`earningsBasis` independently thereafter — do NOT call this
 * on a live/mid-run ledger, it would flatten the deferred-tax divergence.
 *
 * Contribution defaults to `balance` when absent (→ earnings 0, "all principal";
 * mirrors the builder's `contributionBasis ?? balance`). An over-stated
 * contribution (`> balance`) clamps earnings at 0, matching §8.5.
 *
 * Reads the balance as `balance ?? initialValue`: a serialized config seed spells
 * it `initialValue` (the Account constructor arg), a built Account/state record
 * spells it `balance` — mirroring the serializer's `d.balance ?? d.initialValue`.
 *
 * Roth rollover buckets (`rolloverContribBasis` / `rolloverEarningsBasis`, design
 * 36) are a SEPARATE layer of the same balance, so they are subtracted too — the
 * full invariant is `balance == contributionBasis + earningsBasis +
 * rolloverContribBasis + rolloverEarningsBasis`. Deriving from `balance −
 * contributionBasis` alone would mis-attribute rolled-over principal as regular
 * earnings (the Roth case §8.5 flagged for confirmation). Absent buckets are 0.
 *
 * @param {object} account - seed record ({ balance|initialValue, contributionBasis?, earningsBasis, rollover*Basis? })
 * @returns {number} the derived earningsBasis (also written onto the account)
 */
export function deriveEarningsBasis(account, { openingDerivedFraction = 1 } = {}) {
  const balance = account?.balance ?? account?.initialValue ?? 0;
  const contrib = account?.contributionBasis ?? balance;
  const rollover = (account?.rolloverContribBasis ?? 0) + (account?.rolloverEarningsBasis ?? 0);
  const earnings = +Math.max(0, balance - contrib - rollover).toFixed(2);
  if (account) {
    account.earningsBasis = earnings;
    // Design 84 G2 — seed the derived pool from the same figure, on the same terms.
    // This mirrors what the function already does to `earningsBasis`: it is a SEED
    // path, so it recomputes rather than preserves. Default fraction 1 (all opening
    // earnings treated as derived) is the conservative choice — see the
    // RetirementAccount note on why 0 would be the same error G2 exists to fix.
    const f = Math.min(1, Math.max(0, openingDerivedFraction));
    account.derivedIncomeBasis = +(earnings * f).toFixed(2);
  }
  return earnings;
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
   * @param {number}      [opts.derivedIncomeBasis=0]    - s99B-assessable subset of earningsBasis (design 84 G2)
   * @param {number|null} [opts.minimumAge=null]         - Age gate in decimal years (e.g. 59.5, 60)
   * @param {boolean}     [opts.allowsEarlyWithdrawal=false] - True if pre-minimumAge drawdown is permitted (with penalty)
   */
  constructor(balance = 0, opts = {}) {
    super(balance, opts);
    this.contributionBasis     = opts.contributionBasis     ?? balance;
    this.earningsBasis         = opts.earningsBasis         ?? 0;
    // Design 84 G2 — the s99B-assessable pool: "amounts DERIVED by the trust estate"
    // (dividends, interest, realised gains), as opposed to unrealised appreciation,
    // which nobody has derived. A SUBSET TAG of `earningsBasis`, not a replacement:
    // earningsBasis keeps its existing meaning (everything beyond contributions) so
    // the deferred-tax split on IRA/401k/super is untouched, and this rides alongside
    // as the narrower slice s99B actually reaches. Same shape as NIIT's subset tag on
    // usOrdinaryIncomeYTD. Invariant: 0 <= derivedIncomeBasis <= earningsBasis.
    //
    // SEEDING an opening balance defaults to earningsBasis — i.e. the earnings a
    // wrapper already held at sim start are treated as fully derived. We have no
    // record of how that history split between distributions and price growth, and
    // seeding 0 would silently assert it was ALL unrealised appreciation, retroactively
    // un-deriving decades of dividends. That is the same error G2 exists to fix, only
    // pointing the other way. Defaulting to "all derived" reproduces the pre-G2 charge
    // on the opening slice exactly, so G2 changes only what the sim itself accrues, and
    // keeps the metric's standing rule that it never understates a liability.
    // `openingDerivedFraction` (design 84 G2) scales this for the sensitivity sweep.
    this.derivedIncomeBasis    = opts.derivedIncomeBasis    ?? this.earningsBasis;
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
