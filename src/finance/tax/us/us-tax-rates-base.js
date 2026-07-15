/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseTaxRatesModule } from '../base-tax-rates-module.js';
import { toUSD } from '../tax-fx.js';

/**
 * UsTaxRatesBase — base class for US federal tax rate computation.
 *
 * Implements computeTax() supporting two filing statuses:
 *   - Married Filing Jointly (MFJ): default when state.usFilingSingle is falsy
 *   - Single:                       used when state.usFilingSingle === true
 *
 * Subclasses set year-specific bracket tables and deduction amounts for both
 * filing statuses.
 *
 * State fields consumed:
 *   usOrdinaryIncomeYTD, usNegativeIncomeYTD, usCapitalGainsYTD,
 *   usPenaltyYTD, usFilingSingle, plus the design-52 cross-border-relief fields
 *   (foreign{General,Passive}IncomeYTD, ftcCurrent*, ftcPool*, usFeieElected)
 */
export class UsTaxRatesBase extends BaseTaxRatesModule {
  get countryCode() { return 'US'; }

  // Subclasses set these in their constructors:

  /** Ordinary income brackets (MFJ): [[threshold, rate], ...] ascending by threshold */
  _brackets_mfj     = [];
  /** Long-term capital gains brackets (MFJ): [[threshold, rate], ...] ascending */
  _ltcg_mfj         = [];
  /** Standard deduction for MFJ filing status */
  _stdDeduction_mfj = 0;

  /** Ordinary income brackets (Single): [[threshold, rate], ...] ascending by threshold */
  _brackets_single     = [];
  /** Long-term capital gains brackets (Single): [[threshold, rate], ...] ascending */
  _ltcg_single         = [];
  /** Standard deduction for Single filing status */
  _stdDeduction_single = 0;

  /** Social Security wage base (informational; not used in income tax calc) */
  _ficaWageBase     = 0;

  /**
   * Foreign Earned Income Exclusion cap (Form 2555), USD (design 52 §4.2).
   * Year-specific statutory amount set on each subclass; 0 on the base means no
   * exclusion. Inflation-indexed by InflationAdjustedUsTaxRates like the brackets,
   * so 2026+ derive from the 2025 base × the cumulative factor.
   */
  _feieCap = 0;

  computeTax(state) {
    const {
      usOrdinaryIncomeYTD    = 0,
      usNegativeIncomeYTD    = 0,
      usCapitalGainsYTD      = 0,
      usCollectibleGainsYTD  = 0,
      usPenaltyYTD           = 0,
      usFilingSingle         = false,
    } = state;

    const brackets     = usFilingSingle ? this._brackets_single     : this._brackets_mfj;
    const ltcgBrackets = usFilingSingle ? this._ltcg_single         : this._ltcg_mfj;
    const stdDeduction = usFilingSingle ? this._stdDeduction_single : this._stdDeduction_mfj;
    const filingStatus = usFilingSingle ? 'Single' : 'Married Filing Jointly';

    // Step 1: AGI and taxable ordinary income
    const agi             = usOrdinaryIncomeYTD - usNegativeIncomeYTD;
    const taxableOrdinary = Math.max(0, agi - stdDeduction);

    // Step 1b: FEIE (Form 2555) — exclude foreign *earned* income up to the cap
    // per qualifying person (design 52 §4.2). Excluded income is already inside
    // usOrdinaryIncomeYTD/agi (AU wages/SE are worldwide income), so the exclusion
    // is applied via the IRS stacking method below rather than by reducing AGI.
    const feieExcluded    = this._computeFeie(state);
    const excludedStacked = Math.min(feieExcluded, taxableOrdinary);

    // Step 2: ordinary income tax via marginal brackets, with the FEIE stacking
    // rule (IRS Foreign Earned Income Tax Worksheet): the non-excluded income is
    // taxed at its true marginal rate, i.e. tax(all) − tax(excluded stacked at the
    // bottom). With feieExcluded = 0 this is exactly tax(taxableOrdinary).
    const ordinaryTax    = _applyBrackets(taxableOrdinary, brackets)
                         - _applyBrackets(excludedStacked, brackets);
    const taxableOrdinaryAfterFeie = Math.max(0, taxableOrdinary - excludedStacked);

    // Step 3: long-term capital gains tax — stack on top of taxable ordinary
    // income (IRC §1(h)). Capital gains sit in the brackets above the ordinary
    // income ceiling, so the tax is the bracket differential, not the bracket
    // applied to gains alone.
    const cg             = Math.max(0, usCapitalGainsYTD);
    const capitalGainsTax = _applyBrackets(taxableOrdinaryAfterFeie + cg, ltcgBrackets)
                          - _applyBrackets(taxableOrdinaryAfterFeie, ltcgBrackets);

    // Step 4: collectibles taxed at flat 28% rate (IRS §1(h)(4))
    const collectibles    = Math.max(0, usCollectibleGainsYTD);
    const collectiblesTax = collectibles * 0.28;

    // Step 5: gross liability including early-withdrawal penalties
    const penaltyTax = Math.max(0, usPenaltyYTD);
    const grossTax   = ordinaryTax + capitalGainsTax + collectiblesTax + penaltyTax;

    // Step 6: Foreign Tax Credit — per §904 basket (design 52 §4.3). Replaces the
    // pre-52 `min(ftcYTD, grossTax)` income-credit hack: credit the *actual* AU
    // tax paid on AU-source income (funded into ftcCurrent*/ftcPool* at the AU
    // settle), capped per basket by grossTax × foreignBasketIncome / totalTaxable,
    // drawing current-year foreign tax first then carryover vintages oldest→newest.
    const ftc          = this._computeFtc(state, {
      grossTax,
      totalTaxable: taxableOrdinaryAfterFeie + cg + collectibles,
      generalNumerator: Math.max(0, (state.foreignGeneralIncomeYTD ?? 0) - feieExcluded),
      passiveNumerator: Math.max(0, state.foreignPassiveIncomeYTD ?? 0),
    });
    const credits      = ftc.credit;
    const netLiability = Math.max(0, grossTax - credits);

    const totalGrossIncome = usOrdinaryIncomeYTD + cg + collectibles;
    const effectiveRate    = totalGrossIncome > 0 ? netLiability / totalGrossIncome : 0;
    const marginalRate     = _marginalBracketRate(taxableOrdinary, brackets);

    return {
      filingStatus,
      inputs: {
        grossOrdinaryIncome: usOrdinaryIncomeYTD,
        adjustments:         usNegativeIncomeYTD,
        capitalGains:        usCapitalGainsYTD,
        collectibleGains:    usCollectibleGainsYTD,
        penalties:           usPenaltyYTD,
        foreignEarnedIncomeExclusion: feieExcluded,
        standardDeduction:   stdDeduction,
      },
      adjustedGrossIncome: agi,
      taxableIncome:       taxableOrdinary,
      feieExcluded,
      taxableIncomeAfterFeie: taxableOrdinaryAfterFeie,
      ordinaryTax,
      capitalGainsTax,
      collectiblesTax,
      penaltyTax,
      grossTax,
      credits,
      ftc,
      netLiability,
      effectiveRate,
      marginalRate,
      lineItems: [
        { label: 'Gross Ordinary Income',               amount:  usOrdinaryIncomeYTD },
        { label: 'Adjustments (Pre-tax Contributions)', amount: -usNegativeIncomeYTD },
        { label: 'Adjusted Gross Income',               amount:  agi },
        { label: 'Standard Deduction',                  amount: -stdDeduction },
        { label: 'Taxable Ordinary Income',             amount:  taxableOrdinary },
        ...(feieExcluded > 0
          ? [{ label: 'Foreign Earned Income Exclusion (Form 2555)', amount: -excludedStacked }]
          : []),
        { label: 'Tax on Ordinary Income',              amount:  ordinaryTax },
        { label: 'Long-Term Capital Gains Tax',         amount:  capitalGainsTax },
        { label: 'Collectibles Tax (28%)',              amount:  collectiblesTax },
        { label: 'Early Withdrawal Penalties',          amount:  penaltyTax },
        { label: 'Gross Tax',                           amount:  grossTax },
        ...(ftc.hasActivity
          ? [
              { label: 'Foreign Tax Credit — General (§904)', amount: -ftc.general.credit },
              { label: 'Foreign Tax Credit — Passive (§904)', amount: -ftc.passive.credit },
            ]
          : [{ label: 'Foreign Tax Credit',              amount: -credits }]),
        { label: 'Net Tax Liability',                   amount:  netLiability },
      ],
    };
  }

  /**
   * Foreign Earned Income Exclusion (Form 2555), USD — design 52 §4.2.
   *
   * When `usFeieElected`, exclude each qualifying person's AU-source *earned*
   * income (wages/SE, tracked in AUD by auPersonEarnedIncomeYTD) up to that
   * person's own cap (`_feieCap`, MFJ answer: each spouse's own cap), then
   * aggregate. A person qualifies only while AU-resident AND after the first
   * full qualifying tax year — a partial-year move-in is suppressed (proxying
   * the BFR/PPT timing) by comparing the person's `residencySinceMs` stamp to
   * the start of the US tax year. `residencySinceMs == null` means resident from
   * the outset (no mid-sim move), which qualifies.
   *
   * Returns 0 when FEIE is not elected or `_feieCap` is 0, so the stacking calc
   * collapses to the plain bracket tax (byte-identical to pre-52 behavior).
   */
  _computeFeie(state) {
    if (!state.usFeieElected || !(this._feieCap > 0)) return 0;
    const people    = state.people ?? {};
    const earnedMap = state.auPersonEarnedIncomeYTD ?? {};
    const taxYearStartMs = state.currentPeriods?.US?.startMs ?? null;

    let excluded = 0;
    for (const [key, person] of Object.entries(people)) {
      if (!person || person.residency !== 'AU') continue;
      const since = person.residencySinceMs;
      const fullYear = since == null || (taxYearStartMs != null && since <= taxYearStartMs);
      if (!fullYear) continue;   // suppress the partial move-in year
      const earnedUsd = toUSD(earnedMap[key] ?? 0, 'AUD', state);
      excluded += Math.min(Math.max(0, earnedUsd), this._feieCap);
    }
    return excluded;
  }

  /**
   * Per-§904-basket Foreign Tax Credit with 10-year carryforward pools — §4.3.
   *
   * For each basket (General, Passive):
   *   frac   = clamp01(basketForeignIncome / totalTaxable)   // post-FEIE
   *   limit  = grossTax × frac                                // §904 limitation
   *   avail  = currentYearForeignTax + Σ pool vintages
   *   credit = min(avail, limit)
   * then draw the credit down current-year-first, carryover oldest→newest, bank
   * the unused current-year remainder as a new vintage, and expire vintages >10y.
   * Pure: returns the credit breakdown AND the resulting pool state; the settle
   * reducer persists nextPool{General,Passive}.
   */
  _computeFtc(state, { grossTax, totalTaxable, generalNumerator, passiveNumerator }) {
    const currentCY = state.currentPeriods?.US?.startMs != null
      ? new Date(state.currentPeriods.US.startMs).getUTCFullYear()
      : 0;

    const basket = (numerator, currentTax, pool) => {
      const frac  = totalTaxable > 0 ? Math.min(1, Math.max(0, numerator / totalTaxable)) : 0;
      const limit = Math.max(0, grossTax) * frac;
      const poolTotal = Object.values(pool).reduce((s, v) => s + v, 0);
      const avail = currentTax + poolTotal;
      const credit = Math.min(avail, limit);
      const { nextPool, currentYearUsed, carryoverUsed } = _drawDownBasket(currentTax, pool, credit, currentCY);
      const carryforwardRemaining = Object.values(nextPool).reduce((s, v) => s + v, 0);
      return { numerator, frac, limit, currentTax, poolTotal, avail, credit,
               currentYearUsed, carryoverUsed, carryforwardRemaining, nextPool };
    };

    const general = basket(generalNumerator, state.ftcCurrentGeneral ?? 0, state.ftcPoolGeneral ?? {});
    const passive = basket(passiveNumerator, state.ftcCurrentPassive ?? 0, state.ftcPoolPassive ?? {});
    const hasActivity = general.avail > 0 || passive.avail > 0
      || generalNumerator > 0 || passiveNumerator > 0;

    return {
      credit: general.credit + passive.credit,
      general, passive,
      nextPoolGeneral: general.nextPool,
      nextPoolPassive: passive.nextPool,
      hasActivity,
    };
  }
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Draw `creditUsed` from a basket's foreign-tax sources and return the updated
 * vintage pool (design 52 §4.3). Order: current-year foreign tax first, then
 * carryover vintages oldest→newest. The unused remainder of the current-year tax
 * opens a new vintage keyed by the settle year; vintages older than 10 years
 * (settleYear − vintage > 10) expire. Uses a small epsilon to drop residual dust.
 *
 * @param {number} currentTax  current-year foreign tax available (USD)
 * @param {Record<string, number>} pool  existing vintages { [vintageCY]: USD }
 * @param {number} creditUsed  credit actually taken this year (≤ currentTax + Σpool)
 * @param {number} currentCY   settle calendar year (vintage key for the remainder)
 */
export function _drawDownBasket(currentTax, pool, creditUsed, currentCY) {
  const EPS = 1e-9;
  let remaining = creditUsed;

  // 1. current-year foreign tax first
  const fromCurrent = Math.min(remaining, currentTax);
  remaining -= fromCurrent;
  const currentRemainder = currentTax - fromCurrent;

  // 2. carryover vintages, oldest → newest
  const nextPool = {};
  let carryoverUsed = 0;
  for (const v of Object.keys(pool).map(Number).sort((a, b) => a - b)) {
    const avail = pool[v];
    const draw  = Math.min(remaining, avail);
    remaining     -= draw;
    carryoverUsed += draw;
    const left = avail - draw;
    if (left > EPS) nextPool[v] = left;
  }

  // 3. bank the unused current-year remainder as a new vintage
  if (currentRemainder > EPS) {
    nextPool[currentCY] = (nextPool[currentCY] ?? 0) + currentRemainder;
  }

  // 4. expire vintages older than the 10-year §904(c) window
  for (const v of Object.keys(nextPool)) {
    if (currentCY - Number(v) > 10) delete nextPool[v];
  }

  return { nextPool, currentYearUsed: fromCurrent, carryoverUsed };
}

/**
 * Apply marginal brackets to an income amount.
 * brackets: [[threshold, rate], ...] sorted ascending by threshold.
 */
function _applyBrackets(income, brackets) {
  if (income <= 0) return 0;
  let tax = 0;
  for (let i = 0; i < brackets.length; i++) {
    const [lo, rate] = brackets[i];
    const hi = i + 1 < brackets.length ? brackets[i + 1][0] : Infinity;
    if (income <= lo) break;
    tax += (Math.min(income, hi) - lo) * rate;
  }
  return tax;
}

/** Return the marginal rate of the highest bracket reached by income. */
function _marginalBracketRate(income, brackets) {
  if (income <= 0 || brackets.length === 0) return 0;
  let rate = 0;
  for (const [lo, r] of brackets) {
    if (income > lo) rate = r;
  }
  return rate;
}
