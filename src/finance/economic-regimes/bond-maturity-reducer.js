/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY } from '../../simulation-framework/reducers.js';
import { ALLOCATION }         from '../holdings/allocation.js';
import { _syncBalance }       from '../holdings/holding-reducers.js';

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

/**
 * BondMaturityReducer — redeems individual bonds that have reached maturity
 * (design 66 §G4, the §3 fund-vs-individual identity decision made concrete).
 *
 * An *individual bond* is a BOND holding with a non-null `maturityDate`; a bond
 * *fund* (maturityDate null) is perpetual and is never touched here. Fires on
 * every period-advance at PRE_PROCESS + 3 — AFTER BondPriceAdjustReducer
 * (PRE_PROCESS + 2) has run its final pull-to-par mark, so the redeemed price has
 * already converged to par.
 *
 * For each BOND holding whose `maturityDate <= asOf` (asOf = the advancing
 * country's period start), one of two things happens:
 *
 *  - **Redeem to cash (default).** The bond is redeemed at par: the holding is
 *    converted *in place* (same id) to a CASH holding of `marketValue = costBasis
 *    = faceValue` (return of principal). Because Phase-3 bonds are par bonds
 *    (faceValue == acquisition basis), there is no realized capital gain, so no
 *    CGT chain is needed — premium/discount market-discount tax is design 66 §G9,
 *    out of scope. The cash then earns money-market yield (design 60) and is
 *    redeployed by the normal drawdown / rebalance machinery.
 *
 *  - **Roll (opt-in, `rollAtMaturity`).** Instead of redeeming, the bond ROLLS
 *    into a fresh par bond of the same term, re-issued at the then-current market
 *    yield (`effectiveInterestRates[rateKey]`, the G1 lock-in) — a self-sustaining
 *    single-rung ladder. Term is `maturityDate − purchaseDate` (falling back to
 *    the modified `duration`, else 5y, when no purchaseDate is stamped).
 *
 * costBasis is set to faceValue on redemption/roll (par). `state` accounts are
 * scanned generically, so a matured bond in ANY account (brokerage / 401k / IRA /
 * Roth / super / au-stock) is handled with zero per-account wiring — mirroring
 * BondPriceAdjustReducer.
 */
export class BondMaturityReducer extends Reducer {
  static type        = 'BondMaturityReducer';
  static description = 'Redeems matured individual bonds (maturityDate reached) at par to cash, or rolls them into a fresh par bond at the current yield when rollAtMaturity is set.';

  constructor() {
    super('Bond Maturity', PRIORITY.PRE_PROCESS + 3);
    this.reducedActionTypes = ['US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE'];
  }

  reduce(state, action) {
    const cc     = action?.type === 'AU_PERIOD_ADVANCE' ? 'AU' : 'US';
    const asOfMs = state.currentPeriods?.[cc]?.startMs ?? null;
    if (asOfMs == null) return this.newState(state);

    const effectiveRates = state.effectiveInterestRates ?? {};
    const accountUpdates = {};

    for (const key of Object.keys(state)) {
      const account = state[key];
      if (!account || !Array.isArray(account.holdings) || account.holdings.length === 0) continue;

      const hasMatured = account.holdings.some(h => isMatured(h, asOfMs));
      if (!hasMatured) continue;

      const nextHoldings = account.holdings.map(h => isMatured(h, asOfMs) ? redeem(h, asOfMs, effectiveRates) : h);
      accountUpdates[key] = _syncBalance({ ...account, holdings: nextHoldings });
    }

    return this.newState(state, accountUpdates);
  }
}

/** True when a holding is an individual bond that has reached maturity. */
function isMatured(h, asOfMs) {
  if (!h || h.allocation !== ALLOCATION.BOND || h.maturityDate == null) return false;
  const matMs = h.maturityDate instanceof Date ? h.maturityDate.getTime() : new Date(h.maturityDate).getTime();
  return Number.isFinite(matMs) && matMs <= asOfMs;
}

/**
 * Transform a matured bond: roll into a fresh par bond (rollAtMaturity) or redeem
 * at par to a CASH holding (default). `faceValue ?? marketValue` is the par
 * proceeds.
 */
function redeem(h, asOfMs, effectiveRates) {
  const par = h.faceValue ?? h.marketValue ?? 0;

  if (h.rollAtMaturity) {
    const matMs      = h.maturityDate instanceof Date ? h.maturityDate.getTime() : new Date(h.maturityDate).getTime();
    const purchaseMs = h.purchaseDate
      ? (h.purchaseDate instanceof Date ? h.purchaseDate.getTime() : new Date(h.purchaseDate).getTime())
      : null;
    const termMs   = (purchaseMs != null && matMs > purchaseMs)
      ? (matMs - purchaseMs)
      : ((h.duration ?? 5) * YEAR_MS);
    const newCoupon = (h.rateKey != null ? effectiveRates[h.rateKey] : undefined) ?? h.couponRate ?? null;
    return {
      ...h,
      marketValue:  par,
      costBasis:    par,
      couponRate:   newCoupon,           // lock in the current yield at re-issue (G1)
      purchaseDate: new Date(matMs),     // the roll date is the new acquisition date
      maturityDate: new Date(matMs + termMs),
    };
  }

  // Redeem to cash (return of principal). Clear all bond-specific fields so the
  // sleeve is a plain CASH position going forward.
  return {
    ...h,
    allocation:     ALLOCATION.CASH,
    marketValue:    par,
    costBasis:      par,
    purchaseDate:   new Date(asOfMs),
    rateKey:        null,
    couponRate:     null,
    duration:       null,
    maturityDate:   null,
    faceValue:      null,
    rollAtMaturity: false,
    taxExemption:   'none',
    issuingState:   null,
  };
}
