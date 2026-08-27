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
import { section988ForRedemption } from '../account-rules/bond-currency-basis.js';
import { unitiseBond, indexedRedemptionValue, instrumentOf } from '../holdings/holding-utils.js';

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
    const securities     = state.securities ?? null;

    for (const key of Object.keys(state)) {
      const account = state[key];
      if (!account || !Array.isArray(account.holdings) || account.holdings.length === 0) continue;

      const hasMatured = account.holdings.some(h => isMatured(h, instrumentOf(h, securities), asOfMs));
      if (!hasMatured) continue;

      // Design 87 G9 — a foreign-currency bond is a DEBT INSTRUMENT (§988(c)(1)(B)(i)),
      // and its holder realizes ordinary exchange gain or loss on principal when it is
      // redeemed (Reg. §1.988-2(b)(5), the mirror of the (b)(6) obligor rule the
      // mortgage leg uses). Collected before the map so the pre-redemption holding —
      // which still carries `fxBasisRate` — is the one measured.
      for (const h of account.holdings) {
        if (isMatured(h, instrumentOf(h, securities), asOfMs)) {
          s988Actions.push(...section988ForRedemption(state, key, account, h, asOfMs));
        }
      }

      // The spot the redeemed principal is translated at — and therefore the rate at
      // which a ROLL re-acquires. Passed in rather than read inside `redeem` so the
      // realization above and the re-stamp below cannot use different rates.
      const spot = state.effectiveExchangeRates?.USD_AUD ?? null;
      const nextHoldings = account.holdings.map(h => {
        const inst = instrumentOf(h, securities);
        return isMatured(h, inst, asOfMs)
          ? redeem(h, inst, asOfMs, effectiveRates, yieldCurve, spot, securities)
          : h;
      });
      accountUpdates[key] = _syncBalance({ ...account, holdings: nextHoldings });
    }

    return this.newState(state, accountUpdates, s988Actions);
  }
}

/**
 * True when a holding is an individual bond that has reached maturity.
 *
 * `allocation` is the POSITION's and `maturityDate` is the INSTRUMENT's (design 94 §5.1),
 * so both have to be passed — the split runs right through this two-line predicate.
 */
function isMatured(h, inst, asOfMs) {
  if (!h || h.allocation !== ALLOCATION.BOND || inst?.maturityDate == null) return false;
  const matMs = inst.maturityDate instanceof Date ? inst.maturityDate.getTime() : new Date(inst.maturityDate).getTime();
  return Number.isFinite(matMs) && matMs <= asOfMs;
}

/**
 * Transform a matured bond: roll into a fresh par bond (rollAtMaturity) or redeem
 * at par to a CASH holding (default). `faceValue ?? marketValue` is the par
 * proceeds.
 */
function redeem(h, inst, asOfMs, effectiveRates, yieldCurve = {}, spot = null, securities = null) {
  // A TIPS redeems at the greater of its inflation-adjusted principal (its accreted
  // marketValue) and the original face — the Treasury deflation floor (design 66
  // §G5). A zero / plain bond redeems at par (faceValue). Falls back to marketValue
  // when no faceValue is stamped.
  // A position that holds NOTHING redeems for nothing, whatever par it still claims.
  // `faceValue` is a parallel field that not every value-move path maintains, so a rung
  // drained to zero market value (a cross-border transfer sweeping the account, say) can
  // reach maturity still carrying its original par. Redeeming that par — especially
  // through the TIPS deflation floor below, which takes the MAXIMUM — mints money from a
  // position with no units in it, and `rollAtMaturity` then compounds the invention:
  // measured at $556,636 conjured across 14 empty rungs, and gross income of 1e+66 by the
  // end of the run. The floor protects the original principal of units still held; it is
  // not a claim on units already spent.
  // par-reviewed: clears a drained lot. Sets BOTH marketValue and faceValue to 0, so par
  // cannot survive units that are gone - this IS the fix, not a bypass of it. Under the
  // unitised representation (design 93 §5b) the same statement is `units: 0`, and both
  // are written so the derived and stored views agree.
  if ((h.marketValue ?? 0) <= 0.005) {
    return { ...h, marketValue: 0, faceValue: 0, ...(h.units != null ? { units: 0 } : {}) };
  }

  // design 93 §5.3 — the live bug, fixed by the representation rather than by a patch.
  //
  // A TIPS used to redeem at `max(marketValue, faceValue)`. Its `marketValue` carries
  // accumulated rate marks, and TIPS are deliberately excluded from pull-to-par (design
  // 66 §G5), so those marks NEVER wash out: the instrument redeemed for its indexed
  // principal plus whatever rate noise happened to be sitting in its price. It also
  // overloaded `faceValue` — "redemption amount" for a nominal bond, "deflation floor"
  // for a TIPS — which is defect #8.
  //
  // Under units the principal is tracked explicitly (`parPerUnit x cpiIndexRatio`) and
  // the floor compares two quantities that are both par-like. Market price does not
  // appear. `indexedRedemptionValue` returns null for a scalar holding, which keeps the
  // old expression for a bond that was never promoted — a UI preview, a unit test —
  // rather than silently redeeming it at un-indexed par.
  const par = indexedRedemptionValue(h, securities) ?? (inst.inflationLinked
    ? Math.max(h.marketValue ?? 0, h.faceValue ?? 0)
    : (h.faceValue ?? h.marketValue ?? 0));

  if (h.rollAtMaturity) {
    // A LONE inflation-linked bond re-issues as a plain par bond (`rollsAsTips` below), so
    // its index ratio has to go with the instrument it belonged to. Carrying it through the
    // spread would park a stale 1.2 on a nominal bond — inert today, because
    // `indexedRedemptionValue` reads it only when `inflationLinked`, and exactly the kind
    // of field that stops being inert when someone later reads it. Dropped rather than
    // nulled, so a bond that never had one does not gain a key (design 93 §5a).
    const { cpiIndexRatio: _stale, ...rolling } = h;
    const matMs      = inst.maturityDate instanceof Date ? inst.maturityDate.getTime() : new Date(inst.maturityDate).getTime();
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
        : ((inst.duration ?? 5) * YEAR_MS);
    // design 67 — re-lock at the yield for the ROLL TERM's tenor (not a flat 5y proxy),
    // so a rung rolling into an N-year ladder bond earns the curve's N-year term premium.
    // resolveYield returns null when the anchor is absent ⇒ keep the prior couponRate.
    const rollTenorYears = termMs / YEAR_MS;
    // A LADDER rung (design 66 §G8 — `rollTermYears` set) that is inflation-linked rolls
    // into another TIPS. A TIPS ladder whose rungs came back as nominal bonds would stop
    // being a TIPS ladder within one ladder length — the opposite of §10.3's "the ladder
    // self-perpetuates" — and it is not what the instrument means. A LONE inflation-linked
    // bond keeps the pre-existing behavior (roll into a plain par bond), which is what the
    // §G5 note below is about.
    const rollsAsTips = inst.inflationLinked === true && h.rollTermYears != null;
    // A rolling TIPS re-issues at the CONTRACTED REAL yield it already carries. The engine
    // models a nominal curve only (design 67), so `resolveYield` would hand a TIPS the
    // NOMINAL yield and pay it on a principal that also indexes to CPI — compensating for
    // inflation twice. Holding the real yield flat is the neutral assumption in the absence
    // of a real-yield curve, and it is what makes a TIPS ladder the risk-free leg it is
    // supposed to be.
    const newCoupon = rollsAsTips
      ? (inst.couponRate ?? null)
      : (resolveYield(
          { effectiveInterestRates: effectiveRates, yieldCurve },
          { rateKey: inst.rateKey, tenorYears: rollTenorYears },
        ) ?? inst.couponRate ?? null);
    // par-reviewed: the ROLL issues a different instrument: new maturity, new purchase date,
    // re-locked coupon and (for a TIPS) a re-faced par. No ratio on the old position
    // describes that.
    return {
      ...rolling,
      marketValue:  par,
      // The new bond is issued at what was actually redeemed. For a nominal bond that is
      // `faceValue` already; for a TIPS it is the INDEXED principal, so the face has to
      // move with it or the next redemption's deflation floor would be measured against a
      // decades-stale original face.
      ...(rollsAsTips ? { faceValue: par } : {}),
      // design 93 §5b — the roll IS a purchase (the class doc says so, and design 87 G9
      // re-stamps the §988 basis on exactly that reasoning), so it re-issues at par: a
      // fresh unit count against a fresh `cpiIndexRatio` of 1. That is what retires the
      // TIPS ratchet at the source rather than repairing the face afterwards — the
      // indexation earned by the OLD units was realized at redemption and is now
      // principal, so the new units start un-indexed.
      ...(h.units != null
        ? unitiseBond({ faceValue: par, inflationLinked: rollsAsTips })
        : {}),
      // Carried, not re-based at par — see the class doc. `?? par` keeps the original
      // behavior for a bond that never carried a basis at all.
      costBasis:    h.costBasis ?? par,
      couponRate:   newCoupon,           // lock in the current yield at re-issue (G1)
      purchaseDate: new Date(matMs),     // the roll date is the new acquisition date
      maturityDate: new Date(matMs + termMs),
      // Roll into a fresh plain (cash-coupon) par bond — a LONE accreting instrument is
      // not re-issued as one (design 66 §G5/§G6). A ladder rung is the exception: see
      // `rollsAsTips` above. Zeros are never re-issued as zeros either way, because a
      // fresh zero would have to be priced at a discount and the roll issues at par.
      zeroCoupon:      false,
      inflationLinked: rollsAsTips,
      // Design 87 G9 — RE-STAMP the §988 basis at the roll rate. `Reg. §1.988-2(b)(5)`
      // makes an instrument's principal amount "the holder's purchase price in units of
      // nonfunctional currency", and the roll IS a purchase: the matured principal was
      // just realized above, and these units buy a different instrument at today's spot.
      // Carrying the old rate through `...h` would measure the next redemption against a
      // rate that never applied to the new bond and recognize the same currency movement
      // twice — the exact defect `blendSection988BookingRate` exists to prevent on the
      // debt leg. `?? h.fxBasisRate` keeps an authored rate alive when no spot is
      // available rather than silently discarding basis.
      fxBasisRate:     h.fxBasisRate == null ? null : (spot > 0 ? spot : h.fxBasisRate),
    };
  }

  // Redeem to cash (return of principal). Clear all bond-specific fields so the
  // sleeve is a plain CASH position going forward.
  //
  // design 93 §5b — the unit fields are DROPPED rather than nulled. CASH is a scalar
  // sleeve (§6.2 mode 2), and leaving a unit count behind would let `syncHolding`
  // re-derive a cash balance from a bond's units for the rest of the run. Dropping (not
  // `: null`) because §5a's fields are assigned only when present: writing explicit nulls
  // would put four new keys on every redeemed sleeve in every fixture.
  const { units: _u, parPerUnit: _p, pricePerUnit: _pp, cpiIndexRatio: _cpi, ...scalar } = h;
  // par-reviewed: redemption to CASH changes the allocation and clears every bond field
  // including faceValue, so there is no par left to desynchronise.
  return {
    ...scalar,
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
    // Design 87 G9/§11 — the §988 position closed when the principal was realized above,
    // and a CASH sleeve has no per-holding currency basis at all: a cash pool's basis
    // lives on the ACCOUNT (`fxBasisRate` / `fxBasisUsd`, maintained by the lot observer).
    // Leaving a stale per-holding rate here would be a second, contradictory basis for the
    // same money — [[cash-sleeve-has-no-capital-gain]] one field over.
    fxBasisRate:     null,
    zeroCoupon:      false,
    inflationLinked: false,
  };
}
