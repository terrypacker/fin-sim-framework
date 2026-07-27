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
 * Semi-annual coupons (design 66 §G10a): when the caller drives the coupon on a
 * `firingsPerYear`-times-a-year stream (2 = semi-annual), each firing pays only the
 * per-holding fraction of the annual coupon that accrued in this sub-period, so the
 * firings across a year sum to the full `marketValue × couponRate`. A holding paying
 * fewer times than the stream fires (an annual `couponFrequency:1` bond on a
 * semi-annual stream) pays only on the year-end firing (see `couponFiringFraction`).
 * The default (`firingsPerYear:1`) pays the full annual coupon in one firing — the
 * pre-G10 behavior, byte-identical for all direct callers.
 *
 * @param {object} opts
 * @param {object} opts.state           - Current simulation state
 * @param {string} opts.stateKey        - state[stateKey] is the account
 * @param {number} opts.fallbackRate    - Coupon rate used when a BOND holding has no couponRate
 * @param {number} [opts.firingIndex=0] - 0-based index of this firing within the year
 *                                        (0 = first/mid-year half, firingsPerYear−1 = year-end)
 * @param {number} [opts.firingsPerYear=1] - How many times/year the coupon stream fires
 * @returns {{ amount: number, federalTaxableAmount: number, stateTaxableAmount: number, holdingActions: HoldingTransactAction[], reinvestBuckets: object[] }}
 *   `reinvestBuckets` groups the coupon by tax character (taxExemption + issuingState
 *   + rateKey + allocation) for the design 66 §G10b new-vintage reinvestment path.
 */
export function computeHoldingsCoupons({ state, stateKey, fallbackRate, firingIndex = 0, firingsPerYear = 1 }) {
  const account  = state?.[stateKey];
  const holdings = account?.holdings ?? [];
  const residentState = primaryResidencyState(state);

  let total          = 0;
  let federalTaxable = 0;
  let stateTaxable   = 0;
  const holdingActions = [];
  // Group the coupon by tax character so §G10b can reinvest each slice into a
  // new-vintage lot that keeps the source's taxExemption/rateKey (a Treasury coupon
  // reinvests into a new Treasury) but takes the prevailing market yield.
  const bucketMap = new Map();
  for (const h of holdings) {
    if (!h || h.allocation !== 'BOND') continue;
    const fraction = couponFiringFraction(h.couponFrequency, firingIndex, firingsPerYear);
    if (fraction === 0) continue;   // this holding pays nothing on this firing
    const mv     = h.marketValue ?? 0;
    const rate   = h.couponRate ?? fallbackRate;
    const coupon = +(mv * rate * fraction).toFixed(2);
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
    const te = h.taxExemption ?? 'none';
    const bucketKey = `${te}|${h.issuingState ?? ''}|${h.rateKey ?? ''}`;
    const b = bucketMap.get(bucketKey);
    if (b) b.amount += coupon;
    else bucketMap.set(bucketKey, {
      taxExemption: te, issuingState: h.issuingState ?? null, rateKey: h.rateKey ?? null, amount: coupon,
    });
  }
  const reinvestBuckets = [...bucketMap.values()].map(b => ({ ...b, amount: +b.amount.toFixed(2) }));
  return {
    reinvestBuckets,
    amount:               +total.toFixed(2),
    federalTaxableAmount: +federalTaxable.toFixed(2),
    stateTaxableAmount:   +stateTaxable.toFixed(2),
    holdingActions,
  };
}

/**
 * The fraction of a BOND holding's annual coupon paid on one firing of a
 * `firingsPerYear`-times-a-year coupon stream (design 66 §G10a).
 *
 * A holding pays its coupon `freq` (= `couponFrequency`, default 2) times a year. On
 * a stream that fires `firingsPerYear` times, the holding participates in the LAST
 * `min(freq, firingsPerYear)` firings of the year (back-loaded so an annual bond pays
 * at year-end, not mid-year) and splits its annual coupon evenly across them. The
 * fractions therefore sum to exactly 1 across a year, preserving the annual coupon.
 *
 * Examples (firingsPerYear = 2 → firings [0=mid-year, 1=year-end]):
 *   freq 2 → 0.5 at each firing;   freq 1 → 0 mid-year, 1.0 at year-end;
 *   freq 4 → 0.5 at each firing (capped at the 2 firing points).
 * With the default `firingsPerYear = 1`, every holding pays the full annual coupon
 * on the single firing regardless of `freq` (the pre-G10 behavior).
 *
 * @param {number} [couponFrequency=2] - Payments/year for the holding
 * @param {number} firingIndex         - 0-based index of this firing within the year
 * @param {number} firingsPerYear      - Firings/year of the stream
 * @returns {number} fraction of the annual coupon due on this firing (0 ≤ f ≤ 1)
 */
export function couponFiringFraction(couponFrequency, firingIndex, firingsPerYear) {
  const freq = Number.isFinite(couponFrequency) && couponFrequency > 0 ? couponFrequency : 2;
  const perYear = Number.isFinite(firingsPerYear) && firingsPerYear > 0 ? firingsPerYear : 1;
  const nPay = Math.min(freq, perYear);                 // firings this holding pays on
  const firstPayingIndex = perYear - nPay;              // back-loaded toward year-end
  if (firingIndex < firstPayingIndex) return 0;
  return 1 / nPay;
}

/**
 * Resolve which firing-of-the-year a coupon event represents from its date, for the
 * semi-annual (2×/yr) coupon stream (design 66 §G10a). Those firings land on the two
 * half-year ends — Jun 30 (mid-year, index 0) and Dec 31 (year-end, index
 * firingsPerYear−1). A single-firing (`firingsPerYear ≤ 1`) or dateless call is index 0.
 *
 * @param {Date|null} date
 * @param {number} [firingsPerYear=1]
 * @returns {number} 0-based firing index within the year
 */
export function couponFiringIndex(date, firingsPerYear = 1) {
  if (!date || firingsPerYear <= 1) return 0;
  return date.getUTCMonth() === 11 ? firingsPerYear - 1 : 0;   // December = the year-end firing
}

/**
 * Resolve the prevailing market yield to stamp on a coupon-reinvestment lot
 * (design 66 §G10b), from `state.effectiveInterestRates`: the per-account
 * `<rateKey>::<stateKey>` override wins over the shared `<rateKey>` (mirrors the G1
 * establish-time stamp). Returns null when neither is present so the caller can fall
 * back to its own per-account coupon rate.
 *
 * @param {object} state
 * @param {string} stateKey
 * @param {string|null} rateKey
 * @returns {number|null}
 */
export function resolvePrevailingCouponRate(state, stateKey, rateKey) {
  const rates = state?.effectiveInterestRates;
  if (!rates || rateKey == null) return null;
  const perAcct = (stateKey != null) ? rates[`${rateKey}::${stateKey}`] : undefined;
  return perAcct ?? rates[rateKey] ?? null;
}

/**
 * Reinvest bond coupons into NEW-VINTAGE lots priced at the *then-prevailing* market
 * yield (design 66 §G10b — reinvestment risk). Rather than crediting the coupon back
 * into the source bond (which perpetuates its old coupon), each tax-character bucket
 * (from `computeHoldingsCoupons().reinvestBuckets`) buys a fresh BOND lot stamped with
 * `prevailingRate`, keeping the source's `taxExemption`/`issuingState`/`rateKey`. The
 * sleeve becomes a real blend of coupon vintages.
 *
 * Consolidation: one lot per `(bucket × year)`, id `reinvest-<stateKey>-<bucket>-<year>`.
 * Both semi-annual firings of a year merge into that year's lot, blending the coupon
 * rate by market value (within-year firings are ≈ the same yield). Holdings stay
 * bounded (≈ one reinvest lot per bucket per year).
 *
 * Preserves the §4.4 invariant only in concert with the caller: it raises Σ marketValue
 * by Σ bucket.amount, so the caller must credit the same total to `balance` (or re-sync
 * balance to Σ marketValue).
 *
 * @param {object[]} holdings - the account's current holdings
 * @param {object} opts
 * @param {string} opts.stateKey
 * @param {object[]} opts.buckets       - reinvestBuckets from computeHoldingsCoupons
 * @param {number|null} opts.prevailingRate - market yield for the new lots (null ⇒ keep bucket's source rate)
 * @param {number} opts.year            - calendar year of the firing (vintage key)
 * @param {number|null} [opts.purchaseMs=null] - firing timestamp for the new lot's purchaseDate
 * @returns {object[]} new holdings array
 */
export function mergeCouponReinvestLots(holdings, { stateKey, buckets, prevailingRate, year, purchaseMs = null }) {
  if (!Array.isArray(holdings) || !Array.isArray(buckets) || buckets.length === 0) return holdings ?? [];
  const next = holdings.slice();
  for (const b of buckets) {
    const amount = +(b.amount ?? 0).toFixed(2);
    if (amount <= 0) continue;
    const te        = b.taxExemption ?? 'none';
    const bucketKey = `${te}|${b.issuingState ?? ''}|${b.rateKey ?? ''}`;
    const lotId     = `reinvest-${stateKey}-${bucketKey}-${year}`;
    const idx       = next.findIndex(h => h?.id === lotId);
    if (idx >= 0) {
      const cur   = next[idx];
      const curMv = cur.marketValue ?? 0;
      const newMv = +(curMv + amount).toFixed(2);
      // mv-weighted blend of this vintage's coupon rate; null prevailing ⇒ keep current.
      const curRate = cur.couponRate ?? prevailingRate ?? 0;
      const blended = prevailingRate == null ? curRate
        : +(((curMv * curRate) + (amount * prevailingRate)) / newMv).toFixed(6);
      next[idx] = { ...cur, marketValue: newMv, costBasis: +((cur.costBasis ?? 0) + amount).toFixed(2), couponRate: blended };
    } else {
      next.push({
        id:              lotId,
        allocation:      'BOND',
        marketValue:     amount,
        costBasis:       amount,   // a bond's basis = its market value (design 53 P1)
        couponRate:      prevailingRate ?? null,
        couponFrequency: 2,        // semi-annual (design 66 §G10a)
        taxExemption:    te,
        issuingState:    b.issuingState ?? null,
        rateKey:         b.rateKey ?? null,
        purchaseDate:    purchaseMs != null ? new Date(purchaseMs) : null,
        label:           `Reinvested coupons ${year}`,
      });
    }
  }
  return next;
}

const ACCRETION_YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

/**
 * Walk an account's BOND holdings and compute per-holding *accretion* — the
 * imputed, non-cash principal growth of a zero-coupon/OID bond or a TIPS, which is
 * currently-taxable ordinary income even though no cash changes hands (design 66
 * §G5 / §G6). Two accreting instruments share this path:
 *
 *   - **Zero-coupon / OID (`zeroCoupon`).** Bought at a discount, the bond's price
 *     accretes to `faceValue` over its life. The annual Original Issue Discount is
 *     computed by the constant-yield method off the *adjusted basis*:
 *         y         = (faceValue / basis)^(1 / yearsToMaturity) − 1
 *         accretion = basis × y                       (capped at faceValue − basis)
 *     so the discount closes smoothly and exactly by maturity.
 *
 *   - **TIPS / inflation-linked (`inflationLinked`).** The principal indexes to CPI:
 *         accretion = basis × cpiRate                 (cpiRate = the period's CPI rate)
 *     The cash coupon (computeHoldingsCoupons) is paid on the grown marketValue, so
 *     indexing the principal here automatically pays the real coupon on the adjusted
 *     principal. Deflation (cpiRate < 0) reduces the principal/income symmetrically;
 *     the redemption deflation-floor lives in BondMaturityReducer.
 *
 * For BOTH, `basis` is the holding's current `costBasis` (which this accretion steps
 * up), and each holding action raises `marketValue` AND `costBasis` by the accretion
 * — the basis step-up is what prevents the accreted principal being taxed a second
 * time as a capital gain at maturity/sale. Plain coupon bonds and bond funds are
 * skipped (no accretion).
 *
 * Returns the coupon-shaped `{ amount, federalTaxableAmount, stateTaxableAmount,
 * holdingActions }`, splitting the accretion by exemption exactly like
 * computeHoldingsCoupons (a Treasury STRIPS `taxExemption:'state'` is federally
 * taxable but state-exempt; a muni zero `taxExemption:'federal'` is federally
 * exempt), so it can route through the shared BOND_COUPON_TAX classification.
 *
 * @param {object} opts
 * @param {object} opts.state           - Current simulation state
 * @param {string} opts.stateKey        - state[stateKey] is the account
 * @param {number} [opts.cpiRate=0]     - The advancing country's period CPI/inflation rate (TIPS indexation)
 * @param {Date|number|null} [opts.currentDate=null] - As-of date (epoch ms or Date) for zero-coupon time-to-maturity
 * @returns {{ amount: number, federalTaxableAmount: number, stateTaxableAmount: number, holdingActions: HoldingTransactAction[] }}
 */
export function computeHoldingsAccretion({ state, stateKey, cpiRate = 0, currentDate = null }) {
  const account  = state?.[stateKey];
  const holdings = account?.holdings ?? [];
  const residentState = primaryResidencyState(state);
  const asOfMs = currentDate == null ? null
    : (currentDate instanceof Date ? currentDate.getTime() : Number(currentDate));

  let total          = 0;
  let federalTaxable = 0;
  let stateTaxable   = 0;
  const holdingActions = [];
  for (const h of holdings) {
    if (!h || h.allocation !== 'BOND') continue;
    const basis = h.costBasis ?? 0;
    let accretion = 0;

    if (h.zeroCoupon) {
      // Constant-yield OID off the adjusted basis; requires a maturity + a par above
      // the current basis (a discount bond) and a positive time remaining.
      const face = h.faceValue ?? 0;
      const matMs = h.maturityDate == null ? null
        : (h.maturityDate instanceof Date ? h.maturityDate.getTime() : new Date(h.maturityDate).getTime());
      const ttm = (matMs != null && asOfMs != null && Number.isFinite(matMs))
        ? Math.max(0, (matMs - asOfMs) / ACCRETION_YEAR_MS) : null;
      if (basis > 0 && face > basis && ttm != null && ttm > 0) {
        const y = Math.pow(face / basis, 1 / ttm) - 1;
        accretion = Math.min(+(basis * y).toFixed(2), +(face - basis).toFixed(2));
      }
    } else if (h.inflationLinked) {
      // Principal indexes to CPI (may be negative under deflation).
      accretion = +(basis * cpiRate).toFixed(2);
    } else {
      continue;  // plain coupon bond / fund — no accretion
    }

    accretion = +accretion.toFixed(2);
    if (accretion === 0) continue;
    total += accretion;
    if (!couponFederalExempt(h))              federalTaxable += accretion;
    if (!couponStateExempt(h, residentState)) stateTaxable   += accretion;
    holdingActions.push(new HoldingTransactAction({
      stateKey,
      holdingId:        h.id,
      marketValueDelta: accretion,
      costBasisDelta:   accretion,   // basis step-up: no double-tax at redemption
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
