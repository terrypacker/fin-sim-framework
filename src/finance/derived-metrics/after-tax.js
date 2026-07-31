/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { isDrawdownAccessible } from './net-liquidity.js';
import { TaxSettleService }     from '../tax-settle-service.js';
import { isCollectibleAllocation } from '../holdings/allocation.js';
import { getResidency, primaryPersonKey } from '../residency-utils.js';
import { toAUD }                from '../tax/tax-fx.js';

/**
 * After-tax re-pricing (design/40).
 *
 * `computeNetWorth` / `computeNetLiquidity` price a pre-tax Traditional IRA /
 * 401(k) dollar AT PAR with a Roth dollar, even though withdrawing the pre-tax
 * dollar triggers ordinary-income tax. That par-value error blinds the headline
 * wealth objectives to Roth-conversion value (a conversion looks like pure tax
 * loss or pure noise), so the MPC Roth lever has no gradient to climb.
 *
 * This module values each balance net of an estimated liquidation tax on its
 * remaining untaxed gain, keyed by **tax class** (not account identity — so a
 * 401k→IRA rollover changes nothing). It is a **modifier orthogonal to the
 * worth/liquidity scope**: the same per-entry value feeds both
 * `computeAfterTaxNetWorth` (all assets) and `computeAfterTaxNetLiquidity`
 * (lever-reachable, reusing net-liquidity's include-predicate). Phase 1 ships
 * Option A (configured effective rates) behind a C-shaped `rateProvider`
 * contract; Options B/C (marginal / liquidation-waterfall) drop into the same
 * seam later (design/40 §3, D1).
 *
 * The same par-value error has a second, opposite-signed form across a border
 * (design 84 G1): a Roth is tax-free to a US holder but a foreign trust to an
 * Australian one, whose earnings are s99B ordinary income with NO foreign tax
 * credit. Valuing it at par for an AU resident overstates household wealth and hid
 * the decant-before-the-move decision entirely. Tax class alone cannot express that
 * — the same account is two different things to two owners — so the ROTH branch of
 * `computeAfterTaxValue` reads per-account ownership and residency.
 */

/** Tax-class taxonomy (design/40 §2.1). Fixes each account's discount formula. */
export const TAX_CLASS = Object.freeze({
  PRE_TAX:       'PRE_TAX',        // ordinary income on withdrawal (IRA, 401k)
  ROTH:          'ROTH',           // US: qualified, tax-free. AU resident: s99B (design 84 G1)
  TAXABLE_BASIS: 'TAXABLE_BASIS',  // gains taxed on sale (brokerage)
  CASH:          'CASH',           // already taxed (savings/checking)
  SUPER:         'SUPER',          // jurisdiction-specific (AU super)
  COLLECTIBLE:   'COLLECTIBLE',    // gold sleeve gain — US 28% collectibles CGT (design 56 §7.3)
});

const _ROLE_TAX_CLASS = {
  'ira':             TAX_CLASS.PRE_TAX,
  'k401':            TAX_CLASS.PRE_TAX,
  'roth-ira':        TAX_CLASS.ROTH,
  'us-stock':        TAX_CLASS.TAXABLE_BASIS,
  'fixed-income':    TAX_CLASS.TAXABLE_BASIS,
  'au-stock':        TAX_CLASS.TAXABLE_BASIS,
  'au-fixed-income': TAX_CLASS.TAXABLE_BASIS,
  'us-savings':      TAX_CLASS.CASH,
  'au-savings':      TAX_CLASS.CASH,
  'super':           TAX_CLASS.SUPER,
};

/**
 * Map an account `role` to its tax class. Unknown roles fall back to CASH (valued
 * at par — the conservative no-op, never an over-discount).
 *
 * `residency` is accepted for the C-shaped contract but remains unused, and that is
 * now a settled decision rather than a pending phase: a tax CLASS describes the
 * asset, residency describes the HOLDER, and the same Roth is two different things
 * to two owners. Residency-dependent pricing therefore lives on the rate path —
 * `computeAfterTaxValue`'s ROTH branch plus `rothLiquidationRate` (design 84 G1) —
 * where it can read per-account ownership instead of being baked into a global
 * role→class map.
 */
export function taxClassForRole(role, { residency } = {}) { // eslint-disable-line no-unused-vars
  return _ROLE_TAX_CLASS[role] ?? TAX_CLASS.CASH;
}

const DEFAULT_ORDINARY_RATE      = 0.22;
const DEFAULT_CAP_GAINS_RATE     = 0.15;
const DEFAULT_COLLECTIBLE_RATE   = 0.28;   // US collectibles (28%) CGT — gold (design 56 §7.3)
const DEFAULT_ASSUMED_GAIN_FRAC  = 0.5;

/** True when an account is denominated/domiciled in AU (picks the AU rate). */
function _isAu(account) {
  const code = account?.currency?.code ?? account?.currency ?? null;
  return code === 'AUD' || account?.country === 'AU';
}

/**
 * The C-shaped rate-provider contract (design/40 §3, D1). A provider answers the
 * effective liquidation rate for a balance given the rest of state — Option A
 * (this default) returns configured constants ignoring `amount`/`state`; Options
 * B/C use those args to read the live brackets / stack the engine. Because the
 * contract already passes `account`+`amount`+`state`+`date`, landing C is
 * swapping the provider, not reworking the metric.
 *
 * @param {object} cfg
 * @param {number} [cfg.ordinaryRate]   - effective ordinary rate (US / default).
 * @param {number} [cfg.ordinaryRateAu] - effective ordinary rate for AU accounts/super.
 * @param {number} [cfg.capGainsRate]   - effective long-term cap-gains rate.
 */
export function defaultRateProvider({
  ordinaryRate    = DEFAULT_ORDINARY_RATE,
  ordinaryRateAu  = ordinaryRate,
  capGainsRate    = DEFAULT_CAP_GAINS_RATE,
  collectibleRate = DEFAULT_COLLECTIBLE_RATE,
} = {}) {
  const ord   = Number.isFinite(ordinaryRate)   ? ordinaryRate   : DEFAULT_ORDINARY_RATE;
  const ordAu = Number.isFinite(ordinaryRateAu) ? ordinaryRateAu : ord;
  const cg    = Number.isFinite(capGainsRate)   ? capGainsRate    : DEFAULT_CAP_GAINS_RATE;
  const coll  = Number.isFinite(collectibleRate)? collectibleRate : DEFAULT_COLLECTIBLE_RATE;
  return {
    ordinaryLiquidationRate(account /*, amount, state, date */) {
      return _isAu(account) ? ordAu : ord;
    },
    capGainsLiquidationRate(/* account, unrealizedGain, state, date */) {
      return cg;
    },
    // A Roth wrapper is US-domiciled, so `_isAu(account)` is false for it and
    // `ordinaryLiquidationRate` would answer the US rate. But the s99B charge is
    // AUSTRALIAN — it falls on the AU-resident beneficiary, not on the account's
    // domicile — so this deliberately answers `ordAu` (design 84 G1). Reached only
    // when the owner is an AU resident; a US-resident Roth never consults a rate.
    rothLiquidationRate(/* account, assessable, state, date */) {
      return ordAu;
    },
    // Gold sleeve (design 56 §7.3): US collectibles 28%; an AU-domiciled gold sleeve
    // disposes as an ordinary AU capital gain, so it takes the cap-gains rate there.
    collectibleLiquidationRate(account /*, gain, state, date */) {
      return _isAu(account) ? cg : coll;
    },
  };
}

/**
 * Option C — the liquidation-waterfall provider (design 40 §3, Phase 3). The
 * real-world-faithful rate: it runs the candidate liquidation through the SAME
 * inflation-adjusted, year-resolved tax engine the sim settles with
 * (`TaxSettleService.computeUsTax`), stacked on the realized income at the
 * valuation date, and returns the **effective** rate `(tax_after − tax_before)/amount`.
 *
 * Because the contract already passes `account`+`amount`+`state`+`date`, this is a
 * drop-in for the Option-A default — landing it is swapping the provider, no metric
 * change (design 40 D1). Scope: **US** pre-tax (ordinary) and US brokerage (LTCG)
 * go through the engine (the dominant pre-tax pile and the Roth jurisdiction —
 * the US taxes IRA/401k distributions regardless of residency, §2.3). **AU/super**
 * fall back to the configured Option-A rates (AU super is concessionally taxed,
 * not ordinary income — its engine path is the design 40 Phase 2 follow-up). Any
 * error or non-finite result also falls back, so the metric never throws.
 *
 * Approximation (documented): each account is valued at its own marginal stack on
 * realized income (not a joint multi-account liquidation), matching the per-entry
 * metric. Joint-liquidation ordering is a later refinement.
 */
export function liquidationRateProvider({ ordinaryRate, ordinaryRateAu, capGainsRate, collectibleRate } = {}) {
  const fallback = defaultRateProvider({ ordinaryRate, ordinaryRateAu, capGainsRate, collectibleRate });
  const svc = new TaxSettleService();
  const MIN_AMOUNT = 1;   // below this the effective-rate delta is numerically meaningless

  // Effective MARGINAL rate of stacking `amount` onto `state.<field>` through a tax
  // engine (computeUsTax / computeAuTax), read off netLiability — the true marginal
  // total tax (brackets, Medicare, CGT discount, FTC interaction all included).
  // Falls back on any trouble so the metric never throws.
  const engineDelta = (computeFn, field, amount, state, fallbackFn) => {
    if (!state || !(amount > MIN_AMOUNT)) return fallbackFn();
    try {
      const before = computeFn(state)?.netLiability ?? 0;
      const after  = computeFn({ ...state, [field]: (state[field] ?? 0) + amount })?.netLiability ?? 0;
      const r = (after - before) / amount;
      return Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : fallbackFn();
    } catch {
      return fallbackFn();
    }
  };
  const computeUs = (s) => svc.computeUsTax(s);
  const computeAu = (s) => svc.computeAuTax(s);

  return {
    ordinaryLiquidationRate(account, amount, state, date) {
      const fb = () => fallback.ordinaryLiquidationRate(account, amount, state, date);
      const cls = taxClassForRole(account?.role);
      // PRE_TAX (US IRA/401k) AND SUPER both liquidate as US ordinary income — the
      // model taxes super EARNINGS withdrawals as US ordinary, no AU tax (§model).
      if (cls === TAX_CLASS.PRE_TAX || cls === TAX_CLASS.SUPER) {
        return engineDelta(computeUs, 'usOrdinaryIncomeYTD', amount, state, fb);
      }
      return fb();
    },
    capGainsLiquidationRate(account, gain, state, date) {
      const fb = () => fallback.capGainsLiquidationRate(account, gain, state, date);
      // AU brokerage → AU CGT (50% discount + brackets + Medicare, via computeAuTax).
      // US brokerage → US LTCG. NB the cross-border case (the runtime adds AU-stock
      // gains to BOTH usCapitalGainsYTD and auCapitalGainsYTD, reconciled by FTC) is
      // approximated here by the AU side only — a documented refinement (design 40).
      if (_isAu(account)) return engineDelta(computeAu, 'auCapitalGainsYTD', gain, state, fb);
      return engineDelta(computeUs, 'usCapitalGainsYTD', gain, state, fb);
    },
    // Roth earnings distributed to an AU resident stack on `auOrdinaryIncomeYTD` as
    // s99B trust income. No US-source removal set is involved: the US taxes nothing
    // here, so FITO has nothing to relieve and the engine delta IS the whole marginal
    // cost — no credit offsets it (design 84 §4). This is the number the Option-A
    // constant can only approximate, and it is the one the study needs, because the
    // slice sits on TOP of the year's other income and is taxed in the highest bracket
    // the household reaches.
    // FX: the Roth is USD but `auOrdinaryIncomeYTD` is an AUD accumulator, so the
    // slice must be converted before it is stacked — otherwise it lands in too low a
    // bracket and the rate comes back understated. The result is a ratio (ΔAUD tax /
    // AUD slice) and so is currency-neutral: the caller may apply it to the USD
    // amount unchanged. `toAUD` is the same helper the s99B reducer uses, and it
    // returns the native amount when the run records no rate.
    rothLiquidationRate(account, assessable, state, date) {
      const fb  = () => fallback.rothLiquidationRate(account, assessable, state, date);
      const ccy = account?.currency?.code ?? account?.currency ?? 'USD';
      return engineDelta(computeAu, 'auOrdinaryIncomeYTD', toAUD(assessable, ccy, state), state, fb);
    },
    // Gold sleeve (design 56 §7.3): a US gold gain stacks on usCollectibleGainsYTD (the
    // 28%-rate accumulator); an AU-domiciled gold sleeve is an ordinary AU capital gain.
    collectibleLiquidationRate(account, gain, state, date) {
      const fb = () => fallback.collectibleLiquidationRate(account, gain, state, date);
      if (_isAu(account)) return engineDelta(computeAu, 'auCapitalGainsYTD',     gain, state, fb);
      return engineDelta(computeUs, 'usCollectibleGainsYTD', gain, state, fb);
    },
  };
}

/**
 * Unrealized gain of a taxable account, split into the **collectible** (gold, US 28%
 * CGT — design 56 §7.3) and the ordinary cap-gains portions. Σ holdings
 * (marketValue − costBasis) per bucket; when basis is unavailable (no holdings), the
 * whole account falls back to a fraction of balance as ordinary cap-gains gain (design
 * 40 Q3) — a gold-less account is therefore byte-for-byte identical to the pre-56 metric.
 * @returns {{ collectibleGain: number, capGainsGain: number }}
 */
function _unrealizedGainSplit(account, assumedGainFraction) {
  const holdings = account?.holdings;
  if (Array.isArray(holdings) && holdings.length > 0) {
    let coll = 0, other = 0;
    for (const h of holdings) {
      const g = (h?.marketValue ?? 0) - (h?.costBasis ?? 0);
      if (isCollectibleAllocation(h?.allocation)) coll += g; else other += g;
    }
    return { collectibleGain: Math.max(0, coll), capGainsGain: Math.max(0, other) };
  }
  const frac = Number.isFinite(assumedGainFraction) ? assumedGainFraction : DEFAULT_ASSUMED_GAIN_FRAC;
  return { collectibleGain: 0, capGainsGain: Math.max(0, (account?.balance ?? 0) * frac) };
}

/**
 * True when this account's owner is an AU resident **right now**.
 *
 * The metric is a "liquidate today" valuation, so it keys off CURRENT residency
 * rather than a planned future move. That is not an approximation: a Roth emptied
 * while still US-resident genuinely is tax-free, which is the entire premise of the
 * design 45 decant lever. Pricing a pre-move Roth as if the move had already
 * happened would erase the very gap the decant exists to exploit.
 *
 * `ownerId` first, primary as the fallback — the convention `RothWithdrawalEarningsHandler`
 * already uses. Unknown owner, or no `state.people` at all ⇒ false (par), the
 * conservative no-op that never over-discounts.
 */
function _isAuResidentOwner(account, state) {
  const key = account?.ownerId ?? primaryPersonKey(state);
  return key != null && getResidency(state, key) === 'AU';
}

/**
 * The s99B-assessable slice of a Roth balance: the earnings, plus the IRA-earnings
 * portion of any converted principal.
 *
 * `earningsBasis` is DERIVED (design 53 §8) as balance − contributionBasis −
 * rollovers, so it already excludes converted principal. Converted principal is
 * mostly corpus and does come out free — but the portion attributable to the source
 * IRA's *earnings* is pre-tax money that "would have been included in assessable
 * income if derived by a resident", so s99B(2)(a) denies it the corpus exemption.
 * `roth-conversion-classes.js` stamps exactly that figure per lot as `taxableAmount`
 * for this purpose, so add it back. Growth ON converted principal needs no special
 * handling — it lands in `earningsBasis` already, since the rollover basis does not
 * grow with the balance.
 *
 * NOTE — the known conservative bias (design 84 G2): `earningsBasis` is
 * mark-to-market APPRECIATION, whereas s99B reaches "amounts derived by the trust
 * estate" — dividends, interest, realised gains — and unrealised growth is derived by
 * nobody. This therefore OVER-states the assessable slice for a buy-and-hold wrapper.
 * That direction is deliberate: the metric never understates a liability. Tracking
 * derived income separately is the design 84 P7 follow-up.
 *
 * No ledger at all ⇒ the whole balance is assessable, mirroring SUPER's back-compat
 * fallback.
 */
function _s99bAssessable(account, balance) {
  const eb = account?.earningsBasis;
  const earnings = Number.isFinite(eb) ? Math.min(Math.max(0, eb), balance) : balance;
  let converted = 0;
  for (const lot of account?.rolloverConversions ?? []) {
    const t = lot?.taxableAmount;
    if (Number.isFinite(t) && t > 0) converted += t;
  }
  return Math.min(balance, earnings + converted);
}

/**
 * After-tax value of a single account, in the account's own currency (FX is
 * applied by the summing functions, mirroring computeNetWorth). The shared core
 * of both scope metrics — one place defines the per-class discount.
 *
 * @param {object} account
 * @param {object} state
 * @param {Date|null} date
 * @param {object} [opts]
 * @param {object} [opts.rateProvider]
 * @param {number} [opts.assumedGainFraction]
 * @returns {number}
 */
export function computeAfterTaxValue(account, state, date, {
  rateProvider = defaultRateProvider(),
  assumedGainFraction = DEFAULT_ASSUMED_GAIN_FRAC,
} = {}) {
  const balance = account?.balance ?? 0;
  const cls = taxClassForRole(account?.role);

  switch (cls) {
    case TAX_CLASS.ROTH: {
      // US holder: a qualified distribution is excluded from gross income
      // (IRC §408A(d)(1)) — par. (Still ignores §408A 5-year recapture and the
      // §72(t) charge on a non-qualified draw — design/40 Q5, unchanged.)
      //
      // AU holder (design 84 G1): the ATO does not recognise the wrapper. It is a
      // foreign trust, distributed EARNINGS are ordinary income under s99B ITAA 1936,
      // and there is NO foreign tax credit — the US levies nothing here, so FITO has
      // nothing to relieve. Pricing that at par overvalued the worst-taxed dollar a
      // cross-border household owns, and it is what blinded this metric to the
      // decant-before-the-move decision.
      //
      // Corpus still comes out free, so only the assessable slice is discounted —
      // the same shape as SUPER below.
      if (!_isAuResidentOwner(account, state)) return balance;
      const assessable = _s99bAssessable(account, balance);
      const r = rateProvider.rothLiquidationRate
        ? rateProvider.rothLiquidationRate(account, assessable, state, date)
        : rateProvider.ordinaryLiquidationRate(account, assessable, state, date);
      return (balance - assessable) + assessable * (1 - clampRate(r));
    }

    case TAX_CLASS.CASH:
      // Already taxed — par.
      return balance;

    case TAX_CLASS.PRE_TAX: {
      // Every dollar is taxed as ordinary income on withdrawal.
      const r = rateProvider.ordinaryLiquidationRate(account, balance, state, date);
      return balance * (1 - clampRate(r));
    }

    case TAX_CLASS.SUPER: {
      // AU super (design/40 Phase 2): post-preservation-age, only the EARNINGS
      // portion is taxed (as US ordinary income, §model) — the contribution basis
      // comes out tax-free. So value = contribution (par) + earnings·(1 − r). When
      // earningsBasis is unknown, fall back to taxing the whole balance (back-compat).
      const eb = account?.earningsBasis;
      const earnings = Number.isFinite(eb) ? Math.min(Math.max(0, eb), balance) : balance;
      const contrib = balance - earnings;
      const r = rateProvider.ordinaryLiquidationRate(account, earnings, state, date);
      return contrib + earnings * (1 - clampRate(r));
    }

    case TAX_CLASS.TAXABLE_BASIS: {
      // Split the embedded gain: a GOLD sleeve's gain carries the 28% collectibles CGT
      // (design 56 §7.3), the rest the ordinary cap-gains rate. A gold-less account has
      // collectibleGain 0, so this is identical to the pre-56 single-rate discount.
      const { collectibleGain, capGainsGain } = _unrealizedGainSplit(account, assumedGainFraction);
      const rCg   = rateProvider.capGainsLiquidationRate(account, capGainsGain, state, date);
      const rColl = (rateProvider.collectibleLiquidationRate
        ? rateProvider.collectibleLiquidationRate(account, collectibleGain, state, date)
        : DEFAULT_COLLECTIBLE_RATE);
      return balance - clampRate(rCg) * capGainsGain - clampRate(rColl) * collectibleGain;
    }

    default:
      return balance;
  }
}

function clampRate(r) {
  if (!Number.isFinite(r)) return 0;
  return Math.min(1, Math.max(0, r));
}

/**
 * Sum after-tax account values in `baseCurrency`, over the entries selected by
 * `includeAccount`. Real property / collectibles are added at par equity (Phase
 * 1, ≡ computeNetWorth — illiquid-asset cap-gains is design/40 Q5), and only
 * when `includeIlliquid` (the worth scope; net liquidity has no balance for them
 * and excludes them anyway).
 */
function _sumAfterTax(state, date, opts, { includeAccount, includeIlliquid }) {
  const baseCurrency = opts?.baseCurrency ?? 'USD';
  let total = 0;

  for (const val of Object.values(state)) {
    if (val == null || typeof val !== 'object') continue;

    let contribution;
    if (val.type === 'loan' && typeof val.balance === 'number') {
      // Liability (design 54): owed principal reduces the worth scope at par. A loan
      // is not a liquid asset, so — like real property — it is only counted when
      // includeIlliquid (worth), never in the net-liquidity scope.
      if (!includeIlliquid) continue;
      contribution = -val.balance;
    } else if (typeof val.balance === 'number') {
      if (!includeAccount(val)) continue;
      contribution = computeAfterTaxValue(val, state, date, opts);
    } else if (includeIlliquid && val.kind === 'real-property' && typeof val.value === 'number') {
      contribution = val.value - (val.mortgageBalance ?? 0);
    } else if (includeIlliquid && val.kind === 'collectible' && typeof val.value === 'number') {
      contribution = val.value;
    } else {
      continue;
    }

    const currency = val.currency?.code ?? val.currency ?? baseCurrency;
    if (currency === baseCurrency) {
      total += contribution;
    } else {
      const pairId = `${baseCurrency}_${currency}`;
      const rate   = state.effectiveExchangeRates?.[pairId] ?? 1;
      total += contribution / rate;
    }
  }
  return total;
}

/**
 * After-tax NET WORTH: every balance-bearing entry (the computeNetWorth scope),
 * each priced net of its embedded liquidation tax, plus real-property equity and
 * collectibles at par (Phase 1).
 */
export function computeAfterTaxNetWorth(state, date = null, opts = {}) {
  return _sumAfterTax(state, date, opts, {
    includeAccount:  () => true,
    includeIlliquid: true,
  });
}

/**
 * After-tax NET LIQUIDITY: the lever-reachable pool only — reusing
 * net-liquidity's `isDrawdownAccessible` predicate so the scope rule lives in
 * exactly one place — each balance priced net of its embedded liquidation tax.
 * This is the honest "die with $X spendable" anchor (design/40 §2.0).
 */
export function computeAfterTaxNetLiquidity(state, date = null, opts = {}) {
  return _sumAfterTax(state, date, opts, {
    includeAccount:  (acct) => isDrawdownAccessible(acct, state, date),
    includeIlliquid: false,
  });
}

/** DerivedMetrics writer for state.metrics.afterTaxNetWorth (registry passes date 2nd). */
export function deriveAfterTaxNetWorth(state, date = null) {
  if (!state.metrics || typeof state.metrics !== 'object') state.metrics = {};
  state.metrics.afterTaxNetWorth = +computeAfterTaxNetWorth(state, date).toFixed(2);
}

/** DerivedMetrics writer for state.metrics.afterTaxNetLiquidity (registry passes date 2nd). */
export function deriveAfterTaxNetLiquidity(state, date = null) {
  if (!state.metrics || typeof state.metrics !== 'object') state.metrics = {};
  state.metrics.afterTaxNetLiquidity = +computeAfterTaxNetLiquidity(state, date).toFixed(2);
}
