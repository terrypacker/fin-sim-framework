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
 * The statutory-amount projection series. One per group of figures that a real
 * authority indexes on its OWN schedule, because collapsing any two of them means a
 * scenario cannot express a change to one without silently making the same change to
 * the other.
 *
 *   US        — federal brackets, LTCG breakpoints, standard deduction (§1(f), C-CPI-U)
 *   US_STATE  — state brackets and deductions. States file on the US calendar year but
 *               legislate their own schedules; neither HI nor NE indexes at all.
 *   US_FICA   — the §3121(a)(1) contribution and benefit base. Moves with the SSA
 *               AVERAGE WAGE INDEX, not with prices: it has historically outrun CPI by
 *               roughly the economy's real wage growth, so a run wanting fidelity sets
 *               a small positive spread here and nowhere else.
 *   US_FEIE   — the §911 foreign earned income exclusion cap. Indexed to the same
 *               chained CPI as the brackets, but a DIFFERENT act of Congress: freezing
 *               the brackets to model bracket creep must not silently freeze the FEIE.
 *   AU        — AU resident/non-resident brackets and the Medicare levy threshold.
 */
export const BRACKET_INDEX_SERIES = Object.freeze({
  US: 'US', AU: 'AU', US_STATE: 'US_STATE', US_FICA: 'US_FICA', US_FEIE: 'US_FEIE',
});

/**
 * How much to index a PUBLISHED rates table by: the bracket-index level now, divided
 * by the level in the table's own year.
 *
 * Two things are load-bearing here.
 *
 * **The anchor.** `bracketIndexAccumulator` is 1.0 at SIM START, so using it directly
 * indexes a published table for every year between the sim's first year and the
 * table's — indexation the authority already baked into the figures it published. For
 * the US that was coincidentally harmless (the newest table, 2026, IS the sim's usual
 * first year), but Australia registers tables out to FY2027-28 while an AU period
 * commonly starts at FY2025-26, so the statutory FY2026-27 and FY2027-28 tables were
 * being inflated on top of their own indexation — and the offset never washed out,
 * leaving every later year on a 2027 table pre-inflated by two extra years. Same class
 * of anchor bug `limitIndexAccumulator` fixes for contribution caps.
 *
 * **The series.** Projecting a table past its published horizon means ASSUMING how
 * thresholds move, and outside the US that assumption is not law — neither the AU
 * federal brackets nor Hawaii's or Nebraska's are statutorily indexed. So the rate is
 * `CPI + spread` with a per-series settable spread, not CPI itself; see
 * `InflationAdjustReducer`. A recorded history rather than `(1+r)^n` is what makes
 * this exact when the realised rate differs year to year, which it does under both an
 * economic-regimes run and any non-zero spread.
 *
 * When there is no recorded level — the table predates the sim's first year, or the
 * state is an old snapshot with no bracket series — it degrades to the sim-start
 * anchor on whichever series is available, i.e. indexing from `max(moduleYear,
 * simStartYear)`, which is the most the run can know.
 *
 * @param {object} state      Simulation state snapshot
 * @param {string} series     One of BRACKET_INDEX_SERIES ('US' | 'AU' | 'US_STATE')
 * @param {number} moduleYear The rates table's own published year
 * @returns {number} Multiplicative factor, >= 1 under a non-negative indexation rate
 */
export function bracketIndexationFactor(state, series, moduleYear) {
  // The country whose inflation series backs this one, for the legacy fallback below.
  const cc     = series === BRACKET_INDEX_SERIES.AU ? 'AU' : 'US';
  const level  = state?.bracketIndexAccumulator?.[series]
              ?? state?.inflationAccumulator?.[cc] ?? 1.0;
  const anchor = state?.bracketIndexAccumulatorByYear?.[series]?.[moduleYear];
  return anchor > 0 ? level / anchor : level;
}

/**
 * InflationAdjustedUsTaxRates — US federal rates with each statutory dollar amount
 * projected on the series that actually governs it.
 *
 * Wraps a UsTaxRatesBase instance (e.g. UsTaxRates2026) and scales the bracket
 * thresholds, LTCG breakpoints and standard deduction by `bracket`; the §3121(a)(1)
 * wage base by `fica`; and the §911 exclusion cap by `feie`. Rates, the NIIT
 * thresholds and the Additional Medicare threshold are NOT scaled — the first are not
 * amounts, the last two are fixed by statute with no indexation at all.
 *
 * **Three factors, not one.** All three used to ride the bracket factor, which was
 * invisible while that factor was simply CPI but becomes wrong the moment brackets are
 * projected on an assumption of their own: the wage base follows the SSA average wage
 * index rather than prices, and the FEIE cap — though indexed to the same chained CPI
 * as the brackets — is a separate act of Congress, so modelling a bracket freeze must
 * not silently freeze either of them.
 *
 * @param {UsTaxRatesBase}      baseRates – Base-year rates module to project.
 * @param {number|object}       factors   – A single number applies to all three
 *   (kept for callers that only care about brackets); otherwise
 *   `{ bracket, fica = bracket, feie = bracket }`.
 */
export class InflationAdjustedUsTaxRates extends UsTaxRatesBase {
  constructor(baseRates, factors) {
    super();
    const { bracket, fica, feie } = _usFactors(factors);
    this._brackets_mfj        = baseRates._brackets_mfj.map(([t, r]) => [t * bracket, r]);
    this._ltcg_mfj            = baseRates._ltcg_mfj.map(([t, r]) => [t * bracket, r]);
    this._stdDeduction_mfj    = baseRates._stdDeduction_mfj * bracket;
    this._brackets_single     = baseRates._brackets_single.map(([t, r]) => [t * bracket, r]);
    this._ltcg_single         = baseRates._ltcg_single.map(([t, r]) => [t * bracket, r]);
    this._stdDeduction_single = baseRates._stdDeduction_single * bracket;
    this._ficaWageBase        = baseRates._ficaWageBase * fica;
    this._feieCap             = baseRates._feieCap      * feie;
    this._baseYear            = baseRates.year;
  }

  get year()        { return this._baseYear; }
  get countryCode() { return 'US'; }
}

/** Normalise the scalar-or-object factor argument. @private */
function _usFactors(factors) {
  if (typeof factors === 'number') return { bracket: factors, fica: factors, feie: factors };
  const bracket = factors?.bracket ?? 1;
  return { bracket, fica: factors?.fica ?? bracket, feie: factors?.feie ?? bracket };
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
    // Keep a reference to the wrapped year module so year-specific CGT policy
    // (the FY2027+ reform: discount removal + indexation + 30% minimum tax) is
    // NOT lost when the brackets are inflated. Without this delegation the wrapper
    // silently reverts every inflation-adjusted year to AuTaxRatesBase's flat 50%
    // discount (design 57 Bug 1 — the reform never fires past the base year).
    this._base = baseRates;
    this._brackets            = baseRates._brackets.map(([t, r]) => [t * cumulativeFactor, r]);
    this._nonResidentBrackets = baseRates._nonResidentBrackets.map(([t, r]) => [t * cumulativeFactor, r]);
    this._medicareLevy = {
      ...baseRates._medicareLevy,
      lowerThreshold: baseRates._medicareLevy.lowerThreshold * cumulativeFactor,
    };
    this._cgtDiscountRate = baseRates._cgtDiscountRate;
    this._baseYear = baseRates.year;
  }

  get year()        { return this._baseYear; }
  get countryCode() { return 'AU'; }

  // Delegate the per-year CGT relief hook (and its label) to the wrapped module so
  // the FY2027 indexation + minimum-tax regime survives inflation adjustment
  // (design 57 §6.1/§6.3). Bracket inflation is orthogonal to CGT relief.
  _cgtRelief(state, auCapitalGainsYTD) { return this._base._cgtRelief(state, auCapitalGainsYTD); }
  _cgtReliefLabel()                    { return this._base._cgtReliefLabel(); }
}
