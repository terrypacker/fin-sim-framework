/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ALLOCATION, isCollectibleAllocation } from './allocation.js';
import { buildHoldingsComparator } from './holdings-selection.js';
import { isLongTerm, YEAR_MS }     from './holding-period.js';
import { instrumentOf }            from './holding-utils.js';

/**
 * Consume an account's holdings to satisfy a sale of `amount` dollars at
 * marketValue. Returns the realized cost basis and the new holdings array (with
 * consumed positions removed or reduced).
 *
 * Sort order (design 65): a pluggable **selection policy** decides which lots to
 * consume. When `selection` is null the lots are walked in ascending purchaseDate
 * order (FIFO) — byte-identical to the historic behavior — so every caller that
 * omits `selection` (and the golden) is unaffected. When a `selection` is supplied
 * the primitive walks the sleeve order (Lever A/C) then the lot strategy (Lever B),
 * with a purchaseDate tie-break; see holdings-selection.js. Every tally below is
 * computed from *whichever* lots are consumed, so the tax chain downstream is
 * untouched — only *which* lots get sold changes.
 *
 * Holdings with null purchaseDate sort first under FIFO (treated as oldest —
 * "carried in from scenario boot").
 *
 * Each holding's basis share is computed pro-rata against its own
 * (consumed / marketValue) × costBasis. This matches the realized-gain
 * convention used by US/AU brokerage tax modules.
 *
 * Per-country cost bases (design 36 §12.2): when a lot carries a
 * `costBaseByCountry` map (a jurisdiction stepped up its basis on the resident's
 * move), the realized basis is also tallied per country into
 * `realizedBasisByCountry`. A lot with no entry for a country falls back to its
 * universal `costBasis`, so the per-country tally is complete across mixed lots.
 *
 * Collectible split (design 56 §7.2): the proceeds and realized basis attributable
 * to consumed **collectible** lots (`isCollectibleAllocation` — GOLD) are tallied
 * separately into `collectibleProceeds` / `collectibleBasis`, so the caller (the US
 * brokerage disposal reducer) can route the gold portion of the gain through the 28%
 * collectibles-CGT path while the rest keeps ordinary brokerage CGT. Both are 0 when
 * no consumed lot is collectible, so non-gold callers are unaffected.
 *
 * CGT cost-base indexation (design 57 §6.3): when `indexation = { level, asOfMs,
 * country }` is supplied, the realized cost base for that country is ALSO tallied
 * with each lot's basis scaled by a per-lot CPI index factor
 * `max(1, level / lot.acquisitionPriceLevel)`, but only for lots held at least 12
 * months (`asOfMs − purchaseDate`). Lots with no `acquisitionPriceLevel` (or held
 * <12 months) index at factor 1, so `realizedIndexedBasisByCountry[country]` then
 * equals the un-indexed `realizedBasisByCountry[country]`. The result is `{}` when
 * no indexation context is passed, so non-AU / pre-2027 callers are unaffected.
 *
 * @param {Array}  holdings - account.holdings (not mutated)
 * @param {number} amount   - market-value dollars to consume; must be > 0
 * Collectible per-country / indexed basis (design 57 §6.3, gold): when an
 * `indexation` context is supplied, the collectible (GOLD) slice's realized basis
 * is ALSO tallied for the reform country — both un-indexed (`collectibleBasisByCountry`)
 * and indexed (`collectibleIndexedBasisByCountry`) — so a cross-border caller can
 * measure the gold portion's AU gain from its stepped-up, CPI-indexed cost base
 * while true (non-gold) collectibles stay un-indexed. Both are `{}` when no
 * indexation context is passed.
 *
 * CGT 50%-discount split (design 62 §4): when an `indexation` (AU CGT) context is
 * supplied, `realizedDiscountableGainByCountry[country]` tallies the realized gain
 * from EQUITY/BOND lots held ≥12 months measured from the country's deemed-acquisition
 * date (`acquisitionDateByCountry[country]`, stamped at the resident's move) — falling
 * back to `purchaseDate` for lots never stepped up. The pre-2027 rates module discounts
 * only this portion; lots sold within 12 months of the move are excluded (the ATO clock
 * restarts at residency). `{}` when no indexation context is passed. `level` is optional
 * here: a caller that only needs the discount split (not indexation) may pass
 * `{ asOfMs, country }` with no `level` — the index factor then stays 1.
 *
 * Signed holding-period split (design 90 §3): when `terms = { asOfMs, countries }` is
 * supplied, `realizedGainByCountryAndTerm[country]` tallies the **signed** realized gain
 * of the consumed non-collectible lots into `{ short, long }`, and
 * `collectibleGainByCountryAndTerm` does the same for the GOLD slice. Both are `{}` when
 * `terms` is absent, so every existing caller is byte-identical.
 *
 * This is deliberately NOT the same thing as `realizedDiscountableGainByCountry`, which
 * stays exactly as it was:
 *
 *   - `realizedDiscountableGainByCountry` answers "how much of this gain earns the AU
 *     Div 115 discount" — floored at zero, non-collectible only, gated on `indexation`.
 *   - `realizedGainByCountryAndTerm` answers "what did this disposal realize, by
 *     jurisdiction and by §1222 character" — signed, so a sale below basis is a LOSS
 *     rather than a zero, and split short/long because §1212(b)(1)(A)/(B) carries the
 *     two characters forward as separate pools.
 *
 * The long-term test is per country (`LONG_TERM_TEST`): AU's Div 115 "at least 12 months"
 * is inclusive, the US §1222(3) "more than 1 year" is exclusive. Each country measures
 * from its own deemed-acquisition date where one was stamped, else `purchaseDate`.
 *
 * @param {Object}  [opts={}]
 * @param {{ level?: number, asOfMs: number, country: string }|null} [opts.indexation=null]
 * @param {{ sleeveOrder?: string[], sleeveWeights?: Object<string,number>, sleeveScore?: Function, lotStrategy?: string }|null} [opts.selection=null]
 *   The design-65 selection policy; null ⇒ FIFO (identical to the historic behavior).
 * @param {{ asOfMs: number, countries: string[] }|null} [opts.terms=null]
 *   Disposal date + the countries to characterize for; absent ⇒ no term tally.
 * §988 bond principal (design 87 G9): `section988` is `{ principal, usdBasis, weightedDays }`
 * when the disposal consumed any BOND lot in a foreign currency carrying an authored
 * `fxBasisRate`, and **null** otherwise. It reports the PRINCIPAL (par) share consumed and
 * what it cost in USD, never the proceeds — Reg. §1.988-2(b)(5) separates the exchange
 * component of principal from the instrument's own price movement. Callers hand it to
 * `section988ForBondPrincipal`; see `bond-currency-basis.js`.
 *
 * @returns {{ realizedBasis: number, realizedBasisByCountry: Object<string,number>, realizedIndexedBasisByCountry: Object<string,number>, realizedDiscountableGainByCountry: Object<string,number>, realizedGainByCountryAndTerm: Object<string,{short:number,long:number}>, collectibleGainByCountryAndTerm: Object<string,{short:number,long:number}>, collectibleProceeds: number, collectibleBasis: number, collectibleBasisByCountry: Object<string,number>, collectibleIndexedBasisByCountry: Object<string,number>, section988: {principal:number,usdBasis:number,weightedDays:number|null}|null, newHoldings: Array, consumed: number }}
 *   `consumed` may be less than `amount` if the holdings total less.
 */
const TWELVE_MONTHS_MS = YEAR_MS;

/** `{ short: 0, long: 0 }` for each requested country. */
function _emptyTermTally(countries) {
  const out = {};
  for (const c of countries) out[c] = { short: 0, long: 0 };
  return out;
}

export function consumeHoldings(holdings, amount, { indexation = null, selection = null, terms = null, securities = null } = {}) {
  if (!Array.isArray(holdings) || holdings.length === 0 || amount <= 0) {
    return { realizedBasis: 0, realizedBasisByCountry: {}, realizedIndexedBasisByCountry: {}, realizedDiscountableGainByCountry: {}, realizedGainByCountryAndTerm: {}, collectibleGainByCountryAndTerm: {}, collectibleProceeds: 0, collectibleBasis: 0, collectibleBasisByCountry: {}, collectibleIndexedBasisByCountry: {}, section988: null, newHoldings: holdings ?? [], consumed: 0 };
  }
  // Union of step-up countries present across the lots, so the per-country tally
  // covers every country even when only some lots were stepped up.
  const countries = new Set();
  for (const h of holdings) {
    if (h?.costBaseByCountry) for (const c of Object.keys(h.costBaseByCountry)) countries.add(c);
  }
  const sorted = [...holdings].sort(buildHoldingsComparator(selection, securities));
  let remaining     = amount;
  let realizedBasis = 0;
  let consumed      = 0;
  let collectibleProceeds = 0;
  let collectibleBasis    = 0;
  const realizedBasisByCountry = {};
  for (const c of countries) realizedBasisByCountry[c] = 0;
  // Indexed cost base for the reform country (design 57): tallied only when an
  // indexation context is supplied. Seed the country key so it is present even if
  // no lot carries a per-country override.
  const idxCountry = indexation?.country ?? null;
  const realizedIndexedBasisByCountry = idxCountry ? { [idxCountry]: 0 } : {};
  // CGT 50%-discount eligibility (design 62 §4): the portion of the realized gain
  // from lots held ≥12 months measured from the country's deemed-acquisition date.
  const realizedDiscountableGainByCountry = idxCountry ? { [idxCountry]: 0 } : {};
  // Collectible (gold) slice tallies for the reform country — un-indexed and indexed.
  const collectibleBasisByCountry        = idxCountry ? { [idxCountry]: 0 } : {};
  const collectibleIndexedBasisByCountry = idxCountry ? { [idxCountry]: 0 } : {};
  // SIGNED realized gain split by holding period, per country (design 90 §3). Distinct
  // from `realizedDiscountableGainByCountry` above in three ways that all matter:
  //   - it is SIGNED, so a disposal below basis produces a recorded loss instead of a
  //     zero (the whole point — every consumer upstream floored at Math.max(0, …));
  //   - it is split short/long rather than eligible/not, because §1212(b)(1)(A)/(B)
  //     carries the two characters forward as SEPARATE pools;
  //   - it is not gated on an indexation context, so a caller that wants a holding
  //     period and no CPI indexation can ask for one.
  // Opt-in via `terms`; absent ⇒ `{}` and this path costs nothing.
  const termCountries = terms?.countries ?? [];
  const termAsOfMs    = terms?.asOfMs ?? null;
  const termsOn       = termCountries.length > 0 && termAsOfMs != null;
  const realizedGainByCountryAndTerm    = termsOn ? _emptyTermTally(termCountries) : {};
  const collectibleGainByCountryAndTerm = termsOn ? _emptyTermTally(termCountries) : {};
  // §988 on a foreign-currency BOND sold BEFORE maturity — design 87 G9's second (b)(5)
  // trigger, "or the instrument is disposed of". Tallied here rather than at each caller
  // because this is the one shared liquidation primitive: the drawdown, both brokerage
  // sale reducers and the rebalancer all pass through it, and per-site detection would
  // have to re-derive "which lots left" from a result that does not report them.
  //
  // UNCONDITIONAL and un-gated, unlike `indexation` / `terms` above. It costs one
  // allocation-free predicate per lot and stays null unless a lot is a BOND carrying an
  // authored `fxBasisRate`, so there is no context for a caller to forget to pass — which
  // is the failure mode design 87 §14.1 chose the observer seam to avoid. Turning the
  // tally into a tax action is still per-caller; an unwired caller UNDERSTATES §988,
  // matching every other default in the design.
  //
  // Principal, not proceeds: Reg. §1.988-2(b)(5) separates the exchange component of
  // PRINCIPAL from the instrument's own price movement, which stays capital under §1001.
  let s988Principal = 0;
  let s988UsdBasis  = 0;
  let s988Weighted  = 0;
  const s988AsOfMs  = termAsOfMs ?? indexation?.asOfMs ?? null;
  const newHoldings = [];

  for (const h of sorted) {
    if (!h) continue;
    const mv = h.marketValue ?? 0;
    if (remaining <= 0 || mv <= 0) {
      if (mv > 0) newHoldings.push(h);
      continue;
    }
    const take = Math.min(remaining, mv);
    const fraction   = take / mv;
    // Design 87 §11 — CASH realizes NO capital gain. A unit of currency is disposed of
    // for exactly its face, so its basis equals its proceeds by definition; there is no
    // price to have moved. `rebalance-to-target-apply-reducer` has always known this
    // (`taxable && allocation !== ALLOCATION.CASH`), but this path — the brokerage
    // DRAWDOWN path — did not, so the same sleeve booked a phantom gain when it was
    // drawn instead of rebalanced. Whatever `costBasis` a CASH lot happens to carry is
    // meaningless for gain purposes; the §988 currency basis is a RATE and lives in
    // `fxBasisRate`, which is the whole point of design 87.
    const isCash     = h.allocation === ALLOCATION.CASH;
    const basisShare = isCash ? take : (h.costBasis ?? 0) * fraction;
    realizedBasis += basisShare;
    if (isCollectibleAllocation(h.allocation)) {
      collectibleProceeds += take;
      collectibleBasis    += basisShare;
    }
    for (const c of countries) {
      const cb = h.costBaseByCountry?.[c] ?? (h.costBasis ?? 0);
      realizedBasisByCountry[c] += isCash ? take : cb * fraction;
    }
    if (idxCountry) {
      const cb        = h.costBaseByCountry?.[idxCountry] ?? (h.costBasis ?? 0);
      const lotLevel  = h.acquisitionPriceLevel;
      // The ≥12-month CGT clock runs from the country's DEEMED-acquisition date when
      // the lot was stepped up on the resident's move (design 62 §4) — the ATO restarts
      // the clock at the residency date, not the original purchase. Falls back to the
      // purchase date for lots never stepped up.
      const acqTs     = h.acquisitionDateByCountry?.[idxCountry] ?? _purchaseTs(h);
      const held12mo  = (indexation.asOfMs - acqTs) >= TWELVE_MONTHS_MS;
      // CPI index factor ≥ 1 (indexation only ratchets the basis up; never a loss).
      const factor    = (held12mo && lotLevel != null && lotLevel > 0 && indexation.level > 0)
        ? Math.max(1, indexation.level / lotLevel)
        : 1;
      // Cash is never indexed either: ratcheting a currency balance's basis up would
      // manufacture a capital LOSS out of inflation on money that cannot have one.
      const idxBasisShare = isCash ? take : cb * fraction;
      realizedIndexedBasisByCountry[idxCountry] += isCash ? take : idxBasisShare * factor;
      // Discountable gain (design 62 §4): EQUITY/BOND (non-collectible) lots held
      // ≥12mo from the deemed-acquisition date are eligible for the pre-2027 Division
      // 115 50% discount. Sum each such lot's per-lot floored AU gain (proceeds share
      // − AU basis share). The rates module discounts only this portion. Collectibles/
      // gold are excluded (gold is indexed, not discounted, under the reform).
      if (held12mo && !isCollectibleAllocation(h.allocation)) {
        realizedDiscountableGainByCountry[idxCountry] += Math.max(0, take - idxBasisShare);
      }
      // Split the gold (collectible) slice out so the caller can index gold while
      // leaving equity's own indexed basis intact (both already counted above).
      if (isCollectibleAllocation(h.allocation)) {
        collectibleBasisByCountry[idxCountry]        += idxBasisShare;
        collectibleIndexedBasisByCountry[idxCountry] += idxBasisShare * factor;
      }
    }
    // Signed, per-country, per-character gain (design 90 §3.1). Independent of the
    // indexation block above — same per-country basis, no CPI factor, no floor.
    //
    // Per-LOT signing is load-bearing rather than incidental: character is a property
    // of the lot, not of the disposal. A draw that consumes one lot held 8 months at a
    // loss and one held 8 years at a gain is a short-term loss AND a long-term gain,
    // and §1212(b)(1) cannot be computed from their sum. Net later, never here.
    //
    // CASH contributes exactly 0 by construction — its basis share IS its proceeds
    // (design 87 §11) — so it needs no special case, only this note explaining why the
    // zero is correct rather than a missing branch.
    if (termsOn) {
      const isColl = isCollectibleAllocation(h.allocation);
      const bucket = isColl ? collectibleGainByCountryAndTerm : realizedGainByCountryAndTerm;
      for (const c of termCountries) {
        const cb       = h.costBaseByCountry?.[c] ?? (h.costBasis ?? 0);
        const cbShare  = isCash ? take : cb * fraction;
        // The country's own acquisition date: the deemed one where a residency step-up
        // stamped it (AU, s855-45), else the real purchase date. Only AU steps up
        // (`residency-cost-base-policy.js`), so the US arm of this reads the true
        // acquisition date today — and stays correct if another country ever does.
        const acqTs    = h.acquisitionDateByCountry?.[c] ?? _purchaseTs(h);
        bucket[c][isLongTerm(c, termAsOfMs - acqTs) ? 'long' : 'short'] += take - cbShare;
      }
    }
    // Design 87 G9 — the §988 principal leaving with this lot. `faceValue ?? marketValue`
    // matches `bondPrincipalUnits`; the two must agree or the amount realized on a sale
    // and the amount realized at maturity would measure different things.
    if (h.allocation === ALLOCATION.BOND && h.fxBasisRate > 0) {
      const par = instrumentOf(h, securities).inflationLinked
        ? Math.max(mv, h.faceValue ?? 0)
        : (h.faceValue ?? mv);
      const parShare = par * fraction;
      if (parShare > 0) {
        s988Principal += parShare;
        s988UsdBasis  += parShare / h.fxBasisRate;
        if (s988AsOfMs != null) {
          s988Weighted += parShare * Math.max(0, s988AsOfMs - _purchaseTs(h));
        }
      }
    }
    consumed      += take;
    remaining     -= take;
    const remainingMv = mv - take;
    if (remainingMv > 0.001) {
      // par-reviewed: the FIFO partial depletes each per-country cost base by the consumed
      // fraction and re-asserts the CASH basis invariant. Par IS scaled here (design 87 G9) -
      // this was the one path that always got it right.
      const partial = {
        ...h,
        marketValue: +remainingMv.toFixed(2),
        // A CASH remainder re-asserts the invariant rather than subtracting: a stale
        // basis minus full proceeds would otherwise leave a NEGATIVE basis behind.
        costBasis:   isCash ? +remainingMv.toFixed(2)
                            : +((h.costBasis ?? 0) - basisShare).toFixed(2),
      };
      // A partly-sold bond keeps only the part of its PRINCIPAL that was not sold.
      // Carrying the whole `faceValue` through the spread — which is what happened before
      // design 87 G9 went looking — would redeem the full original par at maturity after
      // half of it had already been sold, and would double-count the same units' §988.
      //
      // design 93 §5b — on a UNITISED lot the same sentence is "it keeps the units that
      // were not sold", and par follows because `parPerUnit` never moved. `units` is set
      // from the surviving market value at the lot's own price rather than scaled by a
      // ratio, so the remainder's stored `marketValue` stays EXACTLY the proceeds
      // arithmetic's remainder and the §4.4 balance invariant is untouched by rounding.
      if (h.units != null && (h.pricePerUnit ?? 0) > 0) {
        partial.units = +(remainingMv / h.pricePerUnit).toFixed(8);
        // Only an instrument that HAS a par gets one derived. Design 94 step 3 made this
        // reachable: equity is unitised now and carries no `parPerUnit`, and the old
        // `?? 0` stamped `faceValue: 0` on every partly-sold share position — a par of
        // zero is a redemption target, not the absence of one, so `_syncBalance`'s ghost-par
        // sweep and the maturity path would both have had an opinion about a share lot.
        const par = instrumentOf(h, securities).parPerUnit;
        if (par != null) partial.faceValue = +(partial.units * par).toFixed(2);
      } else if (h.faceValue != null && mv > 0) {
        partial.faceValue = +(h.faceValue * (remainingMv / mv)).toFixed(2);
      }
      // Deplete each per-country cost base by the same consumed fraction.
      if (h.costBaseByCountry) {
        partial.costBaseByCountry = {};
        for (const c of Object.keys(h.costBaseByCountry)) {
          partial.costBaseByCountry[c] = +(h.costBaseByCountry[c] * (remainingMv / mv)).toFixed(2);
        }
      }
      newHoldings.push(partial);
    }
    // If fully consumed (remainingMv ≈ 0), the holding is dropped.
  }
  for (const c of countries) realizedBasisByCountry[c] = +realizedBasisByCountry[c].toFixed(2);
  if (idxCountry) {
    realizedIndexedBasisByCountry[idxCountry]    = +realizedIndexedBasisByCountry[idxCountry].toFixed(2);
    realizedDiscountableGainByCountry[idxCountry] = +realizedDiscountableGainByCountry[idxCountry].toFixed(2);
    collectibleBasisByCountry[idxCountry]        = +collectibleBasisByCountry[idxCountry].toFixed(2);
    collectibleIndexedBasisByCountry[idxCountry] = +collectibleIndexedBasisByCountry[idxCountry].toFixed(2);
  }
  // `termsOn`, not `termCountries` — the two are not the same test. A caller that names
  // countries but has no as-of date (`terms: { countries: [...], asOfMs: null }`) leaves
  // both tallies as `{}`, and rounding a named country's bucket then dereferenced
  // `undefined.short`. Unreachable only while every caller passed a non-null date, which
  // in two reducers was a `Date.now()` wall clock standing in for the missing one.
  if (termsOn) {
    for (const c of termCountries) {
      for (const term of ['short', 'long']) {
        realizedGainByCountryAndTerm[c][term]    = +realizedGainByCountryAndTerm[c][term].toFixed(2);
        collectibleGainByCountryAndTerm[c][term] = +collectibleGainByCountryAndTerm[c][term].toFixed(2);
      }
    }
  }
  return {
    realizedBasis: +realizedBasis.toFixed(2),
    realizedBasisByCountry,
    realizedIndexedBasisByCountry,
    realizedDiscountableGainByCountry,
    realizedGainByCountryAndTerm,
    collectibleGainByCountryAndTerm,
    collectibleProceeds: +collectibleProceeds.toFixed(2),
    collectibleBasis:    +collectibleBasis.toFixed(2),
    collectibleBasisByCountry,
    collectibleIndexedBasisByCountry,
    // Null — not a zeroed object — when nothing §988 was consumed, so a caller cannot
    // mistake "no foreign bond in this disposal" for "a foreign bond that gained zero".
    // Design 87's whole failure mode is a zero that reads like a correct answer.
    section988: s988Principal > 0
      ? {
          principal:    +s988Principal.toFixed(2),
          // NOT rounded. This is a transient tally, not a state field, and rounding it
          // would make the sale trigger and the maturity trigger value the same principal
          // slightly differently — which is exactly the drift CB-38 pins.
          usdBasis:     s988UsdBasis,
          weightedDays: s988AsOfMs != null
            ? Math.round(s988Weighted / s988Principal / 86400000)
            : null,
        }
      : null,
    newHoldings,
    consumed:      +consumed.toFixed(2),
  };
}

/**
 * FIFO consumption — the historic entry point, now a thin wrapper over
 * `consumeHoldings` with no selection policy (⇒ purchaseDate ascending). Kept so
 * every existing caller (engine drawdown, event withdrawals, design-61 rebalance,
 * inheritance, residency cost-base) is byte-identical until it opts into a policy.
 *
 * @param {Array}  holdings
 * @param {number} amount
 * @param {{ level?: number, asOfMs: number, country: string }|null} [indexation=null]
 */
export function consumeHoldingsFifo(holdings, amount, indexation = null) {
  return consumeHoldings(holdings, amount, { indexation });
}

function _purchaseTs(h) {
  if (!h?.purchaseDate) return 0;
  const t = h.purchaseDate instanceof Date
    ? h.purchaseDate.getTime()
    : new Date(h.purchaseDate).getTime();
  return Number.isNaN(t) ? 0 : t;
}
