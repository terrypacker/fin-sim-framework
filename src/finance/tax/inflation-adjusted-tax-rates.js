/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { UsTaxRatesBase } from './us/us-tax-rates-base.js';
import { AuTaxRatesBase } from './au/au-tax-rates-base.js';

/**
 * InflationAdjustedUsTaxRates — US federal tax rates scaled by a cumulative
 * inflation factor.
 *
 * Wraps an existing UsTaxRatesBase instance (e.g. UsTaxRates2025) and scales
 * every bracket threshold and the standard deduction by cumulativeFactor.
 * The result is economically equivalent to the IRS indexing brackets for
 * inflation: the same real income falls into the same or lower marginal rate.
 *
 * @param {UsTaxRatesBase} baseRates       – Base-year rates module to inflate.
 * @param {number}         cumulativeFactor – Product of (1 + annualRate) over
 *                                           all elapsed years (e.g. 1.03^3 ≈ 1.0927).
 */
export class InflationAdjustedUsTaxRates extends UsTaxRatesBase {
  constructor(baseRates, cumulativeFactor) {
    super();
    this._brackets_mfj     = baseRates._brackets_mfj.map(([t, r]) => [t * cumulativeFactor, r]);
    this._ltcg_mfj         = baseRates._ltcg_mfj.map(([t, r]) => [t * cumulativeFactor, r]);
    this._stdDeduction_mfj = baseRates._stdDeduction_mfj * cumulativeFactor;
    this._ficaWageBase     = baseRates._ficaWageBase     * cumulativeFactor;
    this._baseYear         = baseRates.year;
  }

  get year()        { return this._baseYear; }
  get countryCode() { return 'US'; }
}

/**
 * InflationAdjustedAuTaxRates — Australian income tax rates scaled by a
 * cumulative inflation factor.
 *
 * Wraps an existing AuTaxRatesBase instance and scales every bracket threshold
 * and the Medicare levy low-income threshold by cumulativeFactor.
 *
 * @param {AuTaxRatesBase} baseRates       – Base-year rates module to inflate.
 * @param {number}         cumulativeFactor – Cumulative inflation factor.
 */
export class InflationAdjustedAuTaxRates extends AuTaxRatesBase {
  constructor(baseRates, cumulativeFactor) {
    super();
    this._brackets            = baseRates._brackets.map(([t, r]) => [t * cumulativeFactor, r]);
    this._nonResidentBrackets = baseRates._nonResidentBrackets.map(([t, r]) => [t * cumulativeFactor, r]);
    this._medicareLevy = {
      ...baseRates._medicareLevy,
      lowerThreshold: baseRates._medicareLevy.lowerThreshold * cumulativeFactor,
    };
    this._baseYear = baseRates.year;
  }

  get year()        { return this._baseYear; }
  get countryCode() { return 'AU'; }
}
