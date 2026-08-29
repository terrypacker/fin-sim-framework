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

  /**
   * Dot-com bust (2000-2002) — the SLOW, US-led, DISINFLATIONARY bear market, and the
   * shape none of the other presets carry. Where the GFC/COVID presets are a deep
   * instantaneous drop with a quick fade, this is a 30-month grind: a moderate level
   * break followed by a long stretch of negative forward returns that only unwinds
   * after 18 months (U profile, 36 months).
   *
   * Four things distinguish it, and all four matter to a reserve/bucket study:
   *
   *  1. **Duration, not depth.** A 2-year bond bucket survives a 2008; it is exhausted
   *     by a 2000. Peak-to-trough took 30 months and the S&P did not regain its March
   *     2000 high until late 2007.
   *  2. **US-led and asymmetric.** The S&P fell ~49% and MSCI EAFE ~48%, but the ASX 200
   *     fell only ~22% — no local tech bubble and a resources-heavy index. So the level
   *     effect is an ARRAY of per-market entries rather than one multiplier across every
   *     equity sleeve (the GFC/COVID presets treat US and AU as one crash).
   *  3. **Bonds RALLIED.** The Fed cut 6.5% → 1.0% and the 10-year went 6.5% → 3.6%, so
   *     the fixed-income LEVEL falls and the curve BULL-STEEPENS (short falls further
   *     than long). Duration is a gain here, which is the opposite of a stagflation.
   *  4. **No inflation shock.** US CPI drifted 3.4% → 1.6%. Mild disinflation, not the
   *     1970s.
   *
   * Composition of the equity path (illustrative, US): a −35% level break plus a −20pp
   * forward-return drag held flat for 18 months and fading to zero at 36 puts the US
   * sleeve at −47% around month 30 — the depth and the timing of the real episode
   * (−49% at 30 months), without a rebound overshoot the framework cannot express.
   * Measured, not asserted: `scenarios/offset-bond-pool/probe-dotcom-path.mjs`.
   *
   * Policy rates move on PRIME_US / PRIME_AU only, never on SAVINGS_*. Prime-linked cash
   * accounts and variable loans pick the cut up through PrimeRelinkReducer, and because
   * that reducer ADDS the Prime delta to the per-account savings key, moving both keys
   * would cut a linked account twice. An account authored with a fixed savings rate opted
   * out of the policy link, so it correctly does not move.
   */
  DOTCOM_2000_LITE: {
    shockId:  'DOTCOM_2000_LITE',
    name:     'Dot-Com Bust (2000-2002 style)',
    severity: 0.35,
    levelEffects: {
      // Array form (per-market severities). `severity` scales the whole vector
      // proportionally, so the ratios between markets survive an MC sweep.
      equityRevaluation: [
        { rateKeys: ['EQUITY_US', 'EQUITY_INTL_EX_AU'], multiplier: -0.35 },
        { rateKeys: ['EQUITY_INTL_EX_US'],              multiplier: -0.32 },
        { rateKeys: ['EQUITY_AU'],                      multiplier: -0.18 },
      ],
    },
    // TWO LEGS, because the equity bust and the monetary easing that answered it ran on
    // completely different clocks — and sharing one recovery curve handed back the bond
    // rally this episode is famous for (design 21 §18.6).
    legs: [
      {
        id: 'equity',
        regime: {
          returnAdjustment: {
            EQUITY_US: -0.20, EQUITY_INTL_EX_AU: -0.19, EQUITY_INTL_EX_US: -0.18, EQUITY_AU: -0.09,
          },
          // Dividends held up — payouts were not cut the way they were in 2008/2020; the
          // damage was concentrated in non-payers. A modest trim, not a collapse.
          dividendAdjustment: { EQUITY_US: -0.10, EQUITY_AU: -0.05 },
          // Mild, not GFC-scale: the USD bid of 2000-01 was largely handed back by 2002.
          fxAdjustment:    { USD_AUD: 0.05 },
          fxVolAdjustment: { USD_AUD: 0.25 },
        },
        // U / 36 months: full strength for 18, then fading. The grind a 2-year bucket
        // cannot outlast.
        recovery: { profile: 'U', durationMonths: 36 },
      },
      {
        id: 'rates',
        regime: {
          // The bond LEVEL falls (yields down ⇒ prices up via BondPriceAdjustReducer) and the
          // policy rate is cut. Both sit on this SLOW leg: bonds are supposed to pay here, and
          // on the equity leg's 36-month clock they gave the gain straight back.
          returnAdjustment:       { FIXED_INCOME_US: -0.020, FIXED_INCOME_AU: -0.012 },
          interestRateAdjustment: {
            FIXED_INCOME_US: -0.020, FIXED_INCOME_AU: -0.012,
            PRIME_US:        -0.045, PRIME_AU:        -0.015,
          },
          inflationAdjustment: { US: -0.010, AU: -0.005 },
          // Bull steepener, stated RELATIVE to the level move above (the 5-year point is the
          // curve's anchor, spread 0). Short rates fall a further 1.5pp beyond the level cut;
          // the long end gives back most of it, so 30-year yields barely move in total.
          yieldCurveTwist: {
            US: [{ tenor: 1, spread: -0.015 }, { tenor: 2, spread: -0.010 }, { tenor: 5, spread: 0.000 }, { tenor: 10, spread: 0.008 }, { tenor: 30, spread: 0.013 }],
            AU: [{ tenor: 1, spread: -0.010 }, { tenor: 2, spread: -0.007 }, { tenor: 5, spread: 0.000 }, { tenor: 10, spread: 0.005 }, { tenor: 30, spread: 0.008 }],
          },
        },
        // U / 84 months — the leg that makes this preset honest. Full easing for 42 months
        // (a shock at Mar 2000 holds the cut through late 2003, when the funds rate really was
        // at 1%), then fading to baseline by 2007, which is about when the 10-year got back to
        // ~5%. On the equity leg's 36-month clock the rate cut round-tripped to zero by 2003
        // and the bond sleeve handed back every dollar of its rally.
        recovery: { profile: 'U', durationMonths: 84 },
      },
    ],
    // The shock-level `recovery` is what a single-leg reader sees; it names the EQUITY leg,
    // which is the one that defines the episode's shape. `legs` is authoritative when present.
    recovery: { profile: 'U', durationMonths: 36 },
  },

  /**
   * Lost decade (2000-2012) — the SEQUENCE-RISK case, and the one a reserve actually exists
   * for. Distinct from `DOTCOM_2000_LITE`, which models the 2000-2002 BUST: a break, a
   * 30-month grind, and then forward returns hand the baseline straight back. That is two bad
   * years inside a sixteen-year plan, and a plan whose equity earns its full baseline in
   * fourteen of sixteen years does not need a bond reserve — it needs equity.
   *
   * What made the dot-com era ruinous for a retiree was not the drawdown, it was the DECADE.
   * The S&P 500 first closed above its March 2000 high in 2013; total return over 2000-2012
   * was roughly flat in nominal terms and negative in real terms. That is the world where
   * "hold the 10% asset" stops being obvious, because the 10% does not arrive.
   *
   * Composition: a −30 % break plus a −7pp forward-return drag held FLAT for 120 months
   * (L profile — no fade, then baseline resumes). Against a 10 % baseline that is ~3 %/yr for
   * ten years, so the decade compounds to ≈ 0.70 × 1.03^10 ≈ −6 % nominal — the real figure.
   * A retiree spending through it draws down a book that never recovers, which is precisely
   * the mechanic a bucket strategy is built to survive.
   *
   * Rates ride a matching slow leg: policy stayed easy for most of the decade, so nominal
   * bonds out-earned equities over it (the Agg returned ~6 %/yr against the S&P's ~0 %).
   * That is not a modelling flourish, it is the period's defining fact.
   *
   * ⚠️ An AUTHORED stress, not a forecast, and a harsh one: it asserts a specific decade-long
   * path. Run it as an arm beside the others and never as a constant.
   */
  LOST_DECADE_2000: {
    shockId:  'LOST_DECADE_2000',
    name:     'Lost Decade (2000-2012 style)',
    severity: 0.30,
    levelEffects: {
      equityRevaluation: [
        { rateKeys: ['EQUITY_US', 'EQUITY_INTL_EX_AU'], multiplier: -0.30 },
        { rateKeys: ['EQUITY_INTL_EX_US'],              multiplier: -0.28 },
        { rateKeys: ['EQUITY_AU'],                      multiplier: -0.15 },
      ],
    },
    legs: [
      {
        id: 'equity',
        regime: {
          // −7pp off the baseline for ten years. The AU leg is shallower: the ASX had no tech
          // bubble and the resources cycle carried it through much of the decade.
          returnAdjustment: {
            EQUITY_US: -0.07, EQUITY_INTL_EX_AU: -0.07, EQUITY_INTL_EX_US: -0.06, EQUITY_AU: -0.03,
          },
          dividendAdjustment: { EQUITY_US: -0.10, EQUITY_AU: -0.05 },
          fxAdjustment:    { USD_AUD: 0.04 },
          fxVolAdjustment: { USD_AUD: 0.25 },
        },
        // L / 120: flat at full strength for the whole decade, then the baseline resumes.
        // No fade, because the point of this preset is the ABSENCE of a recovery.
        recovery: { profile: 'L', durationMonths: 120 },
      },
      {
        id: 'rates',
        regime: {
          returnAdjustment:       { FIXED_INCOME_US: -0.015, FIXED_INCOME_AU: -0.010 },
          interestRateAdjustment: {
            FIXED_INCOME_US: -0.015, FIXED_INCOME_AU: -0.010,
            PRIME_US:        -0.035, PRIME_AU:        -0.015,
          },
          yieldCurveTwist: {
            US: [{ tenor: 1, spread: -0.012 }, { tenor: 2, spread: -0.008 }, { tenor: 5, spread: 0.000 }, { tenor: 10, spread: 0.006 }, { tenor: 30, spread: 0.010 }],
            AU: [{ tenor: 1, spread: -0.008 }, { tenor: 2, spread: -0.005 }, { tenor: 5, spread: 0.000 }, { tenor: 10, spread: 0.004 }, { tenor: 30, spread: 0.007 }],
          },
        },
        recovery: { profile: 'L', durationMonths: 120 },
      },
    ],
    recovery: { profile: 'L', durationMonths: 120 },
  },

  /**
   * Bear flattener (design 67 §6) — a curve-SHAPE shock: short rates rise sharply while
   * the long end barely moves, so the curve flattens. Priced as an additive twist over
   * the base shape (positive spread deltas concentrated at the short tenors). V-shaped
   * recovery over 24 months. No level/equity effect — this is a pure term-structure move
   * (the analog of the equity/rate shocks, expressed on the yield curve). Applied to both
   * countries' curves.
   */
  CURVE_BEAR_FLATTENER: {
    shockId:  'CURVE_BEAR_FLATTENER',
    name:     'Bear Flattener (short rates up)',
    severity: null,
    levelEffects: null,
    regime: {
      yieldCurveTwist: {
        US: [{ tenor: 1, spread: 0.015 }, { tenor: 5, spread: 0.008 }, { tenor: 10, spread: 0.003 }, { tenor: 30, spread: 0.000 }],
        AU: [{ tenor: 1, spread: 0.015 }, { tenor: 5, spread: 0.008 }, { tenor: 10, spread: 0.003 }, { tenor: 30, spread: 0.000 }],
      },
    },
    recovery: { profile: 'V', durationMonths: 24 },
  },

  /**
   * Bull steepener (design 67 §6) — the mirror image: short rates fall while the long end
   * holds, so the curve steepens. Negative spread deltas concentrated at the short tenors.
   * V-shaped recovery over 24 months. Both countries.
   */
  CURVE_BULL_STEEPENER: {
    shockId:  'CURVE_BULL_STEEPENER',
    name:     'Bull Steepener (short rates down)',
    severity: null,
    levelEffects: null,
    regime: {
      yieldCurveTwist: {
        US: [{ tenor: 1, spread: -0.015 }, { tenor: 5, spread: -0.008 }, { tenor: 10, spread: -0.002 }, { tenor: 30, spread: 0.000 }],
        AU: [{ tenor: 1, spread: -0.015 }, { tenor: 5, spread: -0.008 }, { tenor: 10, spread: -0.002 }, { tenor: 30, spread: 0.000 }],
      },
    },
    recovery: { profile: 'V', durationMonths: 24 },
  },

  /**
   * Yield-curve inversion (design 67 §6) — short rates rise above long rates (a recession
   * signal): positive spread deltas at the short end, negative at the long end, so the
   * effective curve slopes downward. L-shaped (persists) for 18 months, then snaps back.
   * Both countries.
   */
  CURVE_INVERSION: {
    shockId:  'CURVE_INVERSION',
    name:     'Yield-Curve Inversion (short > long)',
    severity: null,
    levelEffects: null,
    regime: {
      yieldCurveTwist: {
        US: [{ tenor: 1, spread: 0.020 }, { tenor: 2, spread: 0.012 }, { tenor: 5, spread: 0.005 }, { tenor: 10, spread: -0.003 }, { tenor: 30, spread: -0.008 }],
        AU: [{ tenor: 1, spread: 0.020 }, { tenor: 2, spread: 0.012 }, { tenor: 5, spread: 0.005 }, { tenor: 10, spread: -0.003 }, { tenor: 30, spread: -0.008 }],
      },
    },
    recovery: { profile: 'L', durationMonths: 18 },
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
  { value: 'DOTCOM_2000_LITE',       label: 'Dot-Com Bust (2000-2002 style, 36 mo)' },
  { value: 'LOST_DECADE_2000',       label: 'Lost Decade (2000-2012 style, 120 mo)' },
  { value: 'MILD_CORRECTION',        label: 'Mild Correction (−15 % US equity)' },
  { value: 'SF_BAY_HOUSING_CRASH',   label: 'SF Bay Housing Crash (−35 %, regional)' },
  { value: 'CURVE_BEAR_FLATTENER',   label: 'Bear Flattener (yield curve, short up)' },
  { value: 'CURVE_BULL_STEEPENER',   label: 'Bull Steepener (yield curve, short down)' },
  { value: 'CURVE_INVERSION',        label: 'Yield-Curve Inversion (short > long)' },
]);
