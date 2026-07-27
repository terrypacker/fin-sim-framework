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
const AU_PER_PERSON_INCOME_FIELDS = [
  'auPersonOrdinaryIncomeYTD',
  'auPersonCapitalGainsYTD',
  'auPersonDiscountableGainsYTD',
  'auPersonRealCapitalGainsYTD',
  'auPersonNonResidentWithholdingYTD',
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
        auRealCapitalGainsYTD:       perPersonShare(state.auPersonRealCapitalGainsYTD,        state.auRealCapitalGainsYTD),
        auNonResidentWithholdingYTD: perPersonShare(state.auPersonNonResidentWithholdingYTD,  state.auNonResidentWithholdingYTD),
        auSuperTaxYTD:               perPersonShare(state.auPersonSuperTaxYTD,                state.auSuperTaxYTD),
        auFrankingCreditYTD:         perPersonShare(state.auPersonFrankingCreditYTD,          state.auFrankingCreditYTD),
        // FITO (design 52 §4.5): the US-source removal set and the US-tax-paid
        // input are household scalars — split evenly across residents so each
        // person's return applies its own share of the offset + with/without limit.
        usSourceOrdinaryAudYTD:      (state.usSourceOrdinaryAudYTD ?? 0) / numResidents,
        usSourceCapGainsAudYTD:      (state.usSourceCapGainsAudYTD ?? 0) / numResidents,
        usSourceRealCapGainsAudYTD:  (state.usSourceRealCapGainsAudYTD ?? 0) / numResidents,
        usTaxPaidOnUsSourceAud:      (state.usTaxPaidOnUsSourceAud ?? 0) / numResidents,
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
    const available = Object.keys(this._modules)
      .filter(k => k.startsWith(cc + '_'))
      .map(k => parseInt(k.split('_')[1], 10))
      .sort((a, b) => a - b);

    if (available.length === 0) {
      throw new Error(`[TaxSettleService] No rates module registered for country: ${cc}`);
    }

    const period = state.currentPeriods?.[cc];
    if (period) {
      const taxYear = new Date(period.startMs).getUTCFullYear();
      const best    = available.filter(y => y <= taxYear).pop() ?? available[0];
      return this._inflationWrap(cc, this._modules[`${cc}_${best}`], state);
    }

    // No period in state — use highest available year as fallback
    const baseModule = this._modules[`${cc}_${available[available.length - 1]}`];
    return this._inflationWrap(cc, baseModule, state);
  }
}
