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

/**
 * Ceiling on unrecaptured section 1250 gain — IRC §1(h)(1)(D). Statutory, not indexed.
 * A MAXIMUM, not a flat rate: the slice is stacked on ordinary income and taxed at the
 * ordinary marginal rates up to this cap, so a taxpayer whose marginal rate is below
 * 25% pays their own rate. That distinction is why this is not modelled the way
 * COLLECTIBLES_RATE is — a retired household selling a long-held rental is exactly the
 * taxpayer for whom a flat 25% would be wrong.
 */
const UNRECAPTURED_1250_MAX_RATE = 0.25;

/**
 * The \$20,000 de minimis in the Form 1116 *adjustment exception* — design 90 §4.5 step 9.
 * Below this much foreign source net capital gain (plus foreign qualified dividends, of
 * which this model has none: every dividend it books is taxed at ordinary rates) a
 * taxpayer may elect not to make the §904(b)(2) rate differential adjustment at all.
 *
 * **Not inflation-indexed**, for the same reason `ORDINARY_CAPITAL_LOSS_CAP` is not: it is
 * a fixed figure in the instructions and in Reg. §1.904(b)-1(b)(3), with no indexing
 * mechanism attached. Inflating it would widen an exception Treasury has not widened.
 */
const RATE_DIFFERENTIAL_EXCEPTION_CAP = 20_000;

/**
 * The other half of the adjustment exception: taxable ordinary income (QDCGT worksheet
 * line 5) must not exceed a threshold the Form 1116 instructions state as \$394,600 MFJ /
 * \$197,300 otherwise for 2025.
 *
 * Those are **the floor of the 32% ordinary bracket**, to the dollar — `UsTaxRates2025`
 * already carries `[394_600, 0.32]` and `[197_300, 0.32]`. So the threshold is read off
 * the module's own bracket table rather than transcribed, which makes it track the rate
 * modules and the bracket-inflation wrapper for free. A transcribed pair would be a
 * second, silently stale copy of a figure the module already knows — the
 * `published-base-guard` failure in miniature.
 */
const ADJUSTMENT_EXCEPTION_BRACKET_RATE = 0.32;

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
      usOrdinaryIncomeYTD: _usOrdinaryIncomeRaw = 0,
      usNegativeIncomeYTD    = 0,
      usCapitalGainsYTD      = 0,
      usCollectibleGainsYTD  = 0,
      // Unrecaptured section 1250 gain (design 83 G7 step 3b) — the depreciation slice
      // of a real-property gain, taxed at its own ceiling and never excludable under
      // §121. Absent on every pre-G7 state, so it defaults to a fully inert 0.
      usUnrecaptured1250GainYTD = 0,
      usPenaltyYTD           = 0,
      usSeEarningsYTD        = 0,
      usSsWagesYTD           = 0,
      usFilingSingle         = false,
      // §988 ordinary exchange LOSS on foreign-currency debt (design 86 G7 / P8),
      // stored positive. It is an above-the-line ordinary deduction, taken here
      // rather than netted into usOrdinaryIncomeYTD by the classifier — see the
      // SECTION_988_GAIN classifier for why (G5b: a negative that reduces gross
      // income without reducing any basket breaks the §904 partition). Entering
      // via BOTH `agi` and `unrelatedDeductions` is what keeps the Form 1116
      // identity exact; that is the same pair usNegativeIncomeYTD uses.
      usSection988LossYTD    = 0,
    } = state;

    // Step 0a: §469 passive activity loss limitation (design 86 G5/G5b).
    // Applied before anything else reads income, because it changes what income IS.
    const pal = _computePassiveLossLimitation(state);
    const usOrdinaryIncomeYTD = _usOrdinaryIncomeRaw + pal.adjustment;

    // Step 0a2: §1211/§1212 capital-loss netting (design 90 §4). Runs before anything
    // reads a gain figure, because it decides what each rate group's gain IS: the four
    // `*Gain` outputs below REPLACE the raw YTD accumulators everywhere downstream.
    // Reading `usCapitalGainsYTD` directly past this point is a bug — it is the
    // pre-netting figure and may be negative.
    const capLoss = _computeCapitalLossLimitation(state);

    // Step 0a2: the §904 half of the same netting (design 90 §4.5). Derived here, beside
    // `capLoss`, because it consumes exactly those post-netting figures as Pub 514's
    // "worldwide capital gain" — computing it near its use site in `_computeFtc` would
    // separate it from the thing that defines it.
    const capBasket = _computeCapitalLossBasketAdjustment(state, capLoss);

    // Step 0b: §163(d) investment interest (design 86 G3 error 1). Computed after the
    // §469 pass because its own limit reads `usPassiveActivityIncomeYTD` to carve
    // passive rents out of net investment income, and taken as a deduction below
    // rather than netted into income — see the function's header for both reasons.
    const invInt = _computeInvestmentInterestLimitation(state);

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
    // Short-term capital gain is ORDINARY income for rate purposes — §1(h) reserves the
    // preferential rates for "net capital gain", which §1222(11) defines as the excess of
    // net LONG-term gain over net short-term loss. So it joins AGI here rather than
    // stacking in the LTCG brackets below. The §1211(b) allowance leaves AGI on the same
    // line, alongside the two deductions that already enter this way (design 90 §4.2
    // step 4): `usNegativeIncomeYTD` and `usSection988LossYTD` are the documented pair
    // whose above-the-line treatment keeps the Form 1116 identity exact, and a capital
    // loss deduction belongs in the same place (§62(a)(3)).
    const agi             = usOrdinaryIncomeYTD + capLoss.shortTermGain - capLoss.allowance
                            - usNegativeIncomeYTD - seDeduction - usSection988LossYTD
                            - invInt.allowed;
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

    // Step 2b: unrecaptured section 1250 gain — design 83 G7 step 3b. The slice of a
    // real-property gain attributable to depreciation already taken. §1(h)(1)(D) taxes
    // it at the ordinary rates but never above 25%, and §1(h) stacks it BELOW the
    // 0/15/20 capital-gain layer — so it is computed first and the LTCG layer then
    // stacks on ordinary + this.
    //
    // Modelled as a bracket differential capped at the ceiling, rather than a flat 25%,
    // because "maximum 25%" is doing real work for a retired household: a couple with
    // modest ordinary income pays their own marginal rate on much of the slice. A flat
    // rate would have been simpler and the same shape as COLLECTIBLES_RATE, and it
    // would have overstated the tax for precisely the taxpayer this models.
    // Post-§1211 netting (design 90 §4): a capital loss walks the long-term rate groups
    // highest-rate-first, so each of these three may have been reduced before it is taxed.
    const unrecap1250     = capLoss.unrecaptured1250Gain;
    const u1250Stacked    = applyBracketsDetailed(taxableOrdinaryAfterFeie + unrecap1250, brackets);
    const u1250Base       = applyBracketsDetailed(taxableOrdinaryAfterFeie,               brackets);
    const unrecap1250Tax  = Math.min(u1250Stacked.tax - u1250Base.tax,
                                     unrecap1250 * UNRECAPTURED_1250_MAX_RATE);

    // Step 3: long-term capital gains tax — stack on top of taxable ordinary
    // income (IRC §1(h)). Capital gains sit in the brackets above the ordinary
    // income ceiling, so the tax is the bracket differential, not the bracket
    // applied to gains alone. The §1250 layer sits between the two, so the LTCG base
    // includes it; with no §1250 gain this is bit-identical to the pre-G7 computation.
    const cg              = capLoss.longTermGain;
    const ltcgFloor       = taxableOrdinaryAfterFeie + unrecap1250;
    const ltcgStacked     = applyBracketsDetailed(ltcgFloor + cg, ltcgBrackets);
    const ltcgBase        = applyBracketsDetailed(ltcgFloor,      ltcgBrackets);
    const capitalGainsTax = ltcgStacked.tax - ltcgBase.tax;

    // Step 4: collectibles taxed at flat 28% rate (IRS §1(h)(4))
    const collectibles    = capLoss.collectibleGain;
    const collectiblesTax = collectibles * COLLECTIBLES_RATE;

    // Step 4b: §904(b)(2) capital gain rate differential (design 90 §4.5, step 9).
    // Computed here rather than beside `capBasket` because it needs the 0/15/20 rate-group
    // split, and that split only exists once the LTCG layer has been stacked — which is
    // step 3, two lines up. `ltcgStacked − ltcgBase` band-wise IS the split: the two
    // schedules bracket the same interval, so their per-band differences sum to `cg`.
    const topOrdinaryRate = brackets.length > 0 ? brackets[brackets.length - 1][1] : 0;
    const rateDiff = _computeRateDifferentialAdjustment({
      ltcgBands: ltcgStacked.bands.map((b, i) => ({
        rate: b.rate, income: b.income - (ltcgBase.bands[i]?.income ?? 0),
      })),
      collectibleGain:      collectibles,
      unrecaptured1250Gain: unrecap1250,
      shortTermGain:        capLoss.shortTermGain,
      topOrdinaryRate,
      netGeneral: capBasket.netGeneral ?? 0,
      netPassive: capBasket.netPassive ?? 0,
      // QDCGT worksheet line 5 = taxable income less the preferential-rate layer, which
      // is this model's `taxableOrdinary` exactly. Pre-FEIE-stacking deliberately: Form
      // 1040 line 15 is not reduced by the exclusion either — §911 is applied through the
      // tax worksheet, not by shrinking taxable income.
      taxableOrdinary,
      exceptionThreshold: _adjustmentExceptionThreshold(brackets),
    });

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
    const regularTax  = ordinaryTax + capitalGainsTax + collectiblesTax + unrecap1250Tax;
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
    // Design 90 §4.4 — `26 CFR 1.1411-4` gives TWO rules where this line had one.
    // (d)(2): "The calculation of net gain may not be less than zero" — satisfied by
    // construction, since every gain figure here is post-§1211 netting and floored.
    // (f)(4)(i): the §1211(b) allowance is a DEDUCTION against other net investment
    // income, "the amount of losses that were allowable under chapter 1 in excess of the
    // amounts taken into account in computing net gain" — all of it, since net gain has
    // already floored. Without it a loss year overstated NII by up to the allowance.
    // Short-term gain is net gain too (§1411(c)(1)(A)(iii) does not distinguish character).
    const netGainForNii       = cg + collectibles + unrecap1250 + capLoss.shortTermGain;
    const netInvestmentIncome = Math.max(0, (state.usNetInvestmentIncomeYTD ?? 0) + netGainForNii - capLoss.allowance);
    // MAGI = AGI + FEIE add-back (§1411(d)). This model's `agi` is ordinary-only
    // (capital/collectible gains are tracked in separate buckets and never folded
    // into it), so the gains — which are part of true AGI — are added back here.
    const magi                = agi + cg + collectibles + unrecap1250 + feieExcluded;
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
    // §1250 gain joins the gross and the §904 denominator with the other gain buckets.
    // Leaving it out of either is the G5b failure in miniature: a basket numerator that
    // includes the whole foreign property gain, over a denominator that does not.
    // Short-term gain joins gross income (it is in AGI); the §1211(b) allowance joins the
    // unrelated deductions below. Both are required to keep the Form 1116 identity
    // `totalTaxable = grossIncomeAllSources − unrelatedDeductions − FEIE` exact — the same
    // pairing usNegativeIncomeYTD and the §988 loss already use.
    const totalGrossIncome      = usOrdinaryIncomeYTD + capLoss.shortTermGain + cg + collectibles + unrecap1250;
    const grossIncomeAllSources = Math.max(0, totalGrossIncome);
    const unrelatedDeductions   = stdDeduction + seDeduction + Math.max(0, usNegativeIncomeYTD)
                                  + Math.max(0, usSection988LossYTD)
                                  // §163(d) investment interest (design 86 G3 error 1).
                                  // Form 1116 would apportion it against the investment
                                  // income it definitely relates to; here it joins the
                                  // unrelated pool for the same reason the §988 loss
                                  // does — it is the only route that keeps the identity
                                  // above exact, and both errors point the same way
                                  // (slightly less foreign taxable income in every
                                  // basket, so slightly less credit, never more).
                                  + Math.max(0, invInt.allowed)
                                  + Math.max(0, capLoss.allowance);

    // Step 6: Foreign Tax Credit — per §904 basket (design 52 §4.3). Replaces the
    // pre-52 `min(ftcYTD, grossTax)` income-credit hack: credit the *actual* AU
    // tax paid on AU-source income (funded into ftcCurrent*/ftcPool* at the AU
    // settle), capped per basket by grossTax × foreignTaxableIncome / totalTaxable,
    // drawing current-year foreign tax first then carryover vintages oldest→newest.
    // The limitation base is the §26(b)(1) regular tax only; NIIT, SECA, the
    // Additional Medicare surtax and the §72(t) penalty are all outside it.
    const ftc          = this._computeFtc(state, {
      grossTax: regularTax,
      // §904(b)(2)(B)(ii) — "the entire taxable income shall include gain … only in an
      // amount equal to capital gain net income reduced by the rate differential portion
      // of net capital gain". This is the Form 1116 *Worksheet for Line 18*, whose
      // per-group multipliers are the exact complements of the line-1a factors.
      totalTaxable: taxableOrdinaryAfterFeie + cg + collectibles + unrecap1250
                    - rateDiff.worldwide,
      grossIncomeAllSources,
      unrelatedDeductions,
      // §904(b)(2)(B)(i), per basket. Passed separately rather than netted into
      // `*Gross` above, because Form 1116's line 3d instruction is explicit that the
      // deduction-apportionment fraction takes capital gains "**without regard to any
      // adjustments**" — so this comes off line 7 AFTER 3g, not off 3d before it.
      generalCapGainAdjustment: rateDiff.general,
      passiveCapGainAdjustment: rateDiff.passive,
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
      // Design 90 §4.5 — less the U.S. capital loss adjustment. A capital loss reaches
      // `grossIncomeAllSources` through the netting but cannot reach an accumulator that
      // was summed during the year, so without this the baskets keep the gross gain and
      // the partition breaks by the absorbed loss. Same failure as the §469 line below,
      // and as design 83 G9's rent; see `_computeCapitalLossBasketAdjustment`.
      generalGross:    Math.max(0, (state.foreignGeneralIncomeYTD ?? 0) + (state.usSourceGeneralUsdYTD ?? 0)
                                   - capBasket.general),
      generalExcluded: Math.max(0, feieExcluded),
      // The §469 adjustment must reach the basket too, or the partition breaks.
      // A suspended loss is removed from `usOrdinaryIncomeYTD` (hence from
      // `grossIncomeAllSources`), so leaving it inside the passive accumulator — where
      // the Math.max floors it away — makes the general basket's gross exceed total
      // gross income and the §904 denominator collapse to zero. That is precisely the
      // invariant violation design 86 G5b records; suspending the loss in both places
      // is what restores `Σ basket gross ≤ grossIncomeAllSources`.
      passiveGross:    Math.max(0, (state.foreignPassiveIncomeYTD ?? 0) + (state.usSourcePassiveUsdYTD ?? 0)
                                   + pal.foreignAdjustment - capBasket.passive),
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
        // PRE-netting, deliberately: this block reports what came IN, and after design
        // 90 that figure can be negative. Anything wanting the taxed amount must read
        // `capitalLoss.longTermGain` / `.collectibleGain` below, not these.
        capitalGains:        usCapitalGainsYTD,
        collectibleGains:    usCollectibleGainsYTD,
        penalties:           usPenaltyYTD,
        foreignEarnedIncomeExclusion: feieExcluded,
        standardDeduction:   stdDeduction,
      },
      adjustedGrossIncome: agi,
      taxableIncome:       taxableOrdinary,
      // §1211/§1212 (design 90 §4). `closingShort`/`closingLong` are what
      // UsTaxSettleApplyReducer persists; everything else is for the worksheet and for
      // tests that need to see the netting without re-deriving it.
      capitalLoss:            capLoss,
      shortTermCapitalGain:   capLoss.shortTermGain,
      capitalLossDeduction:   capLoss.allowance,
      // The two Pub 514 adjustments to foreign source capital gains, in the order the
      // publication runs them: §904(b)(3)(A)'s U.S. capital loss adjustment (design 90
      // §4.5 step 8), then §904(b)(2)(B)'s rate differential (step 9). Reported rather
      // than re-derived, because neither is visible from `ftc` alone — the basket rows
      // show only the net line 7.
      capitalLossBasketAdjustment: capBasket,
      rateDifferential:            rateDiff,
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
      unrecapturedSection1250Gain: unrecap1250,
      unrecapturedSection1250Tax: unrecap1250Tax,
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
      // §469 suspended-loss pool (design 86 G5). `closing` is what the settle
      // reducer persists; the rest is the return's own arithmetic.
      passiveLoss: pal,
      // §163(d) investment interest (design 86 G3 error 1). `closing` is what the
      // settle reducer persists; same contract as `passiveLoss` above.
      investmentInterest: invInt,
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
        // §469 (design 86 G5). Shown only when there is something to show, so an
        // ordinary return is unchanged. `Gross Ordinary Income` above is already net
        // of these; the lines exist so a reader can see WHY a rental loss did not
        // reduce this year's income, and how much is waiting to be released.
        ...(pal.suspended > 0
          ? [{ label: 'Passive Loss Suspended (§469)',  amount:  pal.suspended }]
          : []),
        ...(pal.released > 0
          ? [{ label: 'Suspended Passive Loss Released', amount: -pal.released }]
          : []),
        ...(pal.closing > 0
          ? [{ label: 'Suspended Passive Losses — carried forward', amount: pal.closing }]
          : []),
        { label: 'Adjustments (Pre-tax Contributions)', amount: -usNegativeIncomeYTD },
        ...(seDeduction > 0
          ? [{ label: '½ Self-Employment Tax Deduction', amount: -seDeduction }]
          : []),
        // §988 (design 86 G7). The gain is already inside grossOrdinaryIncome; only
        // the deductible loss is a separate line. The disallowed personal loss is
        // printed too, at zero effect — an amount that cost real money and produces
        // no deduction is exactly the thing a reader must not have to infer.
        ...((state.usSection988GainYTD ?? 0) > 0
          ? [{ label: '§988 Exchange Gain on Foreign Debt (in gross income)', amount: 0 }]
          : []),
        ...(usSection988LossYTD > 0
          ? [{ label: '§988 Exchange Loss on Foreign Debt', amount: -usSection988LossYTD }]
          : []),
        ...((state.usSection988DisallowedLossYTD ?? 0) > 0
          ? [{ label: '§988 Personal Exchange Loss — DISALLOWED (§165(c))', amount: 0 }]
          : []),
        // §163(d) (design 86 G3 error 1). The deduction alone cannot show a reader
        // that interest was DISALLOWED this year — which is the entire behaviour of
        // the limitation — so the pool gets its own line whenever it is non-empty,
        // exactly as the §469 pool does above.
        ...(invInt.allowed > 0
          ? [{ label: 'Investment Interest Deduction (§163(d))', amount: -invInt.allowed }]
          : []),
        ...(invInt.closing > 0
          ? [{ label: 'Disallowed Investment Interest — carried forward (limited to net investment income)',
               amount: invInt.closing }]
          : []),
        // §1211/§1212 (design 90 §4). Three lines because three different things can
        // happen to a capital loss and a reader must be able to tell them apart:
        // short-term gain is taxed HERE at ordinary rates (not in the §1(h) stack
        // below), the allowance is the deduction, and the pools are the part that got
        // nothing this year. Without the pool lines a return showing a \$3,000 deduction
        // against a \$40,000 loss looks like an arithmetic error.
        ...(capLoss.shortTermGain > 0
          ? [{ label: 'Short-Term Capital Gain (taxed at ordinary rates, §1(h))', amount: capLoss.shortTermGain }]
          : []),
        ...(capLoss.allowance > 0
          ? [{ label: 'Capital Loss Deduction (§1211(b), capped at \$3,000)', amount: -capLoss.allowance }]
          : []),
        ...(capLoss.closingShort > 0
          ? [{ label: 'Short-Term Capital Loss — carried forward (§1212(b)(1)(A))', amount: capLoss.closingShort }]
          : []),
        ...(capLoss.closingLong > 0
          ? [{ label: 'Long-Term Capital Loss — carried forward (§1212(b)(1)(B))', amount: capLoss.closingLong }]
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
        ...(unrecap1250 > 0
          ? [{ label: 'Unrecaptured \u00a71250 Gain (25% max)',  amount:  unrecap1250Tax }]
          : []),
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
    generalGross = 0, generalExcluded = 0, generalCapGainAdjustment = 0,
    passiveGross = 0, passiveCapGainAdjustment = 0,
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

    const basket = (gross, excluded, capGainAdjustment, currentTax, pool) => {
      const apportionedDeduction = apportionedShare(gross);
      // Form 1116 line 7 — foreign TAXABLE income: gross in the category, less the
      // Form 2555 exclusion, less the ratable share of unrelated deductions, less the
      // §904(b)(2)(B)(i) rate differential portion of this category's net capital gain.
      //
      // Order matters and it is the form's: 3g apportions against UNADJUSTED gross
      // (line 3d: capital gains enter it "without regard to any adjustments"), and the
      // rate differential comes off afterwards. Netting it into `gross` instead would
      // shrink the apportionment fraction as well and quietly hand the basket back part
      // of the deduction it should have borne.
      //
      // The zero clamp is an approximation: a real return would carry the shortfall
      // as an overall foreign loss subject to §904(f) recapture in later years, which
      // this model does not track. Design 90 §4.7 measured it — the clamp fires, but
      // never as an overall foreign loss: deductions are apportioned proportionally
      // above, so this and `totalTaxable` go negative TOGETHER, and a clamped year is a
      // whole-return no-taxable-income year with no credit at stake. A real OFL needs a
      // deduction definitely related to foreign income; if one is ever added, this line
      // is where the account would be opened. Design 83 §10 records the clamp as accepted.
      //
      // §904(b)(2)(B)(i) broke the "TOGETHER" half of that: the rate differential is
      // charged to the basket that holds the gain, so ONE basket can clamp while another
      // stays positive. `rawNumerator` is kept for the invariants, which have to be read
      // across the baskets rather than one at a time — see `_assertFtcInvariants`.
      const rawNumerator = gross - excluded - apportionedDeduction - capGainAdjustment;
      const numerator = Math.max(0, rawNumerator);
      const frac  = totalTaxable > 0 ? Math.min(1, Math.max(0, numerator / totalTaxable)) : 0;
      const limit = Math.min(Math.max(0, grossTax) * frac, headroom);
      const poolTotal = Object.values(pool).reduce((s, v) => s + v, 0);
      const avail = currentTax + poolTotal;
      const credit = Math.min(avail, limit);
      headroom = Math.max(0, headroom - credit);
      const { nextPool, currentYearUsed, carryoverUsed } = _drawDownBasket(currentTax, pool, credit, currentCY);
      const carryforwardRemaining = Object.values(nextPool).reduce((s, v) => s + v, 0);
      return { gross, excluded, apportionedDeduction, capGainAdjustment, rawNumerator, numerator, frac, limit,
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
    const general = basket(generalGross, generalExcluded, generalCapGainAdjustment,
      (state.ftcCurrentGeneral ?? 0) + (state.ftcCurrentResourced ?? 0),
      _mergeVintagePools(state.ftcPoolGeneral ?? {}, state.ftcPoolResourced ?? {}));
    const passive = basket(passiveGross, 0, passiveCapGainAdjustment,
      state.ftcCurrentPassive ?? 0, state.ftcPoolPassive ?? {});
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
/**
 * The Form 1116 adjustment-exception income threshold for a bracket table — the floor of
 * the `ADJUSTMENT_EXCEPTION_BRACKET_RATE` band. See that constant for why it is read off
 * the table instead of transcribed. Returns Infinity when no such band exists, which
 * makes the exception depend on the \$20,000 test alone rather than silently vanishing.
 *
 * @param {Array<[number, number]>} brackets  ascending by threshold
 */
function _adjustmentExceptionThreshold(brackets) {
  const band = (brackets ?? []).find(([, rate]) => rate >= ADJUSTMENT_EXCEPTION_BRACKET_RATE);
  return band ? band[0] : Infinity;
}

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
 * IRC §469 passive activity loss limitation — design 86 G5.
 *
 * Rental activity is passive **per se** under §469(c)(2), so a net rental loss cannot
 * offset wages, interest, dividends or gains. It is *suspended* and carried forward
 * under §469(b) until the taxpayer has passive income to absorb it, or disposes of
 * the activity. Before this, the signed rental result went straight into
 * `usOrdinaryIncomeYTD` and a foreign rental loss reduced US ordinary income without
 * limit — driving it negative in a measured run.
 *
 * ─── why this also fixes the §904 partition (G5b) ────────────────────────────
 * The unlimited loss reduced `usOrdinaryIncomeYTD`, hence `grossIncomeAllSources`,
 * while the same loss inside `foreignPassiveIncomeYTD` was floored away by the
 * `Math.max(0, …)` that forms the basket gross. Total gross income therefore fell
 * BELOW the general basket's own gross, the baskets stopped partitioning income, and
 * `totalTaxable` collapsed to zero with a positive numerator still sitting on it —
 * tripping `_assertFtcInvariants`. Suspending the loss removes it from both places at
 * once, which is what restores `Σ basket gross ≤ grossIncomeAllSources`.
 *
 * ─── the §469(i) allowance is deliberately not modelled ──────────────────────
 * §469(i) lets an actively-participating individual deduct up to \$25,000 of rental
 * loss against non-passive income, but it phases out over \$100,000–\$150,000 MAGI and
 * is gone entirely above \$150,000. It also requires active participation, which a
 * foreign rental managed by an agent generally fails. Modelling it would add a
 * phase-out cliff that almost never binds for this model's taxpayers; the omission is
 * conservative (it suspends slightly more loss than a real return might).
 *
 * ─── release on disposal is likewise not modelled ────────────────────────────
 * §469(g) frees the whole suspended pool on a fully taxable disposition of the
 * activity. The engine has no activity-level disposal signal — a property sale is a
 * CGT event with no link back to the rental. So the pool is released only against
 * later passive income. That defers relief rather than destroying it, and it is the
 * one place this treatment is materially harsher than the statute; recorded here
 * rather than hidden.
 *
 * Pure — the caller persists `closing` at the settle. This runs inside a computeTax
 * that is itself re-run on counterfactual states (the FITO handoff), so it must never
 * draw down the pool it was handed.
 *
 * @param {object} state
 * @returns {{ opening: number, netPassive: number, suspended: number, released: number,
 *             closing: number, adjustment: number, foreignAdjustment: number }}
 *   `adjustment` is added to `usOrdinaryIncomeYTD`; `foreignAdjustment` is its
 *   foreign-source share, added to the passive basket's gross.
 */
/**
 * IRC §163(d) investment interest limitation — design 86 G3 error 1.
 *
 * Interest on money borrowed to buy income-producing property that is NOT a rental is
 * deductible only up to the year's **net investment income**; the disallowed excess is
 * treated as investment interest paid in the following year (§163(d)(2)) and so carries
 * forward indefinitely. Before this, a standalone `LoanAccount` accrued interest and
 * produced no deduction at all, which is why §10.2 recorded "an arm that borrows
 * against something other than the rental and invests the proceeds is not modellable".
 *
 * ─── this is NOT the §469 pool, and must never become it ─────────────────────
 * Both limitations suspend a deduction and release it later, which is exactly what
 * makes the shortcut tempting. They are not interchangeable: §469 releases against
 * later *passive* income and frees the whole pool on disposal of the activity;
 * §163(d) releases against later *investment* income and has no disposal event at
 * all. Routing investment interest through the passive pool would suspend it behind
 * rental profits it has nothing to do with.
 *
 * ─── the deduction is taken above the line, which the real return does not ───
 * §163(d) interest is an itemized deduction (Schedule A, line 9). This model has no
 * itemized-deduction machinery — every taxpayer takes the standard deduction — so the
 * allowed amount enters AGI directly, the same shortcut `usSection988LossYTD` takes.
 * It therefore relieves tax for a taxpayer who in reality would not itemize, and
 * over-relieves by the standard deduction's shadow for one who would. Stated here
 * rather than buried: it is the largest single approximation in this channel.
 *
 * Pure — the caller persists `closing` at the settle. `computeTax` is re-run on
 * counterfactual states (the FITO handoff), so this must never draw down the pool it
 * was handed.
 *
 * @param {object} state
 * @returns {{ opening: number, expense: number, nii: number, allowed: number, closing: number }}
 *   `allowed` is the deduction for the year (USD); `closing` is the new pool.
 */
export function _computeInvestmentInterestLimitation(state) {
  const opening = Math.max(0, state?.usInvestmentInterestCarryforward ?? 0);
  const expense = Math.max(0, state?.usInvestmentInterestYTD ?? 0);

  // §163(d)(4)(A) net investment income = investment income − investment expenses.
  // This model's `usNetInvestmentIncomeYTD` is the §1411 pool: interest, dividends,
  // coupons AND net rents. Rents must come out — §163(d)(4)(D) excludes income from a
  // passive activity, and rental activity is passive per se (§469(c)(2)), which is the
  // same classification G5 already relies on. Subtracting the passive result (floored,
  // because a passive LOSS never enlarges investment income) is exactly that carve-out
  // expressed against the accumulators we have.
  //
  // Net capital gain and qualified dividends are deliberately NOT included. §163(d)(4)
  // (B)(iii) lets a taxpayer ELECT to treat them as investment income, at the price of
  // giving up the preferential rate on the elected amount. The election is a real
  // planning lever, but modelling it means modelling the trade-off, and defaulting it
  // ON would silently overstate the deduction in every gain year. Not electing is the
  // statutory default and the conservative one.
  const nii = Math.max(0, (state?.usNetInvestmentIncomeYTD ?? 0)
                        - Math.max(0, state?.usPassiveActivityIncomeYTD ?? 0));

  const available = opening + expense;
  const allowed   = Math.min(available, nii);
  const closing   = available - allowed;
  return { opening, expense, nii, allowed, closing };
}

/**
 * IRC §1211(b) — the annual allowance against ordinary income. \$3,000, or \$1,500 for
 * a married individual filing separately.
 *
 * **Not inflation-indexed, and that is not an oversight in this model.** The figure has
 * stood at \$3,000 since 1978; the amendment history in
 * `docs/us-tax/USCODE-2024-…-sec1211.txt` ends in 1986. It must therefore be excluded
 * from the bracket-inflation wrapper — over a 44-year horizon its real value decays to
 * near-nothing, which is the correct behaviour and the whole reason the relief matters
 * less each year. Inflating it would invent relief Congress has not granted.
 *
 * MFS is not modelled (`usFilingSingle` distinguishes Single from MFJ, both of which
 * take the \$3,000), so the \$1,500 branch has no reachable caller and is noted rather
 * than coded.
 */
export const ORDINARY_CAPITAL_LOSS_CAP = 3_000;

/**
 * IRC §1211(b) + §1212(b) — capital-loss netting, the ordinary-income allowance, and the
 * two carryforward pools (design 90 §4).
 *
 * Pure, and for the same reason its two siblings below are: `computeTax` is re-run on the
 * US-source-removed counterfactual that sizes the FITO limit (design 52 §4.5, design 83
 * G8), so this must never draw down the pools it was handed. It REPORTS `closingShort` /
 * `closingLong` and `UsTaxSettleApplyReducer._extraStatePatches` owns the write-back, on
 * the real pass only.
 *
 * ## Netting order, and why the groups are walked highest-rate-first
 *
 * §1222(5)–(8) nets within each character, then §1211(b) allows the excess against
 * ordinary income. Where the model has more than one long-term rate group — collectibles
 * at 28% (§1(h)(4)), unrecaptured §1250 at its 25% ceiling (§1(h)(1)(D)), and the
 * 0/15/20 layer — a loss is applied to the HIGHEST-taxed group first. That is the §1(h)
 * netting rule, and it is also the only ordering that does not silently under-value a
 * loss: spending it against the 0/15/20 layer while 28% gain stands would waste up to
 * 13 points of relief.
 *
 * ## What is deliberately not modelled
 *
 * - **§1091 wash sales.** Design 90 §11. Nothing here re-tests a substitute purchase, so
 *   a harvested loss is always allowed. This over-values harvesting and is the single
 *   most important thing to fix before the harvest lever is tuned.
 * - **§1212(b)(2)'s "adjusted taxable income" limit.** The allowance is capped at the
 *   lesser of \$3,000 and the loss, but §1212(b)(2)(B) further limits how much counts as
 *   absorbed when taxable income is itself negative. Ignoring it means a household with
 *   no income to shelter still burns \$3,000 of pool. Conservative in the wrong
 *   direction, but only by up to \$3,000 in a year that by construction pays no tax.
 *
 * @param {object} state
 * @returns {{ openingShort:number, openingLong:number, shortTermGain:number,
 *   longTermGain:number, collectibleGain:number, unrecaptured1250Gain:number,
 *   allowance:number, closingShort:number, closingLong:number, netLoss:number }}
 *   The four `*Gain` figures are post-netting and floored at zero — what the rate
 *   schedules should tax. `allowance` is the §1211(b) ordinary deduction.
 */
export function _computeCapitalLossLimitation(state) {
  const openingShort = Math.max(0, state?.usShortTermCapitalLossCarryforward ?? 0);
  const openingLong  = Math.max(0, state?.usLongTermCapitalLossCarryforward  ?? 0);

  const rawShort       = state?.usShortTermCapitalGainsYTD ?? 0;
  const rawLong        = state?.usCapitalGainsYTD          ?? 0;
  const rawCollectible = state?.usCollectibleGainsYTD      ?? 0;

  // The long-term rate groups, highest rate first. §1250 gain is structurally
  // non-negative (depreciation already taken cannot be un-taken), so it never
  // contributes to the loss side.
  let coll28 = Math.max(0, rawCollectible);
  let g25    = Math.max(0, state?.usUnrecaptured1250GainYTD ?? 0);
  let g20    = Math.max(0, rawLong);

  // Long-term losses from every source: this year's 0/15/20 loss, this year's
  // collectible loss (a collectible loss is an ordinary capital loss — the 28% rate
  // attaches to net collectible GAIN only), and the pool §1212(b)(1)(B) carried in.
  let ltLoss = Math.max(0, -rawLong) + Math.max(0, -rawCollectible) + openingLong;
  let stGain = Math.max(0, rawShort);
  let stLoss = Math.max(0, -rawShort) + openingShort;

  /** Spend `loss` against `gain`; returns the pair after absorption. */
  const absorb = (loss, gain) => {
    const used = Math.min(loss, gain);
    return [loss - used, gain - used];
  };

  // §1222: within character first. A long-term loss walks the long groups
  // highest-rate-first; a short-term loss meets short-term gain.
  [ltLoss, coll28] = absorb(ltLoss, coll28);
  [ltLoss, g25]    = absorb(ltLoss, g25);
  [ltLoss, g20]    = absorb(ltLoss, g20);
  [stLoss, stGain] = absorb(stLoss, stGain);

  // §1211(b): then across character, in the same highest-rate-first order.
  [stLoss, coll28] = absorb(stLoss, coll28);
  [stLoss, g25]    = absorb(stLoss, g25);
  [stLoss, g20]    = absorb(stLoss, g20);
  [ltLoss, stGain] = absorb(ltLoss, stGain);

  // What survives on both sides is the net capital loss for the year.
  const netLoss   = stLoss + ltLoss;
  const allowance = Math.min(ORDINARY_CAPITAL_LOSS_CAP, netLoss);

  // §1212(b)(2): the amount allowed under §1211(b) is "treated as a short-term capital
  // gain" when sizing the carryover, so it consumes the SHORT-term loss first. That
  // ordering is worth money in the taxpayer's favour and is easy to get backwards:
  // short-term loss is the more valuable pool (it can shelter ordinary-rate gain), so
  // spending the cheap \$3,000 allowance on it first is exactly wrong intuitively and
  // exactly right statutorily.
  let remaining = allowance;
  const fromShort = Math.min(stLoss, remaining); remaining -= fromShort;
  const fromLong  = Math.min(ltLoss, remaining);

  return {
    openingShort, openingLong,
    shortTermGain:        +stGain.toFixed(2),
    longTermGain:         +g20.toFixed(2),
    collectibleGain:      +coll28.toFixed(2),
    unrecaptured1250Gain: +g25.toFixed(2),
    allowance:            +allowance.toFixed(2),
    closingShort:         +(stLoss - fromShort).toFixed(2),
    closingLong:          +(ltLoss - fromLong).toFixed(2),
    netLoss:              +netLoss.toFixed(2),
  };
}

/**
 * The **U.S. capital loss adjustment** — IRS Pub 514 (2025) p.28, *Adjustments to Foreign
 * Source Capital Gains and Losses* (design 90 §4.5).
 *
 * A capital loss reduces total gross income through `_computeCapitalLossLimitation`, which
 * nets it against the year's gains and can draw down a §1212(b) carryforward besides. The
 * §904 basket accumulators are built during the year and know nothing about either. Without
 * this, the baskets keep the gross gain while `grossIncomeAllSources` keeps the net one, and
 * the partition breaks by exactly the absorbed loss — which is the failure design 83 §12.1
 * has now recorded three times, after rent (G9) and the §469 suspended loss (design 86 G5b).
 *
 * The publication's mechanic, verbatim in structure:
 *
 *   foreign source capital gain = foreign-source capital gains − foreign-source capital losses
 *   worldwide capital gain      = worldwide gains − worldwide losses, floored at zero
 *   U.S. capital loss adjustment = foreign source capital gain − worldwide capital gain
 *
 * then *"apportion the U.S. capital loss adjustment among your separate categories that have
 * a net capital gain … **pro rata based on the amount of net capital gain in each separate
 * category**"*. Note what that settles: losses net WITHIN a category first — which the signed
 * per-basket accumulators do for free — and only the residue apportions across categories,
 * weighted by each category's NET capital gain rather than by its total income. Weighting by
 * total income is the obvious wrong answer and would move relief between baskets.
 *
 * **This makes `Σ basket gross ≤ grossIncomeAllSources` hold by construction**, because the
 * capital component of the baskets is capped at exactly the capital component of gross
 * income. The ordinary components already partitioned it.
 *
 * ## Why the carryforward's own source is not traced
 *
 * §1212(b) treats a carryover as a capital loss *of the succeeding year*, so it lands inside
 * `worldwideCapGain` above and enlarges the adjustment. It is NOT separately assigned to the
 * basket it arose in. That is the publication's own treatment — its adjustment is computed
 * from the year's net figures and never asks where a carryover came from — and the two
 * readings coincide whenever the gains are all foreign-source, which is the case §865(a)
 * produces for a US citizen resident abroad. They diverge only when a US-source capital gain
 * and a foreign-source carryover meet in one year; design 90 §4.5 records that as accepted.
 *
 * @param {object} state
 * @param {{shortTermGain:number, longTermGain:number, collectibleGain:number,
 *          unrecaptured1250Gain:number}} capLoss  the post-netting figures from
 *          {@link _computeCapitalLossLimitation} — i.e. the "worldwide capital gain".
 * @returns {{general:number, passive:number, adjustment:number,
 *            foreignSourceCapGain:number, worldwideCapGain:number}} amounts to SUBTRACT
 *          from each basket's gross, in USD.
 */
export function _computeCapitalLossBasketAdjustment(state, capLoss) {
  // Net capital gain per separate category. Signed accumulators, so a foreign-source loss
  // has already reduced its own basket; the floor is Pub 514's "categories that have a net
  // capital gain", which are the only ones the adjustment is apportioned among.
  const general = Math.max(0, (state?.foreignGeneralCapGainsYTD ?? 0)
                            + (state?.usSourceGeneralCapGainsUsdYTD ?? 0));
  const passive = Math.max(0, (state?.foreignPassiveCapGainsYTD ?? 0)
                            + (state?.usSourcePassiveCapGainsUsdYTD ?? 0));

  const foreignSourceCapGain = general + passive;
  const worldwideCapGain = Math.max(0, (capLoss?.shortTermGain ?? 0) + (capLoss?.longTermGain ?? 0)
                                     + (capLoss?.collectibleGain ?? 0) + (capLoss?.unrecaptured1250Gain ?? 0));
  const adjustment = Math.max(0, foreignSourceCapGain - worldwideCapGain);

  if (!(adjustment > 0) || !(foreignSourceCapGain > 0)) {
    return { general: 0, passive: 0, adjustment: 0, foreignSourceCapGain, worldwideCapGain,
             netGeneral: general, netPassive: passive };
  }

  const general904 = adjustment * (general / foreignSourceCapGain);
  const passive904 = adjustment * (passive / foreignSourceCapGain);
  return {
    general: general904,
    passive: passive904,
    adjustment, foreignSourceCapGain, worldwideCapGain,
    // Each basket's net capital gain AFTER the adjustment — Pub 514's "resulting
    // \$250 / \$500 on line 1a". This is §904(b)(3)(A)'s "foreign source capital gain
    // net income", the base the §904(b)(2)(B) rate differential then scales; the
    // publication is explicit that the two run in that order.
    netGeneral: general - general904,
    netPassive: passive - passive904,
  };
}

/**
 * The **capital gain rate differential adjustment** — IRC §904(b)(2)(B) and §904(b)(3)(E),
 * as implemented by IRS Pub 514 (2025) pp.30–32 and the Form 1116 *Worksheet for Line 18*
 * (design 90 §4.5, step 9).
 *
 * Preferential-rate income does not deserve full-rate limitation room. A dollar of
 * long-term gain taxed at 15% generates 15/37 of the US tax that a dollar of ordinary
 * income does, so §904(b)(2)(B) includes it in the §904 fraction at 15/37 of face — on
 * BOTH sides of that fraction. Clause (i) does the foreign numerator, clause (ii) "the
 * entire taxable income", i.e. the denominator. Adjusting one without the other is worse
 * than adjusting neither.
 *
 * **§904(b)(3)(E), verbatim** — the rate differential portion is the same proportion of
 * the amount as *"the excess of (I) the highest rate of tax set forth in subsection (a),
 * (b), (c), (d), or (e) of section 1 (whichever applies), over (II) the alternative rate
 * of tax determined under section 1(h), bears to (ii) that rate referred to in subclause
 * (I)"* — i.e. `portion = amount × (topRate − altRate) ÷ topRate`, so the amount that
 * survives is `amount × altRate ÷ topRate`. Pub 514's published factors are that formula
 * at a 37% top rate: 15/37 = 0.4054, 20/37 = 0.5405, 25/37 = 0.6757, 28/37 = 0.7568, and
 * the line-18 worksheet uses the exact complements (0.5946, 0.4595, 0.3243, 0.2432).
 * They are derived here rather than transcribed so a rate module with a different top
 * bracket — or the bracket-inflation wrapper — cannot silently keep 2025's arithmetic.
 *
 * ## The rate groups, and where each one comes from
 *
 * Pub 514 Table 4 lists six. All six are already computed by the time this runs, which is
 * why step 9 needs no new state at all:
 *
 * | group | source |
 * |---|---|
 * | 0% / 15% / 20% | the per-band split of `applyBracketsDetailed(ltcgFloor + cg)` less its base |
 * | 25% | `capLoss.unrecaptured1250Gain` (§1(h)(1)(D)) |
 * | 28% | `capLoss.collectibleGain` (§1(h)(4)) |
 * | short-term | `capLoss.shortTermGain` — taxed at ordinary rates, so its factor is 1 |
 *
 * The 25% group uses the statutory 25% ceiling, not the bracket differential `computeTax`
 * actually charges. §904(b)(3)(E)(i)(II) says "the alternative rate of tax determined
 * under section 1(h)", and for §1(h)(1)(D) that rate is 25%; a household whose marginal
 * rate puts the real charge below the ceiling still uses the group's rate, which is what
 * Pub 514's flat 0.6757 encodes.
 *
 * ## Why one blended factor, and when that is exact
 *
 * Pub 514 Step 2 apportions per separate category *per rate group*. This model knows the
 * rate-group split only at the worldwide level, and structurally cannot know it per
 * basket: the 0/15/20 split depends on where the year's gain stacks at year end, which is
 * not knowable at the moment a disposal books to a basket. So the worldwide *included
 * fraction* is applied to each basket's net capital gain.
 *
 * **That is exact whenever a single basket holds all the capital gain**, which is this
 * model's structural situation — design 90 §4.5 records that `foreignGeneralCapGainsYTD`
 * is zero at every disposal classifier, and every disposal books to passive. It diverges
 * only when two baskets hold gains with genuinely different rate-group mixes (a foreign
 * 25% property gain meeting a US-source 20% gain in one year). Recorded as accepted, in
 * the same terms as the carryforward-source question one function above.
 *
 * ## The adjustment exception
 *
 * The Form 1116 instructions let a taxpayer elect not to adjust at all when taxable
 * ordinary income is under the 32%-bracket floor AND foreign source net capital gain is
 * under \$20,000. Not adjusting always yields a larger fraction, so the election is taken
 * whenever it is available — which is what any preparer does, and what keeps a year
 * carrying a trivial gain bit-identical to one carrying none.
 *
 * @param {object} args
 * @param {Array<{rate:number, income:number}>} args.ltcgBands  per-band 0/15/20 split
 * @param {number} args.collectibleGain        28% rate group
 * @param {number} args.unrecaptured1250Gain   25% rate group
 * @param {number} args.shortTermGain          short-term rate group (factor 1)
 * @param {number} args.topOrdinaryRate        §1(a)–(e) highest rate
 * @param {number} args.netGeneral             general-basket net capital gain, post-§904(b)(3)(A)
 * @param {number} args.netPassive             passive-basket net capital gain, post-§904(b)(3)(A)
 * @param {number} args.taxableOrdinary        QDCGT worksheet line 5 analogue
 * @param {number} args.exceptionThreshold     the 32%-bracket floor for this filing status
 * @returns {{ worldwide:number, general:number, passive:number, includedFraction:number,
 *   worldwideCapGain:number, adjustedCapGain:number, exceptionApplied:boolean }}
 *   `worldwide` is subtracted from the §904 denominator; `general`/`passive` from their
 *   own Form 1116 line 7. All non-negative.
 */
export function _computeRateDifferentialAdjustment({
  ltcgBands = [], collectibleGain = 0, unrecaptured1250Gain = 0, shortTermGain = 0,
  topOrdinaryRate = 0, netGeneral = 0, netPassive = 0,
  taxableOrdinary = 0, exceptionThreshold = Infinity,
}) {
  const groups = [
    ...ltcgBands.map(b => ({ rate: b.rate, amount: b.income })),
    { rate: UNRECAPTURED_1250_MAX_RATE, amount: unrecaptured1250Gain },
    { rate: COLLECTIBLES_RATE,          amount: collectibleGain },
    // Short-term gain is taxed at ordinary rates, so its alternative rate IS the top
    // rate and its factor is 1. It is carried explicitly rather than dropped: it belongs
    // in the blend's denominator, or a basket holding short-term gain would be scaled by
    // a factor derived only from the long-term groups.
    { rate: topOrdinaryRate,            amount: shortTermGain },
  ].filter(g => g.amount > 0);

  const worldwideCapGain = groups.reduce((s, g) => s + g.amount, 0);
  const foreignNetCapGain = Math.max(0, netGeneral) + Math.max(0, netPassive);

  const exceptionApplied = taxableOrdinary <= exceptionThreshold
                        && foreignNetCapGain < RATE_DIFFERENTIAL_EXCEPTION_CAP;

  const inert = {
    worldwide: 0, general: 0, passive: 0, includedFraction: 1,
    worldwideCapGain, adjustedCapGain: worldwideCapGain, exceptionApplied,
  };
  if (exceptionApplied || !(worldwideCapGain > 0) || !(topOrdinaryRate > 0)) return inert;

  const adjustedCapGain = groups.reduce(
    (s, g) => s + g.amount * Math.min(1, g.rate / topOrdinaryRate), 0);
  const includedFraction = adjustedCapGain / worldwideCapGain;
  const removed = 1 - includedFraction;

  return {
    // §904(b)(2)(B)(ii) — off the denominator, at full worldwide scope.
    worldwide: worldwideCapGain * removed,
    // §904(b)(2)(B)(i) — off each basket's own line 7. Σ of these can never exceed
    // `worldwide`, because §904(b)(3)(A) already capped Σ basket gain at the worldwide
    // figure (that is what `_computeCapitalLossBasketAdjustment` enforces), so the
    // denominator always falls by at least as much as the numerators do and the design
    // 83 partition invariant survives this adjustment by construction.
    general: Math.max(0, netGeneral) * removed,
    passive: Math.max(0, netPassive) * removed,
    includedFraction, worldwideCapGain, adjustedCapGain, exceptionApplied,
  };
}

export function _computePassiveLossLimitation(state) {
  const opening    = Math.max(0, state?.usPassiveLossCarryforward ?? 0);
  const netPassive = state?.usPassiveActivityIncomeYTD ?? 0;
  const foreignNet = state?.usForeignPassiveActivityIncomeYTD ?? 0;

  // A loss year suspends the whole net loss; a profit year releases as much of the
  // pool as it can absorb. The two are mutually exclusive by construction.
  const suspended = Math.max(0, -netPassive);
  const released  = Math.min(opening, Math.max(0, netPassive));
  const closing   = opening + suspended - released;

  // `adjustment` ADDS BACK the suspended loss (raising income) and SUBTRACTS the
  // released loss (lowering it), so income moves in the opposite direction to the pool.
  const adjustment = suspended - released;

  // The share of the adjustment that belongs to the foreign passive basket. A loss
  // year apportions by the foreign share of the loss; a release apportions by the
  // foreign share of the income absorbing it. Both fall back to 1 when the split is
  // unavailable — every rental in the cross-border scenarios this serves is foreign,
  // so over-attributing to the foreign basket is the safe default: it keeps the
  // basket gross from exceeding total gross income, which is the invariant at stake.
  const share = (part, whole) => (Math.abs(whole) > 1e-9 ? Math.min(1, Math.max(0, part / whole)) : 1);
  const foreignAdjustment = netPassive < 0
    ? suspended * share(Math.max(0, -foreignNet), suspended)
    : -released * share(Math.max(0, foreignNet), Math.max(0, netPassive));

  return { opening, netPassive, suspended, released, closing, adjustment, foreignAdjustment };
}

/**
 * The §904 invariants — design 83 §8. None of these were asserted before, and
 * `npm run crossfoot` cannot see them: it only checks worksheet lines carrying a
 * `drillReport` link, and no §904 line has one. A limitation fraction of 5.157 sat
 * in a shipped export for weeks because nothing here was checked.
 *
 * 1. the baskets' gross income partitions gross income from all sources;
 * 2. the baskets' foreign taxable income, SUMMED, ≤ the total taxable income it
 *    divides by;
 * 3. the fractions sum to ≤ 1 (they partition one taxpayer's income);
 * 4. total credit ≤ the limitation base.
 *
 * (1) is the one the message has always named, and the only one of the four that is
 * unconditionally true: a basket accumulator is a subset-TAG of gross income, so a
 * classifier that double-counts, or that routes income to a basket without adding it
 * to the US totals, breaks it at the moment it is introduced. Everything else here is
 * downstream of it.
 *
 * (2) and (3) hold once the unrelated deductions are apportioned (G1): the identity
 * totalTaxable = grossIncomeAllSources − unrelatedDeductions − FEIE makes Σ numerators
 * ≤ totalTaxable exact — but only while the return HAS taxable income, and only in the
 * sum. Two things break the per-basket, all-years reading, and both of them fire in an
 * ordinary low-income retirement year on the reference plan:
 *
 *   · `taxableOrdinary` clamps at zero when the standard deduction exceeds ordinary
 *     income, so the denominator drops a deduction the identity has already spent
 *     — and once gross income is below total deductions the leftover deduction has no
 *     US-source income left to sit against, which is what the identity assumes; and
 *   · §904(b)(2)(B) takes a 0%-rate-group capital gain out of the denominator in full
 *     (ii) but charges (i) only to the basket that HOLDS the gain, so the other
 *     basket's numerator can outlive a denominator that has collapsed to zero.
 *
 * A year like that is a no-taxable-income year: `basket()`'s `totalTaxable > 0` guard
 * has already forced every `frac` to zero, the limitation base is zero too, and there
 * is no credit at stake — the harmless case design 90 §4.7 describes, reached by a
 * route it did not anticipate. So (2) and (3) are asserted only when the denominator
 * is positive, and (2) is read across the baskets on the PRE-clamp numerators, since
 * `numerator`'s own zero clamp is what lets one basket hide another's shortfall.
 *
 * Warn-then-throw rather than a bare throw so the message names the offender; in a
 * production build it degrades to a console warning.
 */
function _assertFtcInvariants(ftc) {
  const { totalTaxable, limitationBase, general, passive } = ftc;
  const baskets = [['general', general], ['passive', passive]]
    .filter(([, b]) => b != null);

  const failures = [];
  const grossSum = baskets.reduce((s, [, b]) => s + (b.gross ?? 0), 0);
  if (grossSum > (ftc.grossIncomeAllSources ?? 0) + FTC_INVARIANT_EPSILON) {
    failures.push(`basket gross sums to ${grossSum.toFixed(2)}, which exceeds gross income `
      + `from all sources ${(ftc.grossIncomeAllSources ?? 0).toFixed(2)}`);
  }
  if (totalTaxable > 0) {
    const numeratorSum = baskets.reduce((s, [, b]) => s + (b.rawNumerator ?? b.numerator), 0);
    if (numeratorSum > totalTaxable + FTC_INVARIANT_EPSILON) {
      failures.push(`basket numerators sum to ${numeratorSum.toFixed(2)}, which exceeds the §904 `
        + `denominator ${totalTaxable.toFixed(2)} `
        + `(${baskets.map(([n, b]) => `${n}=${(b.rawNumerator ?? b.numerator).toFixed(2)}`).join(' ')})`);
    }
    const fracSum = baskets.reduce((s, [, b]) => s + b.frac, 0);
    if (fracSum > 1 + FTC_INVARIANT_EPSILON) {
      failures.push(`§904 fractions sum to ${fracSum.toFixed(5)}, which exceeds 1`);
    }
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
