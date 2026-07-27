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
import {
  applyBrackets as _applyBrackets,
  applyBracketsDetailed,
  marginalBracketRate as _marginalBracketRate,
  subtractBands,
  flatRateBand,
} from '../bracket-schedule.js';

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
/** Flat rate on collectible gains (IRC §1(h)(4)); statutory, not inflation-indexed. */
const COLLECTIBLES_RATE = 0.28;

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

  /**
   * Net Investment Income Tax (IRC §1411) — a flat 3.8% Chapter-2A surtax on the
   * lesser of net investment income and the excess of MAGI over a statutory
   * threshold. The thresholds are fixed by statute and, unlike the income-tax
   * brackets, are NOT inflation-indexed — so they are intentionally omitted from
   * the InflationAdjustedUsTaxRates scaling list and stay constant across years.
   */
  _niitRate            = 0.038;
  _niitThresholdMfj    = 250_000;
  _niitThresholdSingle = 200_000;

  /**
   * Self-employment tax (SECA, IRC §1401) — design 69. Net SE earnings are the
   * gross SE income × 0.9235 (the §1402(a)(12) employer-half deduction). The
   * Social Security (OASDI) portion is capped at the annual _ficaWageBase (which
   * IS inflation-indexed), coordinated with SS-covered wages that fill the base
   * first; the Medicare (HI) portion is uncapped. The Additional Medicare surtax
   * (IRC §1401(b)(2)) is 0.9% on earned income over a statutory threshold; like
   * the NIIT thresholds it is fixed by statute and NOT inflation-indexed.
   */
  _seNetFactor              = 0.9235;
  _seSsRate                 = 0.124;
  _seMedicareRate           = 0.029;
  _addlMedicareRate         = 0.009;
  _addlMedicareThresholdMfj    = 250_000;
  _addlMedicareThresholdSingle = 200_000;

  computeTax(state) {
    const {
      usOrdinaryIncomeYTD    = 0,
      usNegativeIncomeYTD    = 0,
      usCapitalGainsYTD      = 0,
      usCollectibleGainsYTD  = 0,
      usPenaltyYTD           = 0,
      usSeEarningsYTD        = 0,
      usSsWagesYTD           = 0,
      usFilingSingle         = false,
    } = state;

    const brackets     = usFilingSingle ? this._brackets_single     : this._brackets_mfj;
    const ltcgBrackets = usFilingSingle ? this._ltcg_single         : this._ltcg_mfj;
    const stdDeduction = usFilingSingle ? this._stdDeduction_single : this._stdDeduction_mfj;
    const filingStatus = usFilingSingle ? 'Single' : 'Married Filing Jointly';

    // Step 0: Self-employment tax (SECA, IRC §1401) — design 69. Computed first
    // because half the regular SE tax is an above-the-line deduction reducing AGI
    // (IRC §164(f)). This is NOT circular: SECA depends only on SE earnings and
    // SS-covered wages, never on AGI. See §2.1 of design/69.
    const seNet          = Math.max(0, usSeEarningsYTD) * this._seNetFactor;
    const ssWages        = Math.max(0, usSsWagesYTD);
    const ssBaseLeft     = Math.max(0, this._ficaWageBase - ssWages);   // wage base filled by W-2 wages first
    const seSsTax        = Math.min(seNet, ssBaseLeft) * this._seSsRate;
    const seMedicareTax  = seNet * this._seMedicareRate;
    const selfEmploymentTax = seSsTax + seMedicareTax;                  // regular SE tax (half deductible)
    const seDeduction    = selfEmploymentTax * 0.5;

    // Additional Medicare surtax (IRC §1401(b)(2)) — 0.9% on combined earned
    // income (Medicare wages + net SE earnings) over the statutory threshold.
    const addlMedThreshold  = usFilingSingle ? this._addlMedicareThresholdSingle : this._addlMedicareThresholdMfj;
    const earnedForAddlMed  = ssWages + seNet;
    const additionalMedicareTax = Math.max(0, earnedForAddlMed - addlMedThreshold) * this._addlMedicareRate;

    // Step 1: AGI and taxable ordinary income (AGI reduced by the ½ SE-tax
    // deduction — the surtax is not deductible).
    const agi             = usOrdinaryIncomeYTD - usNegativeIncomeYTD - seDeduction;
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
    //
    // The `Detailed` variants carry the per-band breakdown alongside the same
    // scalar totals (design 71 §3.1–3.2); `.tax` is bit-identical to the scalar
    // `_applyBrackets` these lines used before.
    const ordinarySchedule = applyBracketsDetailed(taxableOrdinary, brackets);
    const feieSchedule     = applyBracketsDetailed(excludedStacked, brackets);
    const ordinaryTax      = ordinarySchedule.tax - feieSchedule.tax;
    const taxableOrdinaryAfterFeie = Math.max(0, taxableOrdinary - excludedStacked);

    // Step 3: long-term capital gains tax — stack on top of taxable ordinary
    // income (IRC §1(h)). Capital gains sit in the brackets above the ordinary
    // income ceiling, so the tax is the bracket differential, not the bracket
    // applied to gains alone.
    const cg              = Math.max(0, usCapitalGainsYTD);
    const ltcgStacked     = applyBracketsDetailed(taxableOrdinaryAfterFeie + cg, ltcgBrackets);
    const ltcgBase        = applyBracketsDetailed(taxableOrdinaryAfterFeie,      ltcgBrackets);
    const capitalGainsTax = ltcgStacked.tax - ltcgBase.tax;

    // Step 4: collectibles taxed at flat 28% rate (IRS §1(h)(4))
    const collectibles    = Math.max(0, usCollectibleGainsYTD);
    const collectiblesTax = collectibles * COLLECTIBLES_RATE;

    // Step 5: the Chapter-1 income tax, split in two because only one half is the
    // §904 limitation base (design 83 G2).
    //
    //   regularTax — the "regular tax liability" of IRC §26(b)(1): Form 1040 line 16
    //     plus Schedule 2 line 1z. Form 1116 line 20 asks for exactly this ("your
    //     total U.S. income tax against which the credit is allowed … Don't include
    //     any taxes listed in section 26(b)(2)").
    //   penaltyTax — the §72(t) additional tax on early withdrawals. A §26(b)(2) tax,
    //     reported in Schedule 2 **Part II** and not on line 1z, so the FTC may not be
    //     credited against it. It is still tax owed: it stays inside grossTax and is
    //     added to netLiability *after* the credit, on the same side of the line as
    //     NIIT / SECA / Additional Medicare below.
    //
    // Before design 83 the penalty sat in the limitation base, which inflated the
    // §904 limit in exactly the years a penalty was incurred — CY2030 of the
    // reference run had a base 12× larger than the true one.
    const penaltyTax  = Math.max(0, usPenaltyYTD);
    const regularTax  = ordinaryTax + capitalGainsTax + collectiblesTax;
    const chapter1Tax = regularTax + penaltyTax;

    // Step 5b: Net Investment Income Tax (IRC §1411) — a flat 3.8% surtax on the
    // lesser of net investment income and (MAGI − statutory threshold). NII is
    // interest/dividends/coupons/net-rents (usNetInvestmentIncomeYTD) plus net
    // capital gains and collectible gains; distributions from qualified
    // retirement plans, wages and Social Security are excluded by construction
    // (they never enter usNetInvestmentIncomeYTD). A US person is taxed on
    // WORLDWIDE net investment income, so AU-source interest, dividends and net
    // rents feed usNetInvestmentIncomeYTD too (via the AU classifiers) — and since
    // NIIT is a Chapter-2A tax outside the FTC system, the AU tax already paid on
    // that income cannot offset the 3.8%. MAGI = AGI + the §911 FEIE
    // add-back (§1411(d)(1)); with no FEIE this is just AGI. NIIT is a Chapter-2A
    // tax OUTSIDE the foreign tax credit system, so it is excluded from the FTC
    // limitation base and added on top of net liability — the FTC can never
    // offset it (per the design decision for cross-border years).
    const niitThreshold       = usFilingSingle ? this._niitThresholdSingle : this._niitThresholdMfj;
    const netInvestmentIncome = Math.max(0, (state.usNetInvestmentIncomeYTD ?? 0) + cg + collectibles);
    // MAGI = AGI + FEIE add-back (§1411(d)). This model's `agi` is ordinary-only
    // (capital/collectible gains are tracked in separate buckets and never folded
    // into it), so the gains — which are part of true AGI — are added back here.
    const magi                = agi + cg + collectibles + feieExcluded;
    const niitBase            = Math.max(0, Math.min(netInvestmentIncome, magi - niitThreshold));
    const niitTax             = niitBase * this._niitRate;

    // Step 5c: the two Form 1116 line-3 inputs that turn a *gross* basket income
    // into a foreign *taxable* income (design 83 G1).
    //
    //   3e — gross income from all sources, before any deduction. The instructions
    //     are explicit that lines 3d and 3e both "include any foreign earned income
    //     you have excluded on Form 2555", so this is deliberately NOT net of FEIE
    //     (line 1a is; the apportionment fraction is not).
    //   3c — the deductions that don't definitely relate to any class of income:
    //     the standard deduction (line 3a) plus, per line 3b, "any other deductions
    //     that don't definitely relate to any specific type of income (for example,
    //     deductions shown on Schedule 1 (Form 1040), Part II, Adjustments to
    //     Income)" — which is where both the ½-SE-tax deduction and this model's
    //     usNegativeIncomeYTD (deductible IRA/401k contributions) live.
    //
    // Including all three is what makes the limitation footable: the identity
    //   totalTaxable = grossIncomeAllSources − unrelatedDeductions − FEIE
    // holds exactly, so Σ basket numerators can never exceed the denominator and
    // the §904 fractions cannot sum past 1. Apportioning the standard deduction
    // alone would leave the SE and contribution deductions unallocated and the
    // fractions could still overshoot.
    const totalGrossIncome      = usOrdinaryIncomeYTD + cg + collectibles;
    const grossIncomeAllSources = Math.max(0, totalGrossIncome);
    const unrelatedDeductions   = stdDeduction + seDeduction + Math.max(0, usNegativeIncomeYTD);

    // Step 6: Foreign Tax Credit — per §904 basket (design 52 §4.3). Replaces the
    // pre-52 `min(ftcYTD, grossTax)` income-credit hack: credit the *actual* AU
    // tax paid on AU-source income (funded into ftcCurrent*/ftcPool* at the AU
    // settle), capped per basket by grossTax × foreignTaxableIncome / totalTaxable,
    // drawing current-year foreign tax first then carryover vintages oldest→newest.
    // The limitation base is the §26(b)(1) regular tax only; NIIT, SECA, the
    // Additional Medicare surtax and the §72(t) penalty are all outside it.
    const ftc          = this._computeFtc(state, {
      grossTax: regularTax,
      totalTaxable: taxableOrdinaryAfterFeie + cg + collectibles,
      grossIncomeAllSources,
      unrelatedDeductions,
      // Per basket: gross foreign income in the category (Form 1116 line 3d) and
      // the part of it excluded on Form 2555 (removed at line 1a, but NOT from 3d).
      //
      // Design 83 G3: each basket is genuinely-foreign income PLUS the US-source
      // income re-sourced to foreign by Art. 27(1)(c), booked to general or passive
      // by character in the US classifiers. There is no third "re-sourced by treaty"
      // basket — see _computeFtc.
      //
      // The re-sourced half is kept in its own accumulators rather than added
      // straight into foreign*IncomeYTD, for one load-bearing reason: the FITO
      // handoff in UsTaxSettleHandler re-runs this whole computation on a
      // counterfactual with the US-source income removed, and it has to be able to
      // remove it from the BASKETS too. Merged in at source, the counterfactual
      // return would keep claiming limitation room for income it no longer contains
      // — which is how design 83 G8 went wrong the first time, and the §904
      // invariants catch it immediately.
      generalGross:    Math.max(0, (state.foreignGeneralIncomeYTD ?? 0) + (state.usSourceGeneralUsdYTD ?? 0)),
      generalExcluded: Math.max(0, feieExcluded),
      passiveGross:    Math.max(0, (state.foreignPassiveIncomeYTD ?? 0) + (state.usSourcePassiveUsdYTD ?? 0)),
    });
    const credits      = ftc.credit;
    // Total gross tax includes NIIT; net liability credits the FTC against the
    // §26(b)(1) regular tax only, then adds the uncreditable taxes back on top.
    // SECA, the Additional Medicare surtax and the §72(t) penalty are Chapter-2/2A
    // or §26(b)(2) taxes: not creditable by the FTC and outside the §904 limitation
    // base — added on top of net liability exactly like NIIT (design 69 §2.1.4,
    // design 83 G2).
    const grossTax     = chapter1Tax + niitTax + selfEmploymentTax + additionalMedicareTax;
    const netLiability = Math.max(0, regularTax - credits)
      + penaltyTax + niitTax + selfEmploymentTax + additionalMedicareTax;

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
      // The exclusion ACTUALLY applied — `feieExcluded` capped at taxable ordinary
      // income by the stacking rule. The two differ when the qualifying exclusion
      // exceeds taxable income, and only this one keeps the Income section footing
      // (design 71 §7.1).
      feieApplied: excludedStacked,
      taxableIncomeAfterFeie: taxableOrdinaryAfterFeie,
      ordinaryTax,
      capitalGainsTax,
      collectiblesTax,
      penaltyTax,
      netInvestmentIncome,
      modifiedAgi: magi,
      niitThreshold,
      niitTax,
      selfEmploymentTax,
      selfEmploymentTaxDeduction: seDeduction,
      seNetEarnings:              seNet,
      additionalMedicareTax,
      // The §26(b)(1) regular tax — the §904 limitation base, and the only tax the
      // FTC may be credited against. `grossTax` is this plus the §26(b)(2)/Chapter-2A
      // taxes (§72(t) penalty, NIIT, SECA, Additional Medicare); design 83 G2.
      regularTax,
      grossTax,
      credits,
      ftc,
      netLiability,
      effectiveRate,
      marginalRate,
      brackets: this._bracketBreakdown({
        filingStatus, ordinarySchedule, feieSchedule, excludedStacked,
        ltcgStacked, ltcgBase, collectibles, collectiblesTax,
        niitThreshold, netInvestmentIncome, magi, niitBase, niitTax,
        usSeEarningsYTD, seNet, ssWages, ssBaseLeft, seSsTax, seMedicareTax,
        selfEmploymentTax, seDeduction,
        addlMedThreshold, earnedForAddlMed, additionalMedicareTax,
      }),
      lineItems: [
        { label: 'Gross Ordinary Income',               amount:  usOrdinaryIncomeYTD },
        { label: 'Adjustments (Pre-tax Contributions)', amount: -usNegativeIncomeYTD },
        ...(seDeduction > 0
          ? [{ label: '½ Self-Employment Tax Deduction', amount: -seDeduction }]
          : []),
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
        ...(niitTax > 0
          ? [{ label: 'Net Investment Income Tax (3.8%)', amount: niitTax }]
          : []),
        ...(selfEmploymentTax > 0
          ? [{ label: 'Self-Employment Tax (SECA)',       amount: selfEmploymentTax }]
          : []),
        ...(additionalMedicareTax > 0
          ? [{ label: 'Additional Medicare Tax (0.9%)',   amount: additionalMedicareTax }]
          : []),
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
   * Per-band breakdown of every bracketed and flat-rate tax in this return —
   * design 71 §3.3. Purely derived from figures `computeTax` already computed; it
   * adds no arithmetic of its own, so it cannot change a liability. Reported on the
   * TaxComputationResult so the tax worksheet export can show *which* income fell in
   * *which* bracket, and so `Σ band.tax` can be checked against the line total.
   *
   * @returns {object} see design 71 §3.3 for the shape
   */
  _bracketBreakdown({
    filingStatus, ordinarySchedule, feieSchedule, excludedStacked,
    ltcgStacked, ltcgBase, collectibles, collectiblesTax,
    niitThreshold, netInvestmentIncome, magi, niitBase, niitTax,
    usSeEarningsYTD, seNet, ssWages, ssBaseLeft, seSsTax, seMedicareTax,
    selfEmploymentTax, seDeduction,
    addlMedThreshold, earnedForAddlMed, additionalMedicareTax,
  }) {
    // With no FEIE the subtracted stack is all zeros, so reporting the raw ordinary
    // schedule keeps `Σ band.tax` exactly equal to `ordinaryTax` (differencing two
    // schedules can leave sub-ulp residue). When FEIE *is* elected the differenced
    // bands are the substance of the stacking rule, so they are what we report.
    const hasFeie = excludedStacked > 0;

    return {
      table: filingStatus === 'Single' ? 'Single' : 'MFJ',
      ordinary: hasFeie
        ? subtractBands(ordinarySchedule.bands, feieSchedule.bands)
        : ordinarySchedule.bands,
      feieStacked: hasFeie ? feieSchedule.bands : null,
      // The LTCG differential IS the computation (IRC §1(h) stacking), so these
      // bands are always differenced — they show which LTCG band the gain reached
      // given the ordinary income sitting underneath it.
      ltcg: subtractBands(ltcgStacked.bands, ltcgBase.bands),
      collectibles: flatRateBand(COLLECTIBLES_RATE, collectibles, collectiblesTax),
      niit: {
        ...flatRateBand(this._niitRate, niitBase, niitTax),
        threshold: niitThreshold,
        netInvestmentIncome,
        magi,
      },
      // SECA (design 69) is a Chapter-2 tax with its own multi-step worksheet
      // rather than a bracket schedule; null when the household has no SE income
      // and no Additional Medicare exposure.
      seca: (selfEmploymentTax > 0 || additionalMedicareTax > 0)
        ? {
            grossSeIncome:     usSeEarningsYTD,
            netFactor:         this._seNetFactor,
            netEarnings:       seNet,
            ssWageBase:        this._ficaWageBase,
            ssWagesApplied:    ssWages,      // W-2 wages fill the base before SE earnings
            ssBaseRemaining:   ssBaseLeft,
            socialSecurity:    flatRateBand(this._seSsRate, Math.min(seNet, ssBaseLeft), seSsTax),
            medicare:          flatRateBand(this._seMedicareRate, seNet, seMedicareTax),
            tax:               selfEmploymentTax,
            deduction:         seDeduction,  // half, above-the-line (IRC §164(f))
            additionalMedicare: {
              ...flatRateBand(
                this._addlMedicareRate,
                Math.max(0, earnedForAddlMed - addlMedThreshold),
                additionalMedicareTax,
              ),
              threshold:    addlMedThreshold,
              earnedIncome: earnedForAddlMed,
            },
          }
        : null,
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
   * Per-§904-basket Foreign Tax Credit with 10-year carryforward pools — §4.3,
   * with the Form 1116 deduction apportionment of design 83 G1.
   *
   * For each basket (General, Passive — design 83 G3 deleted the third), following
   * the form's own lines:
   *   3d     = gross foreign source income in the category (FEIE still in it)
   *   3f     = 3d ÷ 3e                                       // 3e = gross, all sources
   *   3g     = 3c × 3f                                       // ratable share of deductions
   *   line 7 = (3d − FEIE) − 3g                              // foreign TAXABLE income
   *   frac   = clamp01(line 7 ÷ totalTaxable)
   *   limit  = grossTax × frac                               // §904 limitation
   *   avail  = currentYearForeignTax + Σ pool vintages
   *   credit = min(avail, limit)
   * then draw the credit down current-year-first, carryover oldest→newest, bank
   * the unused current-year remainder as a new vintage, and expire vintages >10y.
   * Pure: returns the credit breakdown AND the resulting pool state; the settle
   * reducer persists nextPool{General,Passive}.
   *
   * Before G1 the numerator was the *gross* basket income while the denominator was
   * net of the standard deduction, so the fractions could sum well past 1 — CY2034 of
   * the reference run produced a single fraction of 5.157. See _assertFtcInvariants.
   */
  _computeFtc(state, {
    grossTax, totalTaxable,
    grossIncomeAllSources = 0, unrelatedDeductions = 0,
    generalGross = 0, generalExcluded = 0,
    passiveGross = 0,
  }) {
    const currentCY = state.currentPeriods?.US?.startMs != null
      ? new Date(state.currentPeriods.US.startMs).getUTCFullYear()
      : 0;

    // Overall §904 headroom. With G1's apportionment the fractions provably sum to
    // ≤ 1, so this can no longer bind on that account — but it stays as a hard
    // backstop against crediting more than the US tax actually due, which would
    // break the return's footing (gross + credits = net). Baskets draw in
    // declaration order; whichever runs second keeps its unused foreign tax banked
    // in its own pool rather than losing it.
    let headroom = Math.max(0, grossTax);

    // Form 1116 line 3g. The fraction 3f uses GROSS foreign income — including
    // anything excluded on Form 2555, which lines 3d and 3e both keep even though
    // line 1a drops it.
    const apportionedShare = (gross) => grossIncomeAllSources > 0
      ? unrelatedDeductions * Math.min(1, gross / grossIncomeAllSources)
      : 0;

    const basket = (gross, excluded, currentTax, pool) => {
      const apportionedDeduction = apportionedShare(gross);
      // Form 1116 line 7 — foreign TAXABLE income: gross in the category, less the
      // Form 2555 exclusion, less the ratable share of unrelated deductions.
      //
      // The zero clamp is an approximation: a real return would carry the shortfall
      // as an overall foreign loss subject to §904(f) recapture in later years,
      // which this model does not track. It bites only in thin-income years, where
      // the absolute dollars are smallest — design 83 §10 records it as accepted.
      const numerator = Math.max(0, gross - excluded - apportionedDeduction);
      const frac  = totalTaxable > 0 ? Math.min(1, Math.max(0, numerator / totalTaxable)) : 0;
      const limit = Math.min(Math.max(0, grossTax) * frac, headroom);
      const poolTotal = Object.values(pool).reduce((s, v) => s + v, 0);
      const avail = currentTax + poolTotal;
      const credit = Math.min(avail, limit);
      headroom = Math.max(0, headroom - credit);
      const { nextPool, currentYearUsed, carryoverUsed } = _drawDownBasket(currentTax, pool, credit, currentCY);
      const carryforwardRemaining = Object.values(nextPool).reduce((s, v) => s + v, 0);
      return { gross, excluded, apportionedDeduction, numerator, frac, limit,
               currentTax, poolTotal, avail, credit,
               currentYearUsed, carryoverUsed, carryforwardRemaining, nextPool };
    };

    // Design 83 G3 — two baskets, not three. The "certain income re-sourced by
    // treaty" category (Form 1116 category F) used to be a third basket here, on the
    // reading that Art. 27(1)(c) re-sourcing needs its own limitation. It does not,
    // for THIS taxpayer: Reg. §1.904-4(k)(1)(iv)(A) disapplies §904(d)(6) and
    // ¶(k)(1) entirely for relief *"solely applicable to U.S. citizens who are
    // residents of the other Contracting State"*, which is Art. 22(4)'s opening
    // clause. Re-sourced income lands in general or passive by its own character;
    // the US classifiers book it there directly.
    //
    // G4 — the vintage pools followed. `ftcPoolResourced` is folded into the general
    // pool below rather than migrated by category, because the pools record only
    // amount and vintage. A simulator has no filed return to preserve, so a
    // re-derived run is the accurate answer and the fold exists only so a SAVED
    // state carrying a resourced balance does not silently lose it.
    // G4 option A+C: re-derive, and heal rather than migrate. A run from simStart
    // never populates these, so on a fresh run both are empty and the fold is a
    // no-op; a SAVED state written before G3 carries real balances, and folding them
    // into general (the residual §904 category) is the bounded, one-line answer.
    // Apportioning each vintage by its year's general/passive income ratio — option
    // B — buys accuracy no simulator needs, since re-running is free and exact.
    const general = basket(generalGross, generalExcluded,
      (state.ftcCurrentGeneral ?? 0) + (state.ftcCurrentResourced ?? 0),
      _mergeVintagePools(state.ftcPoolGeneral ?? {}, state.ftcPoolResourced ?? {}));
    const passive = basket(passiveGross, 0,               state.ftcCurrentPassive ?? 0, state.ftcPoolPassive ?? {});
    const hasActivity = general.avail > 0 || passive.avail > 0
      || general.numerator > 0 || passive.numerator > 0;

    const result = {
      credit: general.credit + passive.credit,
      general, passive,
      nextPoolGeneral:   general.nextPool,
      nextPoolPassive:   passive.nextPool,
      hasActivity,
      // The two denominators of the §904 limitation. Without them a reader can see
      // `frac` and `limit` but cannot check either, since neither the ratio's
      // denominator nor the tax it scales appears anywhere else on the return
      // (design 71 §13).
      totalTaxable,
      limitationBase: grossTax,
      grossIncomeAllSources,
      unrelatedDeductions,
    };
    _assertFtcInvariants(result);
    return result;
  }
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/** Tolerance for the §904 invariants, in USD. Float noise only, not a fudge. */
const FTC_INVARIANT_EPSILON = 0.01;

/**
 * Sum two { [vintageCY]: USD } pools key-wise — design 83 G4.
 *
 * Only ever used to fold the deleted re-sourced pool into general. Returns a fresh
 * object; neither input is mutated, because both are live state and the journal
 * stores diffs by reference (see [[journal-diff-live-alias]]).
 */
function _mergeVintagePools(a, b) {
  if (!b || Object.keys(b).length === 0) return a;
  const out = { ...a };
  for (const [vintage, amount] of Object.entries(b)) {
    out[vintage] = (out[vintage] ?? 0) + amount;
  }
  return out;
}

/**
 * True in dev/test, false in a production build — mirrors the AU_ATTRIBUTION_STRICT
 * gate in tax-settle-service.js. A broken §904 limitation is a programming error
 * being introduced right now and is worth failing on at the point of introduction;
 * a user's run should survive it.
 */
function _ftcStrict() {
  try {
    if (typeof process !== 'undefined' && process.env) {
      if (process.env.FTC_LIMITATION_STRICT === 'off') return false;
      if (process.env.FTC_LIMITATION_STRICT === 'on')  return true;
      if (process.env.NODE_ENV === 'production') return false;
    }
  } catch { /* no process (browser) */ }
  try {
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.PROD) return false;
  } catch { /* import.meta.env absent */ }
  return true;
}

/**
 * The §904 invariants — design 83 §8. None of these were asserted before, and
 * `npm run crossfoot` cannot see them: it only checks worksheet lines carrying a
 * `drillReport` link, and no §904 line has one. A limitation fraction of 5.157 sat
 * in a shipped export for weeks because nothing here was checked.
 *
 * 1. each basket's foreign taxable income ≤ the total taxable income it divides by;
 * 2. the fractions sum to ≤ 1 (they partition one taxpayer's income);
 * 3. total credit ≤ the limitation base.
 *
 * (1) and (2) hold by construction once the unrelated deductions are apportioned
 * (G1): the identity totalTaxable = grossIncomeAllSources − unrelatedDeductions −
 * FEIE makes Σ numerators ≤ totalTaxable exact. So a failure here means the basket
 * accumulators no longer partition gross income — a classifier double-counting or
 * routing income to a basket without adding it to the US totals — which is a real
 * bug worth stopping on, not a rounding issue.
 *
 * Warn-then-throw rather than a bare throw so the message names the offender; in a
 * production build it degrades to a console warning.
 */
function _assertFtcInvariants(ftc) {
  const { totalTaxable, limitationBase, general, passive } = ftc;
  const baskets = [['general', general], ['passive', passive]]
    .filter(([, b]) => b != null);

  const failures = [];
  for (const [name, b] of baskets) {
    if (b.numerator > totalTaxable + FTC_INVARIANT_EPSILON) {
      failures.push(`${name} numerator ${b.numerator.toFixed(2)} exceeds §904 denominator ${totalTaxable.toFixed(2)}`);
    }
  }
  const fracSum = baskets.reduce((s, [, b]) => s + b.frac, 0);
  if (fracSum > 1 + FTC_INVARIANT_EPSILON) {
    failures.push(`§904 fractions sum to ${fracSum.toFixed(5)}, which exceeds 1`);
  }
  if (ftc.credit > limitationBase + FTC_INVARIANT_EPSILON) {
    failures.push(`credit ${ftc.credit.toFixed(2)} exceeds the limitation base ${limitationBase.toFixed(2)}`);
  }
  if (failures.length === 0) return;

  const message = `§904 limitation invariant violated — ${failures.join('; ')}. `
    + `Gross income all sources ${ftc.grossIncomeAllSources?.toFixed(2)}, `
    + `unrelated deductions ${ftc.unrelatedDeductions?.toFixed(2)}, `
    + `basket gross ${baskets.map(([n, b]) => `${n}=${b.gross?.toFixed(2)}`).join(' ')}. `
    + 'The basket accumulators should partition gross income (design 83 §8).';
  if (_ftcStrict()) throw new Error(message);
  console.warn(message);
}

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

// `_applyBrackets` / `_marginalBracketRate` used to live here as private copies,
// duplicated byte-for-byte in the AU and US-state rate modules. Design 71 §3 moved
// them to the shared `../bracket-schedule.js` — imported at the top of this file
// under the same local names — and added the per-band detail that `computeTax` now
// reports in its `brackets` field.
