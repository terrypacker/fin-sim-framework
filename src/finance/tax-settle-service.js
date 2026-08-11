/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { UsTaxRates2024 } from './tax/us/us-tax-rates-2024.js';
import { UsTaxRates2025 } from './tax/us/us-tax-rates-2025.js';
import { UsTaxRates2026 } from './tax/us/us-tax-rates-2026.js';
import { AuTaxRates2024 } from './tax/au/au-tax-rates-2024.js';
import { AuTaxRates2025 } from './tax/au/au-tax-rates-2025.js';
import { AuTaxRates2026 } from './tax/au/au-tax-rates-2026.js';
import { AuTaxRates2027 } from './tax/au/au-tax-rates-2027.js';
import {
  InflationAdjustedUsTaxRates,
  InflationAdjustedAuTaxRates,
} from './tax/inflation-adjusted-tax-rates.js';

// Per-person AU maps whose non-zero balance means a person accrued AU tax
// exposure this fiscal year. Used by computeAuTaxPerPerson to detect a person
// who died mid-year (already gone from state.people) but still owes a final-year
// return (design/68 Gap 1). Franking credits / earned-income views are excluded:
// they are credits or duplicate views, not a standalone reason to file.
// Household AU scalars that design 76 migrated to per-person maps. Anything left in
// one of these at settle time is income that resolved to nobody, and it gets divided
// by headcount below — the very behaviour design 76 exists to remove. Post-P3 both
// reference scenarios drain these to zero, so a non-zero value means a newly added
// income type skipped attribution. Warned about rather than thrown on: the scalar is
// still a correct-in-total fallback, and a hard throw would take down a user's run
// over an accuracy regression. `tests/unit/design-76-no-household-residue.test.mjs`
// is the enforcing check.
const AU_MIGRATED_HOUSEHOLD_FIELDS = [
  'auOrdinaryIncomeYTD',
  'auCapitalGainsYTD',
  'auDiscountableGainsYTD',
  'auRealCapitalGainsYTD',
  'usSourceOrdinaryAudYTD',
  'usSourceCapGainsAudYTD',
  'usSourceRealCapGainsAudYTD',
];

/**
 * True in dev/test, false in a production build — mirrors state-utils' strict gate.
 *
 * Read per call rather than cached at module load so a test can opt a single case out
 * of the escalation (the two that deliberately exercise the legacy shared-pool split).
 * Runs once per country per simulated year, so the cost is irrelevant.
 */
function _attributionWarningsOn() {
  try {
    if (typeof process !== 'undefined' && process.env) {
      if (process.env.AU_ATTRIBUTION_WARN === 'off') return false;
      if (process.env.AU_ATTRIBUTION_WARN === 'on')  return true;
      if (process.env.NODE_ENV === 'production') return false;
    }
  } catch { /* no process (browser) */ }
  return true;
}
/**
 * Escalate the warning to a throw. On in dev/test — where an un-attributed income
 * type is a programming error being introduced right now, and failing at the point
 * of introduction is worth far more than a correct-in-total number — and off in a
 * production build, where the user's run should survive.
 */
function _attributionStrict() {
  try {
    if (typeof process !== 'undefined' && process.env) {
      if (process.env.AU_ATTRIBUTION_STRICT === 'off') return false;
      if (process.env.AU_ATTRIBUTION_STRICT === 'on')  return true;
      if (process.env.NODE_ENV === 'production') return false;
    }
  } catch { /* no process (browser) */ }
  try {
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.PROD) return false;
  } catch { /* import.meta.env absent */ }
  return true;
}
/** Fields already reported this session — one warning each, not one per settle. */
const _warnedFields = new Set();

const AU_PER_PERSON_INCOME_FIELDS = [
  'auPersonOrdinaryIncomeYTD',
  'auPersonCapitalGainsYTD',
  'auPersonDiscountableGainsYTD',
  'auPersonRealCapitalGainsYTD',
  'auPersonNonResidentWithholdingYTD',
  'auPersonNrWithholdingInterestYTD',
  'auPersonNrWithholdingUnfrankedDividendYTD',
  'auPersonSuperTaxYTD',
];

/**
 * TaxSettleService — year-aware computation of end-of-period tax liability.
 *
 * Holds a registry of BaseTaxRatesModule instances keyed by country+year.
 * At settlement time, the correct module is resolved from state.currentPeriods,
 * using the same highest-year-<= logic as TaxEngine.
 *
 * Registered modules (ordered by country and financial year):
 *   US 2024  — IRS Rev. Proc. 2023-34 MFJ brackets
 *   US 2025  — IRS Rev. Proc. 2024-40 MFJ brackets
 *   US 2026  — IRS Rev. Proc. 2025-32 MFJ brackets (permanent OBBBA schedule)
 *   AU 2024  — ATO FY2024-25 (Stage 3 tax cuts)
 *   AU 2025  — ATO FY2025-26 (30% bracket extended to $135k)
 *   AU 2026  — ATO FY2026-27 ($18,201–$45,000 band cut 16% → 15%; CGT unchanged)
 *   AU 2027  — ATO FY2027-28 (CGT reform: 50% discount removed + 30% min tax; band 15% → 14%)
 *
 * For years beyond the highest registered year, the highest available module
 * is used as a forward-compatibility fallback.
 */
export class TaxSettleService {
  constructor() {
    /** @type {Record<string, import('./tax/base-tax-rates-module.js').BaseTaxRatesModule>} */
    this._modules = {};

    for (const m of [
      new UsTaxRates2024(),
      new UsTaxRates2025(),
      new UsTaxRates2026(),
      new AuTaxRates2024(),
      new AuTaxRates2025(),
      new AuTaxRates2026(),
      new AuTaxRates2027(),
    ]) {
      this._modules[`${m.countryCode}_${m.year}`] = m;
    }
  }

  /**
   * Compute total US federal tax liability for the period.
   *
   * Resolves the correct year's module from state.currentPeriods.US.
   * Filing status: Married Filing Jointly (MFJ).
   * FTC credit applied after computing gross liability (cannot exceed liability).
   *
   * @param {object} state - Simulation state snapshot
   * @returns {TaxComputationResult} Structured result including line items, rates, netLiability, and taxYear
   */
  computeUsTax(state) {
    const result = this._getModule('US', state).computeTax(state);
    const period = state.currentPeriods?.US;
    result.taxYear = period ? new Date(period.startMs).getUTCFullYear() : undefined;
    return result;
  }

  /**
   * Compute total AU tax liability for the period.
   *
   * Resolves the correct year's module from state.currentPeriods.AU.
   * Resident:     progressive brackets + Medicare levy, franking credits offset.
   * Non-resident: flat brackets (no threshold), withholding added directly.
   *
   * taxYear reflects the financial year start (e.g. 2025 = FY2025-26 starting July 2025).
   *
   * @param {object} state - Simulation state snapshot
   * @returns {TaxComputationResult} Structured result including line items, rates, netLiability, and taxYear
   */
  computeAuTax(state) {
    const result = this._getModule('AU', state).computeTax(state);
    const period = state.currentPeriods?.AU;
    result.taxYear = period ? new Date(period.startMs).getUTCFullYear() : undefined;
    return result;
  }

  /**
   * Compute AU tax separately for each person who was resident during the fiscal
   * year — the living residents in state.people PLUS anyone who accrued AU income
   * this year and has since died (design/68 Gap 1). A person who dies partway
   * through the year is removed from state.people the moment PERSON_DIED fires,
   * but their per-person accumulators still hold the pre-death income at settle
   * time (the reset runs later, in the apply reducer), so their final-year return
   * must still be filed and its liability debited. Prior-year deaths were already
   * zeroed at their own settle, so the non-zero-balance check naturally excludes
   * them and does not dilute numResidents.
   *
   * Each AU YTD field is resolved as:
   *   personValue = auPersonXYTD[key] + auXYTD / numResidents
   *
   * This lets each income type migrate incrementally: once an event writes
   * directly to the per-person map its shared-pool contribution drops to 0,
   * while un-migrated types continue to split evenly from the shared pool.
   *
   * Used when state.auPersonOrdinaryIncomeYTD is populated (i.e. the
   * InternationalRetirementFinancialState is in use).
   *
   * @param {object} state - Simulation state snapshot
   * @returns {{ personKey: string, personName: string, taxDetail: TaxComputationResult }[]}
   */
  computeAuTaxPerPerson(state) {
    const people   = state.people ?? {};
    const deceased = state.deceased ?? {};
    const period   = state.currentPeriods?.AU;

    // Resident-of-the-year set: living residents ∪ mid-year-deceased who were AU
    // residents for part of this fiscal year. Two independent signals so both the
    // migrated-income and shared-pool-only cases are covered:
    //   (1) a non-zero per-person AU balance — catches income already migrated to
    //       the per-person maps (design 52/55).
    //   (2) an AU-resident death dated inside this fiscal period — catches income
    //       that only ever lived in the shared pool (no per-person attribution),
    //       and keeps numResidents correct so the survivor's shared-pool split is
    //       unchanged from the pre-death allocation.
    const activeKeys = new Set(Object.keys(people).filter(k => people[k] != null));
    for (const field of AU_PER_PERSON_INCOME_FIELDS) {
      const map = state[field];
      if (!map) continue;
      for (const [k, v] of Object.entries(map)) {
        if (v) activeKeys.add(k);
      }
    }
    if (period) {
      for (const [k, rec] of Object.entries(deceased)) {
        if (rec?.taxJurisdiction !== 'AU') continue;
        const t = rec.date instanceof Date ? rec.date.getTime()
                : (rec.date != null ? new Date(rec.date).getTime() : NaN);
        if (!Number.isNaN(t) && t >= period.startMs && t < period.endMs) activeKeys.add(k);
      }
    }

    const residentKeys = [...activeKeys];
    const numResidents = Math.max(1, residentKeys.length);
    const auModule = this._getModule('AU', state);
    const taxYear  = period ? new Date(period.startMs).getUTCFullYear() : undefined;

    // Design 76 P5: every AU-assessable income type now attributes to a person, so
    // nothing should be sitting on these household scalars. Anything that is has
    // skipped attribution, and dividing it by headcount is the bug this design
    // exists to remove — right only by accident, for a jointly held asset with equal
    // owners, and wrong for everything else.
    //
    // Surfaced rather than silently split, and surfaced loudly in dev/test because
    // that is where a newly added income type gets introduced. Production keeps
    // running: the scalar is still correct in TOTAL, so a household's headline tax
    // is right even when the split is not, and taking down someone's simulation over
    // an accuracy regression is the wrong trade. `AU_ATTRIBUTION_STRICT=on` forces
    // the throw anywhere; `AU_ATTRIBUTION_WARN=off` silences the warning.
    const residues = AU_MIGRATED_HOUSEHOLD_FIELDS
      .map(field => ({ field, value: state[field] ?? 0 }))
      .filter(r => Math.abs(r.value) > 0.005);
    if (residues.length > 0 && numResidents > 1) {
      const detail = residues.map(r => `${r.field}=${r.value.toFixed(2)}`).join(', ');
      const message =
        `[design 76] AU income reached the settle unattributed and would be split `
        + `${numResidents} ways: ${detail}. Australia has no joint assessment — stamp the `
        + `emitting action with personKey / stateKey / owner fields so it attributes to `
        + `whoever actually earns it.`;
      if (_attributionStrict()) throw new Error(message);
      for (const { field } of residues) {
        if (_attributionWarningsOn() && !_warnedFields.has(field)) {
          _warnedFields.add(field);
          console.warn(`${message} (AU_ATTRIBUTION_WARN=off to silence.)`);
        }
      }
    }

    // Each person's US-source income (AUD), on the same hybrid as everything below.
    // Hoisted because the FITO *tax* apportionment (design 76 Gap D / P4) needs the
    // household total as its denominator, not just this person's slice.
    const usSourceFor = (k) =>
        (state.auPersonUsSourceOrdinaryAudYTD?.[k] ?? 0) + (state.usSourceOrdinaryAudYTD ?? 0) / numResidents
      + (state.auPersonUsSourceCapGainsAudYTD?.[k] ?? 0) + (state.usSourceCapGainsAudYTD ?? 0) / numResidents;
    const usSourceTotal = residentKeys.reduce((sum, k) => sum + usSourceFor(k), 0);

    return residentKeys.map((key) => {
      // Living person, else the death-captured record (name + Age Pension flag).
      const person = people[key] ?? deceased[key] ?? {};

      const perPersonShare = (map, shared) =>
        (map?.[key] ?? 0) + (shared ?? 0) / numResidents;

      const personState = {
        ...state,
        auOrdinaryIncomeYTD:         perPersonShare(state.auPersonOrdinaryIncomeYTD,         state.auOrdinaryIncomeYTD),
        auCapitalGainsYTD:           perPersonShare(state.auPersonCapitalGainsYTD,            state.auCapitalGainsYTD),
        auDiscountableGainsYTD:      perPersonShare(state.auPersonDiscountableGainsYTD,       state.auDiscountableGainsYTD),
        // design 83 G7 step 3 — the apportioned base and its relief travel with the
        // discountable gain they belong to, or the person's return would apply a flat
        // 50% to a base someone else's apportionment had already reduced.
        auDiscountApportionedBaseYTD: perPersonShare(state.auPersonDiscountApportionedBaseYTD, state.auDiscountApportionedBaseYTD),
        auDiscountAllowanceYTD:       perPersonShare(state.auPersonDiscountAllowanceYTD,       state.auDiscountAllowanceYTD),
        auRealCapitalGainsYTD:       perPersonShare(state.auPersonRealCapitalGainsYTD,        state.auRealCapitalGainsYTD),
        auNonResidentWithholdingYTD: perPersonShare(state.auPersonNonResidentWithholdingYTD,  state.auNonResidentWithholdingYTD),
        auNrWithholdingInterestYTD:          perPersonShare(state.auPersonNrWithholdingInterestYTD,          state.auNrWithholdingInterestYTD),
        auNrWithholdingUnfrankedDividendYTD: perPersonShare(state.auPersonNrWithholdingUnfrankedDividendYTD, state.auNrWithholdingUnfrankedDividendYTD),
        auSuperTaxYTD:               perPersonShare(state.auPersonSuperTaxYTD,                state.auSuperTaxYTD),
        // Div 36 loss pool (design 86 G1). NOT a perPersonShare: there is no household
        // scalar to split, because a carried-forward loss belongs to one taxpayer and
        // splitting it would let one spouse's loss shelter the other's income.
        auTaxLossPool:               state.auPersonTaxLossPool?.[key] ?? 0,
        // s102-5 net capital losses (design 90 §5). NOT a perPersonShare, for exactly the
        // reason stated above, and a DIFFERENT pool from the Div 36 one: s102-10(2)
        // forbids a net capital loss from reducing assessable income at all.
        auCapitalLossPool:           state.auPersonCapitalLossPool?.[key] ?? 0,
        auFrankingCreditYTD:         perPersonShare(state.auPersonFrankingCreditYTD,          state.auFrankingCreditYTD),
        // FITO (design 52 §4.5): the US-source removal set — the slice
        // _assessResidentPreFito subtracts for the "without US-source" pass that
        // sizes the FITO limit. Design 76 Gap D migrates it per-person on the same
        // hybrid as the income above, and that pairing is load-bearing rather than
        // cosmetic: this set MUST be attributed identically to the income it is a
        // subset of. Give Terry 100% of an IRA distribution's assessable income but
        // only half its US-source slice and his "without" pass removes too little,
        // overstating his limit, while Jeanne's removes income she never had.
        usSourceOrdinaryAudYTD:      perPersonShare(state.auPersonUsSourceOrdinaryAudYTD,     state.usSourceOrdinaryAudYTD),
        usSourceCapGainsAudYTD:      perPersonShare(state.auPersonUsSourceCapGainsAudYTD,     state.usSourceCapGainsAudYTD),
        usSourceRealCapGainsAudYTD:  perPersonShare(state.auPersonUsSourceRealCapGainsAudYTD, state.usSourceRealCapGainsAudYTD),
        // Design 76 Gap D / P4 — the one FITO input that cannot be *attributed*.
        // US tax is assessed MFJ and stamped once per US settle, so there is no
        // per-person value to migrate to; it has to be APPORTIONED. The basis is each
        // person's share of the US-source income Australia is also taxing, which is
        // exactly what the three lines above now provide.
        //
        // Why that basis: this figure exists to cap the FITO, and the cap is meant to
        // relieve the US tax borne on the income AU is taxing a second time. Handing a
        // person half the household's US tax when they hold 90% of the US-source income
        // under-relieves them and over-relieves their spouse, whose own limit then
        // wastes the excess (FITO has no carryforward — §4.5). Apportioning by income
        // share keeps each person's offset proportionate to the double tax they bear,
        // and degrades to the old even split when the two shares are equal.
        //
        // Zero US-source income across the household ⇒ nothing to apportion by; fall
        // back to the even split rather than dividing by zero.
        usTaxPaidOnUsSourceAud: usSourceTotal > 0
          ? (state.usTaxPaidOnUsSourceAud ?? 0) * (usSourceFor(key) / usSourceTotal)
          : (state.usTaxPaidOnUsSourceAud ?? 0) / numResidents,
        // AU CGT reform (design 57 §6.6): this person's Age Pension / JobSeeker
        // exemption from the 30% CGT minimum tax; read by AuTaxRates2027._cgtRelief.
        auMinTaxExempt:              person.incomeSupportRecipient === true,
      };

      const taxDetail = auModule.computeTax(personState);
      taxDetail.taxYear = taxYear;

      return { personKey: key, personName: person.name || key, taxDetail };
    });
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  /**
   * Wrap a rates module with inflation-adjusted brackets when
   * state.inflationAccumulator[cc] > 1.0.  Returns the base module unchanged
   * when no accumulator is present or the factor is effectively 1.
   *
   * @param {string} cc
   * @param {import('./tax/base-tax-rates-module.js').BaseTaxRatesModule} baseModule
   * @param {object} state
   * @returns {import('./tax/base-tax-rates-module.js').BaseTaxRatesModule}
   */
  _inflationWrap(cc, baseModule, state) {
    const factor = state.inflationAccumulator?.[cc] ?? 1.0;
    if (factor <= 1.0) return baseModule;
    if (cc === 'US') return new InflationAdjustedUsTaxRates(baseModule, factor);
    if (cc === 'AU') return new InflationAdjustedAuTaxRates(baseModule, factor);
    return baseModule;
  }

  /**
   * Resolve the best-matching rates module for the given country.
   *
   * Uses state.currentPeriods[cc].startMs to derive the tax year, then picks
   * the highest registered year <= that year (same strategy as TaxEngine.get()).
   * Falls back to the highest available year if no period is set in state.
   *
   * @param {string} cc    Country code ('US' or 'AU')
   * @param {object} state Simulation state snapshot
   * @returns {import('./tax/base-tax-rates-module.js').BaseTaxRatesModule}
   */
  _getModule(cc, state) {
    const period = state.currentPeriods?.[cc];
    const baseModule = period
      ? this.ratesForYear(cc, new Date(period.startMs).getUTCFullYear())
      // No period in state — use highest available year as fallback
      : this.ratesForYear(cc, Infinity);
    return this._inflationWrap(cc, baseModule, state);
  }

  /** Registered years for a country, ascending. */
  _yearsFor(cc) {
    const years = Object.keys(this._modules)
      .filter(k => k.startsWith(cc + '_'))
      .map(k => parseInt(k.split('_')[1], 10))
      .sort((a, b) => a - b);
    if (years.length === 0) {
      throw new Error(`[TaxSettleService] No rates module registered for country: ${cc}`);
    }
    return years;
  }

  /**
   * The STATUTORY (un-inflated) rates module for a calendar year — the highest
   * registered year <= `year`, the same selection `_getModule` makes before the
   * inflation wrap. Public so bracket-shaped levers (Roth-conversion ceilings,
   * the MPC cockpit's bracket labels) read the same tables the settle path does
   * instead of pinning a base year of their own.
   *
   * @param {string} cc    Country code ('US' or 'AU')
   * @param {number} year  Calendar year; Infinity selects the highest registered.
   * @returns {import('./tax/base-tax-rates-module.js').BaseTaxRatesModule}
   */
  ratesForYear(cc, year) {
    const years = this._yearsFor(cc);
    const best  = years.filter(y => y <= year).pop() ?? years[0];
    return this._modules[`${cc}_${best}`];
  }

  /**
   * Base year for REAL (inflation-free) US amounts: the newest registered US
   * statutory table. `state.inflationAccumulator.US` starts at 1.0 in the sim's
   * first year, so this is the year in which quoted-real and nominal coincide.
   *
   * @returns {number}
   */
  get usBracketBaseYear() {
    const years = this._yearsFor('US');
    return years[years.length - 1];
  }

  /**
   * Gross ordinary income (usOrdinaryIncomeYTD) at the TOP of the MFJ bracket
   * with the given marginal rate, for the given year.
   *
   * "Top of bracket" = lower threshold of the next higher bracket (in taxable-income
   * space) + the standard deduction — the usOrdinaryIncomeYTD level at which a
   * household crosses into the next bracket. Returns Infinity for the top (37%) bracket.
   *
   * Mirrors the settle path: `year`'s statutory table, then indexed by inflation the
   * way `_inflationWrap` indexes it. Indexing runs from `usBracketBaseYear` — where
   * the settle-time accumulator is 1.0 — so a year with its own statutory module
   * (2026 = Rev. Proc. 2025-32) is quoted at its published thresholds rather than
   * an inflated older table's.
   *
   * @param {number} rate            Target marginal rate, e.g. 0.22
   * @param {number} year            Tax year to compute for
   * @param {number} annualInflation Annual rate used for bracket indexing
   * @returns {number}
   */
  usBracketGrossIncomeCeiling(rate, year, annualInflation = 0.03) {
    const base   = this.ratesForYear('US', year);
    const factor = Math.pow(1 + annualInflation, year - this.usBracketBaseYear);

    const idx = base._brackets_mfj.findIndex(([, r]) => r === rate);
    if (idx < 0 || idx + 1 >= base._brackets_mfj.length) return Infinity;
    return (base._brackets_mfj[idx + 1][0] + base._stdDeduction_mfj) * factor;
  }
}

/** Shared read-only instance for the module-level bracket helpers below. */
let _sharedService = null;
function _shared() {
  if (!_sharedService) _sharedService = new TaxSettleService();
  return _sharedService;
}

/**
 * Base year for REAL base-year USD amounts — see `TaxSettleService.usBracketBaseYear`.
 * Read through the service so it tracks the newest registered US table instead of
 * being restated as a literal at each call site.
 */
export const US_BRACKET_BASE_YEAR = _shared().usBracketBaseYear;

/** The statutory US rates module for `year` — see `TaxSettleService.ratesForYear`. */
export function usRatesForYear(year) {
  return _shared().ratesForYear('US', year);
}

/**
 * Free-function form of `TaxSettleService.usBracketGrossIncomeCeiling`, for callers
 * (scenario toolsets, the MPC cockpit) that have a year and an inflation rate but no
 * simulation state. Previously lived in `us-tax-rates-2025.js` and was hard-pinned to
 * the 2025 tables; it now resolves the year's registered module.
 *
 * @param {number} rate            Target marginal rate, e.g. 0.22
 * @param {number} year            Tax year to compute for
 * @param {number} annualInflation Annual rate for bracket indexing
 * @returns {number}
 */
export function usBracketGrossIncomeCeiling(rate, year, annualInflation = 0.03) {
  return _shared().usBracketGrossIncomeCeiling(rate, year, annualInflation);
}
