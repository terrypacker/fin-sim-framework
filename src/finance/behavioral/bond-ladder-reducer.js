/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY }  from '../../simulation-framework/reducers.js';
import { ALLOCATION }         from '../holdings/allocation.js';
import { _syncBalance }       from '../holdings/holding-reducers.js';
import { resolveRateKey }     from '../holdings/default-allocations.js';
import { resolveYield }       from '../economic-regimes/yield-curve.js';

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

/**
 * BondLadderReducer — the persistent maintenance half of design 66 §G8 (bond
 * ladders) that makes ladder LENGTH an optimizer / MPC lever (§10.5 foundation +
 * §10.6). It materializes and re-shapes a single self-perpetuating bond ladder in a
 * designated account so a scalar "how many rungs" can be searched.
 *
 * This is the sibling of design-61's RebalanceToTargetReducer: its target (the rung
 * count) is held on the reducer instance (`targetRungs`), NOT in a per-account state
 * field, so it survives MPC snapshot injection and re-wires live via
 * `reducerService.updateReducer(reducer, { targetRungs })` with no `_seededSim`
 * re-stamp (verified pattern, see [[design-61-holding-allocation-lever]] Phase 5).
 *
 * Each period-advance, for the designated account:
 *   - reads the account's total BOND value (rungs + any bond fund);
 *   - if that value has been laddered at the CURRENT `targetRungs` already (a stamped
 *     `_bondLadderRungs` marker matches), does nothing — the Phase-A roll-to-tail
 *     (`rollTermYears`) self-maintains the spacing, so there is no per-period churn;
 *   - otherwise (bootstrap, or the lever changed the rung count) RE-MATERIALIZES:
 *     replaces the account's BOND holdings with `targetRungs` equal, staggered
 *     individual bonds (maturities at 1·spacing … N·spacing years out), each rolling
 *     to the ladder tail (`rollTermYears = N·spacing`) so the ladder self-perpetuates,
 *     and stamps the marker.
 *
 * Value is conserved (Σ rung faceValue == the laddered bond value) and so is every
 * TAX attribute of the sleeve being replaced — see `ladderCarryover`. The reducer is
 * ADDED only when the BOND_LADDER behavioral strategy is selected, so an un-selecting
 * scenario (the golden) never constructs it and is byte-identical.
 */
export class BondLadderReducer extends Reducer {
  static type        = 'BondLadderReducer';
  static description = 'Materializes and re-shapes a self-perpetuating bond ladder (N staggered rolling rungs) in a designated account so ladder length is an optimizer/MPC lever (design 66 §G8).';

  /**
   * @param {object}  opts
   * @param {string}  opts.stateKey            - the account to hold the ladder
   * @param {string}  [opts.country='US']      - 'US'|'AU' — picks the fixed-income rate key
   * @param {number}  [opts.targetRungs=5]     - number of rungs (the searchable lever)
   * @param {number}  [opts.spacingYears=1]    - years between adjacent maturities
   * @param {boolean} [opts.roll=true]         - roll each maturing rung to the tail (self-perpetuate)
   * @param {string}  [opts.taxExemption='state'] - Holding.taxExemption for every rung (default Treasury)
   * @param {boolean} [opts.inflationLinked=false] - every rung is a TIPS (design 66 §G5): CPI-indexed
   *   principal, imputed accretion income, coupon on the adjusted principal. Pair with `couponRate`
   *   set to the REAL yield — the market anchor is a NOMINAL yield and stamping it on a CPI-indexed
   *   principal pays for inflation twice.
   * @param {number|null} [opts.couponRate=null] - fixed coupon for every rung; null ⇒ the curve yield
   *   at each rung's own tenor.
   */
  constructor({ stateKey, country = 'US', targetRungs = 5, spacingYears = 1,
                roll = true, taxExemption = 'state',
                inflationLinked = false, couponRate = null } = {}) {
    super('Bond Ladder', PRIORITY.PRE_PROCESS + 5); // after maturity (+3) and rebalance detect (+4)
    this.reducedActionTypes = ['US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE'];
    this.stateKey     = stateKey;
    this.country      = country;
    this.targetRungs  = targetRungs;
    this.spacingYears = spacingYears;
    this.roll         = roll;
    this.taxExemption = taxExemption;
    this.inflationLinked = inflationLinked;
    this.couponRate      = couponRate;
  }

  reduce(state, action) {
    const cc     = action?.type === 'AU_PERIOD_ADVANCE' ? 'AU' : 'US';
    const asOfMs = state.currentPeriods?.[cc]?.startMs ?? null;
    if (asOfMs == null || this.stateKey == null) return this.newState(state);

    const account = state[this.stateKey];
    if (!account || !Array.isArray(account.holdings)) return this.newState(state);

    const N = Math.max(2, Math.min(30, Math.round(this.targetRungs ?? 5)));

    const bondHoldings = account.holdings.filter(h => h?.allocation === ALLOCATION.BOND);
    const bondValue    = +bondHoldings.reduce((s, h) => s + (h?.marketValue ?? 0), 0).toFixed(2);
    if (bondValue <= 0.01) return this.newState(state); // nothing to ladder ⇒ inert

    // Already laddered at this length ⇒ let the Phase-A roll self-maintain the spacing.
    // This makes the reducer fire the (re)materialization exactly once at bootstrap and
    // once per lever change, not every period (no journal churn, no basis reset drift).
    //
    // The one thing the roll CANNOT self-maintain is new money. When design 61 rebalances
    // INTO bonds it grows the existing sleeves pro rata, but drawdown consumes rungs, and
    // an account whose rungs have all been spent takes its next bond buy as a fresh
    // PERPETUAL FUND sleeve (`_newSleeve`). Left alone those funds accumulate until the
    // "ladder" is a minority of the account's bonds — measured at 100% of the taxable
    // brokerage's $1.29M by year 20. Absorbing them into the standing rungs is the crude
    // form of design 66 §10.5's buy-side tail routing: it keeps every bond dollar inside a
    // dated rung without resetting the maturity spacing a full rebuild would destroy.
    const standingRungs = bondHoldings.filter(h => h?.maturityDate != null);
    if (account._bondLadderRungs === N && standingRungs.length > 0) {
      const funds = bondHoldings.filter(h => h?.maturityDate == null);
      const fundValue = +funds.reduce((s, h) => s + (h?.marketValue ?? 0), 0).toFixed(2);
      if (fundValue <= 0.01) return this.newState(state);
      const absorbed = absorbIntoRungs(standingRungs, funds);
      const others   = account.holdings.filter(h => h?.allocation !== ALLOCATION.BOND);
      return this.newState(state, {
        [this.stateKey]: _syncBalance({ ...account, holdings: [...others, ...absorbed] }),
      });
    }

    const rateKey = resolveRateKey(this.country === 'AU' ? 'AU' : 'US', ALLOCATION.BOND, null);
    // The AU CPI level is the indexation base wherever the ladder lives — only AU
    // indexes a cost base, so the level is read from AU regardless of this.country.
    const auLevel = state.cpiAccumulator?.AU ?? state.inflationAccumulator?.AU ?? 1;
    const rungs   = materializeLadder({
      bondValue, rungs: N, spacingYears: this.spacingYears ?? 1, asOfMs,
      roll: this.roll !== false, taxExemption: this.taxExemption ?? 'state',
      stateKey: this.stateKey, rateKey,
      inflationLinked: this.inflationLinked === true,
      couponRate: this.couponRate
        ?? ((rateKey != null ? state.effectiveInterestRates?.[rateKey] : null) ?? null),
      // design 67 — price each rung along the yield curve at ITS OWN tenor, so a
      // freshly built ladder earns the term premium (flat curve ⇒ every rung == anchor).
      // A pinned `couponRate` (a contracted real yield, typically) overrides the curve.
      couponForTenor: this.couponRate != null
        ? null
        : (tenorYears) => resolveYield(state, { rateKey, tenorYears }),
      priceLevel: auLevel,
      // design 62 §9.5 follow-up — the rebuild REPLACES existing lots, so it must carry
      // their tax attributes across instead of re-basing the sleeve at market value.
      carry: ladderCarryover(bondHoldings, auLevel),
    });

    const nonBond     = account.holdings.filter(h => h?.allocation !== ALLOCATION.BOND);
    const nextAccount = _syncBalance({ ...account, holdings: [...nonBond, ...rungs], _bondLadderRungs: N });
    return this.newState(state, { [this.stateKey]: nextAccount });
  }
}

/**
 * Build `rungs` equal, staggered individual-bond Holdings totaling `bondValue`
 * (design 66 §G8). Rung k (0-based) matures `(k+1)·spacingYears` years after `asOfMs`;
 * the ladder length (roll-to-tail term) is `rungs·spacingYears`. Par bonds:
 * `marketValue = costBasis = faceValue`. The LAST rung absorbs the rounding remainder
 * so Σ faceValue == bondValue exactly. Deterministic ids (`ladder-<stateKey>-<k>`).
 *
 * Shared with the account-editor "+ Bond ladder" builder conceptually (§10.4); kept
 * here so the runtime maintenance and the UI generate identical rung shapes.
 *
 * `carry` (from `ladderCarryover`) is the aggregate tax identity of the sleeve these
 * rungs REPLACE. Supplied, each rung takes its face-weighted share of the carried cost
 * base — universal and per-country — and the whole sleeve's acquisition dates and
 * indexation level; the remainder lands on the last rung exactly as `faceValue` does, so
 * Σ basis is conserved to the cent. Omitted (the UI builder, and an establish-from-
 * nothing), the rungs are par bonds: basis = face, no carried history.
 */
export function materializeLadder({ bondValue, rungs, spacingYears = 1, asOfMs,
                                    roll = true, taxExemption = 'state',
                                    stateKey = 'ladder', rateKey = null, couponRate = null,
                                    couponForTenor = null, priceLevel = null, carry = null,
                                    inflationLinked = false }) {
  const n        = Math.max(1, Math.round(rungs));
  const spacing  = spacingYears > 0 ? spacingYears : 1;
  const ladderTermYears = +(n * spacing).toFixed(4);
  const baseFace = Math.floor((bondValue / n) * 100) / 100; // truncated so the remainder is positive
  const now      = new Date(asOfMs);
  // Each carried total is split by the same rule as faceValue — truncated shares, with
  // the last rung absorbing the remainder — so nothing is created or lost in rounding.
  const split    = _carrySplitter(carry, bondValue, n);

  const out = [];
  let allocated = 0;
  for (let k = 0; k < n; k++) {
    const face      = (k === n - 1) ? +(bondValue - allocated).toFixed(2) : baseFace;
    allocated       = +(allocated + face).toFixed(2);
    const yearsOut  = (k + 1) * spacing;
    const maturity  = new Date(asOfMs + yearsOut * YEAR_MS);
    // design 67 — the rung's own-tenor coupon (curve-priced); falls back to the flat
    // couponRate when no resolver is supplied (the UI builder path) or the anchor is absent.
    const rungCoupon = couponForTenor ? (couponForTenor(yearsOut) ?? couponRate) : couponRate;
    out.push({
      id:             `ladder-${stateKey}-${k}`,
      allocation:     ALLOCATION.BOND,
      marketValue:    face,
      costBasis:      carry ? split('costBasis', k, face) : face,
      costBaseByCountry: carry?.costBaseByCountry
        ? _mapValues(carry.costBaseByCountry, (_v, c) => split(`costBaseByCountry.${c}`, k, face))
        : null,
      purchaseDate:   carry?.purchaseMs != null ? new Date(carry.purchaseMs) : now,
      // AU indexation base at THIS rung's acquisition (design 57 §6.3 / design 62 §9.5),
      // or the carried level of the sleeve it replaces. Null on the UI builder path,
      // which has no simulation state to read a CPI level from — that keeps the
      // pre-existing "never indexed" behavior for authored ladders.
      acquisitionPriceLevel: carry?.priceLevel ?? priceLevel,
      acquisitionDateByCountry: carry?.acquisitionDateByCountry ?? null,
      rateKey,
      label:          `Ladder ${k + 1}/${n}`,
      dividendYield:  null,
      couponRate:     rungCoupon,                   // G1: locked to the market yield at build (null ⇒ floats)
      appreciationSchedule: null,
      duration:       +yearsOut.toFixed(2),         // ≈ time-to-maturity at issue
      taxLossPartner: null,
      taxExemption,
      issuingState:   null,
      maturityDate:   maturity,
      faceValue:      face,
      rollAtMaturity: roll,
      rollTermYears:  roll ? ladderTermYears : null,
      zeroCoupon:      false,
      inflationLinked: inflationLinked === true,
    });
  }
  return out;
}

/**
 * The aggregate tax identity of the bond sleeve a re-materialization is about to
 * REPLACE (design 62 §9.5 follow-up — "Materialize Ladder loses residency step-up").
 *
 * `materializeLadder` used to rebuild the sleeve from its total market value alone, so
 * every rebuild silently re-based the whole ladder at market: the unrealized gain or
 * loss vanished with no disposal and no tax, an AU s855-45 residency step-up carried by
 * the replaced lots was overwritten by a *second*, later step-up, and the post-2027
 * indexation clock (§9.5) restarted at the rebuild. Two of the three favor the taxpayer
 * and none of them is an event that happened.
 *
 * The rebuild is now **carryover-basis**: it reshapes the maturity structure of value the
 * account already holds and conserves the tax attributes attached to it. What is carried:
 *
 *   - `costBasis`, summed with `?? 0` — the same reading `consumeHoldingsFifo` uses, so
 *     the rebuild conserves exactly what a disposal of that sleeve would have measured.
 *   - `costBaseByCountry`, summed per country over ALL lots, a lot with no entry for a
 *     country falling back to its universal `costBasis` (again the FIFO path's reading).
 *     A residency step-up therefore survives the rebuild at its stepped-up amount.
 *   - `acquisitionPriceLevel`, as the **basis-weighted harmonic mean** `Σbasisᵢ /
 *     Σ(basisᵢ / levelᵢ)` — the exact blend `_compactSeasonedLots` uses (design 62 §9.5):
 *     the merged basis and level reproduce `Σ basisᵢ × (levelₙₒw / levelᵢ)` precisely, so
 *     indexation relief is neither gained nor lost. A lot carrying no level indexes at
 *     factor 1, which is `levelₙₒw`, so it enters the blend at today's level.
 *   - `purchaseDate` and `acquisitionDateByCountry`, as the **latest** vintage among the
 *     replaced lots. The rungs are one blended lot per maturity, so a single date has to
 *     stand for the sleeve; taking the newest never credits a ≥12-month holding period to
 *     money that was demonstrably bought later. For a steady-state ladder — every lot
 *     already seasoned — newest and oldest are indistinguishable to every holding-period
 *     rule, so the choice only bites when fresh money is being absorbed, and then it is
 *     conservative. It is in every case newer-bounded by the rebuild date the old code
 *     stamped, so this strictly increases holding-period fidelity.
 *
 * > **What this costs.** FIFO ordering *within* the replaced sleeve is averaged: after a
 * > rebuild a partial sale realizes the ladder's blended basis rather than its oldest
 * > lot's. That is the same pro-rata convention `_reduceProRata` and `_compactSeasonedLots`
 * > already apply, and it is the price of the rebuild emitting exactly N lots — carrying
 * > vintages through un-blended would multiply the lot count at every rebuild without
 * > bound. It is confined to the one account the ladder strategy designates.
 *
 * > **What it deliberately does not do.** A real re-ladder is a partial disposal — you
 * > sell to re-cut the rungs — and would realize CGT on the traded fraction. Modeling it
 * > as a full sale would be worse (a rebuild fires at bootstrap, where converting an
 * > authored bond sleeve into rungs is a change of REPRESENTATION, not a trade the plan
 * > made). Carryover defers that gain to the eventual sale instead of erasing it.
 *
 * @param {Array<object>} replaced - the BOND lots the rebuild is about to discard
 * @param {number} levelNow        - the current AU CPI level (the un-indexed lot's level)
 * @returns {object|null} carry descriptor for `materializeLadder`, or null when there is
 *                        nothing to carry (rungs then fall back to par basis).
 */
export function ladderCarryover(replaced, levelNow) {
  const lots = (replaced ?? []).filter(h => h && (h.marketValue ?? 0) > 0);
  if (lots.length === 0) return null;

  let costBasis = 0, basisOverLevel = 0, purchaseMs = null;
  const stepUpCountries = new Set();
  const dateCountries   = new Set();
  for (const h of lots) {
    const basis = h.costBasis ?? 0;
    costBasis += basis;
    const level = h.acquisitionPriceLevel > 0 ? h.acquisitionPriceLevel : levelNow;
    if (level > 0) basisOverLevel += basis / level;
    const ts = _purchaseMs(h);
    if (ts != null && (purchaseMs == null || ts > purchaseMs)) purchaseMs = ts;
    for (const c of Object.keys(h.costBaseByCountry ?? {}))        stepUpCountries.add(c);
    for (const c of Object.keys(h.acquisitionDateByCountry ?? {})) dateCountries.add(c);
  }

  const costBaseByCountry = stepUpCountries.size === 0 ? null : {};
  for (const c of stepUpCountries) {
    costBaseByCountry[c] = +lots
      .reduce((s, h) => s + (h.costBaseByCountry?.[c] ?? (h.costBasis ?? 0)), 0).toFixed(2);
  }

  const acquisitionDateByCountry = dateCountries.size === 0 ? null : {};
  for (const c of dateCountries) {
    let latest = null;
    for (const h of lots) {
      // A lot never stepped up for `c` was acquired for that country when it was bought.
      const ts = h.acquisitionDateByCountry?.[c] ?? _purchaseMs(h);
      if (ts != null && (latest == null || ts > latest)) latest = ts;
    }
    if (latest != null) acquisitionDateByCountry[c] = latest;
  }

  return {
    costBasis: +costBasis.toFixed(2),
    costBaseByCountry,
    acquisitionDateByCountry,
    purchaseMs,
    // Null (rather than levelNow) when there is no basis to weight by: nothing to index
    // either way, and null lets the caller's own `priceLevel` stand.
    priceLevel: costBasis > 0 && basisOverLevel > 0 ? +(costBasis / basisOverLevel).toFixed(11) : null,
  };
}

/**
 * Split each carried total across the rungs by the same truncate-then-remainder rule
 * `faceValue` uses, so every carried sum is conserved to the cent. Returns a
 * `(field, k, face) => number` closure; `field` is a path into the carry descriptor
 * (`'costBasis'` or `'costBaseByCountry.<c>'`) and each is split independently.
 */
function _carrySplitter(carry, bondValue, n) {
  if (!carry || !(bondValue > 0)) return () => 0;
  const allocated = new Map();
  return (field, k, face) => {
    const total = field.startsWith('costBaseByCountry.')
      ? (carry.costBaseByCountry?.[field.slice('costBaseByCountry.'.length)] ?? 0)
      : (carry[field] ?? 0);
    if (k === n - 1) return +(total - (allocated.get(field) ?? 0)).toFixed(2);
    // Truncated so the remainder the last rung absorbs is positive, matching faceValue.
    const share = Math.floor((total * (face / bondValue)) * 100) / 100;
    allocated.set(field, +((allocated.get(field) ?? 0) + share).toFixed(2));
    return share;
  };
}

/**
 * Fold un-laddered BOND *fund* sleeves into the standing rungs, pro rata by rung
 * `faceValue`, and return the replacement rung list (the funds are dropped by the
 * caller, which rebuilds the account's holdings from this).
 *
 * The crude form of design 66 §10.5's buy-side tail routing. It exists because the
 * design-61 rebalancer spawns a perpetual fund sleeve whenever it buys bonds into an
 * account that currently holds none — which happens routinely once drawdown has eaten
 * an account's rungs — and nothing else ever converts one back into a dated rung.
 *
 * Conservation. `marketValue`, `costBasis` and each `costBaseByCountry` entry are moved
 * across in full: the last rung absorbs the rounding remainder, exactly as `faceValue`
 * splitting does in `materializeLadder`. NOT a taxable event — no lot is disposed of,
 * the money simply changes which lot carries it.
 *
 * The approximation worth naming: `faceValue` grows by the absorbed MARKET value, so a
 * rung that is currently trading away from par has its par redemption amount moved by
 * the market price of the new money rather than by its own par. The error is bounded by
 * the rung's discount/premium (small — an individual bond pulls to par as it ages) and it
 * washes out at the next maturity, where the whole rung redeems at the blended face.
 *
 * @param {Array<object>} rungs - BOND holdings carrying a maturityDate (at least one)
 * @param {Array<object>} funds - BOND holdings with no maturityDate
 * @returns {Array<object>} the rungs, grown
 */
function absorbIntoRungs(rungs, funds) {
  const totalFace = rungs.reduce((s, h) => s + (h?.faceValue ?? h?.marketValue ?? 0), 0);
  if (!(totalFace > 0)) return rungs;

  const addMv    = +funds.reduce((s, h) => s + (h?.marketValue ?? 0), 0).toFixed(2);
  const addBasis = +funds.reduce((s, h) => s + (h?.costBasis   ?? 0), 0).toFixed(2);
  const addByCountry = {};
  for (const f of funds) {
    for (const [c, v] of Object.entries(f?.costBaseByCountry ?? {})) {
      addByCountry[c] = +((addByCountry[c] ?? 0) + (v ?? 0)).toFixed(2);
    }
  }

  const n = rungs.length;
  const taken = new Map();
  // Truncated shares with the last rung taking the remainder — the same rule
  // `_carrySplitter` uses, so nothing is created or destroyed in the rounding.
  const share = (field, total, k, w) => {
    if (!(total > 0)) return 0;
    if (k === n - 1) return +(total - (taken.get(field) ?? 0)).toFixed(2);
    const v = Math.floor(total * w * 100) / 100;
    taken.set(field, +((taken.get(field) ?? 0) + v).toFixed(2));
    return v;
  };

  return rungs.map((h, k) => {
    const w  = (h?.faceValue ?? h?.marketValue ?? 0) / totalFace;
    const mv = share('mv', addMv, k, w);
    if (mv === 0 && addBasis === 0) return h;
    const cb = share('cb', addBasis, k, w);
    const mvBefore = h.marketValue ?? 0;
    const mvAfter  = +(mvBefore + mv).toFixed(2);
    const next = {
      ...h,
      marketValue: mvAfter,
      costBasis:   +((h.costBasis ?? 0) + cb).toFixed(2),
      // Par grows differently for the two instruments, because `faceValue` MEANS
      // something different in each.
      //
      // A nominal rung: par is what it redeems for, and its price-to-par RATIO is what
      // pull-to-par reads. Scale par with the position so absorption leaves the ratio
      // alone; adding market value to par 1:1 would re-price the rung and hand
      // pull-to-par a target no purchase set.
      //
      // A TIPS rung: par is the ORIGINAL issue face, held only as the deflation FLOOR
      // (`redeem` takes `max(indexed principal, face)`), while the indexed principal
      // lives in marketValue and is already well above it after years of CPI accretion.
      // Scaling that floor by the mv ratio inflates it by the accretion — and since the
      // floor then becomes the redemption value, every roll ratchets the position up to
      // an ever-higher floor. New money makes it worse, so the runaway grew with equity
      // weight (clean at 0% equity; 266 of 1750 paths past $1e12 at 75%, one reaching
      // 1e+63). New money buys TIPS AT PAR today, so it contributes its own cash amount
      // to the floor and nothing more.
      faceValue:   (h.faceValue == null || mvBefore <= 0)
        ? h.faceValue
        : h.inflationLinked
          ? +((h.faceValue ?? 0) + mv).toFixed(2)
          : +(h.faceValue * (mvAfter / mvBefore)).toFixed(2),
    };
    if (h.costBaseByCountry || Object.keys(addByCountry).length) {
      const merged = { ...(h.costBaseByCountry ?? {}) };
      for (const [c, total] of Object.entries(addByCountry)) {
        merged[c] = +((merged[c] ?? 0) + share(`cbc.${c}`, total, k, w)).toFixed(2);
      }
      next.costBaseByCountry = merged;
    }
    return next;
  });
}

/** Milliseconds of a lot's purchaseDate, or null when it carries none / an invalid one. */
function _purchaseMs(h) {
  if (!h?.purchaseDate) return null;
  const t = h.purchaseDate instanceof Date ? h.purchaseDate.getTime() : new Date(h.purchaseDate).getTime();
  return Number.isNaN(t) ? null : t;
}

/** `{k: v}` → `{k: fn(v, k)}`. */
function _mapValues(obj, fn) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = fn(v, k);
  return out;
}
