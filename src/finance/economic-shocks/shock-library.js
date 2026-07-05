/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Predefined financial shock library.
 *
 * Each entry is a FinancialShock template: all fields except `startDate`, which
 * is supplied at runtime from the `shockStartDate` scenario parameter.
 *
 * These are **illustrative shapes** — not historical reproductions. They are
 * intended as starting points for scenario planning, not backtests.
 *
 * Keys are stable identifiers stored in `parameters.shockPreset`.
 */
export const SHOCK_LIBRARY = Object.freeze({

  /**
   * Broad equity crash modeled on a typical deep bear market (e.g. 2008 GFC).
   * −40 % US/AU equity level effect; forward returns suppressed for 18 months.
   * V-shaped recovery.
   */
  MARKET_CRASH_2008_LITE: {
    shockId:   'MARKET_CRASH_2008_LITE',
    name:      'Market Crash (GFC-style)',
    severity:  0.40,
    levelEffects: {
      equityRevaluation: {
        rateKeys:   ['EQUITY_US', 'EQUITY_AU'],
        multiplier: -0.40,
      },
    },
    regime: {
      returnAdjustment:   { EQUITY_US: -0.03, EQUITY_AU: -0.025 },
      dividendAdjustment: { EQUITY_US: -0.40, EQUITY_AU: -0.35 },
      // Risk-off: USD safe-haven bid, AUD depreciates → USD_AUD drifts up, and
      // the pair gets choppier (design 47). Both scale by the recovery factor.
      fxAdjustment:       { USD_AUD: 0.08 },
      fxVolAdjustment:    { USD_AUD: 0.5 },
    },
    recovery: { profile: 'V', durationMonths: 18 },
  },

  /**
   * Stagflation episode: no equity-level drop but sustained high inflation and
   * suppressed real returns for 48 months. L-shaped (no recovery within window).
   */
  STAGFLATION_1970S_LITE: {
    shockId:  'STAGFLATION_1970S_LITE',
    name:     'Stagflation (1970s-style)',
    severity: null,
    levelEffects: null,
    regime: {
      returnAdjustment:    { EQUITY_US: -0.02, EQUITY_AU: -0.02 },
      inflationAdjustment: { US: 0.05, AU: 0.04 },
      // Broad USD weakness (1970s-style): USD_AUD drifts down — 1 USD buys fewer
      // AUD — plus sustained choppiness (design 47). Opposite drift sign to the
      // risk-off GFC/COVID presets.
      fxAdjustment:        { USD_AUD: -0.10 },
      fxVolAdjustment:     { USD_AUD: 0.4 },
    },
    recovery: { profile: 'L', durationMonths: 48 },
  },

  /**
   * Sharp, short-lived equity crash with rapid recovery.
   * Models a swift systemic shock followed by stimulus-driven rebound.
   */
  COVID_2020_LITE: {
    shockId:   'COVID_2020_LITE',
    name:      'Pandemic Crash (COVID-style)',
    severity:  0.30,
    levelEffects: {
      equityRevaluation: {
        rateKeys:   ['EQUITY_US', 'EQUITY_AU'],
        multiplier: -0.30,
      },
    },
    regime: {
      returnAdjustment:    { EQUITY_US: -0.04, EQUITY_AU: -0.03 },
      inflationAdjustment: { US: 0.01 },
      dividendAdjustment:  { EQUITY_US: -0.30, EQUITY_AU: -0.20 },
      // Sharp risk-off spike: strong AUD depreciation and a big vol jump that
      // both recover quickly (V, 6mo) (design 47).
      fxAdjustment:        { USD_AUD: 0.10 },
      fxVolAdjustment:     { USD_AUD: 1.0 },
    },
    recovery: { profile: 'V', durationMonths: 6 },
  },

  /**
   * Mild bear market: −15 % US equity only, 12-month U-shaped recovery.
   * Useful as a low-severity baseline stress test.
   */
  MILD_CORRECTION: {
    shockId:   'MILD_CORRECTION',
    name:      'Mild Correction (−15 % US equity)',
    severity:  0.15,
    levelEffects: {
      equityRevaluation: {
        rateKeys:   ['EQUITY_US'],
        multiplier: -0.15,
      },
    },
    regime: {
      returnAdjustment:   { EQUITY_US: -0.02 },
      dividendAdjustment: { EQUITY_US: -0.10 },
    },
    recovery: { profile: 'U', durationMonths: 12 },
  },

  /**
   * Regional Bay Area housing crash: −35 % level effect on properties with
   * `market: 'US-SF-BAY'` only. Country-level real-estate properties unaffected.
   * U-shaped recovery over 36 months. (Design 28 §4 §9 worked example.)
   */
  SF_BAY_HOUSING_CRASH: {
    shockId:   'SF_BAY_HOUSING_CRASH',
    name:      'SF Bay Housing Crash (−35 %)',
    severity:  0.35,
    levelEffects: {
      realEstateRevaluation: {
        rateKeys:   ['REAL_ESTATE_US-SF-BAY'],
        multiplier: -0.35,
      },
    },
    regime: {
      appreciationAdjustment: { 'REAL_ESTATE_US-SF-BAY': -0.04 },
    },
    recovery: { profile: 'U', durationMonths: 36 },
  },

});

/**
 * Ordered list of {value, label} option descriptors for the `shockPreset` param.
 * The first entry is always the sentinel that means "no shock".
 */
export const SHOCK_PRESET_OPTIONS = Object.freeze([
  { value: 'none',                   label: 'None' },
  { value: 'MARKET_CRASH_2008_LITE', label: 'Market Crash (GFC-style, −40 %)' },
  { value: 'STAGFLATION_1970S_LITE', label: 'Stagflation (1970s-style, 48 mo)' },
  { value: 'COVID_2020_LITE',        label: 'Pandemic Crash (COVID-style, −30 %)' },
  { value: 'MILD_CORRECTION',        label: 'Mild Correction (−15 % US equity)' },
  { value: 'SF_BAY_HOUSING_CRASH',   label: 'SF Bay Housing Crash (−35 %, regional)' },
]);
