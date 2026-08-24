/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ALLOCATION, ALLOCATION_VALUES } from './allocation.js';
import { RATE_KEYS }         from '../economic-regimes/rate-keys.js';

const RATE_KEY_VALUES = new Set(Object.values(RATE_KEYS));

/**
 * Every Holding must declare a known ALLOCATION. There is no catch-all bucket and
 * no inferred default here: the allocation decides the holding's rate series, its
 * earnings path, whether a shock revalues it, and whether the rebalancer and the
 * drawdown sleeve order can see it at all. An unrecognised value would be silently
 * skipped by the last two, so it fails at construction instead.
 */
function assertValidAllocation(allocation, id) {
  if (ALLOCATION_VALUES.includes(allocation)) return;
  throw new Error(
    `Holding ${id ?? '(unnamed)'} has ${allocation == null ? 'no allocation' : `an unknown allocation "${allocation}"`}. ` +
    `Expected one of: ${ALLOCATION_VALUES.join(', ')}.`,
  );
}

/**
 * Design 87 §11 — CASH carries no capital gain, so its basis IS its value. A unit of
 * currency is disposed of for exactly its face; there is no price to have moved.
 *
 * The Holding constructor establishes this, but a holding's life is spent inside
 * reducers that patch plain records, never re-running the constructor — so the
 * invariant has to be RE-asserted on every write, not just at birth. Two reducer paths
 * broke it:
 *
 *   - HoldingTransactReducer — the design-60 money-market stream reinvests a CASH
 *     sleeve's interest with a `costBasisDelta`; any delta that does not match
 *     `marketValueDelta` opens a gap.
 *   - HoldingRevalueReducer  — a shock marks CASH down with the rest of the account
 *     (see the shock/allocation note) and leaves basis where it was.
 *
 * Once open the gap is permanent: the proportional scaling in holding-utils preserves
 * whatever basis:value ratio a lot carries, so a drifted ratio is fixed in place for the
 * life of the plan. Downstream, `_unrealizedGainSplit` (after-tax) priced it as embedded
 * CGT, and `basisRatio` / `unrealizedGain` (holdings-selection) read it as HIFO sort
 * keys. The disposal paths themselves were never exposed — both already special-case
 * CASH — so this was a metric/ordering defect, not a tax leak.
 *
 * This does NOT discard currency basis. A foreign-currency pool's §988 basis is a RATE,
 * not an amount, and lives in `fxBasisRate` — that separation is the whole point of
 * design 87. `costBasis` was never able to express it.
 *
 * @param {object} h - a holding record (plain or Holding)
 * @returns {object} `h` unchanged when the invariant already holds, else a corrected copy
 */
export function applyCashBasisInvariant(h) {
  if (!h || h.allocation !== ALLOCATION.CASH) return h;
  const mv = h.marketValue ?? 0;
  if (h.costBasis === mv) return h;
  return { ...h, costBasis: mv };
}

/**
 * A non-null rateKey must name a real rate series. A stale or mistyped key (an
 * older scenario's `BOND_US`, say) resolves to nothing in effectiveGrowthRates /
 * effectiveInterestRates and quietly falls back to the account-level rate, so the
 * holding earns the wrong series with no signal that anything is wrong.
 * `null` stays legal — it means "resolve from (country, allocation, role) at
 * registration", which AccountService does.
 */
function assertValidRateKey(rateKey, id) {
  if (rateKey == null || RATE_KEY_VALUES.has(rateKey)) return;
  throw new Error(
    `Holding ${id ?? '(unnamed)'} has an unknown rateKey "${rateKey}". ` +
    `Expected null or one of: ${[...RATE_KEY_VALUES].join(', ')}.`,
  );
}

/**
 * Holding — plain-data record of a single position inside an Account.
 *
 * An Account exposes a denormalized `balance` scalar, but the source of truth
 * is `account.holdings: Holding[]`. The invariant
 *   account.balance === Σ holdings[i].marketValue   (currency-rounded)
 * is maintained by the holdings reducers (see holding-reducers.js#_syncBalance).
 *
 * No methods — safe for structuredClone snapshots. Logic that needs to read
 * derived values (unrealizedGainLoss) lives on AccountService.
 *
 * Round-trips via TypeRegistry: toJSON / static fromJSON.
 */
export class Holding {
  static type = 'Holding';

  /**
   * @param {object}  [opts]
   * @param {string|null} [opts.id=null]            - Assigned by AccountService on registration
   * @param {string}      opts.allocation           - ALLOCATION value (EQUITY | BOND | CASH | OTHER)
   * @param {number}      [opts.marketValue=0]      - Current market value
   * @param {number}      [opts.costBasis=0]        - Tax basis for gain/loss computation (origin / universal basis)
   * @param {Object<string,number>|null} [opts.costBaseByCountry=null]
   *                                                - Per-country cost-base overrides, keyed by ISO country code,
   *                                                  set when a jurisdiction steps up the basis on becoming
   *                                                  resident (e.g. AU ITAA97 s855-45: market value at the move).
   *                                                  null/absent for a country ⇒ that country uses `costBasis`.
   *                                                  Country-agnostic; see design 36 §12.2.
   * @param {Date|null}   [opts.purchaseDate=null]  - Acquisition date; null = "carried in from scenario boot"
   * @param {number|null} [opts.acquisitionPriceLevel=null]
   *                                                - AU price level (state.inflationAccumulator.AU) at acquisition,
   *                                                  used as the CGT cost-base indexation base for the FY2027 AU CGT
   *                                                  reform (design 57 §6.3). null = not stamped ⇒ no indexation
   *                                                  (index factor 1). The 1 Jul 2027 deemed cost base reset (design
   *                                                  57 §6.4) restamps this alongside costBaseByCountry.AU.
   * @param {Object<string,number>|null} [opts.acquisitionDateByCountry=null]
   *                                                - Per-country CGT deemed-acquisition date (epoch ms), keyed by ISO
   *                                                  country code, set when a jurisdiction steps up the basis on
   *                                                  becoming resident (e.g. AU ITAA97 s855-45: the residency date).
   *                                                  This is the date the ≥12-month CGT-discount / indexation clock
   *                                                  runs from for that country — it RESTARTS at the move, per ATO
   *                                                  "How changing residency affects CGT". null/absent for a country
   *                                                  ⇒ that country uses `purchaseDate`. `purchaseDate` itself is left
   *                                                  unchanged (it drives FIFO order + design 57's straddle test).
   *                                                  Country-agnostic; see design 62 §4.
   * @param {string|null} [opts.rateKey=null]       - Lookup into state.effectiveGrowthRates; resolved on register if null
   * @param {string}      [opts.label='']           - Optional display label ("ITOT", "BND")
   * @param {number|null} [opts.dividendYield=null] - Per-holding annual dividend yield; null = fall back to the
   *                                                  dividend handler's account-level rate (design 28 §7)
   * @param {number|null} [opts.couponRate=null]    - Per-holding annual bond coupon rate (BOND holdings only).
   *                                                  Non-null = a FIXED contractual coupon that is NOT re-adjusted
   *                                                  by state.effectiveInterestRates regime moves (its price still
   *                                                  marks to market via `duration`, design 28). null = fall back to
   *                                                  the regime-adjusted rateKey rate (today's floating behavior).
   *                                                  The bond twin of `dividendYield` (design 53 §4).
   * @param {number} [opts.couponFrequency=2]         - BOND holdings only (design 66 §G10a): how many times per year the
   *                                                  coupon is paid (1 = annual, 2 = semi-annual [the realistic default
   *                                                  for Treasuries/corporates], 4 = quarterly). Each firing pays
   *                                                  `marketValue × couponRate / couponFrequency`; the firings sum to the
   *                                                  annual coupon. Ignored for non-BOND allocations. Back-compat: an old
   *                                                  save with no field loads as 2.
   * @param {Array<{date: Date|string, rate: number}>|null} [opts.appreciationSchedule=null]
   *                                                - Step-wise appreciation schedule; null = use asset scalar rate
   * @param {number|null} [opts.duration=null]      - Modified duration in years (BOND holdings only);
   *                                                  null = fall back to RATE_KEY_META[rateKey].defaultDuration ?? 0
   * @param {string|null} [opts.taxLossPartner=null] - Holding id of the substitute to rebuy after a tax-loss harvest
   *                                                   (design 29 §3.3). Null = fall back to same-rateKey search.
   * @param {'none'|'state'|'federal'|'both'} [opts.taxExemption='none']
   *                                                - BOND holdings only: how the coupon is exempted from income tax
   *                                                  (design 66 §G2, generalizing the design-59 `treasury` flag):
   *                                                    'none'    — fully taxable federal + state (corporate/other bond);
   *                                                    'state'   — federally taxable but US-state-EXEMPT (a direct U.S.
   *                                                                Treasury obligation, 31 U.S.C. § 3124);
   *                                                    'federal' — federally EXEMPT (a municipal bond); ADDITIONALLY
   *                                                                state-exempt when `issuingState` matches the
   *                                                                resident's state (in-state muni), else state-taxable;
   *                                                    'both'    — unconditionally federal- AND state-exempt (a muni
   *                                                                treated as state-exempt regardless of residence).
   *                                                  Ignored for non-BOND allocations. Back-compat: a legacy
   *                                                  `treasury: true` holding loads as 'state'.
   * @param {string|null} [opts.issuingState=null]  - BOND holdings only: 2-letter US state code of a municipal bond's
   *                                                  issuer (taxExemption 'federal'). The muni coupon is state-exempt
   *                                                  only when this matches the resident's state; null ⇒ treated as
   *                                                  out-of-state (state-taxable). Ignored for other taxExemption
   *                                                  values / non-BOND allocations (design 66 §G2).
   * @param {Date|null}   [opts.maturityDate=null]  - BOND holdings only: the redemption date (design 66 §G4 / §3
   *                                                  identity decision). null ⇒ the sleeve is a bond *fund* — perpetual,
   *                                                  static `duration`, never matures (the back-compatible default).
   *                                                  Non-null ⇒ an *individual bond*: its effective duration decays to
   *                                                  0 as the date approaches (BondPriceAdjustReducer) and its price
   *                                                  pulls to `faceValue` (recovering any rate-driven markdown); on the
   *                                                  first period-advance at/after this date it is redeemed at par to
   *                                                  cash by BondMaturityReducer. Ignored for non-BOND allocations.
   * @param {number|null} [opts.faceValue=null]     - BOND holdings only: the par value redeemed at `maturityDate`. For
   *                                                  a par bond (the Phase-3 scope) this equals the purchase
   *                                                  marketValue/costBasis, so redemption is a return of principal with
   *                                                  no realized gain (premium/discount amortization is design 66 §G9,
   *                                                  out of scope). null on an individual bond ⇒ redeem at the
   *                                                  then-current marketValue. Ignored when `maturityDate` is null.
   * @param {boolean}     [opts.rollAtMaturity=false] - BOND holdings only: when true, an individual bond does NOT
   *                                                  redeem to cash at maturity but ROLLS into a fresh par bond of the
   *                                                  same term, re-issued at the then-current market yield
   *                                                  (`effectiveInterestRates[rateKey]`, G1 lock-in) — a self-sustaining
   *                                                  single-rung ladder (design 66 §G4; full ladders are §G8). Ignored
   *                                                  when `maturityDate` is null.
   * @param {number|null} [opts.rollTermYears=null]  - BOND holdings only (design 66 §G8): the term, in years, of the
   *                                                  fresh bond a rung rolls INTO at maturity (only meaningful with
   *                                                  `rollAtMaturity`). This is what turns a set of staggered rungs into a
   *                                                  self-perpetuating *ladder*: every rung rolls to the SAME fixed term
   *                                                  (the ladder length), so a maturing near rung becomes the new far
   *                                                  rung and the {1,2,…,N} spacing is preserved as the clock advances.
   *                                                  null ⇒ roll into a bond of the rung's OWN original term
   *                                                  (`maturityDate − purchaseDate`) — the back-compatible single-bond
   *                                                  "constant-maturity" behavior. Ignored without `rollAtMaturity`.
   * @param {boolean}     [opts.zeroCoupon=false]    - BOND holdings only (design 66 §G6): a zero-coupon / OID bond. Pays
   *                                                  NO cash coupon (couponRate is 0/ignored); it is bought at a discount
   *                                                  to `faceValue` and its price *accretes* to par over its life. The
   *                                                  annual accretion (constant-yield Original Issue Discount) is imputed
   *                                                  ordinary income EVEN THOUGH no cash is received (BondAccretionHandler
   *                                                  → BOND_ACCRETION_APPLY), and it steps up `costBasis` so redemption at
   *                                                  par realizes no further gain. A zero is always an *individual bond*
   *                                                  (requires `maturityDate` + `faceValue`); it is EXCLUDED from the
   *                                                  BondPriceAdjustReducer pull-to-par mark (the accretion owns the price
   *                                                  trajectory) but still takes the rate-sensitivity mark. Ignored for
   *                                                  non-BOND allocations / bond funds (no maturityDate).
   * @param {number|null} [opts.fxBasisRate=null]   - BOND holdings in a non-USD account (design 87 G9):
   *                                                  foreign units per USD when the bond was ACQUIRED. A
   *                                                  foreign-currency bond is a debt instrument
   *                                                  (§988(c)(1)(B)(i)) and its HOLDER realizes ordinary
   *                                                  exchange gain or loss on principal when it is redeemed
   *                                                  or disposed of (Reg. §1.988-2(b)(5) — the mirror of the
   *                                                  (b)(6) obligor rule the mortgage leg uses). Ignored for
   *                                                  EQUITY/GOLD, which are NOT §988 property: their currency
   *                                                  movement rides inside the capital gain via §1001.
   * @param {boolean}     [opts.inflationLinked=false] - BOND holdings only (design 66 §G5): a TIPS / inflation-linked
   *                                                  bond. Its principal indexes to CPI each year (via
   *                                                  `state.cpiAccumulator`), so its cash coupon (marketValue × couponRate)
   *                                                  is paid on the *inflation-adjusted* principal. The annual inflation
   *                                                  accretion is imputed ordinary income (US "phantom" income;
   *                                                  BondAccretionHandler) and steps up `costBasis`. Like a zero it is
   *                                                  EXCLUDED from pull-to-par (its redemption value is the adjusted
   *                                                  principal, not the original face) and redeems at
   *                                                  max(adjustedPrincipal, faceValue) — the deflation floor. Ignored for
   *                                                  non-BOND allocations.
   */
  constructor({
    id                   = null,
    allocation,
    marketValue          = 0,
    costBasis            = 0,
    costBaseByCountry    = null,
    purchaseDate         = null,
    acquisitionPriceLevel = null,
    acquisitionDateByCountry = null,
    rateKey              = null,
    label                = '',
    dividendYield        = null,
    couponRate           = null,
    couponFrequency      = 2,
    appreciationSchedule = null,
    duration             = null,
    taxLossPartner       = null,
    taxExemption         = 'none',
    issuingState         = null,
    maturityDate         = null,
    faceValue            = null,
    rollAtMaturity       = false,
    rollTermYears        = null,
    zeroCoupon           = false,
    inflationLinked      = false,
    fxBasisRate          = null,
    // ── design 93 §5 (Option A): the UNITISED representation, bonds first ──────────
    // Present only on an individual bond. When `units` is non-null the holding is
    // UNITISED and its value flows from a count times a per-unit quantity; when it is
    // absent the holding is SCALAR and `marketValue` is the stored primary, which is
    // every equity sleeve and every bond FUND. Both modes are first-class (design 93
    // §6.2 item 2) — Option C is exactly "flip equity from scalar to unitised", so
    // scalar must never become a legacy branch.
    units                = null,
    parPerUnit           = null,
    pricePerUnit         = null,
    // TIPS only: the CPI index ratio, 1.0 at issue. Today the inflation adjustment is
    // buried inside `marketValue`, which is why redemption pays out accumulated rate
    // noise (design 93 §5.3). Tracking it explicitly is what lets the deflation floor
    // compare two par-like quantities instead of comparing par against a market price.
    cpiIndexRatio        = null,
    // RESERVED, always null under Option A. Under Option C a holding names the security
    // it is a position in and the instrument-level fields move behind that reference;
    // carrying the field from day one means C never has to touch the serializer, the
    // schema registry or the round-trip tests (design 93 §6.2 item 4).
    securityId           = null,
  } = {}) {
    assertValidAllocation(allocation, id);
    assertValidRateKey(rateKey, id);
    this.id                   = id;
    this.allocation           = allocation;
    this.marketValue          = marketValue;
    // Design 87 §11 — see applyCashBasisInvariant. Enforced here rather than trusted,
    // because a stale ratio is invisible and survives forever: one bad authoring or
    // import fixes it in place for the life of the plan. The reducers re-assert the
    // same rule on every write, since they never come back through this constructor.
    this.costBasis            = allocation === ALLOCATION.CASH ? marketValue : costBasis;
    this.costBaseByCountry    = costBaseByCountry;
    this.purchaseDate         = purchaseDate;
    this.acquisitionPriceLevel = acquisitionPriceLevel;
    this.acquisitionDateByCountry = acquisitionDateByCountry;
    this.rateKey              = rateKey;
    this.label                = label;
    this.dividendYield        = dividendYield;
    this.couponRate           = couponRate;
    this.couponFrequency      = couponFrequency;
    this.appreciationSchedule = appreciationSchedule;
    this.duration             = duration;
    this.taxLossPartner       = taxLossPartner;
    this.taxExemption         = taxExemption;
    this.issuingState         = issuingState;
    this.maturityDate         = maturityDate;
    this.faceValue            = faceValue;
    this.rollAtMaturity       = rollAtMaturity;
    this.rollTermYears        = rollTermYears;
    this.zeroCoupon           = zeroCoupon;
    this.inflationLinked      = inflationLinked;
    this.fxBasisRate          = fxBasisRate;
    // ASSIGNED ONLY WHEN PRESENT. `normalizeState` keeps explicit nulls, so defaulting
    // these to null would add five fields to every holding in every golden fixture and
    // make an unrelated diff on every future change. Same discipline as
    // `costBaseByCountry` (design 84 G8).
    if (units         != null) this.units         = units;
    if (parPerUnit    != null) this.parPerUnit    = parPerUnit;
    if (pricePerUnit  != null) this.pricePerUnit  = pricePerUnit;
    if (cpiIndexRatio != null) this.cpiIndexRatio = cpiIndexRatio;
    if (securityId    != null) this.securityId    = securityId;
  }

  toJSON() {
    // par-reviewed: SERIALIZATION, not mutation. This builds a plain JSON record from a
    // Holding; the spreads are conditional field emission, not a copy of a live position,
    // so there is no par to fall out of step with.
    return {
      __type:              this.constructor.type,
      id:                  this.id,
      allocation:          this.allocation,
      marketValue:         this.marketValue,
      costBasis:           this.costBasis,
      costBaseByCountry:   this.costBaseByCountry ? { ...this.costBaseByCountry } : null,
      purchaseDate:        this.purchaseDate ? this.purchaseDate.toISOString() : null,
      acquisitionPriceLevel: this.acquisitionPriceLevel,
      acquisitionDateByCountry: this.acquisitionDateByCountry ? { ...this.acquisitionDateByCountry } : null,
      rateKey:             this.rateKey,
      label:               this.label,
      dividendYield:       this.dividendYield,
      couponRate:          this.couponRate,
      couponFrequency:     this.couponFrequency,
      appreciationSchedule: this.appreciationSchedule
        ? this.appreciationSchedule.map(e => ({
            date: e.date instanceof Date ? e.date.toISOString() : e.date,
            rate: e.rate,
          }))
        : null,
      duration:            this.duration,
      taxLossPartner:      this.taxLossPartner,
      taxExemption:        this.taxExemption,
      issuingState:        this.issuingState,
      maturityDate:        this.maturityDate
        ? (this.maturityDate instanceof Date ? this.maturityDate.toISOString() : this.maturityDate)
        : null,
      faceValue:           this.faceValue,
      rollAtMaturity:      this.rollAtMaturity,
      rollTermYears:       this.rollTermYears,
      zeroCoupon:          this.zeroCoupon,
      inflationLinked:     this.inflationLinked,
      fxBasisRate:         this.fxBasisRate,
      // design 93 §5 — omitted entirely when absent so a scalar holding round-trips to
      // exactly the bytes it did before this field existed.
      ...(this.units         != null ? { units:         this.units }         : {}),
      ...(this.parPerUnit    != null ? { parPerUnit:    this.parPerUnit }    : {}),
      ...(this.pricePerUnit  != null ? { pricePerUnit:  this.pricePerUnit }  : {}),
      ...(this.cpiIndexRatio != null ? { cpiIndexRatio: this.cpiIndexRatio } : {}),
      ...(this.securityId    != null ? { securityId:    this.securityId }    : {}),
    };
  }

  static fromJSON(d, _ctx) {
    return new Holding({
      id:            d.id ?? null,
      allocation:    d.allocation,
      marketValue:   d.marketValue ?? 0,
      costBasis:     d.costBasis   ?? 0,
      costBaseByCountry: /** @type {Object<string,number>|null} */ (d.costBaseByCountry ? { ...d.costBaseByCountry } : null),
      purchaseDate:  d.purchaseDate ? new Date(d.purchaseDate) : null,
      acquisitionPriceLevel: d.acquisitionPriceLevel ?? null,
      acquisitionDateByCountry: /** @type {Object<string,number>|null} */ (d.acquisitionDateByCountry ? { ...d.acquisitionDateByCountry } : null),
      rateKey:       d.rateKey ?? null,
      label:         d.label   ?? '',
      dividendYield: d.dividendYield ?? null,
      couponRate:    d.couponRate ?? null,
      // design 66 §G10a: coupon payment frequency. Absent (pre-G10 save) ⇒ 2 (semi-annual).
      couponFrequency: d.couponFrequency ?? 2,
      appreciationSchedule: d.appreciationSchedule
        ? d.appreciationSchedule.map(e => ({ date: new Date(e.date), rate: e.rate }))
        : null,
      duration:      d.duration ?? null,
      taxLossPartner: d.taxLossPartner ?? null,
      // design 66 §G2: taxExemption generalizes the design-59 `treasury` boolean.
      // Back-compat — a state persisted before design 66 carries `treasury: true`
      // for a direct Treasury obligation, which maps to the state-exempt bucket.
      taxExemption:  d.taxExemption ?? (d.treasury ? 'state' : 'none'),
      issuingState:  d.issuingState ?? null,
      // design 66 §G4: maturity/pull-to-par. Absent ⇒ a perpetual bond fund.
      maturityDate:  d.maturityDate ? new Date(d.maturityDate) : null,
      faceValue:     d.faceValue ?? null,
      rollAtMaturity: d.rollAtMaturity ?? false,
      // design 66 §G8: ladder roll-to-tail term. Absent ⇒ roll to own term (single bond).
      rollTermYears: d.rollTermYears ?? null,
      // design 66 §G5/§G6: TIPS + zero-coupon/OID. Absent ⇒ a plain (coupon) bond.
      zeroCoupon:     d.zeroCoupon ?? false,
      inflationLinked: d.inflationLinked ?? false,
      fxBasisRate:     d.fxBasisRate     ?? null,
      // design 93 §5. Absent on every save written before the unitised representation
      // existed, which is the whole corpus — a scalar holding stays scalar, and the
      // promotion to unitised is a deliberate act (`promoteToUnitised`), never a silent
      // side effect of loading.
      units:           d.units           ?? null,
      parPerUnit:      d.parPerUnit      ?? null,
      pricePerUnit:    d.pricePerUnit    ?? null,
      cpiIndexRatio:   d.cpiIndexRatio   ?? null,
      securityId:      d.securityId      ?? null,
    });
  }
}
