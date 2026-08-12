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
import { resolveYield }       from './yield-curve.js';
import { _syncBalance }       from '../holdings/holding-reducers.js';
import { computeSection988Gain, section988Residence }
  from '../account-rules/loan-classes.js';

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
 *    into a fresh par bond, re-issued at the then-current market yield
 *    (`effectiveInterestRates[rateKey]`, the G1 lock-in). The roll term is:
 *      - `rollTermYears` when set (design 66 §G8) — every rung of a ladder rolls to
 *        the SAME fixed term (the ladder length), so a maturing near rung becomes the
 *        new far rung and the {1,2,…,N} spacing self-perpetuates: a full ladder;
 *      - else `maturityDate − purchaseDate` (the rung's own term) — a self-sustaining
 *        single-rung constant-maturity bond (falling back to the modified `duration`,
 *        else 5y, when no purchaseDate is stamped).
 *    `rollAtMaturity` + `rollTermYears` are preserved on the rolled bond so it keeps
 *    rolling every term.
 *
 * **A ROLL CARRIES ITS COST BASIS.** The par-bond assumption above ("faceValue ==
 * acquisition basis") no longer holds for every bond that reaches here: a ladder rebuild
 * carries the replaced sleeve's basis onto its rungs (design 62 §9.5 follow-up,
 * `ladderCarryover`), so a rung can arrive at maturity with `costBasis != faceValue`.
 * Setting the rolled bond's basis to par would erase that difference — a silent step-up
 * with no disposal, exactly the defect the carryover closed. The roll therefore keeps
 * the maturing bond's basis (and, via the spread, its per-country base and indexation
 * level), which DEFERS the discount/premium to the eventual sale instead of erasing it.
 * The holding-period clock still restarts at the roll, because the rolled bond really is
 * a new instrument. Exact treatment — market discount recognized AT maturity — is design
 * 66 §G9, still out of scope.
 *
 * The redeem-to-cash branch cannot do the same: CASH must carry `costBasis ==
 * marketValue` (design 87 §11), so a below-par basis has nowhere to live and redemption
 * still steps it to par untaxed. Closing that needs an actual disposal event, which is
 * again §G9. A rolling ladder — the only path that can produce a non-par basis today —
 * never reaches it.
 *
 * `state` accounts are scanned generically, so a matured bond in ANY account (brokerage
 * / 401k / IRA / Roth / super / au-stock) is handled with zero per-account wiring —
 * mirroring BondPriceAdjustReducer.
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
    const yieldCurve     = state.yieldCurve ?? {};
    const accountUpdates = {};
    const s988Actions    = [];

    for (const key of Object.keys(state)) {
      const account = state[key];
      if (!account || !Array.isArray(account.holdings) || account.holdings.length === 0) continue;

      const hasMatured = account.holdings.some(h => isMatured(h, asOfMs));
      if (!hasMatured) continue;

      // Design 87 G9 — a foreign-currency bond is a DEBT INSTRUMENT (§988(c)(1)(B)(i)),
      // and its holder realizes ordinary exchange gain or loss on principal when it is
      // redeemed (Reg. §1.988-2(b)(5), the mirror of the (b)(6) obligor rule the
      // mortgage leg uses). Collected before the map so the pre-redemption holding —
      // which still carries `fxBasisRate` — is the one measured.
      for (const h of account.holdings) {
        if (isMatured(h, asOfMs)) s988Actions.push(...section988ForRedemption(state, key, account, h));
      }

      const nextHoldings = account.holdings.map(h => isMatured(h, asOfMs) ? redeem(h, asOfMs, effectiveRates, yieldCurve) : h);
      accountUpdates[key] = _syncBalance({ ...account, holdings: nextHoldings });
    }

    return this.newState(state, accountUpdates, s988Actions);
  }
}

/**
 * §988 on the redemption of a foreign-currency bond — design 87 G9.
 *
 * Only BOND is reached. EQUITY and GOLD are deliberately absent: §988(c)(1)(B) is a
 * closed list (debt instruments, accrued items, forwards/futures/options) and a share
 * is on none of it, so its currency movement stays *inside* the capital gain via §1001
 * translation. Booking a separate §988 item on an equity sleeve would both double-count
 * the move and recharacterise capital gain as ordinary.
 *
 * Measured on the PRINCIPAL received (par), not on market value: Reg. §1.988-2(b)(5)
 * separates the exchange component of principal from the instrument's own price
 * movement, which remains capital.
 *
 * @returns {object[]} zero or one SECTION_988_GAIN action
 */
function section988ForRedemption(state, accountKey, account, holding) {
  if (holding.allocation !== ALLOCATION.BOND) return [];
  if (holding.fxBasisRate == null) return [];
  // Keyed on the ACCOUNT's currency: the bond is denominated in whatever the account
  // is. Super is excluded for the same reason design 87 §5 keeps it out everywhere —
  // a pension interest is its own regime (design 83 Art. 18 / design 84 s99B), and
  // reaching inside it here would conflate two unrelated sets of rules.
  const ccy = account.currency?.code ?? account.currency ?? null;
  if (ccy == null || ccy === 'USD' || account.type === 'super') return [];

  const par = holding.inflationLinked
    ? Math.max(holding.marketValue ?? 0, holding.faceValue ?? 0)
    : (holding.faceValue ?? holding.marketValue ?? 0);
  if (!(par > 0)) return [];

  const spot = state?.effectiveExchangeRates?.USD_AUD ?? 1.55;
  if (!(spot > 0)) return [];

  // A bond held in a taxable account is an investment — §212 — so the §988(e)(3) share
  // is 1 unless the account says otherwise. That is the opposite default from a cash
  // pool, where the balance funds living expenses; the difference is deliberate.
  const frac = account.deductibleFraction ?? 1;
  // Rates TRANSPOSED, because this is the HOLDER of the debt, not the obligor —
  // Reg. §1.988-2(b)(5) vs (b)(6). `computeSection988Gain` is written in the obligor's
  // convention, so passing (acq, spot) here would invert the sign of every redemption.
  // `false`: no §988(e)(2) de minimis. Redeeming a debt instrument returns principal;
  // it is not a disposition of nonfunctional currency. Same reasoning as the mortgage.
  const r = computeSection988Gain(par, spot, holding.fxBasisRate, frac, false);
  if (Math.abs(r.recognized) <= 1e-9 && r.disallowedLoss <= 1e-9) return [];

  return [{
    type: 'SECTION_988_GAIN',
    accountKey, holdingId: holding.id ?? null,
    currency: account.currency?.code ?? account.currency ?? null,
    amount: r.recognized, gross: r.gross,
    disallowedLoss: r.disallowedLoss, deMinimis: r.deMinimis,
    residency: section988Residence(state, account),
  }];
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
function redeem(h, asOfMs, effectiveRates, yieldCurve = {}) {
  // A TIPS redeems at the greater of its inflation-adjusted principal (its accreted
  // marketValue) and the original face — the Treasury deflation floor (design 66
  // §G5). A zero / plain bond redeems at par (faceValue). Falls back to marketValue
  // when no faceValue is stamped.
  const par = h.inflationLinked
    ? Math.max(h.marketValue ?? 0, h.faceValue ?? 0)
    : (h.faceValue ?? h.marketValue ?? 0);

  if (h.rollAtMaturity) {
    const matMs      = h.maturityDate instanceof Date ? h.maturityDate.getTime() : new Date(h.maturityDate).getTime();
    const purchaseMs = h.purchaseDate
      ? (h.purchaseDate instanceof Date ? h.purchaseDate.getTime() : new Date(h.purchaseDate).getTime())
      : null;
    // design 66 §G8 — roll target term. A ladder rung carries `rollTermYears` (the
    // ladder length): every rung rolls into a bond of that SAME fixed term, so a
    // maturing near rung becomes the new far rung and the {1,2,…,N} spacing self-
    // perpetuates. Without it (a lone bond) fall back to the rung's OWN original term
    // (`maturityDate − purchaseDate`) — the back-compatible constant-maturity roll.
    const termMs   = (h.rollTermYears != null)
      ? (h.rollTermYears * YEAR_MS)
      : (purchaseMs != null && matMs > purchaseMs)
        ? (matMs - purchaseMs)
        : ((h.duration ?? 5) * YEAR_MS);
    // design 67 — re-lock at the yield for the ROLL TERM's tenor (not a flat 5y proxy),
    // so a rung rolling into an N-year ladder bond earns the curve's N-year term premium.
    // resolveYield returns null when the anchor is absent ⇒ keep the prior couponRate.
    const rollTenorYears = termMs / YEAR_MS;
    const newCoupon = resolveYield(
      { effectiveInterestRates: effectiveRates, yieldCurve },
      { rateKey: h.rateKey, tenorYears: rollTenorYears },
    ) ?? h.couponRate ?? null;
    return {
      ...h,
      marketValue:  par,
      // Carried, not re-based at par — see the class doc. `?? par` keeps the original
      // behavior for a bond that never carried a basis at all.
      costBasis:    h.costBasis ?? par,
      couponRate:   newCoupon,           // lock in the current yield at re-issue (G1)
      purchaseDate: new Date(matMs),     // the roll date is the new acquisition date
      maturityDate: new Date(matMs + termMs),
      // Roll into a fresh plain (cash-coupon) par bond — an accreting instrument is
      // not re-issued as one (design 66 §G5/§G6).
      zeroCoupon:      false,
      inflationLinked: false,
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
    rollTermYears:  null,
    taxExemption:   'none',
    issuingState:   null,
    zeroCoupon:      false,
    inflationLinked: false,
  };
}
