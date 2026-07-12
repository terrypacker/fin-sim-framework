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
      [        0, 0.325],
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
    const realGain = state != null && 'auRealCapitalGainsYTD' in state
      ? (state.auRealCapitalGainsYTD ?? 0)
      : auCapitalGainsYTD;
    // Age Pension / JobSeeker recipients are exempt from the 30% minimum tax
    // (design 57 §6.6) — they still pay marginal-rate CGT on the real gain, just
    // no floor. auMinTaxExempt is stamped per-person by computeAuTaxPerPerson.
    const minTaxRate = state?.auMinTaxExempt ? 0 : AuTaxRates2027.MIN_CGT_RATE;
    return {
      netTaxableGain: realGain,
      reliefAmount:   auCapitalGainsYTD - realGain,
      minTaxRate,
    };
  }

  _cgtReliefLabel() {
    return 'CGT Discount Removed (FY2027+)';
  }
}
