/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseStateTaxRatesModule } from './base-state-tax-rates-module.js';

/**
 * InflationAdjustedStateTaxRates — a US state's rates module with its bracket
 * thresholds and standard deduction scaled by a cumulative inflation factor.
 *
 * The state analog of `InflationAdjustedUsTaxRates`, and it exists for the same
 * reason: a state module is only registered for the years its legislature has
 * actually published, and a 40-year run spends most of its life past the last one.
 * Without a wrap, Hawaii's 2031 table (the terminal Act 46 step) was applied at
 * fixed nominal thresholds to a nominal income growing at 3% a year, so by the
 * 2050s the household sat in the top bracket on real income it was already paying
 * middle-bracket rates on in 2031 — a pure modelling artefact that showed up as a
 * rising state effective rate with no policy change behind it.
 *
 * ⚠️ This is a PROJECTION CONVENTION, not a transcription of law. Neither Hawaii
 * nor Nebraska indexes its brackets statutorily; under current law the bracket
 * creep above is what would really happen. The framework's convention — already
 * applied to the AU federal brackets, which are equally un-indexed in law — is that
 * beyond the published horizon a legislature keeps thresholds roughly constant in
 * REAL terms, because the alternative silently models 40 years of unlegislated tax
 * increases as if they were policy. Up to and including a published year the table
 * is used exactly as published: the factor is anchored at the module's own year
 * (see `bracketIndexationFactor`), so Act 46's whole 2024→2031 phase-in runs on its
 * statutory figures and only 2032+ is projected.
 *
 * Scaled: bracket thresholds (MFJ + single) and the standard deductions.
 * NOT scaled: the rates themselves, `_capitalGainsAltRate`, and the treatment
 * flags (`_taxesSocialSecurity`, `_pensionExclusionFraction`, `_capitalGainsMode`),
 * none of which are money amounts.
 *
 * @param {BaseStateTaxRatesModule} baseRates        – Published year module to inflate.
 * @param {number}                  cumulativeFactor – Inflation since `baseRates.year`.
 */
export class InflationAdjustedStateTaxRates extends BaseStateTaxRatesModule {
  constructor(baseRates, cumulativeFactor) {
    super();
    this._base = baseRates;

    this.hasIncomeTax = baseRates.hasIncomeTax;

    this._brackets_mfj        = baseRates._brackets_mfj.map(([t, r]) => [t * cumulativeFactor, r]);
    this._brackets_single     = baseRates._brackets_single.map(([t, r]) => [t * cumulativeFactor, r]);
    this._stdDeduction_mfj    = baseRates._stdDeduction_mfj    * cumulativeFactor;
    this._stdDeduction_single = baseRates._stdDeduction_single * cumulativeFactor;

    this._taxesSocialSecurity      = baseRates._taxesSocialSecurity;
    this._pensionExclusionFraction = baseRates._pensionExclusionFraction;
    this._capitalGainsMode         = baseRates._capitalGainsMode;
    this._capitalGainsAltRate      = baseRates._capitalGainsAltRate;

    this._stateCode = baseRates.stateCode;
    this._baseYear  = baseRates.year;
  }

  get stateCode() { return this._stateCode; }
  get year()      { return this._baseYear; }
}
