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
import { RATE_KEY_META }      from './rate-keys.js';
import { interpolateSpread, countryOfRateKey } from './yield-curve.js';
import { _syncBalance }       from '../holdings/holding-reducers.js';
import { revalueLedger }     from '../assets/investment-account.js';
import { reprice, instrumentOf } from '../holdings/holding-utils.js';

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

/**
 * Years from `asOfMs` to a holding's maturity (design 66 §G4). Returns null when
 * the holding is a bond *fund* (no `maturityDate`) or the as-of date is unknown,
 * in which case the caller keeps the perpetual-fund behavior. Floored at 0 (a bond
 * at/after maturity has 0 years left — BondMaturityReducer redeems it).
 *
 * Takes the INSTRUMENT view (design 94 §5.1): a maturity date is a fact about the bond.
 *
 * @param {object} inst     - instrument view of a holding (`instrumentOf`)
 * @param {number|null} asOfMs
 * @returns {number|null}
 */
function yearsToMaturity(inst, asOfMs) {
  if (inst?.maturityDate == null || asOfMs == null) return null;
  const matMs = inst.maturityDate instanceof Date ? inst.maturityDate.getTime() : new Date(inst.maturityDate).getTime();
  if (!Number.isFinite(matMs)) return null;
  return Math.max(0, (matMs - asOfMs) / YEAR_MS);
}

/**
 * BondPriceAdjustReducer — marks BOND-allocation holdings to market on each
 * period-advance (design 28 §5, extended by design 66 §G4).
 *
 * Fires at PRE_PROCESS + 2 (12) — after RegimeApplyReducer (PRE_PROCESS + 1 = 11)
 * has written the new effective rates, before coupon-income handlers compute
 * earnings off the adjusted price, and before BondMaturityReducer (PRE_PROCESS + 3)
 * redeems anything that has matured.
 *
 * Two effects per BOND holding, in order:
 *
 *  1. Rate-sensitivity mark (design 28 §5). Using an *effective* duration
 *       effDuration = min(staticDuration, yearsToMaturity)   [individual bond]
 *                   = staticDuration                          [fund]
 *     where staticDuration = holding.duration ?? RATE_KEY_META[rateKey].defaultDuration ?? 0,
 *     it applies
 *       Δprice      = -effDuration × (curRate − priorRate) × marketValue.
 *     For an individual bond (`maturityDate != null`) the duration decays toward 0
 *     as maturity approaches, so a late-life rate move barely moves the price —
 *     the bond "pulls to par" (design 66 §G4). A fund keeps its static duration
 *     (perpetual, today's exact behavior).
 *
 *  2. Pull-to-par convergence (individual bond only). Independent of any rate
 *     move, the price amortizes toward `faceValue` over the remaining life:
 *       frac        = Δt / (ttm + Δt)          (Δt = years since the prior mark)
 *       marketValue += (faceValue − marketValue) × frac.
 *     As ttm → 0 the fraction → 1, so a rate-driven markdown fully recovers to par
 *     by maturity — the correctness gap a static-duration fund can never close.
 *
 * On the first period, priorMarkRates is empty (Δrate = 0) and priorMarkMs is
 * unset (Δt skipped), so both effects are no-ops. costBasis is never adjusted
 * (mark-to-market only; design 28 §13 Q4). Maintains `state.priorMarkRates` and
 * `state.priorMarkMs` as the after-mark snapshot for next period's deltas.
 */
export class BondPriceAdjustReducer extends Reducer {
  static type        = 'BondPriceAdjustReducer';
  static description = 'Marks BOND holdings to market using modified duration and the period-over-period interest-rate delta; individual bonds (maturityDate) decay duration and pull to par.';

  constructor() {
    super('Bond Price Adjust', PRIORITY.PRE_PROCESS + 2);
    this.reducedActionTypes = ['US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE'];
  }

  reduce(state, action) {
    const effectiveRates = state.effectiveInterestRates ?? {};
    const priorRates     = state.priorMarkRates         ?? {};
    // Curve SHAPE overlay (design 67): the bond's own-tenor yield is level + spread.
    // priorMarkCurve is the after-mark shape snapshot (symmetric with priorMarkRates),
    // so a curve TWIST between periods marks a 2y and a 30y bond differently. Absent
    // shape ⇒ interpolateSpread returns 0 everywhere ⇒ identical to the flat model.
    const yieldCurve     = state.yieldCurve             ?? {};
    const priorCurve     = state.priorMarkCurve         ?? {};
    const cc     = action?.type === 'AU_PERIOD_ADVANCE' ? 'AU' : 'US';
    const asOfMs = state.currentPeriods?.[cc]?.startMs ?? null;
    const priorMs = state.priorMarkMs ?? null;
    // Years since the prior mark; drives pull-to-par amortization. null/≤0 (first
    // period, or no as-of date) ⇒ no convergence this period.
    const dt = (asOfMs != null && priorMs != null) ? (asOfMs - priorMs) / YEAR_MS : 0;

    const accountUpdates = {};
    const securities = state.securities ?? null;

    for (const key of Object.keys(state)) {
      const account = state[key];
      if (!account || !Array.isArray(account.holdings) || account.holdings.length === 0) continue;

      const hasBond = account.holdings.some(h => h?.allocation === ALLOCATION.BOND);
      if (!hasBond) continue;

      let holdingsTouched = false;
      const nextHoldings = account.holdings.map(h => {
        if (!h || h.allocation !== ALLOCATION.BOND) return h;

        const inst = instrumentOf(h, securities);
        const ttm  = yearsToMaturity(inst, asOfMs);    // null ⇒ fund
        let mv = h.marketValue ?? 0;
        let touched = false;

        // (1) Rate-sensitivity mark, with maturity-decayed effective duration.
        if (inst.rateKey) {
          const staticDuration = inst.duration ?? RATE_KEY_META[inst.rateKey]?.defaultDuration ?? 0;
          const effDuration = ttm != null ? Math.min(staticDuration, ttm) : staticDuration;
          if (effDuration > 0) {
            // Curve lookup point: the bond's own tenor (ttm), or the fund tenor
            // (defaultDuration, ≈ the 5y anchor) for a perpetual fund. The curve
            // COUNTRY comes from the holding's own rateKey (independent US/AU curves),
            // not the action's period country.
            const curveCC   = countryOfRateKey(inst.rateKey);
            const fundTenor = RATE_KEY_META[inst.rateKey]?.defaultDuration ?? 0;
            const tenor     = ttm != null ? ttm : fundTenor;
            const curRate   = (effectiveRates[inst.rateKey] ?? 0) + interpolateSpread(yieldCurve[curveCC], tenor);
            const prevBase  = priorRates[inst.rateKey];
            const prevRate  = prevBase != null
              ? prevBase + interpolateSpread(priorCurve[curveCC], tenor)
              : curRate;   // first mark (no prior) ⇒ Δrate 0
            const deltaRate = curRate - prevRate;
            const delta = +(-(effDuration * deltaRate * mv)).toFixed(2);
            if (delta !== 0) { mv = Math.max(0, mv + delta); touched = true; }
          }
        }

        // (2) Pull-to-par convergence (individual bond only, price → faceValue).
        // Accreting bonds (zero-coupon/OID and TIPS, design 66 §G5/§G6) are EXCLUDED:
        // their principal trajectory is owned by the accretion stream
        // (BondAccretionHandler) — a zero accretes to par via constant-yield OID, and
        // a TIPS indexes to CPI (redeeming at the adjusted principal, not the original
        // face) — so a fixed-face pull-to-par here would double-count / fight it. The
        // rate-sensitivity mark (1) above still applies to both.
        if (ttm != null && h.faceValue != null && dt > 0 && !inst.zeroCoupon && !inst.inflationLinked) {
          const frac  = ttm > 0 ? dt / (ttm + dt) : 1;   // ttm 0 ⇒ snap to par
          const delta = +((h.faceValue - mv) * frac).toFixed(2);
          if (delta !== 0) { mv = Math.max(0, mv + delta); touched = true; }
        }

        if (!touched) return h;
        holdingsTouched = true;
        // Both effects above are PRICE, not units: par is right to stand still, and
        // `reprice` is what says so out loud (design 93 §4).
        return reprice(h, mv);
      });

      if (holdingsTouched) {
        const synced = _syncBalance({ ...account, holdings: nextHoldings });
        // A rate mark is a pure revaluation — no cash crosses the account boundary —
        // so it must move the contribution/earnings ledger too (design 84 G8). Same
        // defect as the shock path, found while fixing it: a bond sleeve inside a
        // Roth/IRA/super was marking to market while the ledger stood still.
        const ledger = revalueLedger(account, account.balance ?? 0, synced.balance ?? 0);
        accountUpdates[key] = ledger ? { ...synced, ...ledger } : synced;
      }
    }

    return this.newState(state, {
      ...accountUpdates,
      priorMarkRates: { ...effectiveRates },
      // After-mark shape snapshot for next period's twist delta (design 67). Static
      // in Phases 1–2, so priorCurve == yieldCurve and (1) reduces to the level delta.
      priorMarkCurve: { ...yieldCurve },
      // Only advance the mark timestamp when we actually have an as-of date; unit
      // tests that drive the reducer without currentPeriods keep priorMarkMs unset.
      ...(asOfMs != null ? { priorMarkMs: asOfMs } : {}),
    });
  }
}
