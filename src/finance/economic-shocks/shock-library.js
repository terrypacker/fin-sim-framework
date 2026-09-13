/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { REGIME_TAG } from '../economic-regimes/regime-tag.js';

/**
 * Predefined financial shock library.
 *
 * Each entry is a FinancialShock template: all fields except `startDate`, which
 * is supplied at runtime from the `shockStartDate` scenario parameter.
 *
 * These are **calibrated shapes**, not historical reproductions and not forecasts. Every
 * number is derived from a source on disk — see `docs/economic-shocks/SOURCES.md` for the
 * provenance, `MEASUREMENTS.md` for the measured episode, and `CALIBRATION.md` for what
 * each preset's composed path actually produces against it.
 *
 * ── How to read a preset (design 21 §21) ─────────────────────────────────────────
 * A preset does NOT state its drawdown. It states four things that COMPOSE to one:
 *
 *   levelEffects      an instantaneous revaluation at the shock date
 *   returnAdjustment  a forward-return drag, in percentage points off the baseline
 *   recovery.profile  how that drag persists and then unwinds
 *   durationMonths    how long the depressed-return regime LIVES
 *
 * `durationMonths` is not peak-to-trough and not peak-to-back-to-peak. Both of those are
 * EMERGENT: the trough is where `base + drag × recoveryFactor(t)` crosses zero, and the
 * return to the prior peak is wherever compounding gets back there. The calibration target
 * is therefore the pair (trough depth, trough year), with back-to-peak checked afterwards.
 *
 * ── Two things that decide what a number here means ──────────────────────────────
 * 1. **Equity growth is applied ANNUALLY**, on a year-end EventSeries, as `balance × rate`.
 *    The recovery factor is recomputed monthly but for equity it is only ever SAMPLED on
 *    31 December. A decline is therefore only expressible in whole years, and the drags
 *    below are large because one year-end has to carry a whole year of decline.
 * 2. **A crash that took two years to bottom is a drag, not a level break.** Only 8 % of
 *    the GFC's fall and 17 % of the dot-com's happened in the first three months, against
 *    82 % of COVID's. So the fast episodes are level breaks and the slow ones are mostly
 *    drag — which is why the numbers below look so different from each other.
 *
 * ── Tags, and the STRESS WINDOW (design 29 §4.1) ─────────────────────────────────
 * A preset may tag itself. Tags are what the behavioral layer gates on — `PANIC_SELL`,
 * `CASH_BUCKET_DRAWDOWN`, `DOWNTURN_ROTH_CONVERSION`, `CONTRIBUTION_SUSPENSION` and
 * `OPPORTUNISTIC_REBALANCE` all read `regime.tags` and do nothing without one, so an
 * untagged library was a library in which every one of those strategies was configurable
 * and inert. Design 29 §4.1 always said the library sets them; it just never did.
 *
 * Tags are declared on ONE leg, and that leg's `durationMonths` IS the stress window —
 * the tag does not decay with the recovery factor, it is simply present or absent while
 * its regime lives. That makes the choice of leg a real modelling statement, so each
 * tagged preset carries a dedicated `stress` leg with NO adjustments of its own: its only
 * job is to state how long the household behaves as though it is in a crisis. Hanging the
 * tag on the equity leg instead would have inherited that leg's recovery window, which is
 * chosen to fit a PRICE PATH and is much longer — 120 months on the dot-com bust, whose
 * bust phase was 30.
 *
 * The window is the measured peak→trough (MEASUREMENTS §1), floored at 12 months so that
 * it always spans at least one period boundary — the strategies are evaluated on period
 * advance, and a 2-month window (COVID, as measured) could otherwise be stepped over
 * entirely.
 *
 * Which tag, and why not all of them:
 *   ECONOMIC_STRESS      every broad-market equity preset except MILD_CORRECTION.
 *   PANIC_SELL_TRIGGER   only the SHARP falls — GFC, COVID, dot-com. Panic-selling is an
 *                        entry reaction; nobody panics into year six of a lost decade, and
 *                        the strategy fires once per shock anyway.
 *   (none)               MILD_CORRECTION, the control arm that must not break a plan; the
 *                        housing preset, which is not a market-wide event; and the three
 *                        curve shocks, which have no equity leg at all.
 *
 * `severity` is each preset's measured trough depth, and scales the whole shock (level and
 * drag together) when an MC sweep or the optimizer overwrites it.
 *
 * Keys are stable identifiers stored in `parameters.shockPreset`.
 */
const HISTORICAL_SHOCKS = {

  /**
   * Global financial crisis (Oct 2007 – Mar 2009) — the fast, deep, GLOBAL crash.
   *
   * Calibrated to: S&P 500 −50.8 % over 17 months, OECD US broad −53.3 %, OECD AU −49.3 %
   * (MEASUREMENTS §1). Back to the prior peak in 65 months (US).
   *
   * **It is a grind, not a break.** Only 8 % of the fall happened in the first three
   * months — the level effect is therefore small (−4 %) and a −55 pp drag carries the rest
   * across two year-ends. The previous −40 % instant break put the entire drawdown on day
   * one, which for a reserve study is the one thing that cannot be true: it left nothing
   * to bridge.
   */
  MARKET_CRASH_2008_LITE: {
    shockId:   'MARKET_CRASH_2008_LITE',
    name:      'Market Crash (GFC-style)',
    severity:  0.51,                    // the measured trough depth
    levelEffects: {
      // ≈ 8 % of each market's total fall — the part that really was instantaneous.
      equityRevaluation: [
        { rateKeys: ['EQUITY_US', 'EQUITY_INTL_EX_AU'], multiplier: -0.041 },
        { rateKeys: ['EQUITY_INTL_EX_US'],              multiplier: -0.043 },
        { rateKeys: ['EQUITY_AU'],                      multiplier: -0.039 },
      ],
    },
    legs: [
      // Stress window: 17 months, the measured S&P and OECD peak→trough (MEASUREMENTS §1).
      // Not the equity leg's 72 and emphatically not the rates leg's 84 — the easing
      // outlived the crash by years, and a household is not in crisis posture because the
      // funds rate is still at zero.
      {
        id:       'stress',
        tags:     [REGIME_TAG.ECONOMIC_STRESS, REGIME_TAG.PANIC_SELL_TRIGGER],
        recovery: { profile: 'L', durationMonths: 17 },
      },
      {
        id: 'equity',
        regime: {
          returnAdjustment: {
            EQUITY_US: -0.555, EQUITY_INTL_EX_AU: -0.555,
            EQUITY_INTL_EX_US: -0.565, EQUITY_AU: -0.527,
          },
        },
        // U_REBOUND/72: full strength through two year-ends (the 17-month slide), spent at
        // month 25, then a tailwind peaking at 45 % of the drag. The tailwind is what gets
        // the book back to its prior peak at ~year 5 against a measured 65 months; without
        // it, compounding at 7 % needs 96 (design 21 §22).
        recovery: { profile: 'U_REBOUND', durationMonths: 72, reboundStart: 0.35, reboundPeak: 0.45 },
      },
      {
        id: 'markets',
        regime: {
          // S&P 500 dividends per share fell 22.3 % peak-to-trough (MEASUREMENTS §3). The
          // AU figure is the US figure: there is no AU dividend series on disk, and the
          // ASX's financials-heavy payout almost certainly fell further. Flagged, not measured.
          // The two INTERNATIONAL sleeves carry the US figure for the same reason. Naming
          // only US and AU was not a claim that a global fund kept paying through 2008-09 —
          // it was a hole: `effectiveDividendAdjustments` is keyed by the HOLDING's rate key
          // (holdings-earnings.js), so an unnamed sleeve took the price hit and went on
          // paying its full yield. EQUITY_INTL_EX_AU is ~70 % US by construction, so the US
          // figure is close to right there; EQUITY_INTL_EX_US is asserted, like the AU one.
          dividendAdjustment: {
            EQUITY_US: -0.22, EQUITY_AU: -0.22,
            EQUITY_INTL_EX_AU: -0.22, EQUITY_INTL_EX_US: -0.22,
          },
          // The AUD fell 36 % against the USD in four months and was still 18.4 % down a
          // year on. +0.25 on a 1.55 base is ~16 %, between the spike and the 12-month.
          fxAdjustment:    { USD_AUD: 0.25 },
          // Realized USD/AUD volatility ran 2.87× its baseline (MEASUREMENTS §7).
          fxVolAdjustment: { USD_AUD: 1.9 },
        },
        recovery: { profile: 'U', durationMonths: 30 },
      },
      {
        id: 'rates',
        regime: {
          // Fed funds −4.81 pp, US prime −5.00 pp, AU 3-month −3.50 pp (MEASUREMENTS §5).
          // Policy lands on PRIME_* only, never SAVINGS_* — see design 21 §18.4.
          returnAdjustment:       { FIXED_INCOME_US: -0.034, FIXED_INCOME_AU: -0.020 },
          interestRateAdjustment: {
            FIXED_INCOME_US: -0.034, FIXED_INCOME_AU: -0.020,
            PRIME_US:        -0.050, PRIME_AU:        -0.035,
          },
          // Bull steepener about the 5-year anchor, measured 2007-06 → 2008-12:
          // 1y −1.17, 2y −0.74, 10y +0.59, 30y +0.94 (MEASUREMENTS §6).
          yieldCurveTwist: {
            US: [{ tenor: 1, spread: -0.012 }, { tenor: 2, spread: -0.007 }, { tenor: 5, spread: 0.000 }, { tenor: 10, spread: 0.006 }, { tenor: 30, spread: 0.009 }],
            AU: [{ tenor: 1, spread: -0.010 }, { tenor: 2, spread: -0.006 }, { tenor: 5, spread: 0.000 }, { tenor: 10, spread: 0.005 }, { tenor: 30, spread: 0.007 }],
          },
        },
        // The easing outlasted the crash: the funds rate was at zero until 2015.
        recovery: { profile: 'U', durationMonths: 84 },
      },
    ],
    recovery: { profile: 'U_REBOUND', durationMonths: 72 },
  },

  /**
   * Stagflation (1973 – 1982) — the INFLATION episode, and now also the crash inside it.
   *
   * The preset used to carry no level effect at all while the S&P fell 43.4 % nominal and
   * 59.6 % REAL across 1973-74 and the ASX fell 54.1 % (MEASUREMENTS §1). Modelling the
   * decade as an inflation event only understated it badly, so the equity leg is now real.
   *
   * Duration: US CPI YoY averaged 8.3 % across 1972-1982 with a peak of 14.6 %, +5.76 pp
   * over a 2.5 % baseline (MEASUREMENTS §4). That is a DECADE, in three waves — hence
   * L/120 on the inflation leg, not the 48 months this preset used to claim.
   */
  STAGFLATION_1970S_LITE: {
    shockId:  'STAGFLATION_1970S_LITE',
    name:     'Stagflation (1970s-style)',
    severity: 0.43,
    levelEffects: {
      equityRevaluation: [
        { rateKeys: ['EQUITY_US', 'EQUITY_INTL_EX_AU'], multiplier: -0.069 },
        { rateKeys: ['EQUITY_INTL_EX_US'],              multiplier: -0.077 },
        { rateKeys: ['EQUITY_AU'],                      multiplier: -0.087 },
      ],
    },
    legs: [
      // 23 months — the 1973-74 nominal peak→trough (MEASUREMENTS §1), which is the part
      // of the decade that felt like a crash. No panic tag: a ten-year real-terms grind is
      // not an event anyone panic-sells into, and PanicSell only ever fires on entry.
      {
        id:       'stress',
        tags:     [REGIME_TAG.ECONOMIC_STRESS],
        recovery: { profile: 'L', durationMonths: 23 },
      },
      {
        id: 'equity',
        regime: {
          returnAdjustment: {
            EQUITY_US: -0.395, EQUITY_INTL_EX_AU: -0.395,
            EQUITY_INTL_EX_US: -0.418, EQUITY_AU: -0.473,
          },
        },
        // U_REBOUND/120 with a SMALL rebound (0.15): the 1970s recovery was slow and
        // nominal, and in real terms never happened inside the decade at all.
        recovery: { profile: 'U_REBOUND', durationMonths: 120, reboundStart: 0.25, reboundPeak: 0.15 },
      },
      {
        id: 'inflation',
        regime: {
          inflationAdjustment: { US: 0.05, AU: 0.04 },
          // Broad USD weakness. NOTE: the AUD did not float until 12 Dec 1983, so this is
          // NOT readable off USD/AUD — it is the trade-weighted claim (major-currencies
          // dollar −10.7 % over 1973-1980, MEASUREMENTS §7b). Sign supported, magnitude asserted.
          fxAdjustment:    { USD_AUD: -0.10 },
          fxVolAdjustment: { USD_AUD: 0.4 },
        },
        // L/120 — three inflation waves across a decade, no fade inside any plausible window.
        recovery: { profile: 'L', durationMonths: 120 },
      },
      {
        id: 'rates',
        regime: {
          // Fed funds +13.77 pp and US prime +14.24 pp from 1972 to mid-1981; AU 3-month
          // +11.13 pp, AU 10-year +7.32 pp (MEASUREMENTS §5). The 1979-81 curve moved
          // almost in PARALLEL — twist ≤ 0.9 pp at every tenor (§6) — so there is no
          // yieldCurveTwist here. This is a level shock, and duration is the loss.
          returnAdjustment:       { FIXED_INCOME_US: 0.070, FIXED_INCOME_AU: 0.073 },
          interestRateAdjustment: {
            FIXED_INCOME_US: 0.070, FIXED_INCOME_AU: 0.073,
            PRIME_US:        0.140, PRIME_AU:        0.111,
          },
        },
        // U/240, NOT L/120 like the inflation leg. Inflation really did end abruptly —
        // CPI YoY went 14.6 % (Mar 1980) to 3.8 % (Dec 1982) — but YIELDS did not: the
        // 10-year peaked near 15 % in 1981 and took until about 2000 to work back to 6 %.
        //
        // The distinction is not cosmetic here. An L profile SNAPS its adjustment to zero
        // at the end of its window, so a 7 pp yield spike unwinds in a single step and
        // `BondPriceAdjustReducer` marks the whole ladder UP by duration × 7 pp at once.
        // That handed a nominal bond ladder a windfall the 1970s never paid, and it was
        // large enough to make bonds out-earn equity across this whole episode.
        recovery: { profile: 'U', durationMonths: 240 },
      },
    ],
    recovery: { profile: 'L', durationMonths: 120 },
  },

  /**
   * Pandemic crash (Jan – Mar 2020) — the FAST one, and the only preset where an
   * instantaneous level break is the right shape.
   *
   * 82 % of the fall happened inside three months, so the level effect carries the whole
   * drawdown and the drag exists only to set the RECOVERY SPEED. NBER dates the
   * contraction at 2 months, the shortest on record.
   *
   * Depths are monthly averages: S&P −19.1 %, OECD AU −23.8 % (MEASUREMENTS §1). The daily
   * peak-to-trough was far deeper (Nasdaq −30.1 % in 33 days) and the model has no
   * intra-month resolution to express it — reach for `severity` if you want that case.
   */
  COVID_2020_LITE: {
    shockId:   'COVID_2020_LITE',
    name:      'Pandemic Crash (COVID-style)',
    severity:  0.19,
    levelEffects: {
      equityRevaluation: [
        { rateKeys: ['EQUITY_US', 'EQUITY_INTL_EX_AU'], multiplier: -0.191 },
        { rateKeys: ['EQUITY_INTL_EX_US'],              multiplier: -0.220 },
        { rateKeys: ['EQUITY_AU'],                      multiplier: -0.238 },
      ],
    },
    legs: [
      // The sharpest entry in the library — the panic case if there is one. Measured
      // peak→trough is 2 months and back-to-peak 7; the window is FLOORED at 12 so a
      // period-advance-evaluated strategy cannot step straight over it.
      {
        id:       'stress',
        tags:     [REGIME_TAG.ECONOMIC_STRESS, REGIME_TAG.PANIC_SELL_TRIGGER],
        recovery: { profile: 'L', durationMonths: 12 },
      },
      {
        id: 'equity',
        regime: {
          returnAdjustment: {
            EQUITY_US: -0.530, EQUITY_INTL_EX_AU: -0.530,
            EQUITY_INTL_EX_US: -0.383, EQUITY_AU: -0.210,
          },
        },
        // V_REBOUND/36 with reboundStart 0.15: the tailwind starts inside the FIRST year,
        // which is the only way to reproduce a 7-month round trip when equity growth is
        // applied once a year. The US leg is back at its prior peak at year 1 and +68 % at
        // year 5, against a measured +68.4 % (CALIBRATION).
        recovery: { profile: 'V_REBOUND', durationMonths: 36, reboundStart: 0.15, reboundPeak: 0.55 },
      },
      {
        id: 'markets',
        regime: {
          // S&P dividends per share fell 2.3 % (MEASUREMENTS §3). The old −30 % / −20 %
          // was the single largest calibration error in this library. Every sleeve carries
          // the measured figure — see the GFC preset for why the intl keys must be named.
          dividendAdjustment: {
            EQUITY_US: -0.03, EQUITY_AU: -0.03,
            EQUITY_INTL_EX_AU: -0.03, EQUITY_INTL_EX_US: -0.03,
          },
          // CPI YoY FELL to 0.2 % by May 2020 (§4). The 2021-22 inflation was 18 months
          // later, and this framework cannot start a leg late (design 21 §23) — so this
          // preset models the disinflation that actually accompanied the crash, and the
          // inflation that followed it is a SEPARATE shock you schedule yourself.
          inflationAdjustment: { US: -0.015 },
          fxAdjustment:        { USD_AUD: 0.20 },   // +19 % to the spike, reversed by year-end
          fxVolAdjustment:     { USD_AUD: 0.57 },   // measured ×1.57 (§7)
        },
        recovery: { profile: 'V', durationMonths: 9 },
      },
      {
        id: 'rates',
        regime: {
          // Fed funds and prime both −1.50 pp within four months; AU 3-month −0.79 pp (§5).
          // The curve moved almost in parallel (twist ≤ 0.35 pp, §6), so no twist.
          returnAdjustment:       { FIXED_INCOME_US: -0.0145, FIXED_INCOME_AU: -0.006 },
          interestRateAdjustment: {
            FIXED_INCOME_US: -0.0145, FIXED_INCOME_AU: -0.006,
            PRIME_US:        -0.015,  PRIME_AU:        -0.008,
          },
        },
        recovery: { profile: 'U', durationMonths: 36 },
      },
    ],
    recovery: { profile: 'V_REBOUND', durationMonths: 36 },
  },

  /**
   * Mild correction — the low-severity control arm: the thing that should NOT break a plan.
   *
   * Calibrated to 2018 Q4: S&P −11.5 % on monthly averages over 3 months, back to the prior
   * peak in 7, and **dividends did not move at all** (MEASUREMENTS §1, §3) — so the −10 %
   * dividend trim this preset used to carry is gone. 100 % of the fall was inside three
   * months, so it is a pure level break with a fast rebound.
   *
   * US-LED, deliberately: it is the one preset that does not move every sleeve, and the
   * only one that leaves EQUITY_AU and EQUITY_INTL_EX_US untouched.
   *
   * `EQUITY_INTL_EX_AU` moves with it, though, because that sleeve is a global-ex-Australia
   * basket — roughly 70 % US by weight — and a US correction is most of what it holds. It
   * was priced at the framework's market-factor loading for the sleeve AS IT THEN WAS
   * (`DEFAULT_EQUITY_BETA`, 0.95): −0.115 × 0.95 and −0.418 × 0.95. Design 90 §7.4 sourced
   * that beta at 0.81 (11 Sep 2026); this preset was deliberately NOT re-priced with it — a
   * shock preset is a historical episode, and re-calibrating one is its own decision.
   * Leaving it out meant an AU household whose growth sleeve is a global fund felt nothing
   * at all from the library's control-arm correction.
   *
   * It IS tagged `ECONOMIC_STRESS`, and the control-arm property is preserved by the
   * SEVERITY THRESHOLD rather than by the omission (design 21 §24). At `severity` 0.115 it
   * sits below every strategy's 0.25 default, so nothing fires and the arm behaves exactly
   * as an untagged one — but the decision now lives where it can be tuned and swept. A
   * household modelled as jumpy can lower its own threshold and see the dip bite, and an MC
   * sweep that pushes this preset's severity to 0.4 correctly starts suspending, where a
   * hard-coded absence of a tag would have stayed silent at any depth.
   */
  MILD_CORRECTION: {
    shockId:   'MILD_CORRECTION',
    name:      'Mild Correction (−11.5 % US equity)',
    severity:  0.115,
    levelEffects: {
      equityRevaluation: [
        { rateKeys: ['EQUITY_US'],           multiplier: -0.115 },
        { rateKeys: ['EQUITY_INTL_EX_AU'],   multiplier: -0.109 },
      ],
    },
    // The legs form, purely so the stress window can be stated separately from the price
    // path: measured peak→trough is 3 months (floored to 12, §1), against the 24 the
    // rebound needs. The equity leg is what this preset always was.
    legs: [
      {
        id:       'stress',
        tags:     [REGIME_TAG.ECONOMIC_STRESS],
        recovery: { profile: 'L', durationMonths: 12 },
      },
      {
        id: 'equity',
        regime: {
          returnAdjustment: { EQUITY_US: -0.418, EQUITY_INTL_EX_AU: -0.397 },
        },
        recovery: { profile: 'V_REBOUND', durationMonths: 24, reboundStart: 0.12, reboundPeak: 0.55 },
      },
    ],
    recovery: { profile: 'V_REBOUND', durationMonths: 24, reboundStart: 0.12, reboundPeak: 0.55 },
  },

  /**
   * Regional Bay Area housing crash: a level effect matched on a `market` tag rather than
   * a country, which is the point of the preset.
   *
   * Calibrated to Case-Shiller San Francisco: **−45.3 % over 38 months**, back to the prior
   * peak after 116 (MEASUREMENTS §9). The national index fell only −27.4 %, so the regional
   * index fell 1.7× as far in a little over half the time — which is why a country-level
   * rate key would model the wrong thing entirely.
   *
   * There is deliberately no AU housing preset: BIS's AU residential index fell 4.7 %
   * nominal at its worst.
   */
  SF_BAY_HOUSING_CRASH: {
    shockId:   'SF_BAY_HOUSING_CRASH',
    name:      'SF Bay Housing Crash (−45 %)',
    severity:  0.45,
    levelEffects: {
      // Housing is the SLOWEST decline in the library: just **1 %** of San Francisco's
      // fall happened in the first three months, against 8 % for the GFC's equity and 82 %
      // for COVID's. So the level break is almost nothing and the drag is the whole story.
      realEstateRevaluation: {
        rateKeys:   ['REAL_ESTATE_US-SF-BAY'],
        multiplier: -0.006,
      },
    },
    regime: {
      // Property appreciation is applied ANNUALLY (`interval: 'annually'`), the same
      // resolution as equity, so a −31.75 pp drag over three year-ends composes to the
      // measured −45.3 % trough at month 36 against an actual 38.
      appreciationAdjustment: { 'REAL_ESTATE_US-SF-BAY': -0.3175 },
    },
    // U_REBOUND/72: full strength through three year-ends, spent at month 40, then a
    // tailwind. Housing recoveries are slow but they are not baseline-slow — SF took 116
    // months back to its peak, where 4 % appreciation alone would need 216.
    recovery: { profile: 'U_REBOUND', durationMonths: 72, reboundStart: 0.55, reboundPeak: 0.7 },
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
      // ≈ 17 % of each market's fall was inside the first three months; the rest is drag.
      equityRevaluation: [
        { rateKeys: ['EQUITY_US', 'EQUITY_INTL_EX_AU'], multiplier: -0.074 },
        { rateKeys: ['EQUITY_INTL_EX_US'],              multiplier: -0.068 },
        { rateKeys: ['EQUITY_AU'],                      multiplier: -0.024 },
      ],
    },
    // TWO LEGS, because the equity bust and the monetary easing that answered it ran on
    // completely different clocks — and sharing one recovery curve handed back the bond
    // rally this episode is famous for (design 21 §18.6).
    legs: [
      // 30 months: the measured peak→trough, and the reason this preset exists — a bust
      // long enough to exhaust a two-year bucket. The tag goes here rather than on either
      // equity leg because posture is a household property, not a per-sleeve one, and
      // because the US leg's 120-month price window would have claimed a decade of crisis
      // for a 30-month bust.
      {
        id:       'stress',
        tags:     [REGIME_TAG.ECONOMIC_STRESS, REGIME_TAG.PANIC_SELL_TRIGGER],
        recovery: { profile: 'L', durationMonths: 30 },
      },
      {
        // US and international ex-AU: −43.7 % over 30 months, back to the prior peak at 81.
        id: 'equity',
        regime: {
          returnAdjustment: {
            EQUITY_US: -0.395, EQUITY_INTL_EX_AU: -0.395, EQUITY_INTL_EX_US: -0.350,
          },
        },
        // U_REBOUND/120: full strength through two year-ends, spent at month 30, then a
        // MODEST tailwind (0.30). Modest because the 2003-2007 recovery was real but not
        // violent, and because the decade's second half belongs to LOST_DECADE_2000.
        recovery: { profile: 'U_REBOUND', durationMonths: 120, reboundStart: 0.25, reboundPeak: 0.30 },
      },
      {
        // Australia ran a DIFFERENT episode on a DIFFERENT clock, which is the whole reason
        // this preset exists: the ASX did not peak until Feb 2002 — eighteen months after
        // the S&P — fell only 18.5 % over 13 months, and was back to its peak in 28. Then
        // the resources boom took it up 72 % in five years. One shared recovery curve cannot
        // say that and a shared level effect cannot either, so AU gets its own leg.
        id: 'equity-au',
        regime: {
          returnAdjustment: { EQUITY_AU: -0.557 },
        },
        recovery: { profile: 'U_REBOUND', durationMonths: 48, reboundStart: 0.30, reboundPeak: 0.65 },
      },
      {
        id: 'markets',
        regime: {
          // Dividends held up: S&P 500 dividends per share fell just 6.4 % (MEASUREMENTS §3)
          // — the damage was concentrated in companies that paid none. A trim, not a collapse.
          // The intl sleeves take the US figure; AU keeps its own, milder −5 % (the ASX had
          // no tech bubble to deflate).
          dividendAdjustment: {
            EQUITY_US: -0.064, EQUITY_AU: -0.05,
            EQUITY_INTL_EX_AU: -0.064, EQUITY_INTL_EX_US: -0.064,
          },
          // Mild, not GFC-scale: the USD bid of 2000-01 was largely handed back by 2002, and
          // realized USD/AUD volatility barely moved (×1.03, MEASUREMENTS §7).
          fxAdjustment:    { USD_AUD: 0.08 },
          fxVolAdjustment: { USD_AUD: 0.03 },
        },
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
            US: [{ tenor: 1, spread: -0.015 }, { tenor: 2, spread: -0.011 }, { tenor: 5, spread: 0.000 }, { tenor: 10, spread: 0.009 }, { tenor: 30, spread: 0.019 }],
            AU: [{ tenor: 1, spread: -0.010 }, { tenor: 2, spread: -0.007 }, { tenor: 5, spread: 0.000 }, { tenor: 10, spread: 0.005 }, { tenor: 30, spread: 0.011 }],
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
    recovery: { profile: 'U_REBOUND', durationMonths: 120 },
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
    severity: 0.51,
    levelEffects: {
      equityRevaluation: [
        { rateKeys: ['EQUITY_US', 'EQUITY_INTL_EX_AU'], multiplier: -0.30 },
        { rateKeys: ['EQUITY_INTL_EX_US'],              multiplier: -0.28 },
        { rateKeys: ['EQUITY_AU'],                      multiplier: -0.15 },
      ],
    },
    legs: [
      // The one preset whose stress window really is the whole thing: the measured real
      // peak→trough is 103 months and the preset asserts a flat decade. Note what that
      // means downstream — a household running CONTRIBUTION_SUSPENSION here stops
      // contributing for ten years. Faithful to a preset built around the ABSENCE of a
      // recovery, and the harshest window in the library; check it is what you meant
      // before reading an arm that combines the two. No panic tag, for the same reason
      // as stagflation.
      {
        id:       'stress',
        tags:     [REGIME_TAG.ECONOMIC_STRESS],
        recovery: { profile: 'L', durationMonths: 120 },
      },
      {
        id: 'equity',
        regime: {
          // Calibrated to the measured TEN-YEAR CUMULATIVE, which is the only number that
          // matters for this preset: S&P 500 −20.1 % over Mar 2000 → Mar 2010 (MEASUREMENTS
          // §2). A −30 % break plus −5.7 pp for ten years composes to that.
          //
          // The AU drag is ~0 on purpose. Australia did not have a lost decade: the OECD AU
          // index GAINED 50.3 % over the same window. The old −3 pp was a drag where the
          // record has none, and it made an AU-heavy plan look stressed by an episode that
          // never touched it.
          returnAdjustment: {
            EQUITY_US: -0.057, EQUITY_INTL_EX_AU: -0.057, EQUITY_INTL_EX_US: -0.045, EQUITY_AU: -0.005,
          },
          dividendAdjustment: {
            EQUITY_US: -0.10, EQUITY_AU: -0.05,
            EQUITY_INTL_EX_AU: -0.10, EQUITY_INTL_EX_US: -0.10,
          },
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
   * Panic of 1893 — the RAILROAD bust: a capital-spending boom in a new network technology,
   * financed on credit, that ran out of return. The oldest episode in the library, and the
   * one to reach for when the question is "what if an infrastructure build-out over-shoots".
   *
   * Calibrated to (MEASUREMENTS §1, §10):
   *   - S&P (Cowles/Shiller) −32.2 % over 48 months, Aug 1892 → Aug 1896, back to the prior
   *     peak at 76. The railroad stock index alone: −32.7 % over 53, back at 82 — railroads
   *     WERE the market then, so the two paths are nearly the same line.
   *   - FAST ENTRY, THEN A GRIND. The index was flat from Aug 1892 to Jan 1893, fell 5 % by
   *     April, and then 21.3 % in the three panic months Apr → Jul 1893. The rest came in a
   *     sideways-to-down grind with a second dip in 1896 (NBER dates TWO contractions,
   *     Jan 1893–Jun 1894 and Dec 1895–Jun 1897). So this is the reverse of the GFC: the
   *     level break is most of the fall and the drag is the tail.
   *   - The CAPEX collapse is the defining fact: miles of new railroad built fell from
   *     12,876 in 1887 to 1,654 in 1896 (−87 %). The framework has no sector axis, so that
   *     number calibrates nothing here — it is why the preset exists, not what it moves.
   *
   * Four things distinguish it from every other preset in the library:
   *
   *  1. **Deflation.** The general price level fell ~10 % and stayed down for four years
   *     (Snyder, §10). A gold-standard economy with no central bank; nobody eased. In this
   *     framework deflation LOWERS spending, so it partly CUSHIONS a retiree — real total
   *     returns were far milder than the nominal price fall (§10). That is faithful to 1893
   *     and is the first thing to question before reading this preset as a modern forecast.
   *  2. **Money-market spike, then easy money.** NY commercial paper went 5.0 % → 10.9 % at
   *     the panic (Jul 1893) and then averaged 4.2 % for 1894-96: a liquidity squeeze, not a
   *     policy hike, so it lives on its own short leg.
   *  3. **High-grade bonds were the refuge.** Top-grade railroad bond yields spiked only
   *     +0.3 pp and then FELL ~0.5 pp over the decade. Lower-grade railroad bonds defaulted
   *     wholesale (the receiverships), and the framework has no credit-default channel —
   *     so a bond sleeve here behaves like the survivors, which flatters it.
   *  4. **Dividends were cut hard and slowly**: S&P dividends per share −28 % over 36
   *     months — deeper than the GFC's −22 %. Railroads in receivership paid nothing.
   *
   * Market structure: the 1890s were a GLOBAL bust (Baring crisis in London 1890; Australia's
   * banking collapse in 1893, where 13 trading banks suspended in five months and real GDP
   * fell ~10 % then a further 7 % — RBA RDP 1999-06). There is no scripted non-US share-price
   * series for the decade, so every non-US sleeve carries the US figure: SIGN SUPPORTED
   * (the RBA paper), MAGNITUDE ASSERTED. By the RBA's account Australia's depression was the
   * deeper of the two, so the AU sleeve is more likely understated than overstated.
   *
   * No FX leg: the US and the Australian colonies were both on gold/sterling parities, so
   * there is no floating USD/AUD to calibrate against (and the AUD did not float until 1983).
   */
  RAILROAD_PANIC_1893: {
    shockId:  'RAILROAD_PANIC_1893',
    name:     'Railroad Panic (1893-style)',
    severity: 0.32,                     // the measured trough depth
    levelEffects: {
      // The Apr → Jul 1893 panic, −21.3 % in three months (§10): the front-loaded part of
      // the fall. One entry for all four sleeves — see "Market structure" above.
      equityRevaluation: [
        { rateKeys: ['EQUITY_US', 'EQUITY_INTL_EX_AU', 'EQUITY_INTL_EX_US', 'EQUITY_AU'], multiplier: -0.213 },
      ],
    },
    legs: [
      // 48 months: the measured Cowles/Shiller peak→trough. The first five of those were a
      // flat plateau before the panic, but the rule is the measured window (§1), and the
      // 1896 second dip is what makes the trough that late.
      {
        id:       'stress',
        tags:     [REGIME_TAG.ECONOMIC_STRESS, REGIME_TAG.PANIC_SELL_TRIGGER],
        recovery: { profile: 'L', durationMonths: 48 },
      },
      {
        id: 'equity',
        regime: {
          returnAdjustment: {
            EQUITY_US: -0.135, EQUITY_INTL_EX_AU: -0.135,
            EQUITY_INTL_EX_US: -0.135, EQUITY_AU: -0.135,
          },
        },
        // U_REBOUND/84: the drag holds through the 1894-96 grind, is spent around year 4.5,
        // and a STRONG tailwind follows — the 1897-1900 recovery took the index from its
        // trough to +22 % over the 1893 level in four years.
        recovery: { profile: 'U_REBOUND', durationMonths: 84, reboundStart: 0.65, reboundPeak: 1.45 },
      },
      {
        id: 'markets',
        regime: {
          // S&P dividends per share −28 % over 36 months, back to the prior peak at 78
          // (MEASUREMENTS §3). U/72 is flat for the 36-month slide, then fades by month 72.
          // The non-US sleeves take the US figure, as everywhere in this library.
          dividendAdjustment: {
            EQUITY_US: -0.28, EQUITY_AU: -0.28,
            EQUITY_INTL_EX_AU: -0.28, EQUITY_INTL_EX_US: -0.28,
          },
        },
        recovery: { profile: 'U', durationMonths: 72 },
      },
      {
        id: 'prices',
        regime: {
          // Snyder's general price level fell 78 → 70-72 and held there from 1894 to 1897
          // (§10): about −9 % over four years, i.e. −2.3 %/yr, which is −4.8 pp against a
          // 2.5 % baseline. L because the level stayed down and then turned up in 1897.
          // AU: retail prices fell by more than 20 % from 1891 to 1897 (RBA RDP 1999-06,
          // Figure 3) — the same order, held to the same window. Asserted, sign supported.
          //
          // Shiller's pre-1913 CPI shows twice the fall (−20 %); it is a WHOLESALE-price
          // splice, and wholesale prices swing far harder than a household's basket. Snyder
          // is the general price level, which is what spending indexation means.
          inflationAdjustment: { US: -0.05, AU: -0.05 },
        },
        recovery: { profile: 'L', durationMonths: 48 },
      },
      {
        id: 'panic',
        regime: {
          // The liquidity squeeze: NY commercial paper 5.04 % (1890-92 mean) → 10.88 % (Jul
          // 1893), averaging 6.57 % over Aug-Dec and under 4 % by December; high-grade
          // railroad bond yields +0.32 pp at the worst (§10c). V/8 fades it through the autumn.
          returnAdjustment:       { FIXED_INCOME_US: 0.003 },
          interestRateAdjustment: { FIXED_INCOME_US: 0.003, PRIME_US: 0.058 },
        },
        recovery: { profile: 'V', durationMonths: 8 },
      },
      {
        id: 'rates',
        regime: {
          // Then easy money for years: commercial paper averaged 4.17 % over 1894-96 and
          // 3.82 % over 1897-99 against 5.04 % before (−0.9 to −1.2 pp); high-grade railroad
          // bond yields 3.74 % → 3.53 % → 3.24 % (§10c). No AU rates: no series on disk.
          returnAdjustment:       { FIXED_INCOME_US: -0.004 },
          interestRateAdjustment: { FIXED_INCOME_US: -0.004, PRIME_US: -0.010 },
        },
        recovery: { profile: 'U', durationMonths: 84 },
      },
    ],
    recovery: { profile: 'U_REBOUND', durationMonths: 84 },
  },

  /**
   * Panic of 1873 — the FIRST railroad bust, and the harsher one. Jay Cooke & Co. failed in
   * September 1873 on Northern Pacific railroad bonds it could not place, and the market
   * closed for ten days. NBER dates the contraction that followed at **65 months** (Oct 1873
   * → Mar 1879) — the longest in its record.
   *
   * Calibrated to (MEASUREMENTS §1, §11), measured from Aug 1873, the last pre-panic month:
   *   - S&P (Cowles/Shiller) −18.7 % in the three panic months, a RELIEF RALLY through 1874
   *     (−10.1 % a year on), then a second slide to **−45.1 % in June 1877** (46 months),
   *     back to the pre-panic level in January 1880 (77). The running-peak figure in §1 is
   *     −47.3 % from April 1872; the 16 months before the panic were a drift, not the crisis.
   *   - Railroad construction fell 77 % (1871 → 1875, §10d), as in 1893.
   *
   * What makes it different from RAILROAD_PANIC_1893:
   *
   *  1. **Deeper and slower, with the bottom three and a half years in.** 1893 did most of
   *     its damage in the panic; 1873 did less in the panic and most of it in 1876-77. So
   *     this preset is the one for "the crash was survivable, and then it kept going".
   *  2. **The double dip is drawn, not flattened.** A single drag cannot rally in year one
   *     and slide in years three and four — it bottomed at −37 % trying. So a `relief` leg
   *     carries a TAILWIND that holds for 24 months against a much larger drag that outlives
   *     it. The two nearly cancel while both live (the 1874-75 relief, flat prices), and the
   *     drag is left alone for the 1876-77 slide. `applySeverity` scales both legs by the
   *     same ratio, so a severity sweep keeps the shape.
   *  3. **Dividends −45.5 %** over 60 months — the worst cut on disk outside 1929-33 (§3).
   *  4. **Deflation of ~5 %/yr for five years** (Snyder −23 % by Dec 1878), and high-grade
   *     railroad bonds RALLIED: their price rose from 64.6 to 81.3 between Jan 1873 and
   *     Jan 1879 (§11). Same caveat as 1893: in this framework deflation lowers spending and
   *     cushions a retiree — the real total return was positive by the end of 1874.
   *
   * US-LED, deliberately. Unlike 1893 there is no source on disk for ANY non-US market in
   * the 1870s — FRED's NBER UK share series start in 1887 — so this preset shocks EQUITY_US
   * and EQUITY_INTL_EX_AU (a global basket that is ~70 % US by weight, the same reasoning as
   * MILD_CORRECTION) and leaves EQUITY_AU and EQUITY_INTL_EX_US alone. That is a gap in the
   * evidence, not a claim that nothing happened abroad.
   */
  RAILROAD_PANIC_1873: {
    shockId:  'RAILROAD_PANIC_1873',
    name:     'Railroad Panic (1873-style)',
    severity: 0.45,                     // measured trough from the pre-panic month
    levelEffects: {
      // The three panic months, Aug → Nov 1873: −18.7 % (§11).
      equityRevaluation: [
        { rateKeys: ['EQUITY_US', 'EQUITY_INTL_EX_AU'], multiplier: -0.187 },
      ],
    },
    legs: [
      // 46 months: pre-panic month → the June 1877 trough. Not the 62 of the running-peak
      // row in §1, which starts sixteen months before anything happened.
      {
        id:       'stress',
        tags:     [REGIME_TAG.ECONOMIC_STRESS, REGIME_TAG.PANIC_SELL_TRIGGER],
        recovery: { profile: 'L', durationMonths: 46 },
      },
      {
        id: 'equity',
        regime: {
          returnAdjustment: { EQUITY_US: -0.50, EQUITY_INTL_EX_AU: -0.50 },
        },
        // U_REBOUND/108: full strength while the relief leg lives, then it alone drives the
        // 1876-77 slide, is spent around month 57, and a moderate tailwind (0.5) takes the
        // book back to its pre-panic level in year seven against a measured 77 months.
        recovery: { profile: 'U_REBOUND', durationMonths: 108, reboundStart: 0.525, reboundPeak: 0.5 },
      },
      {
        // The 1874 relief rally. Positive, and deliberately almost as large as the drag: net
        // of both the book gains a few percent a year for two years, which is what it did
        // (−18.7 % after the panic, −10.1 % a year later, −11.3 % the year after, §11).
        id: 'relief',
        regime: {
          returnAdjustment: { EQUITY_US: 0.48, EQUITY_INTL_EX_AU: 0.48 },
        },
        recovery: { profile: 'L', durationMonths: 24 },
      },
      {
        id: 'markets',
        regime: {
          // S&P dividends per share −45.5 % over 60 months, back to the prior peak at 120
          // (MEASUREMENTS §3). Only the two sleeves this preset prices — see US-LED above.
          dividendAdjustment: { EQUITY_US: -0.455, EQUITY_INTL_EX_AU: -0.455 },
        },
        recovery: { profile: 'U', durationMonths: 120 },
      },
      {
        id: 'prices',
        regime: {
          // Snyder's general price level −23.2 % from Aug 1873 to Dec 1878 (§11): −4.8 %/yr
          // over 64 months, i.e. about −7 pp against a 2.5 % baseline. L/66 ends at the NBER
          // trough (Mar 1879); the level never came back, it just stopped falling. US only —
          // nothing on disk speaks to Australian prices in the 1870s.
          inflationAdjustment: { US: -0.07 },
        },
        recovery: { profile: 'L', durationMonths: 66 },
      },
      {
        id: 'panic',
        regime: {
          // NY commercial paper 7.06 % (Aug 1873) → 16.50 % (Oct), averaging 13.60 % over
          // Oct-Dec and 9.8 % by December; call money touched a 61 % monthly average.
          // High-grade railroad bond yields +0.44 pp at the worst (§11).
          returnAdjustment:       { FIXED_INCOME_US: 0.004 },
          interestRateAdjustment: { FIXED_INCOME_US: 0.004, PRIME_US: 0.094 },
        },
        recovery: { profile: 'V', durationMonths: 6 },
      },
      {
        id: 'rates',
        regime: {
          // Then a decade of falling rates: commercial paper 5.52 % over 1874-76 and 5.01 %
          // over 1877-79 against 7.06 % (−1.5 to −2.1 pp); high-grade railroad bond yields
          // 6.06 % → 5.51 % → 5.01 % (§11b). U/120 because the long end kept falling.
          returnAdjustment:       { FIXED_INCOME_US: -0.008 },
          interestRateAdjustment: { FIXED_INCOME_US: -0.008, PRIME_US: -0.018 },
        },
        recovery: { profile: 'U', durationMonths: 120 },
      },
    ],
    recovery: { profile: 'U_REBOUND', durationMonths: 108 },
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

};

/**
 * AI capex bust — `RAILROAD_PANIC_1893` WITHOUT its deflation leg. An AUTHORED stress, not a
 * historical episode, and the one preset in the library that is derived rather than written.
 *
 * The question it answers: what does a network build-out bust do to a plan when the economy
 * around it is modern? The equity, dividend and rate legs are 1893's, unchanged: a −21.3 %
 * panic break, a grind to −33 %, dividends −28 %, a money-market spike and then easier money
 * (MEASUREMENTS §10). What is gone is the `prices` leg. In 1893 prices fell ~9 % because the
 * US was on gold with no central bank. In this framework that deflation LOWERS a household's
 * spending, which made 1893 far kinder to a retiree than its price chart suggests: the real
 * total return was positive by 1894 (§10b). A bust met by a central bank that eases would not
 * deflate, so that cushion goes, and inflation runs at the scenario's baseline throughout.
 *
 * What it deliberately does NOT change, so the arm stays a one-variable comparison against
 * 1893: the rate legs keep 1893's size (−1 pp prime, −0.4 pp bonds), which is milder than a
 * modern easing cycle (GFC: prime −5 pp, MEASUREMENTS §5); every sleeve keeps the US figure;
 * and the bond sleeve still behaves like the surviving high grade. A scenario that wants
 * aggressive rate cuts should add a second shock rather than edit this one.
 *
 * Derived, not copied, so a recalibration of 1893 flows straight through.
 */
const AI_CAPEX_BUST_1893 = {
  ...HISTORICAL_SHOCKS.RAILROAD_PANIC_1893,
  shockId: 'AI_CAPEX_BUST_1893',
  name:    'AI Capex Bust (1893 railroad path, no deflation)',
  legs:    HISTORICAL_SHOCKS.RAILROAD_PANIC_1893.legs.filter(leg => leg.id !== 'prices'),
};

export const SHOCK_LIBRARY = Object.freeze({ ...HISTORICAL_SHOCKS, AI_CAPEX_BUST_1893 });

/**
 * Ordered list of {value, label} option descriptors for the `shockPreset` param.
 * The first entry is always the sentinel that means "no shock".
 */
export const SHOCK_PRESET_OPTIONS = Object.freeze([
  { value: 'none',                   label: 'None' },
  { value: 'MARKET_CRASH_2008_LITE', label: 'Market Crash (GFC-style, −51 % over 2 yrs)' },
  { value: 'STAGFLATION_1970S_LITE', label: 'Stagflation (1970s-style, −43 % + 10 yrs inflation)' },
  { value: 'COVID_2020_LITE',        label: 'Pandemic Crash (COVID-style, −19 %, fast rebound)' },
  { value: 'DOTCOM_2000_LITE',       label: 'Dot-Com Bust (2000-2002 style, −44 % over 30 mo)' },
  { value: 'LOST_DECADE_2000',       label: 'Lost Decade (2000-2012 style, flat for 10 yrs)' },
  { value: 'RAILROAD_PANIC_1893',    label: 'Railroad Panic (1893-style, −32 % over 4 yrs, deflation)' },
  { value: 'RAILROAD_PANIC_1873',    label: 'Railroad Panic (1873-style, −45 % double dip, US-led)' },
  { value: 'AI_CAPEX_BUST_1893',     label: 'AI Capex Bust (1893 railroad path, no deflation)' },
  { value: 'MILD_CORRECTION',        label: 'Mild Correction (−11.5 % US equity)' },
  { value: 'SF_BAY_HOUSING_CRASH',   label: 'SF Bay Housing Crash (−45 %, regional)' },
  { value: 'CURVE_BEAR_FLATTENER',   label: 'Bear Flattener (yield curve, short up)' },
  { value: 'CURVE_BULL_STEEPENER',   label: 'Bull Steepener (yield curve, short down)' },
  { value: 'CURVE_INVERSION',        label: 'Yield-Curve Inversion (short > long)' },
]);
