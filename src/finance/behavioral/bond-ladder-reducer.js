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
 * Value is conserved (Σ rung faceValue == the laddered bond value; par bonds ⇒
 * basis = face, no realized gain). The reducer is ADDED only when the BOND_LADDER
 * behavioral strategy is selected, so an un-selecting scenario (the golden) never
 * constructs it and is byte-identical.
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
   */
  constructor({ stateKey, country = 'US', targetRungs = 5, spacingYears = 1,
                roll = true, taxExemption = 'state' } = {}) {
    super('Bond Ladder', PRIORITY.PRE_PROCESS + 5); // after maturity (+3) and rebalance detect (+4)
    this.reducedActionTypes = ['US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE'];
    this.stateKey     = stateKey;
    this.country      = country;
    this.targetRungs  = targetRungs;
    this.spacingYears = spacingYears;
    this.roll         = roll;
    this.taxExemption = taxExemption;
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

    // Already laddered at this length ⇒ let the Phase-A roll self-maintain it. This
    // makes the reducer fire the (re)materialization exactly once at bootstrap and
    // once per lever change, not every period (no journal churn, no basis reset drift).
    if (account._bondLadderRungs === N) return this.newState(state);

    const rateKey = resolveRateKey(this.country === 'AU' ? 'AU' : 'US', ALLOCATION.BOND, null);
    const rungs   = materializeLadder({
      bondValue, rungs: N, spacingYears: this.spacingYears ?? 1, asOfMs,
      roll: this.roll !== false, taxExemption: this.taxExemption ?? 'state',
      stateKey: this.stateKey, rateKey,
      couponRate: (rateKey != null ? state.effectiveInterestRates?.[rateKey] : null) ?? null,
      // design 67 — price each rung along the yield curve at ITS OWN tenor, so a
      // freshly built ladder earns the term premium (flat curve ⇒ every rung == anchor).
      couponForTenor: (tenorYears) => resolveYield(state, { rateKey, tenorYears }),
      // The AU CPI level is the indexation base wherever the ladder lives — only AU
      // indexes a cost base, so the level is read from AU regardless of this.country.
      priceLevel: state.cpiAccumulator?.AU ?? state.inflationAccumulator?.AU ?? 1,
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
 */
export function materializeLadder({ bondValue, rungs, spacingYears = 1, asOfMs,
                                    roll = true, taxExemption = 'state',
                                    stateKey = 'ladder', rateKey = null, couponRate = null,
                                    couponForTenor = null, priceLevel = null }) {
  const n        = Math.max(1, Math.round(rungs));
  const spacing  = spacingYears > 0 ? spacingYears : 1;
  const ladderTermYears = +(n * spacing).toFixed(4);
  const baseFace = Math.floor((bondValue / n) * 100) / 100; // truncated so the remainder is positive
  const now      = new Date(asOfMs);

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
      costBasis:      face,
      costBaseByCountry: null,
      purchaseDate:   now,
      // AU indexation base at THIS rung's acquisition (design 57 §6.3 / design 62 §9.5).
      // Null on the UI builder path, which has no simulation state to read a CPI level
      // from — that keeps the pre-existing "never indexed" behavior for authored ladders.
      acquisitionPriceLevel: priceLevel,
      acquisitionDateByCountry: null,
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
      inflationLinked: false,
    });
  }
  return out;
}
