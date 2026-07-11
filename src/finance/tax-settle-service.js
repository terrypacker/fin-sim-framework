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
   * Compute AU tax separately for each person in state.people.
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
    const people = state.people ?? {};
    const residents = Object.entries(people).filter(([, p]) => p != null);
    const numResidents = Math.max(1, residents.length);
    const auModule = this._getModule('AU', state);
    const period   = state.currentPeriods?.AU;
    const taxYear  = period ? new Date(period.startMs).getUTCFullYear() : undefined;

    return residents.map(([key, person]) => {
      const perPersonShare = (map, shared) =>
        (map?.[key] ?? 0) + (shared ?? 0) / numResidents;

      const personState = {
        ...state,
        auOrdinaryIncomeYTD:         perPersonShare(state.auPersonOrdinaryIncomeYTD,         state.auOrdinaryIncomeYTD),
        auCapitalGainsYTD:           perPersonShare(state.auPersonCapitalGainsYTD,            state.auCapitalGainsYTD),
        auRealCapitalGainsYTD:       perPersonShare(state.auPersonRealCapitalGainsYTD,        state.auRealCapitalGainsYTD),
        auNonResidentWithholdingYTD: perPersonShare(state.auPersonNonResidentWithholdingYTD,  state.auNonResidentWithholdingYTD),
        auSuperTaxYTD:               perPersonShare(state.auPersonSuperTaxYTD,                state.auSuperTaxYTD),
        auFrankingCreditYTD:         perPersonShare(state.auPersonFrankingCreditYTD,          state.auFrankingCreditYTD),
        // FITO (design 52 §4.5): the US-source removal set and the US-tax-paid
        // input are household scalars — split evenly across residents so each
        // person's return applies its own share of the offset + with/without limit.
        usSourceOrdinaryAudYTD:      (state.usSourceOrdinaryAudYTD ?? 0) / numResidents,
        usSourceCapGainsAudYTD:      (state.usSourceCapGainsAudYTD ?? 0) / numResidents,
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
