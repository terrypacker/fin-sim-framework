/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { primaryResidencyState, primaryPersonKey, getResidency } from '../../residency-utils.js';
import { NeStateTaxRates2024 } from './ne/ne-state-tax-rates-2024.js';
import { NeStateTaxRates2025 } from './ne/ne-state-tax-rates-2025.js';
import { HiStateTaxRates2024 } from './hi/hi-state-tax-rates-2024.js';
import { HiStateTaxRates2025 } from './hi/hi-state-tax-rates-2025.js';
import { HiStateTaxRates2026 } from './hi/hi-state-tax-rates-2026.js';
import { HiStateTaxRates2027 } from './hi/hi-state-tax-rates-2027.js';
import { HiStateTaxRates2028 } from './hi/hi-state-tax-rates-2028.js';
import { HiStateTaxRates2029 } from './hi/hi-state-tax-rates-2029.js';
import { HiStateTaxRates2030 } from './hi/hi-state-tax-rates-2030.js';
import { HiStateTaxRates2031 } from './hi/hi-state-tax-rates-2031.js';
import { SdStateTaxRates2024 } from './sd/sd-state-tax-rates-2024.js';
import { InflationAdjustedStateTaxRates } from './inflation-adjusted-state-tax-rates.js';
import { bracketIndexationFactor, BRACKET_INDEX_SERIES } from '../inflation-adjusted-tax-rates.js';

const ZERO_RESULT = Object.freeze({
  stateCode: null, filingStatus: null, taxableIncome: 0,
  ordinaryTax: 0, capitalGainsTax: 0, netLiability: 0,
  effectiveRate: 0, marginalRate: 0, lineItems: [], taxYear: undefined,
});

/**
 * StateTaxSettleService — year-aware computation of US state income tax (design 34).
 *
 * The state analog of TaxSettleService. Holds BaseStateTaxRatesModule instances
 * keyed `${stateCode}_${year}`. At settlement, the active state is resolved from
 * the PRIMARY person's `residencyState` and the year from `currentPeriods.US`
 * (states file on the US calendar year), using the same highest-year-≤ fallback
 * as the federal engine.
 *
 * Returns a zero liability when no state is configured or the primary person is
 * not a US resident (e.g. after the US→AU move) — so an unconfigured or abroad
 * household pays no state tax.
 */
export class StateTaxSettleService {
  constructor() {
    /** @type {Record<string, import('./base-state-tax-rates-module.js').BaseStateTaxRatesModule>} */
    this._modules = {};
    for (const m of [
      new NeStateTaxRates2024(),
      new NeStateTaxRates2025(),
      new HiStateTaxRates2024(),
      new HiStateTaxRates2025(),
      new HiStateTaxRates2026(),
      new HiStateTaxRates2027(),
      new HiStateTaxRates2028(),
      new HiStateTaxRates2029(),
      new HiStateTaxRates2030(),
      new HiStateTaxRates2031(),
      new SdStateTaxRates2024(),
    ]) {
      this._modules[`${m.stateCode}_${m.year}`] = m;
    }
  }

  /**
   * Compute the household's US state income tax liability for the period.
   * @param {object} state - Simulation state snapshot
   * @returns {object} TaxComputationResult-shaped state liability (netLiability = 0 when N/A)
   */
  computeStateTax(state) {
    const stateCode = primaryResidencyState(state);
    if (!stateCode) return { ...ZERO_RESULT };

    // State income tax applies only while the primary person is a US resident.
    const primaryKey = primaryPersonKey(state);
    if (primaryKey && getResidency(state, primaryKey) !== 'US') return { ...ZERO_RESULT, stateCode };

    const module = this._getModule(stateCode, state);
    if (!module) return { ...ZERO_RESULT, stateCode };

    const result  = module.computeTax(state);
    const period  = state.currentPeriods?.US;
    result.taxYear = period ? new Date(period.startMs).getUTCFullYear() : undefined;
    return result;
  }

  /** @returns {boolean} whether any rates module is registered for the state code. */
  hasState(stateCode) {
    return Object.keys(this._modules).some(k => k.startsWith(stateCode + '_'));
  }

  /**
   * Distinct state codes with at least one rates module registered — the tax
   * layer's own answer to "which states does this model support". US_STATES
   * (us-states.js) is the selectable list shown in the UI and param enums; the
   * two must agree, which state-tax-rates.test.mjs asserts.
   *
   * @returns {string[]}
   */
  get stateCodes() {
    return [...new Set(Object.keys(this._modules).map(k => k.split('_')[0]))];
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  _getModule(stateCode, state) {
    const available = Object.keys(this._modules)
      .filter(k => k.startsWith(stateCode + '_'))
      .map(k => parseInt(k.split('_')[1], 10))
      .sort((a, b) => a - b);
    if (available.length === 0) return null;

    const period  = state.currentPeriods?.US;
    const taxYear = period ? new Date(period.startMs).getUTCFullYear() : available[available.length - 1];
    const best    = available.filter(y => y <= taxYear).pop() ?? available[0];
    return this._inflationWrap(this._modules[`${stateCode}_${best}`], state);
  }

  /**
   * Index a state table's thresholds for the inflation elapsed since ITS OWN year,
   * mirroring what `TaxSettleService._inflationWrap` does federally.
   *
   * States file on the US calendar year but index on their own legislatures'
   * schedules, so this rides the US_STATE series — CPI plus `usStateBracketIndexSpread`
   * — rather than the federal one. The module's own year is the anchor, which means
   * every published year (Act 46's whole 2024→2031 Hawaii phase-in, Nebraska's LB 754
   * glide) is applied exactly as published, and only years past a state's last
   * registered table are projected. See `InflationAdjustedStateTaxRates` for why
   * projecting at all is a convention rather than a transcription of law.
   *
   * A no-income-tax state (SD) is returned unwrapped: there is nothing to index and
   * wrapping would only add an object to every settle.
   *
   * @param {BaseStateTaxRatesModule} baseModule
   * @param {object} state
   * @returns {BaseStateTaxRatesModule}
   */
  _inflationWrap(baseModule, state) {
    if (!baseModule.hasIncomeTax) return baseModule;
    const factor = bracketIndexationFactor(state, BRACKET_INDEX_SERIES.US_STATE, baseModule.year);
    if (factor <= 1.0) return baseModule;
    return new InflationAdjustedStateTaxRates(baseModule, factor);
  }
}
