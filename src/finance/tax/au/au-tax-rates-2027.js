/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { AuTaxRatesBase } from './au-tax-rates-base.js';

/**
 * AuTaxRates2027 — Australian income tax rates for FY 2027-28.
 *
 * year=2027 denotes the financial year starting July 2027 (FY 2027-28).
 *
 * This is the first year of the CGT reform legislated in the 2026-27 Budget
 * (Treasury Laws Amendment (Tax Reform No. 1) Bill 2026; design 57). For CGT
 * events on/after 1 July 2027:
 *
 *   1. The flat 50% Division 115 discount is REMOVED — the full capital gain is
 *      assessable. (Cost-base indexation, which softens this, arrives in design
 *      57 Phase 3; until then the gain is un-indexed.)
 *   2. A 30% minimum effective tax rate (Division 115C) floors the tax
 *      attributable to the net capital gain. `AuTaxRatesBase.computeTax` applies
 *      this incrementally — it tops up only the gain's own marginal tax, so it
 *      has no effect once the taxpayer's marginal rate on the gain reaches 30%.
 *
 * Personal tax cut: the same legislated package lowers the $18,201–$45,000 band
 * from 15% (FY2026-27) to 14% (FY2027-28). [CONFIRM — assumed from the package.]
 *
 * NOT modeled here (design 57): cost-base indexation (Phase 3), the 1 July 2027
 * deemed cost base reset (Phase 4), and the Age Pension / JobSeeker minimum-tax
 * exemption (Phase 4). Non-residents already receive no discount and are
 * unaffected; super keeps its own 15% regime.
 */
export class AuTaxRates2027 extends AuTaxRatesBase {
  get year() { return 2027; }

  /** Minimum effective CGT rate (Division 115C). */
  static MIN_CGT_RATE = 0.30;
  /** s115-100(aa): the discount on a s112-160 deferred gain (design 132). */
  static DEFERRED_GAIN_DISCOUNT = 0.5;

  constructor() {
    super();

    // Resident rates (ATO FY2027-28) — $18,201–$45,000 band cut 15% → 14%.
    this._brackets = [
      [        0, 0.00],
      [   18_200, 0.14],  // 15% → 14% (FY2027-28 legislated personal tax cut)
      [   45_000, 0.30],
      [  135_000, 0.37],
      [  190_000, 0.45],
    ];

    // Non-resident rates — unchanged.
    this._nonResidentBrackets = [
      [        0, 0.30],
      [  135_000, 0.37],
      [  190_000, 0.45],
    ];

    // Medicare levy — thresholds unchanged.
    this._medicareLevy = { rate: 0.02, lowerThreshold: 26_000, phaseInRate: 0.10 };
  }

  /**
   * CGT reform relief: no 50% discount; the assessable gain is the *real
   * (post-indexation) gain* in `state.auRealCapitalGainsYTD`.
   *
   * That bucket is AUTHORITATIVE and read directly — NOT via `?? auCapitalGainsYTD`.
   * Every resident capital-gains classifier populates it in lockstep with the gross
   * bucket: the AU-native AU_STOCK/AU_HOUSE reducers and the US-module cross-border
   * STOCK_WITHDRAWAL_TAX / COMPANY_SALE_TAX / COLLECTIBLE_SALE_TAX reducers
   * (design 57 §6.5). Falling back to the gross gain on a *present zero* would
   * silently tax a gain that was fully indexed away (or is entirely pre-2027) at
   * 100% — the design-57 present-zero trap. So a present real bucket (even 0) wins;
   * only a *truly absent* bucket — a synthetic rate-only state that never ran a
   * classifier — degrades to the gross gain so the rate math still has an input.
   *
   * The reliefAmount shown is the indexation reduction (gross − real). A 30%
   * minimum-tax floor applies to the real gain.
   */
  _cgtRelief(state, auCapitalGainsYTD) {
    const rawReal = state != null && 'auRealCapitalGainsYTD' in state
      ? (state.auRealCapitalGainsYTD ?? 0)
      : auCapitalGainsYTD;
    const realGain = _assertIndexationPartition(state, auCapitalGainsYTD, rawReal);
    // Age Pension / JobSeeker recipients are exempt from the 30% minimum tax
    // (design 57 §6.6) — they still pay marginal-rate CGT on the real gain, just
    // no floor. auMinTaxExempt is stamped per-person by computeAuTaxPerPerson.
    const minTaxRate = state?.auMinTaxExempt ? 0 : AuTaxRates2027.MIN_CGT_RATE;
    if (state?.auDeferredCapitalGainsYTD == null) {
      return {
        netTaxableGain: realGain,
        reliefAmount:   auCapitalGainsYTD - realGain,
        minTaxRate,
      };
    }
    // Design 132 — a lot held across 1 July 2027 adds its s112-160 deferred gain: a
    // discount capital gain at 50% (s115-100(aa)) on its eligible part, never indexed,
    // and NOT a minimum tax capital gain (s119-5(2) covers only residential and
    // non-residential gains; s102-6(5) makes this one deferred). Already netted for
    // losses by `_applyCapitalLosses` below.
    const deferred     = Math.max(0, state.auDeferredCapitalGainsYTD ?? 0);
    const deferredDisc = Math.min(deferred, Math.max(0, state.auDeferredDiscountableGainsYTD ?? 0));
    const deferredTaxable = deferred - deferredDisc * AuTaxRates2027.DEFERRED_GAIN_DISCOUNT;
    const netTaxableGain  = realGain + deferredTaxable;
    return {
      netTaxableGain,
      reliefAmount: auCapitalGainsYTD + deferred - netTaxableGain,
      minTaxRate,
      minTaxBase:   realGain,
    };
  }

  /**
   * s102-5(1) Steps 1–2 once the year can hold a s112-160 deferred gain (design 132).
   *
   * Step 1's order is the Act's, not a choice: capital losses reduce DEFERRED
   * non-residential gains first, then deferred residential, then non-residential, then
   * residential. Note 3's choice applies only WITHIN a category, so inside the deferred
   * gain the non-discountable part goes first (the parent's design 90 §5.3 rule). The
   * prior-year pool follows the same order (Step 2). The post-2027 gain is reduced at
   * face value on both its nominal and its real measure, as the parent does for the
   * prior-year pool.
   *
   * A year with no deferred gain takes the parent's path unchanged.
   */
  _applyCapitalLosses(state) {
    if (state?.auDeferredCapitalGainsYTD == null) return super._applyCapitalLosses(state);
    const opening = Math.max(0, state?.auCapitalLossPool ?? 0);
    const D   = state.auDeferredCapitalGainsYTD ?? 0;
    const Dd0 = Math.min(Math.max(0, D), Math.max(0, state.auDeferredDiscountableGainsYTD ?? 0));
    const Dn0 = D - Dd0;                                    // signed: a deferred loss lands here
    const P0  = state.auCapitalGainsYTD ?? 0;               // post-2027 nominal, signed
    const R0  = 'auRealCapitalGainsYTD' in state ? (state.auRealCapitalGainsYTD ?? 0) : P0;

    const currentYearLosses = Math.max(0, -Dn0) + Math.max(0, -P0);
    let dn = Math.max(0, Dn0), dd = Dd0, p = Math.max(0, P0), r = Math.max(0, R0);
    const take = (pool) => {
      let left = pool;
      const a = Math.min(left, dn); left -= a; dn -= a;
      const b = Math.min(left, dd); left -= b; dd -= b;
      const c = Math.min(left, p);  left -= c; p  -= c; r = Math.max(0, r - c);
      return { left, applied: a + b + c, other: a + c, discountable: b };
    };
    const cy = take(currentYearLosses);
    const py = take(opening);
    const deferredNet = dn + dd;
    return {
      total:        +p.toFixed(2),
      discountable: 0,
      real:         +r.toFixed(2),
      apportionedBase: 0, apportionedAllowance: 0,
      deferred:             +deferredNet.toFixed(2),
      deferredDiscountable: +dd.toFixed(2),
      opening,
      applied: +(cy.applied + py.applied).toFixed(2),
      closing: +(cy.left + py.left).toFixed(2),
      steps: {
        grossDiscountable: +Dd0.toFixed(2),
        grossOther:        +(Math.max(0, Dn0) + Math.max(0, P0)).toFixed(2),
        currentYear: {
          losses: +currentYearLosses.toFixed(2),
          appliedOther:        +cy.other.toFixed(2),
          appliedDiscountable: +cy.discountable.toFixed(2),
          applied: +cy.applied.toFixed(2),
          unapplied: +cy.left.toFixed(2),
        },
        priorYear: {
          opening,
          appliedOther:        +py.other.toFixed(2),
          appliedDiscountable: +py.discountable.toFixed(2),
          applied: +py.applied.toFixed(2),
          unapplied: +py.left.toFixed(2),
        },
      },
    };
  }

  _cgtReliefLabel() {
    return 'CGT Discount Removed (FY2027+)';
  }
}

/** Tolerance for the indexation partition invariant, in AUD. Float noise only. */
const INDEXATION_INVARIANT_EPSILON = 0.01;

/**
 * True in dev/test, false in a production build — mirrors `_ftcStrict` in
 * us-tax-rates-base.js and `AU_ATTRIBUTION_STRICT` in tax-settle-service.js. A real
 * bucket that outgrew its nominal one is a classifier bug being introduced right now
 * and is worth failing on at the point of introduction; a user's run should survive it.
 */
function _indexationStrict() {
  try {
    if (typeof process !== 'undefined' && process.env) {
      if (process.env.AU_INDEXATION_STRICT === 'off') return false;
      if (process.env.AU_INDEXATION_STRICT === 'on')  return true;
      if (process.env.NODE_ENV === 'production') return false;
    }
  } catch { /* no process (browser) */ }
  try {
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.PROD) return false;
  } catch { /* import.meta.env absent */ }
  return true;
}

/**
 * **The real gain is a slice of the nominal gain, never more than all of it.**
 *
 * `auRealCapitalGainsYTD` is the same disposals as `auCapitalGainsYTD`, measured
 * against a cost base that indexation can only ever RAISE (Div 114 / design 57 Part 3),
 * so `real ≤ nominal` for every item and therefore for the sum. `reliefAmount` is
 * `nominal − real`; when the invariant breaks, that difference goes negative and the
 * return prints an indexation *relief* that ADDS assessable income — the au-house-sale
 * F5 finding, where the collectible classifier booked the US-measured gain into the
 * nominal bucket while the FY2027 module booked the AU-measured indexed gain into the
 * real one, so the two buckets were partitions of different quantities.
 *
 * **Not enforced on the FITO counterfactual** (`_fitoCounterfactual`, stamped by
 * `computeTax`). That pass subtracts `usSourceCapGainsAudYTD` from one bucket and
 * `usSourceRealCapGainsAudYTD` from the other; when a classifier fails to stamp the
 * real slice, the counterfactual's real bucket stays whole while its nominal one
 * empties, and the FITO limit's CG component collapses to ~0. That collapse is a
 * DETECTOR, not a defect to repair — it is what `tax-cross-border-relief.test.mjs`
 * FITO-D exists to observe, and what the `_applyCapitalLosses` comment on the real
 * bucket refuses to paper over for the same reason. Clamping there would hide the
 * missing signal; nothing on an actual return is computed from that pass anyway.
 *
 * Both figures reach here already netted for capital losses and floored at zero by
 * `_applyCapitalLosses`, so a negative nominal gain is not a case that arises.
 *
 * Returns the gain to assess: the real one, clamped to the nominal. Clamping is the
 * conservative repair — it makes the relief exactly zero rather than negative — and it
 * keeps the return footing (`Gross Gains − Relief = Net Taxable Gain`) when the strict
 * gate is off.
 */
function _assertIndexationPartition(state, nominalGain, realGain) {
  if (!(realGain > nominalGain + INDEXATION_INVARIANT_EPSILON)) return realGain;
  if (state?._fitoCounterfactual) return realGain;

  const message =
      `FY2027+ indexation partition violated — the real (indexed) capital gain `
    + `${realGain.toFixed(2)} exceeds the nominal gain ${nominalGain.toFixed(2)} it is a `
    + `slice of, by ${(realGain - nominalGain).toFixed(2)}. Indexation raises the cost `
    + `base, so it can only ever REDUCE a gain; a negative reliefAmount would print on `
    + `the return as relief that adds assessable income. Some disposal classifier is `
    + `measuring auRealCapitalGainsYTD on a different basis (or in a different currency) `
    + `from the auCapitalGainsYTD it booked alongside it — design 57 §6.5 requires the `
    + `two to be stamped in lockstep, per disposal. `
    + `US-source slices: nominal ${(state?.usSourceCapGainsAudYTD ?? 0).toFixed(2)}, `
    + `real ${(state?.usSourceRealCapGainsAudYTD ?? 0).toFixed(2)}.`;
  if (_indexationStrict()) throw new Error(message);
  console.warn(message);
  return nominalGain;
}
