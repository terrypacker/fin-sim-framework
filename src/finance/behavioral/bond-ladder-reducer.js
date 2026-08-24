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
import { unitiseBond, addValue } from '../holdings/holding-utils.js';
import { compactLots, LOT_POLICIES } from '../holdings/holding-utils.js';

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
      const spacing = this.spacingYears > 0 ? this.spacingYears : 1;
      const ladderTermYears = +(N * spacing).toFixed(4);
      const rateKeyA = resolveRateKey(this.country === 'AU' ? 'AU' : 'US', ALLOCATION.BOND, null);
      const absorbed = absorbAsTailRung(standingRungs, funds, {
        asOfMs, ladderTermYears, stateKey: this.stateKey, rateKey: rateKeyA,
        roll: this.roll !== false,
        taxExemption: this.taxExemption ?? 'state',
        inflationLinked: this.inflationLinked === true,
        couponRate: this.couponRate
          ?? resolveYield(state, { rateKey: rateKeyA, tenorYears: ladderTermYears })
          ?? null,
        levelNow: state.cpiAccumulator?.AU ?? state.inflationAccumulator?.AU ?? 1,
      });
      const others   = account.holdings.filter(h => h?.allocation !== ALLOCATION.BOND);
      return this.newState(state, {
        [this.stateKey]: _syncBalance({
          ...account,
          holdings: [...others, ..._compactLadderLots(absorbed, asOfMs)],
        }),
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
    // par-reviewed: CONSTRUCTS a rung. The spread is `unitiseBond`'s derived unit fields,
    // which set par and price FOR this market value rather than carrying a stale one — a
    // fresh lot has no par to fall out of step with, and the one field that could is
    // written by the same call.
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
      // design 93 §5b — a rung is ISSUED, so it is unitised from birth rather than
      // promoted later. A par bond at build, so `pricePerUnit` lands on PAR_PER_UNIT and
      // `units x parPerUnit` reproduces `face` exactly (face is 2dp, units 4dp).
      ...unitiseBond({ faceValue: face, inflationLinked: inflationLinked === true }),
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
 * Convert un-laddered BOND *fund* sleeves into a NEW rung at the ladder tail, and return
 * the replacement rung list (the funds are dropped by the caller, which rebuilds the
 * account's holdings from this).
 *
 * The crude form of design 66 §10.5's buy-side tail routing. It exists because the
 * design-61 rebalancer spawns a perpetual fund sleeve whenever it buys bonds into an
 * account that currently holds none — which happens routinely once drawdown has eaten
 * an account's rungs — and nothing else ever converts one back into a dated rung.
 *
 * **This used to fold the money INTO the standing rungs, and design 93 §5.0a is why it no
 * longer does.** A lot is the unit of tax accounting: it has one purchase date, one basis
 * and — once par is per-unit — one `parPerUnit`. Blending new money into an existing rung
 * made the absorbed dollars inherit that rung's acquisition date, and it forced a choice
 * about what par the blend carries which has no good answer (§5.0's three withdrawn
 * options). Design 62 §9 already settled the rule for the rebalancer's buy leg — *"a buy
 * is what it actually is: a purchase made TODAY, in its own lot"* — and never reached the
 * other money-in paths. This is that migration finished.
 *
 * Opening a lot rather than blending also deletes the approximation the old form had to
 * document: it grew each rung's `faceValue` by the MARKET value of the absorbed money, so
 * a rung trading away from par had its redemption amount moved by a price no purchase set.
 * A fresh rung is issued at par, so nothing is approximated.
 *
 * **Vintage, not per-firing.** The new rung's id keys on the tail's maturity YEAR, so
 * repeated absorptions that target the same tail merge into the same lot — one added rung
 * per year at worst, the same bound `mergeCouponReinvestLots` uses for coupon vintages.
 * Merging within a vintage is not the blend the rule forbids: same instrument, same
 * maturity, same year, so no holding-period test can tell the halves apart.
 *
 * **Basis is CARRIED, not re-based.** No lot is disposed of — the money simply changes
 * which lot holds it — so the new rung takes the funds' aggregate `costBasis`, per-country
 * bases, latest acquisition dates and blended indexation level, exactly as `ladderCarryover`
 * defines them for a rebuild. Re-basing at market would be a step-up with no disposal.
 *
 * @param {Array<object>} rungs - BOND holdings carrying a maturityDate (at least one)
 * @param {Array<object>} funds - BOND holdings with no maturityDate
 * @param {object} opts
 * @returns {Array<object>} the rungs, plus (or merged into) the tail rung
 */
export function absorbAsTailRung(rungs, funds, {
  asOfMs, ladderTermYears, stateKey = 'ladder', rateKey = null, roll = true,
  taxExemption = 'state', inflationLinked = false, couponRate = null, levelNow = 1,
} = {}) {
  const addMv = +(funds ?? []).reduce((s, h) => s + (h?.marketValue ?? 0), 0).toFixed(2);
  if (!(addMv > 0.005)) return rungs;

  const carry     = ladderCarryover(funds, levelNow) ?? {};
  const maturity  = new Date(asOfMs + ladderTermYears * YEAR_MS);
  const lotId     = `ladder-${stateKey}-absorb-${maturity.getUTCFullYear()}`;
  const idx       = rungs.findIndex(h => h?.id === lotId);

  if (idx >= 0) {
    // Same vintage, same instrument — more units of the bond this lot already holds.
    // `addValue` owns the money-and-par rule; the carried basis replaces the basis it
    // would have assumed (absorbed money brings its OWN basis, not the cash it is worth).
    const cur    = rungs[idx];
    const merged = addValue(cur, addMv);
    const next   = {
      ...merged,
      costBasis: +((cur.costBasis ?? 0) + (carry.costBasis ?? addMv)).toFixed(2),
    };
    if (cur.costBaseByCountry || carry.costBaseByCountry) {
      const bases = { ...(cur.costBaseByCountry ?? {}) };
      for (const [c, v] of Object.entries(carry.costBaseByCountry ?? {})) {
        bases[c] = +((bases[c] ?? cur.costBasis ?? 0) + (v ?? 0)).toFixed(2);
      }
      next.costBaseByCountry = bases;
    }
    return rungs.map((h, i) => (i === idx ? next : h));
  }

  // par-reviewed: CONSTRUCTS the tail rung. As `materializeLadder` above — the spread is
  // `unitiseBond`'s derived fields, issued at par for this exact market value.
  return [...rungs, {
    id:             lotId,
    allocation:     ALLOCATION.BOND,
    marketValue:    addMv,
    costBasis:      +(carry.costBasis ?? addMv).toFixed(2),
    costBaseByCountry: carry.costBaseByCountry ?? null,
    // The absorbed money's OWN vintage, not today: it was already invested, and the
    // latest-wins rule is `ladderCarryover`'s (never credits a ≥12-month holding period
    // to money demonstrably bought later).
    purchaseDate:   carry.purchaseMs != null ? new Date(carry.purchaseMs) : new Date(asOfMs),
    acquisitionPriceLevel:    carry.priceLevel ?? levelNow,
    acquisitionDateByCountry: carry.acquisitionDateByCountry ?? null,
    rateKey,
    label:          `Ladder tail ${maturity.getUTCFullYear()}`,
    dividendYield:  null,
    couponRate,
    appreciationSchedule: null,
    duration:       +ladderTermYears.toFixed(2),
    taxLossPartner: null,
    taxExemption,
    issuingState:   null,
    maturityDate:   maturity,
    faceValue:      addMv,
    rollAtMaturity: roll,
    rollTermYears:  roll ? ladderTermYears : null,
    zeroCoupon:      false,
    inflationLinked: inflationLinked === true,
    // Issued at par today, like every other rung (design 93 §5b).
    ...unitiseBond({ faceValue: addMv, inflationLinked: inflationLinked === true }),
  }];
}

/**
 * Collapse ladder rungs that have become the SAME instrument, so absorption's lot growth
 * has a ceiling (design 93 §5.4 item 3).
 *
 * Absorption opens one rung per year, and nothing else ever merges them: design 61's
 * `_compactSeasonedLots` deliberately touches only the rebalancer's own `reb-` lots — *"an
 * authored scenario lot, a bond ladder rung or a coupon-reinvestment lot is left exactly
 * where it is"* — and that boundary is worth keeping, so the ladder compacts its own.
 *
 * **Why this binds at all, given every absorption rung has a distinct maturity.** It does
 * not merge them when they are created; it merges them after they ROLL. A rung absorbed in
 * year Y matures at Y+N and rolls to Y+2N; a rung absorbed in year Y+N is issued maturing
 * at Y+2N. At that point the two are the same bond — same maturity, same tenor, so the same
 * re-locked coupon, both re-issued at par, and a rolled TIPS has had its index ratio reset
 * to 1. The ceiling is therefore about N lots rather than one per year forever.
 *
 * The mechanics are `LOT_POLICIES.LADDER` in `lot-compaction.js`; what is specific to the
 * ladder is only that per-country bases are SUMMED rather than keyed, because a rebuild's
 * carryover (`ladderCarryover`) legitimately produces rungs differing only in how a
 * step-up was apportioned across them.
 *
 * Exported for direct testing.
 */
export function _compactLadderLots(rungs, asOfMs) {
  return compactLots(rungs, { asOfMs, policy: LOT_POLICIES.LADDER });
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
