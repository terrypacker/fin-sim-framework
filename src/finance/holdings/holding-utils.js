/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { YEAR_MS as HOLDING_YEAR_MS } from './holding-period.js';
import { syntheticSecurityId }         from './security.js';

/**
 * ─── THE VALUE-CHANGE PRIMITIVES (design 93 §4) ───────────────────────────────
 *
 * A holding's value changes for two physically different reasons, and for most of this
 * codebase's life both were written the same way — `{ ...h, marketValue: <n> }`. Nothing
 * distinguished them, so correctness at every write site depended on the author knowing
 * which kind of change they were making and remembering to carry `faceValue` by hand.
 * Eight defects followed (design 66 §10.6b), each one silently minting or destroying
 * wealth, because par is authoritative twice over: `BondPriceAdjustReducer` pulls a
 * bond's price TOWARD it every period and `BondMaturityReducer` redeems AT it.
 *
 * These four functions make the distinction impossible to leave implicit. Use them
 * instead of spreading a holding and overriding `marketValue`; `bond-par-invariant.test.mjs`
 * fails the build on the raw form.
 *
 *   resize()   units changed proportionally  — a sell, a withdrawal, a rescale
 *   addValue() units increased by new money  — a contribution, a reinvested coupon
 *   reprice()  price changed, units did not  — a rate mark, a shock, pull-to-par
 *
 * `split()` is deliberately ABSENT, and its absence is informative: in a
 * dollar-denominated model a share split is unrepresentable. Two-for-one means twice the
 * units at half the price and half the par per unit — every dollar total is unchanged, so
 * the operation is a literal no-op on `{marketValue, costBasis, faceValue}` and there is
 * nothing to write. It becomes expressible only once §5 stores `units`, which is itself
 * part of the argument for storing them.
 */

/**
 * ─── THE UNITISED REPRESENTATION (design 93 §5) ───────────────────────────────
 *
 * A holding is in one of two modes, and both are first-class:
 *
 *   SCALAR    (`units == null`) — `marketValue` is the stored primary. Every equity
 *             sleeve and every bond FUND. Exactly today's behaviour.
 *   UNITISED  (`units != null`) — value flows from a count times a per-unit quantity:
 *                 marketValue = units x pricePerUnit
 *                 faceValue   = units x parPerUnit          (original issue par)
 *             so a UNIT change writes `units` and a PRICE change writes `pricePerUnit`,
 *             and neither can touch the other's field. That is the structural version of
 *             what §4's primitives enforce by convention.
 *
 * Option C ("equity as security positions") is exactly "flip equity from scalar to
 * unitised", which is why scalar must stay a supported mode rather than a legacy branch.
 */

/**
 * The INSTRUMENT-level view of a holding — the seam that makes Option C additive.
 *
 * Some fields on a holding describe the POSITION (units, basis, acquisition dates) and some
 * describe the INSTRUMENT the position is held in (par, coupon, maturity, tax treatment,
 * the market it tracks, its distribution yield). Under Option A the instrument fields live
 * inline on the holding. Under Option C they move to a shared `Security` and the holding
 * names it via `securityId` (design 94 §5.1 has the partition, field by field).
 *
 * **It returns the holding ITSELF when there is no security to resolve**, and that is the
 * design, not an optimisation:
 *
 *   - it makes the conversion of ~90 read sites (design 94 step 1) *provably* behaviour-
 *     neutral rather than neutral-if-you-audited-every-default. `instrumentOf(h).couponRate`
 *     is not merely equivalent to `h.couponRate`, it is the same property access on the same
 *     object;
 *   - it allocates nothing. `computeHoldingsGrowth` walks every holding of every account on
 *     every tick, and a seam that mints an object per holding per tick to hand back fields
 *     it already had would be a tax on the hot path forever;
 *   - it keeps the DEFAULTS at the call sites, where they already are and where they are
 *     visible, instead of hiding a second set inside the accessor that could drift from them.
 *
 * Read instrument fields through here and Option C changes nothing in the consumers: they
 * already ask the right question, and the answer starts coming from a different place.
 * `instrument-read-gate.test.mjs` is what keeps them asking it.
 *
 * ⚠️ The merge is `{ ...h, ...sec }` — the security wins, the holding fills gaps. Two things
 * that are still design 94 step 2's to settle, flagged here because both have bitten this
 * repo: an explicit `null` on the security OVERRIDES the holding's value (absent and null
 * are different, and `??` does not save you — see the `destinationKey` guard), and design 94
 * D11's dividend-yield chain (security → holding → account rate) depends on which of those
 * a security carrying no yield is.
 *
 * @param {object} h - a holding
 * @param {Object<string,object>|null} [securities] - `state.securities`; absent ⇒ Option A
 * @returns {object} the instrument-level view — the holding itself under Option A
 */
export function instrumentOf(h, securities = null) {
  if (!h || h.securityId == null || !securities) return h;
  const sec = securities[h.securityId];
  return sec ? { ...h, ...sec } : h;
}

/** True when a holding carries a unit count and so derives its value from it. */
export const isUnitised = h => h?.units != null && h.units > 0;

/**
 * The par-per-unit every ENGINE-CREATED bond is issued at (design 93 §5b).
 *
 * 100 rather than "the position's own face value", and the reason is Option C. §6.2 puts
 * `parPerUnit` on the INSTRUMENT side of the partition — under C it moves to a shared
 * `Security` and the holding names it through `securityId`. A par equal to the whole
 * position's face is POSITION-scaled: two holders of the same bond would carry different
 * `parPerUnit`s, so it could never live on a shared instrument and C would have to re-cut
 * every lot instead of moving a field. At 100 the field means what it means on a term
 * sheet, and `units` is a real (if fractional — see §9.3) count of bonds.
 *
 * The engine's rungs are dollar-split, so `units` is fractional; that is a property of
 * how the ladder allocates money, not of the representation.
 */
export const PAR_PER_UNIT = 100;

/** Units carry more precision than money: a $100-par unit count needs 4dp to hit cents. */
const _units = u => +(+u).toFixed(8);
/** Per-unit prices likewise — 8dp on a $100 par is sub-cent on any realistic position. */
const _perUnit = p => +(+p).toFixed(8);

/**
 * The unitised fields for a bond being ISSUED (or re-issued) at a known face and price.
 *
 * The one place the `PAR_PER_UNIT` convention is applied, so a ladder rung, a roll and a
 * tail purchase cannot disagree about what a unit is.
 *
 * @param {object} opts
 * @param {number} opts.faceValue        - the position's par redemption amount
 * @param {number} [opts.marketValue]    - the position's price; defaults to par (a par bond)
 * @param {boolean} [opts.inflationLinked=false] - stamps a fresh `cpiIndexRatio` of 1
 * @returns {object} `{ units, parPerUnit, pricePerUnit, cpiIndexRatio? }`
 */
export function unitiseBond({ faceValue, marketValue = null, inflationLinked = false }) {
  const face  = +(faceValue ?? 0);
  const units = _units(face / PAR_PER_UNIT);
  const mv    = marketValue == null ? face : +marketValue;
  return {
    units,
    parPerUnit:   PAR_PER_UNIT,
    pricePerUnit: units > 0 ? _perUnit(mv / units) : PAR_PER_UNIT,
    ...(inflationLinked ? { cpiIndexRatio: 1 } : {}),
  };
}

/**
 * The unitised fields for an EQUITY position being established at a known market value.
 *
 * `units = marketValue / 100`, at the same `PAR_PER_UNIT` convention a bond uses — design
 * 94 §9.2. Equity has no par, so **`parPerUnit` is deliberately absent**: `syncHolding`
 * re-derives `faceValue` only when `parPerUnit` is present, and stamping one here would
 * mint a face value on an instrument that has none and hand the pull-to-par and redemption
 * paths a target to converge a share position onto.
 *
 * 100 rather than 1 for the same reason the bond convention is 100: the count is what a
 * split, a per-share report and design 94 §8.3's specific identification read, and a unit
 * price that starts at the position's own scale is position-scaled — the one shape design
 * 93 §6.2 says a per-unit quantity must never have.
 *
 * Value-preserving: `units x 100` reproduces the stored market value exactly at any
 * position size (design 94 §9.3 measured 0 divergences over 880,000 repricings). It is the
 * unit-CHANGING paths that can land a cent apart, which is why step 3 lands with a re-gold.
 *
 * @param {object} opts
 * @param {number} opts.marketValue - the position's current value
 * @returns {object} `{ units, pricePerUnit }`
 */
export function unitiseEquity({ marketValue, pricePerUnit = PAR_PER_UNIT }) {
  const mv    = +(marketValue ?? 0);
  const price = (pricePerUnit ?? 0) > 0 ? _perUnit(pricePerUnit) : PAR_PER_UNIT;
  return { units: _units(mv / price), pricePerUnit: price };
}

/**
 * The price a lot BORN beside these ones joins at — value-weighted, `PAR_PER_UNIT` when
 * none of them carries a price.
 *
 * A lot established mid-run buys at TODAY's price, not at the convention's 100. Getting
 * this wrong is not cosmetic: a 2035 lot minted at 100 beside a boot lot standing at 380
 * would be a fabricated unit count (the same money claiming 3.8x the shares), and design
 * 94 §5.5's compaction — whose fungibility key includes the price — would never merge the
 * two, so the lot count would grow without bound over a long run.
 *
 * Value-weighted rather than "the template's", because the caller's template is the
 * biggest lot in a bucket and the bucket may hold several; weighting by value is the same
 * rule the merge itself uses and cannot be thrown by a dust lot.
 *
 * @param {Array<object>} lots
 * @returns {number}
 */
export function prevailingPrice(lots) {
  let mv = 0, units = 0;
  for (const h of lots ?? []) {
    if (!h || h.units == null || !((h.pricePerUnit ?? 0) > 0)) continue;
    mv    += h.units * h.pricePerUnit;
    units += h.units;
  }
  return units > 0 ? _perUnit(mv / units) : PAR_PER_UNIT;
}

/**
 * Recompute the denormalized value fields of a UNITISED holding from its primitives.
 *
 * The holding-level twin of `_syncBalance`, and the same pattern design 25 chose for
 * `Account.balance`: keep the widely-read scalar as a stored, denormalized field so no
 * read site changes, and give it exactly one writer. `structuredClone` snapshots cannot
 * carry a getter (design 93 §1), so a derived getter is not an option here.
 *
 * Scalar holdings pass through untouched.
 *
 * @param {object} h - a holding (not mutated)
 * @returns {object} the holding with marketValue / faceValue re-derived
 */
export function syncHolding(h) {
  // `units != null`, not `isUnitised` — a position resized to ZERO units still has to
  // have its value and its par re-derived, and that is exactly the case where a stale
  // `faceValue` becomes the ghost par `_syncBalance` has to sweep up after.
  if (h?.units == null) return h;
  const mv   = +(h.units * (h.pricePerUnit ?? 0)).toFixed(2);
  const face = h.parPerUnit == null ? h.faceValue : +(h.units * h.parPerUnit).toFixed(2);
  if (mv === h.marketValue && face === h.faceValue) return h;
  // par-reviewed: this IS the derivation — marketValue and faceValue are both recomputed
  // from the unit count, so they cannot disagree with each other by construction.
  return { ...h, marketValue: mv, ...(face == null ? {} : { faceValue: face }) };
}

/**
 * The inflation-adjusted principal PER UNIT of an inflation-linked bond, and what it
 * actually redeems for once the deflation floor is applied.
 *
 * This is design 93 §5.3's fix. Today redemption reads `max(marketValue, faceValue)`, and
 * a TIPS's `marketValue` carries accumulated rate marks that never wash out (TIPS are
 * excluded from pull-to-par), so the instrument redeems for its indexed principal PLUS
 * whatever rate noise happened to be in its price. Deriving the principal from an explicit
 * `cpiIndexRatio` compares two par-like quantities and never consults the market price.
 *
 * `units` and `cpiIndexRatio` are the POSITION's; `parPerUnit` and `inflationLinked` are
 * the INSTRUMENT's (design 94 §5.1), so the registry has to reach here.
 *
 * @param {object} h - a holding
 * @param {Object<string,object>|null} [securities] - `state.securities`; absent ⇒ Option A
 * @returns {number|null} redemption value for the whole position, or null when not applicable
 */
export function indexedRedemptionValue(h, securities = null) {
  const inst = instrumentOf(h, securities);
  if (!isUnitised(h) || inst.parPerUnit == null) return null;
  const ratio  = inst.inflationLinked ? (h.cpiIndexRatio ?? 1) : 1;
  const perUnit = Math.max(inst.parPerUnit * ratio, inst.parPerUnit);   // Treasury deflation floor
  return +(h.units * perUnit).toFixed(2);
}

/**
 * Promote a SCALAR position to the unitised representation, value-preserving.
 *
 * Two instruments reach here. An individual BOND (design 93 §5b) is unitised at its par;
 * an EQUITY position (design 94 §9.1/§9.2) is unitised at the same convention and, in the
 * same act, stamped with the synthetic market security it is a position in. Everything
 * else — a bond FUND lot, cash, gold — has no unit count to recover and passes through.
 *
 * `units = faceValue / PAR_PER_UNIT` at the standard par, NOT one unit at the position's
 * own scale. 5a shipped the latter on the reasoning that a saved scenario has no integer
 * count to recover — true, but it made `parPerUnit` position-scaled, which is the one
 * shape §6.2 says it must never have (see `PAR_PER_UNIT`). Par IS recoverable: a stored
 * `faceValue` is a number of $100 bonds, whether or not the author thought of it that way.
 *
 * Value-preserving either way: `pricePerUnit` takes whatever price makes
 * `units x pricePerUnit` the stored market value, so `syncHolding` reproduces exactly the
 * numbers that were already there.
 *
 * A migrated TIPS recovers its `cpiIndexRatio` from `marketValue / faceValue`, and that is
 * not cosmetic. Under the scalar convention a TIPS's accretion was added to `marketValue`,
 * so the stored price IS the indexed principal and the stored face is the original issue
 * par — exactly the two quantities the ratio is between. Promoting at a flat ratio of 1
 * would leave `indexedRedemptionValue` reading `units x parPerUnit`, i.e. redeeming a
 * seasoned TIPS at its ORIGINAL par and destroying every dollar of principal indexation it
 * had earned. Recovering the ratio makes the promotion reproduce the pre-93 redemption
 * (`max(marketValue, faceValue)`) exactly at the moment it happens, and from then on the
 * indexation is tracked cleanly rather than inferred from a price.
 *
 * What the recovered ratio inherits once, and cannot avoid inheriting, is whatever rate
 * marks were already sitting in that price — §5.3's complaint. There is no information in
 * a scalar holding to separate them. It is a one-time inheritance at promotion, not the
 * per-period accumulation the fix removes.
 *
 * Deliberately NOT done on load (see `fromJSON`): promotion is an act, not a side effect
 * of deserialization, so a saved scenario is never silently rewritten. It is done at the
 * config→run boundary instead (`projectHoldingsToState`).
 *
 * @param {object} h - a holding
 * @param {object} [opts]
 * @param {number} [opts.price=PAR_PER_UNIT] - the price a newly-unitised EQUITY position
 *   joins at. The config→run boundary leaves it at the convention, because at boot every
 *   lot in the run is promoted at the same moment and they are therefore consistent with
 *   each other. A BIRTH site mid-run must pass `prevailingPrice(siblings)` instead — see
 *   that function for what minting at 100 beside a seasoned lot would do.
 * @returns {object} the holding, unitised (unchanged when there is nothing to promote)
 */
export function promoteToUnitised(h, { price = PAR_PER_UNIT } = {}) {
  if (!h) return h;
  // EQUITY is the design 94 step 3 migration, and it is TWO stamps, not one: a unit count
  // (§9.2) and the synthetic security the lot is a position IN (§9.1). They are separate
  // conditions on purpose — a lot that already carries units still needs its `securityId`,
  // and a lot with no resolvable market still needs its units — so neither early-returns
  // past the other. Idempotent in both directions: an authored `securityId` is never
  // overwritten (it may name a REAL security, not the market synthetic), and an existing
  // unit count is left exactly as it is.
  if (h.allocation === 'EQUITY') {
    const needsUnits = h.units == null;
    // Null for a rateKey that is not one of the four markets, so a lot whose market cannot
    // be resolved stays honestly un-securitised rather than naming a security that is not
    // in the registry.
    const securityId = h.securityId == null ? syntheticSecurityId(h.rateKey) : null;
    if (!needsUnits && securityId == null) return h;
    return {
      ...h,
      ...(needsUnits      ? unitiseEquity({ marketValue: h.marketValue ?? 0, pricePerUnit: price }) : {}),
      ...(securityId != null ? { securityId } : {}),
    };
  }
  if (h.units != null) return h;
  if (h.allocation !== 'BOND' || h.maturityDate == null || h.faceValue == null) return h;
  if (!(h.faceValue > 0)) return h;   // a drained rung has no units to count
  const base = unitiseBond({
    faceValue:       h.faceValue,
    marketValue:     h.marketValue ?? 0,
    inflationLinked: h.inflationLinked === true,
  });
  if (h.inflationLinked === true) {
    // The accretion is already in the price — see the doc above. Floored at 1 so a TIPS
    // marked BELOW its original par migrates sitting on its deflation floor, which is
    // where the instrument actually puts it.
    base.cpiIndexRatio = +Math.max(1, (h.marketValue ?? 0) / h.faceValue).toFixed(12);
  }
  return { ...h, ...base };
}

/**
 * The config→run projection for an account's holdings, and the one place a scalar
 * individual bond becomes unitised (design 93 §5b).
 *
 * `promoteToUnitised`'s doc explains why promotion is not a side effect of
 * deserialization. This is the act instead: an account RECORD becomes a runtime STATE
 * entry, once per run, at the boundary where config stops and simulation starts. A saved
 * scenario on disk is never rewritten; every dated bond inside a RUN is unitised, so
 * §5.3's redemption fix and the accretion path reach authored bonds and not only
 * engine-built ladders.
 *
 * Shared by both toolsets deliberately. There have been three drifted copies of the
 * `state.people` projection in this repo; a second copy of this one would silently leave
 * a whole toolset's bonds scalar.
 *
 * @param {Array<object>} holdings - the account record's holdings
 * @returns {Array<object>} plain, structuredClone-safe holdings for `sim.state`
 */
export function projectHoldingsToState(holdings) {
  return (holdings ?? []).map(h => promoteToUnitised({ ...h }));
}

/**
 * A proportional UNIT change: the position got `factor` times bigger or smaller.
 *
 * Everything that travels with the units moves together — market value, cost basis, par,
 * and each per-country cost base. That is what makes the price-to-par RATIO invariant
 * under a resize, which matters because the ratio is what pull-to-par reads.
 *
 * On a UNITISED holding this is `units *= factor` and nothing else: `marketValue` and
 * `faceValue` are then re-derived, so the ratio pull-to-par reads is invariant by
 * CONSTRUCTION rather than by two scalings that happen to agree. It also stops rounding
 * compounding — the old form multiplied an already-rounded market value by a factor and
 * re-rounded, so a long chain of resizes drifted; the derived form always re-rounds from
 * the unit count. Answers design 93 §9.5 for unitised holdings: cents are rounded at the
 * DERIVATION, once, and never carried through a second multiply.
 *
 * @param {object} h      - a holding (not mutated)
 * @param {number} factor - >= 0; 0.4 keeps 40% of the position
 * @returns {object} a new holding
 */
export function resize(h, factor) {
  if (!h) return h;
  const f = Number.isFinite(factor) ? Math.max(0, factor) : 1;
  // par-reviewed: this IS resize() - the definition of the unit-change rule.
  const out = isUnitised(h)
    ? { ...h, units: _units(h.units * f), costBasis: +((h.costBasis ?? 0) * f).toFixed(2) }
    : {
        ...h,
        marketValue: +((h.marketValue ?? 0) * f).toFixed(2),
        costBasis:   +((h.costBasis   ?? 0) * f).toFixed(2),
        ...(h.faceValue != null ? { faceValue: +((h.faceValue ?? 0) * f).toFixed(2) } : {}),
      };
  if (h.costBaseByCountry) {
    out.costBaseByCountry = {};
    for (const [c, v] of Object.entries(h.costBaseByCountry)) {
      out.costBaseByCountry[c] = +((v ?? 0) * f).toFixed(2);
    }
  }
  return syncHolding(out);
}

/**
 * A UNIT INCREASE funded by new money: `amount` of cash bought more of this instrument.
 *
 * Basis rises by the FULL amount (the new money's basis is what was paid for it), which is
 * why this is not `resize` — scaling basis by the value ratio would under-add basis on a
 * position carrying an unrealized gain.
 *
 * Par is where the two instruments genuinely differ, and conflating them was defect #4:
 *   - a NOMINAL bond's par scales with the position, so the price-to-par ratio is
 *     untouched by money merely making the position bigger;
 *   - a TIPS's `faceValue` is its ORIGINAL ISSUE par, held only as the deflation floor
 *     (`redeem` takes `max(indexed principal, face)`), and the indexed principal already
 *     sits above it. Scaling that floor by the value ratio folds years of CPI accretion
 *     into it, and since the floor becomes the redemption value, every roll then ratchets
 *     the position higher. New money buys TIPS AT PAR today, so it adds its own cash
 *     amount to the floor and nothing more.
 *
 * `basisDelta` defaults to `amount`, which is what new money into a lot normally means:
 * you paid for it, so it is basis. It is separable because a **reinvested dividend** is
 * not — the model books the dividend as income and steps no basis (`costBasisDelta: 0` on
 * every dividend HOLDING_TRANSACT), so routing that credit through here with the default
 * would silently start stepping basis and move every golden. Whether it SHOULD step is a
 * real question, open as design 94 §9.4's follow-up F3; this parameter exists so that
 * answering it stays a deliberate change rather than a side effect of design 94 step 2a.
 *
 * @param {object} h      - a holding (not mutated)
 * @param {number} amount - cash added; may be 0
 * @param {object} [opts]
 * @param {number} [opts.basisDelta=amount] - basis to add; 0 for a credit that is income
 * @returns {object} a new holding
 */
export function addValue(h, amount, { basisDelta = amount } = {}) {
  if (!h || !Number.isFinite(amount) || amount === 0) return h;
  // A UNITISED holding buys units at its own current price: `parPerUnit` is a constant of
  // the instrument, so par follows the count and the price-to-par ratio is untouched.
  // That is the only meaning "more money into this lot" can have once par is per-unit,
  // and it is why the three re-pricing rules design 93 §5.0 weighed all evaporated —
  // there is no blend left to choose.
  //
  // Note this is still an addition to an EXISTING lot, which §5.0a says a purchase should
  // not be. It survives for the paths where the money genuinely belongs to the lot it
  // lands in (a coupon re-invested into its own vintage lot); the paths where it was a
  // purchase — the dividend spread and ladder absorption — now open a lot instead.
  if (isUnitised(h)) {
    const price = h.pricePerUnit ?? 0;
    if (price > 0) {
      return syncHolding({
        ...h,
        units:     _units(h.units + amount / price),
        costBasis: +((h.costBasis ?? 0) + basisDelta).toFixed(2),
      });
    }
  }
  const mvBefore = h.marketValue ?? 0;
  // par-reviewed: this IS addValue() - the definition of the new-money rule.
  const out = {
    ...h,
    marketValue: +(mvBefore + amount).toFixed(2),
    costBasis:   +((h.costBasis ?? 0) + basisDelta).toFixed(2),
  };
  if (h.faceValue != null) {
    out.faceValue = (h.inflationLinked || mvBefore <= 0)
      ? +((h.faceValue ?? 0) + amount).toFixed(2)
      : +((h.faceValue ?? 0) * ((mvBefore + amount) / mvBefore)).toFixed(2);
  }
  return out;
}

/**
 * A PRICE change: the same units are worth a different amount.
 *
 * Touches `marketValue` and nothing else. Par does not move, because no units changed
 * hands — a rate mark, a shock revaluation and pull-to-par are all this operation, and
 * each of them is CORRECT to leave par alone. Cost basis does not move either: an
 * unrealized gain is exactly the gap this opens.
 *
 * @param {object} h           - a holding (not mutated)
 * @param {number} marketValue - the new market value (floored at 0)
 * @returns {object} a new holding
 */
export function reprice(h, marketValue) {
  if (!h) return h;
  const mv = Math.max(0, marketValue ?? 0);
  // A unitised holding has a place to PUT a price, so the price is what moves and the
  // market value is derived from it. That is the structural version of this function's
  // contract: there is no longer a way to express "the value changed" without saying
  // whether the count or the price did.
  if (isUnitised(h)) return syncHolding({ ...h, pricePerUnit: _perUnit(mv / h.units) });
  // par-reviewed: this IS reprice() - the definition of the price-change rule.
  return { ...h, marketValue: +mv.toFixed(2) };
}

/**
 * A corporate action that changes the unit count without changing what the position is
 * WORTH: a two-for-one split is twice the units at half the price (design 93 §6.2 item 5).
 *
 * **Its history is the point.** §4 tried to write this against `{marketValue, costBasis,
 * faceValue}` and found it unrepresentable: every dollar total is unchanged, so the
 * operation was a literal no-op with nothing to write. That negative result was recorded as
 * an argument FOR storing units — a substrate that cannot express a split cannot carry
 * equity positions, which is what Option C exists for. This is the same function against
 * the unitised representation, and it is four lines.
 *
 * On a SCALAR holding it is still a no-op, correctly: there is no count to double. That is
 * not a gap — it is the same statement §4 made, now confined to the mode that has no units
 * rather than being true of the whole model.
 *
 * `costBasis` does not move (a split is not a disposal and nothing was paid), and neither
 * does any acquisition date — §1223 and Div 115 both hold the original holding period
 * across a split. `parPerUnit` DOES move, because par is per unit and there are now more
 * units standing for the same principal; a bond split is not a thing anyone does, but
 * getting it wrong here would be the ratchet again.
 *
 * @param {object} h     - a holding (not mutated)
 * @param {number} ratio - new units per old unit; 2 for a two-for-one, 0.1 for a 1:10 reverse
 * @returns {object} a new holding of the same value
 */
export function split(h, ratio) {
  if (!h || !Number.isFinite(ratio) || ratio <= 0 || ratio === 1) return h;
  if (!isUnitised(h)) return h;
  return syncHolding({
    ...h,
    units:        _units(h.units * ratio),
    pricePerUnit: _perUnit((h.pricePerUnit ?? 0) / ratio),
    ...(h.parPerUnit == null ? {} : { parPerUnit: _perUnit(h.parPerUnit / ratio) }),
  });
}

/**
 * ESTABLISH a position in a lot that currently holds nothing (design 93 §5b).
 *
 * The fourth shape, and it existed before this function did — four near-identical
 * annotated branches spelled it out by hand: `scaleHoldings` and
 * `rescaleHoldingsToBalance` when the holdings sum is zero, `distributeHoldingsCredit`
 * when there is no market value to weight against, and `AccountService.transaction`'s
 * credit path. Each says the same thing: there are no units to scale, so the money
 * BECOMES the position.
 *
 * That is not `addValue` (which needs an existing count to add to) and not `reprice`
 * (which needs a count to re-price). On a scalar lot it is today's behaviour exactly —
 * value, basis and par all take the amount. On a UNITISED lot it buys units at the going
 * price, falling back to par when a drained lot's price is stale, and par follows the
 * count because `parPerUnit` is a constant of the instrument.
 *
 * @param {object} h     - a holding (not mutated)
 * @param {number} value - the market value the lot now holds
 * @returns {object} a new holding
 */
export function establish(h, value) {
  if (!h) return h;
  const v = +(value ?? 0);
  if (h.units != null) {
    const price = (h.pricePerUnit ?? 0) > 0 ? h.pricePerUnit : (h.parPerUnit ?? PAR_PER_UNIT);
    return syncHolding({
      ...h,
      units:        _units(v / price),
      pricePerUnit: _perUnit(price),
      costBasis:    +v.toFixed(2),
    });
  }
  // par-reviewed: establish() - there are no units to scale, so the money IS the position
  // and par is set alongside it rather than derived from a ratio that does not exist.
  return {
    ...h,
    marketValue: +v.toFixed(2),
    costBasis:   +v.toFixed(2),
    ...(h.faceValue == null ? {} : { faceValue: +v.toFixed(2) }),
  };
}

/**
 * Proportionally scale all holdings so that Σ holdings[i].marketValue === newBalance.
 *
 * §4.4 invariant: every reducer that changes account.balance must also call this
 * so that the next earnings event (which uses computeHoldingsGrowth on holdings[])
 * and the subsequent _syncBalance call do not overwrite the correct balance with
 * a stale holdings sum.
 *
 * @param {Array}  holdings   - account.holdings array (may be null / undefined / empty)
 * @param {number} oldBalance - account.balance before the operation
 * @param {number} newBalance - account.balance after the operation
 * @returns {Array} updated holdings array (same reference if no change needed)
 */
export function scaleHoldings(holdings, oldBalance, newBalance, vintage = null) {
  if (!Array.isArray(holdings) || holdings.length === 0) return holdings;
  if (oldBalance <= 0) {
    if (newBalance <= 0) return holdings;
    return holdings.map((h, i) => i === 0 ? establish(h, newBalance) : h);
  }
  // design 93 §5.0a item 2 — the two DIRECTIONS are different operations, and treating
  // them alike was the last blending path design 62 §9 never reached.
  //
  // A DEBIT is a proportional sell: every lot gives up the same fraction, which is exactly
  // `resize`. A CREDIT is a PURCHASE — new money buying more of the same thing — and a
  // purchase is a lot. Scaling on the way in made the deposited dollars inherit the
  // destination lots' acquisition dates, and it scaled BASIS by the value ratio, which
  // under-adds basis whenever the position carries an unrealized gain. Both are fixed by
  // routing the credit through the same primitive reinvested income uses.
  //
  // A caller that supplies no `vintage` gets the old proportional scale in both directions.
  // That is for the UI and for unit tests, which have no clock; every simulation caller
  // passes `lotVintage(state, account)`.
  if (vintage != null && newBalance > oldBalance) {
    return distributeHoldingsCredit(holdings, +(newBalance - oldBalance).toFixed(2), vintage);
  }
  const factor = newBalance / oldBalance;
  return holdings.map(h => _scaleOne(h, factor));
}

/**
 * Scale ONE holding's value fields by `factor` — the money-moved-in-or-out rescale.
 *
 * `faceValue` scales with the rest, and leaving it out was a silent wealth leak. Par is
 * a property of the POSITION, not a constant: a bond position twice the size has twice
 * the par. Every deposit into an IRA/401(k)/Roth — a contribution, a rollover, a Roth
 * CONVERSION — comes through `scaleHoldings`, so an account holding dated bonds took the
 * new money as market value against an unchanged par.
 *
 * That is not a cosmetic mismatch, because `faceValue` is authoritative twice over:
 * `BondPriceAdjustReducer` pulls a bond's price TO it every period, and
 * `BondMaturityReducer` redeems AT it. A conversion that doubled an account's market
 * value therefore left pull-to-par dragging the position back toward the pre-conversion
 * par indefinitely — measured at $8k–19k destroyed per period on a $240k sleeve — and in
 * the mirror case (money leaving, or par inflated relative to price) the same mechanism
 * CREATES value out of nothing. Which way it runs depends only on the sign of the drift.
 *
 * The sell side already conserved principal this way (`holdings-fifo`, design 87 G9:
 * `partial.faceValue = h.faceValue * (remainingMv / mv)`). This is the same rule on the
 * deposit side, which was never given it.
 *
 * NOT applied to price movement: a rate mark, a shock revaluation and TIPS accretion all
 * move `marketValue` while par legitimately stands still, and each of those runs through
 * `_patchHolding` / `HoldingTransactReducer` rather than here.
 */
const _scaleOne = (h, factor) => resize(h, factor);

/**
 * Reconcile a balance edit to the holdings so the §4.4 invariant
 * (Σ holdings[i].marketValue === balance) holds, scaling by the holdings'
 * CURRENT market-value sum rather than a (possibly already-stale) stored
 * balance. Pure: returns a NEW array of NEW holding objects and never mutates
 * the input holdings (so a holding already recorded in the journal can't be
 * rewritten by a later rescale — the journal-aliasing invariant). Callers must
 * assign the result back (`account.holdings = rescaleHoldingsToBalance(...)`).
 * The spread produces plain records; the serializer wraps any non-Holding leaf
 * in `new Holding(h)` before toJSON, so the class is not required here.
 *
 * Reconciliation rules (design 25 §4.4, design 43 §3 invariant 3):
 *   - empty / no holdings           → no-op (input array returned unchanged)
 *   - Σ current marketValue > 0     → scale every holding's marketValue AND
 *                                     costBasis by targetBalance / Σmv,
 *                                     preserving the sleeve mix and gain ratio
 *                                     (this includes the single-holding case —
 *                                     a balance edit must NOT reset cost basis to
 *                                     market value and wipe the unrealized gain)
 *   - Σ current marketValue == 0    → assign the full targetBalance to the
 *                                     first holding (marketValue = costBasis); the
 *                                     only branch where costBasis is set to target,
 *                                     since there is no gain ratio to preserve
 * Penny rounding drift is absorbed by the largest-marketValue holding.
 *
 * @param {Array}  holdings      - account.holdings (plain records or Holding[])
 * @param {number} targetBalance - the new account balance to match
 * @returns {Array} a new holdings array (input returned as-is only when empty)
 */
export function rescaleHoldingsToBalance(holdings, targetBalance) {
  if (!Array.isArray(holdings) || holdings.length === 0) return holdings;
  const target = +(+(targetBalance ?? 0)).toFixed(2);

  const curSum = holdings.reduce((s, h) => s + (h?.marketValue ?? 0), 0);

  if (curSum <= 0) {
    // Zero holdings sum, so the target balance BECOMES the first position rather than
    // scaling one; every other lot is emptied. `establish` owns both statements.
    return holdings.map((h, i) => establish(h, i === 0 ? target : 0));
  }

  const factor = target / curSum;
  const scaled = holdings.map(h => _scaleOne(h, factor));

  // Absorb rounding drift into the largest-marketValue holding.
  const newSum = +scaled.reduce((s, h) => s + (h.marketValue ?? 0), 0).toFixed(2);
  const drift  = +(target - newSum).toFixed(2);
  if (drift !== 0) {
    let li = 0;
    for (let i = 1; i < scaled.length; i++) {
      if ((scaled[i].marketValue ?? 0) > (scaled[li].marketValue ?? 0)) li = i;
    }
    // Absorbs sub-cent rounding drift into the largest lot. Deliberately a PRICE move and
    // not a unit change: a penny of rounding must not move par, and `reprice` is what
    // says so — on a unitised lot it lands on `pricePerUnit`, leaving the count alone.
    scaled[li] = reprice(scaled[li], (scaled[li].marketValue ?? 0) + drift);
  }
  return scaled;
}

/**
 * The vintage clock a new lot is opened on: the advancing period's start, the calendar
 * year it falls in, and the AU CPI level to stamp as the lot's indexation base.
 *
 * Read from the ACCOUNT's own country, because a period-advance action carries no date of
 * its own ([[period-advance-no-action-date]]). Shared rather than copied: this repo has
 * had three drifted copies of the `state.people` projection, and a second copy of this
 * would silently leave one family of deposits blending.
 *
 * @param {object} state
 * @param {object} account - the account record in state (for its country)
 * @returns {{ year: number|null, purchaseMs: number|null, priceLevel: number }}
 */
export function lotVintage(state, account) {
  const cc     = account?.country === 'AU' ? 'AU' : 'US';
  const asOfMs = state?.currentPeriods?.[cc]?.startMs ?? null;
  return {
    purchaseMs: asOfMs,
    year:       asOfMs == null ? null : new Date(asOfMs).getUTCFullYear(),
    priceLevel: state?.cpiAccumulator?.AU ?? state?.inflationAccumulator?.AU ?? 1,
  };
}

/**
 * The tax-and-earnings identity of a sleeve, as the vintage key reinvested income buys
 * into. Two sleeves share a bucket when nothing downstream — the growth path, the
 * dividend/coupon path, the federal/state exemption split — can tell them apart.
 */
function _incomeBucketKey(h) {
  return [h?.allocation ?? '', h?.taxExemption ?? 'none',
          h?.issuingState ?? '', h?.rateKey ?? ''].join('|');
}

/**
 * Reinvest a cash credit (a dividend, or a coupon on the pre-§G10b path) into the
 * account's holdings, as a NEW LOT per (sleeve bucket x year).
 *
 * **This used to spread the credit pro rata into the EXISTING lots, and design 93 §5.0a
 * is why it no longer does.** Reinvested income is a purchase: it buys more of the thing
 * at TODAY's price with its own basis. Adding it to existing lots made those dollars
 * inherit an acquisition date they were never bought on — which is what FIFO, HIFO, the
 * AU Division 115 12-month gate, the post-2027 indexation clock and the residency step-up
 * all key off. Design 62 §9 established the rule for the rebalancer's buy leg and design
 * 66 §G10b applied it to coupons (`mergeCouponReinvestLots`); this is the same rule
 * reaching the last money-in path that still blended.
 *
 * **Granularity: one lot per bucket per calendar year** — the convention
 * `mergeCouponReinvestLots` already uses, so the two reinvestment paths do not disagree.
 * Not one lot per payment (four to twelve a year, and it would have to pick ONE sleeve for
 * the whole credit, moving allocation drift), and not one lot per paying sleeve per payment
 * (exact, but unbounded until `_compactSeasonedLots` seasons them). The credit is split
 * across buckets by market value, so **which allocation the money lands in is unchanged** —
 * only which LOT inside it.
 *
 * The vintage lot is always a SCALAR fund position: no `maturityDate`, no par, no units.
 * A reinvested bond coupon buys bond exposure, not more of the specific rung that paid it,
 * which is design 66 §G10b's reinvestment-risk point and also means this path can never
 * blend a par (design 93 §5b).
 *
 * Σ marketValue rises by exactly `amount`, keeping the §4.4 invariant intact when the
 * caller credits `balance` by the same amount.
 *
 * @param {Array}  holdings - account.holdings (returns a new array; originals untouched)
 * @param {number} amount   - positive cash amount being reinvested
 * @param {object} [opts]
 * @param {string} [opts.stateKey='acct']   - account key, for the lot id
 * @param {number|null} [opts.year=null]    - vintage year; ABSENT ⇒ the pre-93 pro-rata
 *   blend, kept so a caller with no clock (a unit test, a UI preview) is unaffected
 * @param {number|null} [opts.purchaseMs=null] - the lot's acquisition date
 * @param {number|null} [opts.priceLevel=null] - AU CPI level at acquisition (design 57 §6.3)
 * @param {string} [opts.label='Reinvested income']
 * @returns {Array} new holdings array
 */
export function distributeHoldingsCredit(holdings, amount, {
  stateKey = 'acct', year = null, purchaseMs = null, priceLevel = null,
  label = 'Reinvested income',
} = {}) {
  if (!Array.isArray(holdings) || holdings.length === 0 || amount === 0) return holdings;
  const total = holdings.reduce((s, h) => s + (h?.marketValue ?? 0), 0);
  if (total <= 0) {
    // No market value to weight against — the credit BECOMES the first position.
    return holdings.map((h, i) => i === 0 ? establish(h, (h.marketValue ?? 0) + amount) : h);
  }

  if (year == null) {
    // Pre-design-93 fallback: pro rata into the existing lots. Reachable only from a
    // caller that cannot say what year it is, which in the simulation is none of them.
    let distributed = 0;
    return holdings.map((h, i) => {
      const share = i === holdings.length - 1
        ? +(amount - distributed).toFixed(2)
        : +(amount * ((h.marketValue ?? 0) / total)).toFixed(2);
      distributed += share;
      return addValue(h, share);
    });
  }

  // Split by bucket, weighted by market value — so allocation drift is untouched — with
  // the last bucket taking the remainder so the parts sum to `amount` exactly.
  const buckets   = new Map();
  // The lots each bucket already holds, so a new vintage can be established at the price
  // they are standing at rather than at the convention's 100 (`prevailingPrice`).
  const bucketLots = new Map();
  for (const h of holdings) {
    if (!h || (h.marketValue ?? 0) <= 0) continue;
    const key = _incomeBucketKey(h);
    if (!buckets.has(key)) { buckets.set(key, { mv: 0, template: h }); bucketLots.set(key, []); }
    bucketLots.get(key).push(h);
    const b = buckets.get(key);
    b.mv += h.marketValue ?? 0;
    // The biggest lot in the bucket is the template the vintage lot copies its earnings
    // and tax identity from — never its vintage, basis or par (see below).
    if ((h.marketValue ?? 0) > (b.template.marketValue ?? 0)) b.template = h;
  }
  if (buckets.size === 0) {
    return holdings.map((h, i) => i === 0 ? establish(h, (h.marketValue ?? 0) + amount) : h);
  }

  let next    = holdings.slice();
  const keys  = [...buckets.keys()];
  let placed  = 0;
  keys.forEach((key, i) => {
    const { mv, template } = buckets.get(key);
    const share = i === keys.length - 1
      ? +(amount - placed).toFixed(2)
      : +(amount * (mv / total)).toFixed(2);
    placed = +(placed + share).toFixed(2);
    if (share === 0) return;

    const lotId = `reinvest-${stateKey}-${key}-${year}`;
    const idx   = next.findIndex(h => h?.id === lotId);
    if (idx >= 0) {
      // Same bucket, same year — the vintage lot this year's earlier payments opened.
      // Merging within a vintage is not the blend the rule forbids: no holding-period
      // test can distinguish two payments made in the same year into the same sleeve.
      next[idx] = addValue(next[idx], share);
      return;
    }
    // `promoteToUnitised` is the BIRTH stamp, not just the boundary one (design 94 §9.5c).
    // This is the largest runtime source of equity lots in the model — one per bucket per
    // year from every reinvested dividend and wrapper deposit — and a lot born here without
    // units is the mixed mode §9.5c measured: a booted lot unitised and a run-created lot
    // still scalar, in one account, where `split()` cannot act and per-share reporting
    // disagrees between lots. It is a no-op on the BOND-fund lots this same call opens.
    // par-reviewed: a CONSTRUCTION of a fund position — `faceValue: null` is set right
    // here alongside the value, so there is no par to desynchronise. It reads as the write
    // shape only because of the conditional `...securityId` spread above.
    next.push(promoteToUnitised({
      // A fresh lot. Everything that makes it a position — id, vintage, basis — is set
      // here; everything that makes it an instrument is copied from the template, INCLUDING
      // which security it is a position in. Written conditionally so a lot in an
      // un-securitised sleeve keeps the field absent rather than gaining an explicit null.
      ...(template.securityId == null ? {} : { securityId: template.securityId }),
      id:                    lotId,
      allocation:            template.allocation,
      marketValue:           share,
      costBasis:             share,
      costBaseByCountry:     null,
      purchaseDate:          purchaseMs != null ? new Date(purchaseMs) : null,
      acquisitionPriceLevel: priceLevel,
      acquisitionDateByCountry: null,
      rateKey:               template.rateKey ?? null,
      label,
      dividendYield:         template.dividendYield ?? null,
      couponRate:            template.couponRate ?? null,
      couponFrequency:       template.couponFrequency ?? 2,
      appreciationSchedule:  null,
      duration:              template.duration ?? null,
      taxLossPartner:        null,
      taxExemption:          template.taxExemption ?? 'none',
      issuingState:          template.issuingState ?? null,
      // A fund position: no maturity, no par, no units. See the doc above.
      maturityDate:          null,
      faceValue:             null,
      rollAtMaturity:        false,
      rollTermYears:         null,
      zeroCoupon:            false,
      inflationLinked:       false,
    }, { price: prevailingPrice(bucketLots.get(key)) }));
  });
  // design 93 §5.5 — compaction is the other half of the lot rule. This path opens one lot
  // per bucket per YEAR, from reinvested income and (since §5.4a) from every wrapper
  // deposit, which made it the largest source of lots in the model: 6 → 69 on a 40-year
  // run. Merging the seasoned ones back down is what stops §5.0a being a memory leak with
  // a tax rationale. Two vintages merge only when nothing downstream can tell them apart —
  // see `lot-compaction.js` for the conditions.
  return purchaseMs == null ? next : compactLots(next, { asOfMs: purchaseMs, policy: LOT_POLICIES.REINVEST });
}

/**
 * True when an account's holdings sum is out of sync with its balance beyond a
 * one-cent tolerance (the condition the on-load auto-heal repairs).
 *
 * @param {object} account - { balance, holdings }
 * @returns {boolean}
 */
export function holdingsOutOfSync(account) {
  const holdings = account?.holdings;
  if (!Array.isArray(holdings) || holdings.length === 0) return false;
  const sum = holdings.reduce((s, h) => s + (h?.marketValue ?? 0), 0);
  return Math.abs(sum - (account.balance ?? 0)) > 0.01;
}

/**
 * ─── LOT COMPACTION (design 93 §5.5) ─────────────────────────────────────────
 *
 * Kept in this file rather than its own, deliberately: compaction re-derives value from
 * `units` (`syncHolding`) and the operations above re-open lots that compaction merges, so
 * splitting them put an import CYCLE through the substrate's core. Both directions were
 * function-body-only and would have worked, but a cycle here is the kind of thing that
 * becomes a TDZ crash the first time someone adds a top-level constant — and this is the
 * code Option C builds on. One module owns lot operations.
 *
 * The lot rule (§5.0a) says a purchase is a new lot. Followed honestly, that means the
 * holdings array grows once per purchase forever — and the model buys constantly:
 * reinvested dividends and coupons, rebalance buys, ladder absorption, every wrapper
 * contribution and rollover. Compaction is the other half of the rule. Without it §5.0a is
 * a memory leak with a tax rationale.
 *
 * Three families grew their own copy of this before it was one function:
 * `_compactSeasonedLots` (design 61, `reb-` lots), `_compactLadderLots` (design 93 §5.4,
 * `ladder-` rungs) and nothing at all for `reinvest-`, which by then was the largest
 * source. Writing the third made the shape obvious, and the copies had already drifted —
 * one used 365 days as "twelve months" and the other 365.25, which is the bond files'
 * MATURITY constant and not a holding period at all. `holding-period.js` owns that
 * question for the whole codebase (`isLongTerm`, the FIFO discount gate), so the policy
 * defers to it and the divergence is gone.
 *
 * ── When two lots may merge ──────────────────────────────────────────────────
 *
 * Only when NOTHING downstream can tell them apart, now or ever after:
 *
 *   1. **Both belong to the policy's own family** (`prefix`). A policy never touches a lot
 *      it did not create — an authored scenario lot, another strategy's lot, a ladder rung
 *      under the reinvest policy. This is design 61's discipline and it is the reason
 *      compaction has never merged something it should not have.
 *   2. **Both hold value.** A zero lot has nothing to contribute and merging it would
 *      quietly delete a row the journal may reference.
 *   3. **Both are seasoned past twelve months**, so no holding-period rule can distinguish
 *      them: AU Division 115's twelve months, US §1222's one year, the post-2027
 *      indexation clock. This is the load-bearing condition — everything below is
 *      arithmetic, but this is what makes the arithmetic legitimate.
 *   4. **Every field the merge does not explicitly handle is equal.** The key is built by
 *      EXCLUSION, so a field added to `Holding` later automatically PREVENTS a merge
 *      rather than being silently averaged away. Being too strict costs a longer array;
 *      being too loose loses tax history, so the default leans strict on purpose.
 *
 * ── What the merge does with the fields it does handle ───────────────────────
 *
 * - **Value.** A UNITISED lot sums `units` and re-derives `marketValue` / `faceValue` from
 *   the count (design 93 §5); a SCALAR lot sums `marketValue` and `faceValue` directly.
 *   Both modes are first-class (§6.2 item 2) and the dispatch is on the lot, not on config.
 * - **`costBasis`** sums. A merge is not a disposal, so basis is conserved exactly.
 * - **`acquisitionPriceLevel`** becomes the **basis-weighted harmonic mean**,
 *   `Σbasisᵢ / Σ(basisᵢ / levelᵢ)`, which is exact rather than approximate: the AU indexed
 *   cost base is `Σ basisᵢ × (levelₙₒw / levelᵢ)`, and that blend reproduces the sum
 *   precisely from one basis and one level. An arithmetic mean would not, and leaving the
 *   level in the key would make every vintage unique and stop compaction dead.
 * - **`blendByValue` fields** (a coupon, a duration, a dividend yield) are averaged by
 *   market value, because `mv × rate` is what the earnings and price-sensitivity paths
 *   actually consume, so the blend is exact at merge time. Their NULL-ness stays in the
 *   key: a lot whose coupon floats never merges with one that locked a rate.
 * - **`purchaseDate`, the id, and everything else** come from the EARLIEST lot, which
 *   keeps FIFO order across the boundary unchanged and replay deterministic.
 *
 * `ladderCarryover` takes the LATEST date for a superficially similar blend. The
 * conventions differ for a real reason: that one merges lots that are NOT both seasoned,
 * where crediting the older date would hand a discount to money bought later. Here both
 * are already past every gate, so FIFO stability is the only thing left to decide.
 */

/** Twelve months, as the rest of the codebase measures it (`isLongTerm`, the FIFO gate). */
const SEASONED_MS = HOLDING_YEAR_MS;

/**
 * The compaction policy for each lot family. A family is identified by its id prefix,
 * which is also its claim: a policy compacts its own lots and no others.
 *
 * Declared here rather than at the call sites so the three are readable side by side —
 * that is how the seasoning divergence was found.
 */
export const LOT_POLICIES = Object.freeze({
  /**
   * Design 61's rebalance buys. Coupon and duration are blended because a bond sleeve
   * established at different times locked different yields, and the sleeve is a genuine
   * blend of them.
   */
  REBALANCE: Object.freeze({
    prefix: 'reb-',
    blendByValue: Object.freeze({ couponRate: 6, duration: 4 }),
  }),
  /**
   * Design 93 §5.4's ladder rungs. Nothing is blended: a rung's coupon, maturity and
   * index ratio are all part of the key, because two rungs that disagree about any of
   * them are different bonds. What makes this policy bind at all is the ROLL — two rungs
   * become the same bond only after both have re-issued into the same maturity.
   *
   * Per-country bases are SUMMED here rather than keyed, because a rebuild's carryover
   * (`ladderCarryover`) legitimately produces rungs that differ only in how a step-up was
   * apportioned across them.
   */
  LADDER: Object.freeze({
    prefix: 'ladder-',
    sumCountryBases: true,
  }),
  /**
   * Design 93 §5.5's reinvestment and deposit vintages — one lot per (sleeve bucket ×
   * year), from reinvested income (`distributeHoldingsCredit`) and from every wrapper
   * deposit (§5.4a). The largest source of lots in the model, and the last to get a
   * policy.
   *
   * The bucket key already pins allocation, rateKey, taxExemption and issuingState, so
   * two vintages of the same bucket differ only in what they inherited from whichever lot
   * was the template that year — hence the same blend list as REBALANCE, plus the
   * dividend yield.
   */
  REINVEST: Object.freeze({
    prefix: 'reinvest-',
    blendByValue: Object.freeze({ couponRate: 6, duration: 4, dividendYield: 6 }),
  }),
});

/** Epoch ms of a lot's purchaseDate; 0 (i.e. "carried in from boot") when it has none. */
function _purchaseTs(h) {
  if (!h?.purchaseDate) return 0;
  const t = h.purchaseDate instanceof Date ? h.purchaseDate.getTime() : new Date(h.purchaseDate).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * The fields the merge handles itself, and which therefore do NOT have to match. Anything
 * else is part of the fungibility key. Derived from the policy rather than listed by hand,
 * so the two can never disagree: a field is mergeable exactly when the merge has a rule
 * for it.
 */
function _mergeableFields(policy) {
  const out = new Set([
    'id',                      // the survivor's
    'purchaseDate',            // the earliest
    'label',                   // cosmetic; the survivor's
    'units', 'marketValue', 'faceValue', 'costBasis',   // summed or derived
    // `pricePerUnit` is DERIVED by the merge (Σvalue / Σunits), not matched. Design 94
    // step 3 is why: under §4's per-position price two lots in the same security legitimately
    // stand at different prices — each one was established at whatever price prevailed when
    // it was born, and each is then repriced off its OWN rounded market value, so even two
    // lots born together drift apart in the eighth decimal. Leaving the price in the
    // fungibility key made compaction unreachable for every equity vintage lot, which is
    // §5.5's unbounded-lot-count leak with a tax rationale. Merging on the value-weighted
    // price conserves both the unit count and the money.
    'pricePerUnit',
    'acquisitionPriceLevel',   // basis-weighted harmonic mean
  ]);
  for (const f of Object.keys(policy.blendByValue ?? {})) out.add(f);
  if (policy.sumCountryBases) { out.add('costBaseByCountry'); out.add('acquisitionDateByCountry'); }
  return out;
}

/**
 * Compact a holdings array under one policy.
 *
 * @param {Array<object>} holdings - not mutated
 * @param {object} opts
 * @param {number} opts.asOfMs     - now, for the seasoning test
 * @param {object} opts.policy     - one of `LOT_POLICIES`
 * @returns {Array<object>} the holdings, compacted — the SAME array reference when nothing
 *   merged, so a caller can skip a state write and the journal shows no churn
 */
export function compactLots(holdings, { asOfMs, policy } = {}) {
  if (!Array.isArray(holdings) || holdings.length < 2 || asOfMs == null || !policy) return holdings;
  const mergeable = _mergeableFields(policy);
  const blend     = policy.blendByValue ?? {};

  const key = (h) => {
    if (!h || typeof h.id !== 'string' || !h.id.startsWith(policy.prefix)) return null;
    if ((h.marketValue ?? 0) <= 0) return null;
    if (asOfMs - _purchaseTs(h) < SEASONED_MS) return null;
    const fields = Object.keys(h).filter(k => !mergeable.has(k)).sort();
    return JSON.stringify([
      ...fields.map(k => [k, h[k] instanceof Date ? h[k].getTime() : h[k]]),
      // A blended field's NULL-ness is not blendable: a lot whose coupon floats is a
      // different instrument from one that locked a rate, however close the numbers are.
      ...Object.keys(blend).sort().map(f => [`${f}:null`, h[f] == null]),
    ]);
  };

  const groups = new Map();
  holdings.forEach((h, i) => {
    const k = key(h);
    if (k == null) return;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  });

  const survivors = new Map();
  const absorbed  = new Set();
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    // Earliest purchaseDate wins; index order breaks a tie so the choice is deterministic.
    let keep = idxs[0];
    for (const i of idxs) if (_purchaseTs(holdings[i]) < _purchaseTs(holdings[keep])) keep = i;
    const base = holdings[keep];

    let units = 0, mv = 0, basis = 0, basisOverLevel = 0;
    let faceSum = 0, anyFace = false;
    const blendMv = {};
    const byCountry = {}, dateByCountry = {};
    for (const i of idxs) {
      const h = holdings[i];
      units += h.units       ?? 0;
      mv    += h.marketValue ?? 0;
      basis += h.costBasis   ?? 0;
      if (h.faceValue != null) { faceSum += h.faceValue; anyFace = true; }
      for (const f of Object.keys(blend)) {
        blendMv[f] = (blendMv[f] ?? 0) + (h[f] ?? 0) * (h.marketValue ?? 0);
      }
      if (h.acquisitionPriceLevel > 0) basisOverLevel += (h.costBasis ?? 0) / h.acquisitionPriceLevel;
      if (policy.sumCountryBases) {
        for (const [c, v] of Object.entries(h.costBaseByCountry ?? {})) {
          byCountry[c] = +((byCountry[c] ?? 0) + (v ?? 0)).toFixed(2);
        }
        // Earliest per country, for the same FIFO-stability reason as `purchaseDate`.
        for (const [c, ts] of Object.entries(h.acquisitionDateByCountry ?? {})) {
          if (dateByCountry[c] == null || ts < dateByCountry[c]) dateByCountry[c] = ts;
        }
      }
      if (i !== keep) absorbed.add(i);
    }

    // par-reviewed: a MERGE. Value and par are summed or DERIVED together — never one
    // without the other — so the merged lot cannot claim a par its units do not stand for.
    const merged = {
      ...base,
      costBasis: +basis.toFixed(2),
      acquisitionPriceLevel: base.acquisitionPriceLevel == null || basisOverLevel <= 0
        ? base.acquisitionPriceLevel
        : +(basis / basisOverLevel).toFixed(11),
    };
    if (isUnitised(base)) {
      // Value flows from the count; `syncHolding` re-derives marketValue and faceValue.
      // The price comes with it: Σvalue / Σunits is the only price at which the merged
      // position holds every absorbed lot's units AND every absorbed lot's dollars.
      merged.units = +units.toFixed(8);
      if (units > 0) merged.pricePerUnit = _perUnit(mv / units);
    } else {
      merged.marketValue = +mv.toFixed(2);
      if (base.faceValue != null || anyFace) merged.faceValue = +faceSum.toFixed(2);
    }
    for (const [f, dp] of Object.entries(blend)) {
      merged[f] = base[f] == null || mv <= 0 ? base[f] : +(blendMv[f] / mv).toFixed(dp);
    }
    if (policy.sumCountryBases) {
      if (base.costBaseByCountry || Object.keys(byCountry).length) merged.costBaseByCountry = byCountry;
      if (base.acquisitionDateByCountry || Object.keys(dateByCountry).length) {
        merged.acquisitionDateByCountry = dateByCountry;
      }
    }
    survivors.set(keep, isUnitised(base) ? syncHolding(merged) : merged);
  }
  if (absorbed.size === 0) return holdings;

  const out = [];
  holdings.forEach((h, i) => {
    if (absorbed.has(i)) return;
    out.push(survivors.get(i) ?? h);
  });
  return out;
}
