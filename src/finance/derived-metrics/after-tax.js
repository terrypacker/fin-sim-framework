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
 */

/** Tax-class taxonomy (design/40 §2.1). Fixes each account's discount formula. */
export const TAX_CLASS = Object.freeze({
  PRE_TAX:       'PRE_TAX',        // ordinary income on withdrawal (IRA, 401k)
  ROTH:          'ROTH',           // qualified, tax-free
  TAXABLE_BASIS: 'TAXABLE_BASIS',  // gains taxed on sale (brokerage)
  CASH:          'CASH',           // already taxed (savings/checking)
  SUPER:         'SUPER',          // jurisdiction-specific (AU super)
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
 * at par — the conservative no-op, never an over-discount). `residency` is
 * accepted for the C-shaped contract but unused in Phase 1 (the provider decides
 * rates); it is wired so Phase 2's residency-aware classification needs no
 * signature change.
 */
export function taxClassForRole(role, { residency } = {}) { // eslint-disable-line no-unused-vars
  return _ROLE_TAX_CLASS[role] ?? TAX_CLASS.CASH;
}

const DEFAULT_ORDINARY_RATE      = 0.22;
const DEFAULT_CAP_GAINS_RATE     = 0.15;
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
  ordinaryRate   = DEFAULT_ORDINARY_RATE,
  ordinaryRateAu = ordinaryRate,
  capGainsRate   = DEFAULT_CAP_GAINS_RATE,
} = {}) {
  const ord   = Number.isFinite(ordinaryRate)   ? ordinaryRate   : DEFAULT_ORDINARY_RATE;
  const ordAu = Number.isFinite(ordinaryRateAu) ? ordinaryRateAu : ord;
  const cg    = Number.isFinite(capGainsRate)   ? capGainsRate    : DEFAULT_CAP_GAINS_RATE;
  return {
    ordinaryLiquidationRate(account /*, amount, state, date */) {
      return _isAu(account) ? ordAu : ord;
    },
    capGainsLiquidationRate(/* account, unrealizedGain, state, date */) {
      return cg;
    },
  };
}

/** Unrealized gain of a taxable account: Σ holdings (marketValue − costBasis), or a fraction of balance when basis is unavailable (design/40 Q3). */
function _unrealizedGain(account, assumedGainFraction) {
  const holdings = account?.holdings;
  if (Array.isArray(holdings) && holdings.length > 0) {
    let gain = 0;
    for (const h of holdings) gain += (h?.marketValue ?? 0) - (h?.costBasis ?? 0);
    return gain;
  }
  const frac = Number.isFinite(assumedGainFraction) ? assumedGainFraction : DEFAULT_ASSUMED_GAIN_FRAC;
  return (account?.balance ?? 0) * frac;
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
    case TAX_CLASS.ROTH:
    case TAX_CLASS.CASH:
      // Roth: qualified, tax-free (Phase 1 ignores §408A recapture — design/40 Q5).
      // Cash: already taxed. Both at par.
      return balance;

    case TAX_CLASS.PRE_TAX:
    case TAX_CLASS.SUPER: {
      // Phase 1 treats super as PRE_TAX at the AU ordinary rate (design/40 Q4).
      const r = rateProvider.ordinaryLiquidationRate(account, balance, state, date);
      return balance * (1 - clampRate(r));
    }

    case TAX_CLASS.TAXABLE_BASIS: {
      const gain = Math.max(0, _unrealizedGain(account, assumedGainFraction));
      const r = rateProvider.capGainsLiquidationRate(account, gain, state, date);
      return balance - clampRate(r) * gain;
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
    if (typeof val.balance === 'number') {
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
