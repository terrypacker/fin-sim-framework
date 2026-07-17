/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HoldingTransactAction }    from './holding-actions.js';
import { resolveScheduledRate }     from './appreciation-schedule-utils.js';
import { primaryResidencyState }    from '../residency-utils.js';

/**
 * Whether a BOND holding's coupon is EXEMPT from US FEDERAL income tax
 * (design 66 §G2). Municipal-bond interest is federally exempt; a `taxExemption`
 * of 'federal' or 'both' marks a muni. Treasury ('state') and generic ('none')
 * coupons are federally taxable.
 *
 * @param {object} h - Holding
 * @returns {boolean}
 */
export function couponFederalExempt(h) {
  return h?.taxExemption === 'federal' || h?.taxExemption === 'both';
}

/**
 * Whether a BOND holding's coupon is EXEMPT from US STATE income tax
 * (design 66 §G2):
 *   - 'state' / 'both'  → always state-exempt (a direct U.S. Treasury obligation,
 *                          31 U.S.C. § 3124, is state-exempt in every state; 'both'
 *                          is an unconditionally state-exempt muni);
 *   - 'federal' (muni)  → state-exempt ONLY when the bond's `issuingState` matches
 *                          the resident's home state (an in-state muni); an
 *                          out-of-state muni (or one with no issuingState) is
 *                          state-taxable;
 *   - 'none'            → state-taxable.
 *
 * @param {object} h              - Holding
 * @param {string|null} residentState - Resident's 2-letter state code (null = no state configured)
 * @returns {boolean}
 */
export function couponStateExempt(h, residentState) {
  const te = h?.taxExemption ?? 'none';
  if (te === 'state' || te === 'both') return true;
  if (te === 'federal') {
    return h?.issuingState != null && residentState != null && h.issuingState === residentState;
  }
  return false;
}

/**
 * Walk an account's holdings, compute per-holding growth using
 * state[rateSource][holding.rateKey] (falling back to the handler-supplied
 * rate), and return:
 *
 *   - `amount`           — the total Σ per-holding growth (rounded to 2 dp),
 *                          which the calling handler emits as the *_EARNINGS_APPLY
 *                          (or *_INTEREST_CREDIT) action's `amount` so existing
 *                          tax / RMD / UI math keeps working off account.balance.
 *   - `holdingActions`   — one HoldingTransactAction per non-zero-growth
 *                          holding, with marketValueDelta = growth and
 *                          costBasisDelta = 0 (appreciation does not raise basis).
 *
 * For single-holding accounts (the bootstrap default), the arithmetic
 * collapses to the same `balance × rate` as the pre-substrate code path —
 * existing tests remain green.
 *
 * For multi-holding accounts (toolset-declared splits), each sleeve grows at
 * its own regime-adjusted rate and the total still flows through the
 * downstream _APPLY reducer unchanged.
 *
 * Emission contract: the holding actions MUST be emitted AFTER the matching
 * *_EARNINGS_APPLY action so the existing reducer (CASH_FLOW) updates
 * balance first; HoldingTransactReducer (POSITION_UPDATE) then patches
 * holdings and re-syncs balance to the same value.
 *
 * @param {object} opts
 * @param {object} opts.state              - Current simulation state
 * @param {string} opts.stateKey           - state[stateKey] is the account
 * @param {number} opts.fallbackRate       - Rate to use when state has no effective rate for the holding
 * @param {string} opts.fallbackRateKey    - RATE_KEYS entry to look up when a holding has no rateKey
 * @param {string} [opts.rateSource='effectiveGrowthRates']
 *                                          - 'effectiveGrowthRates' (equity-style)
 *                                            or 'effectiveInterestRates' (interest-bearing)
 * @param {number} [opts.factor=1]         - Multiplier applied to (mv × rate): 1 = annual,
 *                                            1/12 = monthly
 * @param {number|null} [opts.rateOverride=null]
 *                                          - When provided, used for every holding,
 *                                            bypassing the effective-rates map and
 *                                            per-holding rateKey entirely. Used by
 *                                            handlers that accept a `data.rate` one-off.
 * @param {Date|null} [opts.currentDate=null]
 *                                          - Current simulation date; used to resolve
 *                                            per-holding appreciationSchedule entries.
 *                                            When null, schedule lookup is skipped and
 *                                            the effective rate is used directly.
 * @returns {{ amount: number, holdingActions: HoldingTransactAction[] }}
 */
export function computeHoldingsGrowth({
  state,
  stateKey,
  fallbackRate,
  fallbackRateKey,
  rateSource   = 'effectiveGrowthRates',
  factor       = 1,
  rateOverride = null,
  currentDate  = null,
}) {
  const account  = state?.[stateKey];
  const holdings = account?.holdings ?? [];
  const ratesMap = state?.[rateSource] ?? {};
  // Per-account rate key (design 55 §8): `<rateKey>::<stateKey>`. When the regime
  // toolset has seeded a per-account entry (from the account's own growth/interest
  // rate, regime-adjusted), it wins over the shared type-level key so two same-type
  // accounts can grow at different rates while still responding to regime shocks.
  // Absent (legacy / single-rate scenarios) → falls through to the shared key and
  // the arithmetic is byte-for-byte identical.
  const perAcctKey = (fallbackRateKey != null && stateKey != null)
    ? `${fallbackRateKey}::${stateKey}` : null;
  const fbRate   = rateOverride
    ?? (perAcctKey != null ? ratesMap[perAcctKey] : undefined)
    ?? ratesMap[fallbackRateKey]
    ?? fallbackRate;

  if (!holdings.length) {
    // No holdings (defensive): fall back to the scalar-balance code path.
    const balance = account?.balance ?? 0;
    const amount  = +(balance * fbRate * factor).toFixed(2);
    return { amount, holdingActions: [] };
  }

  // On the fixed-income path, a non-null per-holding `couponRate` is a FIXED
  // contractual coupon — it is NOT re-adjusted by state.effectiveInterestRates
  // regime moves (a fixed-coupon bond pays its stated coupon regardless of where
  // market rates go; its price still marks to market via `duration`). It slots in
  // just ahead of the rateKey lookup, below the handler's one-off rateOverride,
  // matching the existing precedence. On the equity growth path (effectiveGrowthRates)
  // couponRate is a bond concept and is ignored. (design 53 §4)
  const useCoupon = rateSource === 'effectiveInterestRates';

  let total = 0;
  const holdingActions = [];
  for (const h of holdings) {
    if (!h) continue;
    // BOND and CASH holdings do NOT earn equity-style appreciation on the growth
    // path. A BOND's return is the coupon (computeHoldingsCoupons /
    // INTL_BOND_COUPON, design 59); its price only marks to market on rate moves
    // (BondPriceAdjustReducer via `duration`). CASH is nominal — it does not
    // appreciate in price; any yield it earns is interest on the useCoupon
    // (effectiveInterestRates) path, where its SAVINGS/CASH rateKey resolves.
    // Both rateKeys are absent from effectiveGrowthRates, so without this guard
    // they fall through to the account's *equity* growth rate (fbRate) and earn
    // a phantom equity return (mirrors the design-59 dividend skip below). GOLD
    // is deliberately NOT skipped: its `GOLD` rateKey resolves to a real
    // commodity-appreciation rate — that IS gold's return, not a fall-through.
    // On the interest path (useCoupon) these rateKeys resolve, so nothing is skipped.
    if (!useCoupon && (h.allocation === 'BOND' || h.allocation === 'CASH')) continue;
    const mv      = h.marketValue ?? 0;
    const baseRate = rateOverride
      ?? (useCoupon ? (h.couponRate ?? undefined) : undefined)
      ?? (h.rateKey != null ? ratesMap[h.rateKey] : undefined)
      ?? fbRate;
    const hRate   = (currentDate && h.appreciationSchedule)
      ? resolveScheduledRate(h.appreciationSchedule, currentDate, baseRate)
      : baseRate;
    const growth  = +(mv * hRate * factor).toFixed(2);
    total += growth;
    if (growth !== 0) {
      holdingActions.push(new HoldingTransactAction({
        stateKey,
        holdingId:        h.id,
        marketValueDelta: growth,
        costBasisDelta:   0,
      }));
    }
  }
  return { amount: +total.toFixed(2), holdingActions };
}

/**
 * Walk an account's holdings and compute per-holding dividends under any active
 * economic regime (design 28 §7 — dividend-yield cuts under regimes):
 *
 *   perHolding = marketValue × max(0, yield × (1 + adj))
 *
 * where `yield` is `holding.dividendYield ?? fallbackYield` and `adj` is the
 * active regime dividend adjustment for the holding's rate key
 * (`state.effectiveDividendAdjustments[holding.rateKey ?? fallbackRateKey] ?? 0`,
 * already scaled by each regime's recovery factor in RegimeApplyReducer). The
 * `max(0, …)` floors a full dividend suspension (adj ≤ -1) at zero.
 *
 * Returns the same `{ amount, holdingActions }` shape as computeHoldingsGrowth so
 * a handler can either emit the per-holding reinvestment actions (AU franked
 * dividends grow the sleeves) or use only the summed amount (US cash / account-
 * level apply). `costBasisDelta` is 0 — reinvested-dividend basis is raised at
 * the account level by the *_DIVIDEND_*_APPLY reducers, matching the
 * computeHoldingsGrowth precedent.
 *
 * Single-holding accounts (and the no-holdings fallback) collapse to
 * `balance × max(0, yield × (1 + adj))`, matching the pre-substrate code path
 * when no regime is active.
 *
 * @param {object} opts
 * @param {object} opts.state              - Current simulation state
 * @param {string} opts.stateKey           - state[stateKey] is the account
 * @param {number} opts.fallbackYield      - Account-level yield used when a holding has no dividendYield
 * @param {string|null} opts.fallbackRateKey - Rate key used when a holding has no rateKey
 * @returns {{ amount: number, holdingActions: HoldingTransactAction[] }}
 */
export function computeHoldingsDividends({ state, stateKey, fallbackYield, fallbackRateKey }) {
  const account  = state?.[stateKey];
  const holdings = account?.holdings ?? [];
  const adjMap   = state?.effectiveDividendAdjustments ?? {};

  const effYield = (yld, rk) => Math.max(0, yld * (1 + (adjMap[rk] ?? 0)));

  if (!holdings.length) {
    const balance = account?.balance ?? 0;
    const amount  = +(balance * effYield(fallbackYield, fallbackRateKey)).toFixed(2);
    return { amount, holdingActions: [] };
  }

  let total = 0;
  const holdingActions = [];
  for (const h of holdings) {
    if (!h) continue;
    // Only EQUITY (and OTHER) sleeves pay an equity dividend. BOND, CASH and GOLD
    // holdings carry no dividendYield, so without this guard each falls back to the
    // account's equity dividend rate (fallbackYield) and earns a spurious dividend:
    //   - BOND income is the coupon (computeHoldingsCoupons / INTL_BOND_COUPON, design 59);
    //   - CASH income (if any) is interest on the effectiveInterestRates path, not a dividend;
    //   - GOLD is a non-income commodity — it appreciates (computeHoldingsGrowth) but yields nothing.
    if (h.allocation === 'BOND' || h.allocation === 'CASH' || h.allocation === 'GOLD') continue;
    const mv  = h.marketValue ?? 0;
    const yld = h.dividendYield ?? fallbackYield;
    const rk  = h.rateKey ?? fallbackRateKey;
    const div = +(mv * effYield(yld, rk)).toFixed(2);
    total += div;
    if (div !== 0) {
      holdingActions.push(new HoldingTransactAction({
        stateKey,
        holdingId:        h.id,
        marketValueDelta: div,
        costBasisDelta:   0,
      }));
    }
  }
  return { amount: +total.toFixed(2), holdingActions };
}

/**
 * Walk an account's BOND holdings and compute per-holding coupon interest
 * (design 59):
 *
 *   perHolding = marketValue × (holding.couponRate ?? fallbackRate)
 *
 * A non-null `couponRate` is a FIXED contractual coupon and is NOT re-adjusted by
 * economic-regime rate moves (design 53 §4) — so, unlike dividends, coupons take
 * no `effectiveDividendAdjustments`/regime scaling here. Only BOND holdings pay a
 * coupon; EQUITY/CASH/GOLD/OTHER sleeves are skipped.
 *
 * Returns the dividend-shaped `{ amount, holdingActions }` plus two taxable
 * sub-totals that split the coupon by exemption (design 66 §G2, generalizing the
 * design-59 Treasury split):
 *   - `amount`               — the FULL coupon (always credited to the balance);
 *   - `federalTaxableAmount` — the coupon EXCLUDING federally-exempt (municipal)
 *                              holdings; the federal tax module taxes this slice;
 *   - `stateTaxableAmount`   — the coupon EXCLUDING state-exempt holdings, i.e.
 *                              Treasury ('state'/'both') AND in-state munis
 *                              (`issuingState` == the resident's state). The
 *                              resident's state is read from `state.people` via
 *                              primaryResidencyState, so an out-of-state muni is
 *                              state-taxable while an in-state one is exempt.
 * The caller stamps all three onto the BOND_COUPON_* action.
 *
 * `holdingActions` reinvest the coupon into each sleeve (costBasisDelta 0),
 * matching computeHoldingsDividends; a cash-payout caller can ignore them and
 * use only the summed amount.
 *
 * @param {object} opts
 * @param {object} opts.state         - Current simulation state
 * @param {string} opts.stateKey      - state[stateKey] is the account
 * @param {number} opts.fallbackRate  - Coupon rate used when a BOND holding has no couponRate
 * @returns {{ amount: number, federalTaxableAmount: number, stateTaxableAmount: number, holdingActions: HoldingTransactAction[] }}
 */
export function computeHoldingsCoupons({ state, stateKey, fallbackRate }) {
  const account  = state?.[stateKey];
  const holdings = account?.holdings ?? [];
  const residentState = primaryResidencyState(state);

  let total          = 0;
  let federalTaxable = 0;
  let stateTaxable   = 0;
  const holdingActions = [];
  for (const h of holdings) {
    if (!h || h.allocation !== 'BOND') continue;
    const mv     = h.marketValue ?? 0;
    const rate   = h.couponRate ?? fallbackRate;
    const coupon = +(mv * rate).toFixed(2);
    if (coupon === 0) continue;
    total += coupon;
    if (!couponFederalExempt(h))              federalTaxable += coupon;  // munis are federally exempt
    if (!couponStateExempt(h, residentState)) stateTaxable   += coupon;  // Treasury / in-state muni are state-exempt
    holdingActions.push(new HoldingTransactAction({
      stateKey,
      holdingId:        h.id,
      marketValueDelta: coupon,
      costBasisDelta:   0,
    }));
  }
  return {
    amount:               +total.toFixed(2),
    federalTaxableAmount: +federalTaxable.toFixed(2),
    stateTaxableAmount:   +stateTaxable.toFixed(2),
    holdingActions,
  };
}

/**
 * Walk an account's CASH holdings and compute per-holding money-market interest
 * (design 60):
 *
 *   perHolding = marketValue × rate × factor
 *
 * `rate` is resolved from `state.effectiveInterestRates` using the account's
 * country SAVINGS key: `<rateKey>::<stateKey>` per-account override → shared
 * `<rateKey>` → `fallbackRate`, mirroring `UsSavingsInterestMonthlyHandler`. This
 * is the yield a CASH sleeve inside an *equity-served* account (brokerage /
 * retirement / super) earns: those accounts run off the equity-growth earnings
 * handler, which (post design-59 follow-up) applies NO return to CASH, so without
 * this stream their cash would sit idle. Savings/offset/fixed-income accounts have
 * their own interest handlers and are NOT wired to this stream (no double-count).
 *
 * Only CASH holdings earn here; EQUITY/BOND/GOLD/OTHER are skipped. `factor` scales
 * the annual rate to the accrual period (1/12 for the monthly stream), so monthly
 * crediting compounds the sleeve — the effective annual yield is therefore slightly
 * above the nominal rate, exactly as the monthly savings-interest handlers behave.
 *
 * Returns the dividend-shaped `{ amount, holdingActions }`; `holdingActions`
 * reinvest the interest into each CASH sleeve (costBasisDelta 0) so it compounds.
 *
 * @param {object} opts
 * @param {object} opts.state
 * @param {string} opts.stateKey
 * @param {string} opts.rateKey       - SAVINGS_US / SAVINGS_AU key into effectiveInterestRates
 * @param {number} opts.fallbackRate  - Annual rate used when the map has no entry
 * @param {number} [opts.factor=1/12] - Annual→period scale (1/12 = monthly)
 * @returns {{ amount: number, holdingActions: HoldingTransactAction[] }}
 */
export function computeHoldingsCashInterest({ state, stateKey, rateKey, fallbackRate, factor = 1 / 12 }) {
  const account  = state?.[stateKey];
  const holdings = account?.holdings ?? [];
  const rates    = state?.effectiveInterestRates ?? {};
  const rate = (stateKey != null ? rates[`${rateKey}::${stateKey}`] : undefined)
    ?? (rateKey != null ? rates[rateKey] : undefined)
    ?? fallbackRate;

  let total = 0;
  const holdingActions = [];
  for (const h of holdings) {
    if (!h || h.allocation !== 'CASH') continue;
    const mv       = h.marketValue ?? 0;
    const interest = +(mv * rate * factor).toFixed(2);
    if (interest === 0) continue;
    total += interest;
    holdingActions.push(new HoldingTransactAction({
      stateKey, holdingId: h.id, marketValueDelta: interest, costBasisDelta: 0,
    }));
  }
  return { amount: +total.toFixed(2), holdingActions };
}
