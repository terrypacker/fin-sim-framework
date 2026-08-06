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
import {
  applyBrackets as _applyBrackets,
  applyBracketsDetailed,
  marginalBracketRate as _marginalBracketRate,
  subtractBands,
  flatRateBand,
} from '../bracket-schedule.js';

/**
 * Legacy flat withholding rate on the undifferentiated non-resident withholding
 * pool (design 73 Gap 2). 15% is the AU–US treaty rate for portfolio *unfranked
 * dividends* and nothing else; it was generalised into a constant named for the
 * whole bucket, which then over-taxed interest by half again and roughly halved
 * the tax on non-resident capital gains.
 *
 * The typed feeders now book into `_nrWithholdingRates` below. This constant
 * survives only for `auNonResidentWithholdingYTD`, whose remaining feeders (AU
 * capital gains, non-resident wages) are drained by design 73 Gap 2 step 3 and
 * Gap 1 respectively. When the last feeder goes, so does this.
 */
const NR_WITHHOLDING_RATE = 0.15;

/**
 * AuTaxRatesBase — base class for Australian income tax rate computation.
 *
 * Implements computeTax() covering both resident and non-resident cases.
 *
 * Resident path:
 *   - Progressive marginal brackets on (ordinary income + capital gains)
 *   - Medicare levy with low-income phase-in threshold
 *   - Franking credits offset ordinary tax before Medicare levy
 *
 * Non-resident path:
 *   - Separate non-resident brackets (no tax-free threshold)
 *   - No Medicare levy, no franking credit offset
 *   - Non-resident withholding already deducted at source (added directly)
 *
 * Neither path includes the Div 295 superannuation FUND tax (`auSuperTaxYTD`).
 * It is the fund's liability, withheld from fund assets when the contribution or
 * earning accrues, and appears here only as a memo line (design 77 §5.3).
 *
 * The `year` property on each subclass refers to the financial year start
 * (e.g. year=2024 means FY 2024-25, beginning July 2024).
 *
 * State fields consumed:
 *   auOrdinaryIncomeYTD, auCapitalGainsYTD, auNonResidentWithholdingYTD,
 *   auSuperTaxYTD, auFrankingCreditYTD, people[*].residency
 */
export class AuTaxRatesBase extends BaseTaxRatesModule {
  get countryCode() { return 'AU'; }

  // Subclasses set these in their constructors:

  /** Resident marginal brackets: [[threshold, rate], ...] ascending by threshold */
  _brackets            = [];
  /** Non-resident brackets: [[threshold, rate], ...] ascending (no tax-free threshold) */
  _nonResidentBrackets = [];
  /**
   * Medicare levy parameters (ATO).
   *   rate:           flat rate above upper phase-in threshold
   *   lowerThreshold: income below which no levy applies
   *   phaseInRate:    rate applied to (income − lowerThreshold) in the phase-in band
   */
  _medicareLevy = { rate: 0.02, lowerThreshold: 26_000, phaseInRate: 0.10 };
  /** Flat CGT discount rate (ATO Division 115). FY≤2026 = 50%. */
  _cgtDiscountRate = 0.5;
  /**
   * Final withholding rates by income type, for a **US-resident individual**
   * (design 73 Gap 2 step 1). Subclasses may override per financial year the way
   * `_brackets` already is.
   *
   * For interest, unfranked dividends and royalties the withholding genuinely is
   * a *final* tax, which is why that income is kept off the assessable-income
   * return entirely rather than added to `assessableIncome`.
   *
   * Rates are the AU–US treaty caps, verified against the US Treasury Technical
   * Explanations of the 1982 Convention [R9] and the 2001 Protocol [R13]:
   *   interest          Art 11(2), capped at 10%. Australia's *statutory* rate on
   *                     interest paid to non-residents is also 10%, so treaty and
   *                     domestic law coincide and there is no rate anywhere in the
   *                     system that could produce 15%. The Protocol replaced Art 11
   *                     but kept the 10% cap; its 0% tier reaches only governments,
   *                     central banks and unrelated financial institutions — never
   *                     an individual depositor.
   *   unfrankedDividend Art 10(2), capped at 15% for a resident of the other State.
   *                     The Protocol's 5% and 0% tiers BOTH require a *corporate*
   *                     beneficial owner, so a natural person always falls to 15%.
   *                     This model taxes individuals: 15% is the only dividend rate
   *                     it can ever need — do not build the tiering.
   *   frankedDividend   Exempt from dividend withholding **by statute** under the
   *                     imputation system [R13]. Present as a guard: the model has
   *                     no franked non-resident feeder today, and if one lands it
   *                     must not inherit a non-zero default.
   *   royalty           Art 12(2), cut from 10% to 5% by Art 8(a) of the Protocol.
   *                     The only year-sensitive entry — 10% before the Protocol's
   *                     2003 entry into force — but every registered FY is post-2003,
   *                     so 5% holds for all of them. Not yet fed by any income type.
   *
   * Statutory (no-treaty) fallbacks would be 0.10 / 0.30 / 0 / 0.30. They are not
   * modelled: the reduced rates above apply *because* the recipient is a US
   * resident, and this model's scope is exactly the two treaty countries. A third
   * country would force a real per-counterparty treaty lookup keyed off the
   * recipient's residence — this table is where that lookup would land.
   */
  _nrWithholdingRates = {
    interest:          0.10,
    unfrankedDividend: 0.15,
    frankedDividend:   0,
    royalty:           0.05,
  };

  /**
   * Year-specific CGT relief for resident net capital gains.
   *
   * Base implementation: a flat Division 115 discount at `_cgtDiscountRate`.
   * FY2027+ overrides this to replace the discount with cost-base indexation
   * and a minimum-tax floor (design 57 §6.3).
   *
   * @param {object} state             Simulation state snapshot
   * @param {number} auCapitalGainsYTD Gross AU resident capital gains for the period
   * @returns {{ netTaxableGain: number, reliefAmount: number, minTaxRate: number }}
   *   netTaxableGain — portion added to assessable income after relief;
   *   reliefAmount   — the reduction (gross − taxable), for display;
   *   minTaxRate     — minimum effective rate floored on the gain's marginal tax
   *                    (0 = no floor; 0.30 for FY2027+, design 57 §6.3).
   */
  _cgtRelief(state, auCapitalGainsYTD) {
    // The 50% discount applies only to gains from assets held ≥12 months (Div 115).
    // After a residency deemed acquisition the clock restarts at the move, so the
    // eligible slice is tracked separately in auDiscountableGainsYTD (design 62 §4)
    // and capped at the total gain. Absent (old saves / synthetic states) ⇒ discount
    // the full gain, preserving the prior behavior byte-for-byte.
    const discountBase = (state != null && 'auDiscountableGainsYTD' in state)
      ? Math.min(auCapitalGainsYTD, Math.max(0, state.auDiscountableGainsYTD ?? 0))
      : auCapitalGainsYTD;
    const reliefAmount   = discountBase * this._cgtDiscountRate;
    const netTaxableGain = auCapitalGainsYTD - reliefAmount;
    return { netTaxableGain, reliefAmount, minTaxRate: 0 };
  }

  /** Display label for the CGT relief line item. FY2027+ overrides this. */
  _cgtReliefLabel() {
    return 'CGT 50% Discount';
  }

  /**
   * The withholding lines of a non-resident return, one per income type at its own
   * final rate (design 73 Gap 2). Labels carry the rate so the reader can check the
   * line without the bracket columns.
   *
   * The two typed lines are always emitted, zero or not: their presence is what
   * tells a reader that interest and dividends are taxed differently, which is the
   * whole point of the split. The residual pooled line appears only while it still
   * has a feeder, so it vanishes from the return once Gap 2 step 3 and Gap 1 have
   * drained it rather than lingering as a permanent 0.00.
   *
   * Each line carries its own `flat` band. The document renders these as-is, so the
   * label and the rate it names can never drift apart — both are built here, from
   * the one rate table.
   */
  _nrWithholdingLineItems({ interestIncome, interestTax, unfrankedDivIncome, unfrankedDivTax, pooledIncome, pooledTax }) {
    const pct = r => `${+(r * 100).toFixed(2)}%`;
    const { interest, unfrankedDividend } = this._nrWithholdingRates;
    return [
      {
        label: `Withholding Tax — Interest (${pct(interest)})`,
        amount: interestTax,
        flat:   flatRateBand(interest, interestIncome, interestTax),
      },
      {
        label: `Withholding Tax — Unfranked Dividends (${pct(unfrankedDividend)})`,
        amount: unfrankedDivTax,
        flat:   flatRateBand(unfrankedDividend, unfrankedDivIncome, unfrankedDivTax),
      },
      ...(pooledTax !== 0
        ? [{
            label: `Non-Resident Withholding Tax (${pct(NR_WITHHOLDING_RATE)})`,
            amount: pooledTax,
            flat:   flatRateBand(NR_WITHHOLDING_RATE, pooledIncome, pooledTax),
          }]
        : []),
    ];
  }

  /**
   * Resident income-tax assessment BEFORE the Foreign Income Tax Offset
   * (design 52 §4.5). Pure and FITO-free so it can be evaluated twice — once on
   * the full state and once with the US-source removal set disregarded — to
   * derive the FITO "step 1 − step 2" limit without recursion. Returns the
   * component figures plus `netLiabilityPreFito`.
   */
  _assessResidentPreFito(state) {
    const {
      auOrdinaryIncomeYTD = 0,
      auCapitalGainsYTD   = 0,
      auSuperTaxYTD       = 0,
      auFrankingCreditYTD = 0,
      auTaxLossPool       = 0,
    } = state;

    // Apply the year's CGT relief. Base = flat 50% Div 115 discount and no
    // minimum-tax floor (minTaxRate 0). FY2027+ removes the discount and sets
    // minTaxRate to 0.30 (design 57 §6.3).
    const { netTaxableGain, reliefAmount: cgtDiscount, minTaxRate } =
      this._cgtRelief(state, auCapitalGainsYTD);

    // ─── Div 36 carried-forward tax losses (design 86 G1) ────────────────────
    //
    // A prior year's excess loss is deducted from THIS year's total assessable
    // income — including the net capital gain, and after the Div 115 discount, which
    // is the order these lines already compute in. Without the pool a loss year was
    // simply assessed at zero and the excess destroyed, so a negatively-geared
    // property held by someone with little other income produced a deduction worth
    // nothing at all, every year, forever.
    //
    // **This function is evaluated TWICE** — once on the real state and once on the
    // US-source-removed counterfactual that sizes the FITO limit (design 52 §4.5,
    // design 83 G8). So the deduction is computed from the pool passed IN and never
    // written back here: the settle owns the write-back, on the real pass only.
    // Deducting inside each pass also keeps the counterfactual honest — a pass with
    // less income absorbs less loss, which is the true "what would be payable"
    // figure. Hoisting the deduction outside the split would let the counterfactual
    // claim the full deduction against reduced income and overstate the FITO limit.
    const grossDiscountedIncome = auOrdinaryIncomeYTD + netTaxableGain;
    const openingLossPool       = Math.max(0, auTaxLossPool);
    const lossDeducted          = Math.min(openingLossPool, Math.max(0, grossDiscountedIncome));
    // A loss year adds its own excess to the pool; deduction and creation are
    // mutually exclusive, since one needs positive income and the other negative.
    const lossCreated           = Math.max(0, -grossDiscountedIncome);
    const closingLossPool       = openingLossPool - lossDeducted + lossCreated;

    const discountedIncome = grossDiscountedIncome - lossDeducted;
    const assessableIncome = Math.max(0, discountedIncome);
    // `.tax` is identical to the scalar applyBrackets these lines used before; the
    // bands ride along for the worksheet export (design 71 §8.4).
    const assessableSchedule = applyBracketsDetailed(assessableIncome, this._brackets);
    const baseTax          = assessableSchedule.tax;
    const medicare         = this._medicareLevyDetail(discountedIncome);
    const medicareLevy     = medicare.tax;
    const frankingOffset   = Math.min(auFrankingCreditYTD, baseTax);

    // Div 115C minimum tax (FY2027+): floor the tax *attributable to the net
    // capital gain* at minTaxRate × that gain — an incremental floor on the gain's
    // own marginal tax (baseTax with the gain − baseTax without it), not the whole
    // liability, so it only bites when the marginal rate on the gain is below
    // minTaxRate. 0 for FY≤2026.
    const ordinarySchedule = applyBracketsDetailed(Math.max(0, auOrdinaryIncomeYTD), this._brackets);
    const ordinaryOnlyTax  = ordinarySchedule.tax;
    const taxOnGain        = Math.max(0, baseTax - ordinaryOnlyTax);
    const minTaxTopUp      = minTaxRate > 0
      ? Math.max(0, minTaxRate * netTaxableGain - taxOnGain)
      : 0;

    // Design 77 §5.3 — `auSuperTaxYTD` is NOT part of this. Div 295 fund tax is
    // levied on the superannuation fund, not the member: it never appears on the
    // member's notice of assessment, and it is withheld from fund assets at accrual
    // (SuperEarningsHandler / SuperContributionApplyReducer). Including it here made
    // it a personal liability, debited from AU cash by AU_TAX_PAYMENT_DEBIT — paying
    // the same tax twice, once out of the fund and once out of the member's pocket.
    // It stays on the return as a memo line only. Same treatment as the two other
    // withheld-at-source buckets, `auSuperDeathTaxYTD` and `neInheritanceTaxYTD`.
    //
    // Design 57's minimum-tax top-up is INSIDE the offset, not bolted on after it.
    // It was added outside the clamp, which made it a levy no offset could reach:
    // a return whose whole liability was the top-up paid it in full while its
    // franking credits and FITO evaporated (design 84 G10). The reform floors the
    // rate applied to the *gain* against the bracket schedule (§6.3 — an
    // incremental top-up, explicitly not a floor on the whole liability); it is not
    // an anti-offset rule, and nothing in the sourced material makes it one. The
    // return already presented it this way — the top-up sits inside Gross Tax with
    // the Credits section beneath it — so this brings the arithmetic into line with
    // the document the model has been printing all along.
    const netLiabilityPreFito = Math.max(0, baseTax + medicareLevy + minTaxTopUp - frankingOffset);

    // Split baseTax into its ordinary-income and capital-gain components for
    // display (design 57 report breakdown). AU has no separate CGT schedule of
    // rates: the relieved gain is stacked on top of ordinary income and taxed at
    // the resulting marginal brackets. So the gain's share is the *incremental*
    // bracket tax it adds — baseTax(ordinary+gain) − baseTax(ordinary) = taxOnGain
    // — and the two components sum exactly to baseTax (brackets are monotonic, so
    // ordinaryOnlyTax ≤ baseTax). This is the same taxOnGain used by the min-tax
    // floor above; the 30% top-up (when any) is reported as its own line.
    const ordinaryIncomeTax = ordinaryOnlyTax;
    const capitalGainsTax   = taxOnGain;

    return {
      netTaxableGain, cgtDiscount, minTaxRate, minTaxTopUp,
      assessableIncome, baseTax, medicareLevy, frankingOffset,
      ordinaryIncomeTax, capitalGainsTax,
      // Div 36 pool (design 86 G1) — reported on the return and, from the REAL pass
      // only, written back to state by the settle reducer.
      openingLossPool, lossDeducted, closingLossPool,
      superTax: auSuperTaxYTD,
      marginalRate: _marginalBracketRate(assessableIncome, this._brackets),
      netLiabilityPreFito,
      brackets: {
        table:    'Resident',
        ordinary: ordinarySchedule.bands,
        // AU has no separate CGT rate schedule: the relieved gain is stacked on
        // ordinary income and taxed at the resulting marginal brackets, so the gain's
        // share is the bracket DIFFERENTIAL — the same construction the US uses for
        // LTCG (§8.4). Clamped to zero bands when `taxOnGain` clamps, so the bands
        // always sum to the `capitalGainsTax` actually reported (see §11.4 for the
        // capital-loss case that makes the clamp reachable).
        capitalGains: baseTax >= ordinaryOnlyTax
          ? subtractBands(assessableSchedule.bands, ordinarySchedule.bands)
          : ordinarySchedule.bands.map(b => ({ ...b, income: 0, tax: 0 })),
        medicareLevy: medicare.band,
      },
    };
  }

  computeTax(state) {
    const {
      auOrdinaryIncomeYTD         = 0,
      auCapitalGainsYTD           = 0,
      auNonResidentWithholdingYTD = 0,
      auSuperTaxYTD               = 0,
      auFrankingCreditYTD         = 0,
    } = state;

    // Resident if any person in state.people has residency === 'AU'
    const primaryKey   = Object.keys(state.people ?? {})[0];
    const isAuResident = state.people?.[primaryKey]?.residency === 'AU';

    if (isAuResident) {
      const a = this._assessResidentPreFito(state);

      // Design 52 §4.5 — Foreign Income Tax Offset (FITO). Offset AU tax by the US
      // tax paid on US-source income (usTaxPaidOnUsSourceAud), single bucket, NO
      // carryforward (excess is lost — the deliberate asymmetry with the US FTC).
      // A$1,000 de-minimis skips the limit; above it the limit is the marginal AU
      // tax on the US-source income (ATO "step 1 − step 2"), computed by
      // re-assessing pre-FITO with the US-source removal set disregarded. The
      // ordinary/CG split matters because AU taxes them differently (CGT discount),
      // so each US-source slice is removed from its own bucket.
      const foreignTaxAud = Math.max(0, state.usTaxPaidOnUsSourceAud ?? 0);
      let fito = 0, fitoLimit = null, fitoDeMinimis = false;
      if (foreignTaxAud > 0) {
        if (foreignTaxAud <= 1000) {
          fito = foreignTaxAud;
          fitoDeMinimis = true;
        } else {
          const without = this._assessResidentPreFito({
            ...state,
            auOrdinaryIncomeYTD: (state.auOrdinaryIncomeYTD ?? 0) - (state.usSourceOrdinaryAudYTD ?? 0),
            auCapitalGainsYTD:   (state.auCapitalGainsYTD   ?? 0) - (state.usSourceCapGainsAudYTD ?? 0),
            // FY2027+ assesses the *real* (indexed) bucket, so the "without" pass
            // must remove the US-source slice from it too — else the CG component
            // of the FITO limit reads ~0 (design 57 Part 2, Item D). Only present
            // when a FY2027 classifier populated it; absent ⇒ the spread is 0.
            ...('auRealCapitalGainsYTD' in state
              ? { auRealCapitalGainsYTD: (state.auRealCapitalGainsYTD ?? 0) - (state.usSourceRealCapGainsAudYTD ?? 0) }
              : {}),
          }).netLiabilityPreFito;
          fitoLimit = Math.max(0, a.netLiabilityPreFito - without);
          fito      = Math.min(foreignTaxAud, fitoLimit);
        }
        // The offset is non-refundable: it can only wipe out AU tax that exists.
        // The §770-75 limit already implies this (it is a difference of two
        // pre-FITO liabilities, so it can never exceed the larger one), but the
        // de-minimis shortcut skips the limit entirely and can hand over more
        // offset than the return has liability to absorb. Capping here rather than
        // clamping the net below keeps `fito` meaning "offset actually taken",
        // which is what the Credits line states and what the "excess forfeited"
        // worksheet row subtracts — so a wasted de-minimis offset now shows up as
        // forfeited instead of vanishing silently.
        fito = Math.min(fito, a.netLiabilityPreFito);
      }

      // Design 77 §5.3 — super fund tax excluded (see _assessResidentPreFito).
      // No clamp: `frankingOffset` is capped at `baseTax` and `fito` at the
      // pre-FITO liability, so this cannot go negative. Stating it as a plain
      // subtraction is what makes "Gross Tax + credits = Net Tax Liability" hold
      // by construction rather than by luck (design 71 §6).
      const netLiability = a.baseTax + a.medicareLevy + a.minTaxTopUp
                         - a.frankingOffset - fito;

      const totalGrossIncome = auOrdinaryIncomeYTD + auCapitalGainsYTD;
      const effectiveRate    = totalGrossIncome > 0 ? netLiability / totalGrossIncome : 0;

      // Design 83 G10 — the effective AU rate on this year's capital gains, which is
      // the input IRC §865(g)(2) needs on the US side. That paragraph treats a US
      // citizen as a *nonresident* for personal-property sourcing (making the gain
      // FOREIGN source under §865(a)(2)) only *"unless an income tax equal to at
      // least 10 percent of the gain derived from such sale is actually paid to a
      // foreign country"*. So the US return cannot classify these gains without
      // knowing what Australia actually charged on them.
      //
      // Measured the same with/without way as the §770-75 FITO limit, for the same
      // reason: the CGT discount and the bracket the gain lands in make any
      // proportional split wrong. Null when there were no gains — the caller must
      // not read that as "0%", which would fail the test.
      const grossCapitalGains = Math.max(0, auCapitalGainsYTD);
      let auCgtEffectiveRate = null;
      if (grossCapitalGains > 0) {
        const withoutGains = this._assessResidentPreFito({
          ...state,
          auCapitalGainsYTD:      0,
          auDiscountableGainsYTD: 0,
          ...('auRealCapitalGainsYTD' in state ? { auRealCapitalGainsYTD: 0 } : {}),
        }).netLiabilityPreFito;
        auCgtEffectiveRate =
          Math.max(0, a.netLiabilityPreFito - withoutGains) / grossCapitalGains;
      }

      return {
        auCgtEffectiveRate,
        inputs: {
          ordinaryIncome:         auOrdinaryIncomeYTD,
          capitalGains:           auCapitalGainsYTD,
          nonResidentWithholding: auNonResidentWithholdingYTD,
          superTax:               auSuperTaxYTD,
          frankingCredits:        auFrankingCreditYTD,
          foreignIncomeTaxOffset: foreignTaxAud,
          // This person's US-source slices (design 76 Gap D). Surfaced so the
          // creditable-base split can apportion per person under the A$1,000
          // de-minimis, where no fitoLimit is computed to subtract from.
          usSourceOrdinary:       state.usSourceOrdinaryAudYTD ?? 0,
          usSourceCapGains:       state.usSourceCapGainsAudYTD ?? 0,
          isResident:             true,
        },
        isResident:               true,
        cgtDiscount:              a.cgtDiscount,
        discountedCapitalGains:   a.netTaxableGain,
        cgtMinimumTaxTopUp:       a.minTaxTopUp,
        assessableIncome:         a.assessableIncome,
        // Div 36 carried-forward losses (design 86 G1). `closingLossPool` is what the
        // settle reducer persists; the other two are the return's own arithmetic.
        openingLossPool:          a.openingLossPool,
        lossDeducted:             a.lossDeducted,
        closingLossPool:          a.closingLossPool,
        baseTax:                  a.baseTax,
        ordinaryIncomeTax:        a.ordinaryIncomeTax,
        capitalGainsTax:          a.capitalGainsTax,
        medicareLevy:             a.medicareLevy,
        frankingOffset:           a.frankingOffset,
        fito,
        fitoLimit,
        fitoDeMinimis,
        nonResidentWithholdingTax: 0,
        grossTax:                 a.baseTax + a.medicareLevy + a.minTaxTopUp,
        // Fund-level Div 295 tax, already withheld inside super. Reported so the
        // reader can see the whole tax burden; excluded from grossTax/netLiability
        // because it is not the member's liability (design 77 §5.3).
        superFundTax:             a.superTax,
        credits:                  a.frankingOffset,
        netLiability,
        effectiveRate,
        marginalRate:             a.marginalRate,
        brackets:                 a.brackets,
        lineItems: [
          { label: 'Ordinary Income',               amount:  auOrdinaryIncomeYTD },
          { label: 'Capital Gains (before relief)', amount:  auCapitalGainsYTD },
          { label: this._cgtReliefLabel(),          amount: -a.cgtDiscount },
          { label: 'Net Capital Gains',             amount:  a.netTaxableGain },
          // Only shown when there is a pool to talk about, so an ordinary return is
          // unchanged. Three lines, mirroring how the §904 FTC baskets already print
          // (opening / used / remaining) — the two should read alike.
          ...(a.openingLossPool > 0 || a.closingLossPool > 0
            ? [
                { label: 'Carried-Forward Tax Losses — opening', amount:  a.openingLossPool },
                { label: 'Prior-Year Losses Deducted',           amount: -a.lossDeducted },
                { label: 'Carried-Forward Tax Losses — closing', amount:  a.closingLossPool },
              ]
            : []),
          { label: 'Total Assessable Income',       amount:  a.assessableIncome },
          { label: 'Tax on Income',                 amount:  a.baseTax },
          { label: 'Medicare Levy',                 amount:  a.medicareLevy },
          ...(a.minTaxTopUp > 0
            ? [{ label: `CGT Minimum Tax Top-up (${Math.round(a.minTaxRate * 100)}%)`, amount: a.minTaxTopUp }]
            : []),
          { label: 'Gross Tax',                     amount:  a.baseTax + a.medicareLevy + a.minTaxTopUp },
          { label: 'Franking Credits',              amount: -a.frankingOffset },
          ...(fito > 0
            ? [{ label: `Foreign Income Tax Offset${fitoDeMinimis ? ' (de-minimis)' : ''}`, amount: -fito }]
            : []),
          { label: 'Net Tax Liability',             amount:  netLiability },
          // Memo, below the liability line and deliberately outside every subtotal
          // above it: the fund's own Div 295 tax, already withheld from the member's
          // super balance. Not payable by the member (design 77 §5.3).
          { label: 'Memo: Super Fund Tax (withheld in fund)', amount: auSuperTaxYTD, memo: true },
        ],
      };
    } else {
      // Non-resident: no CGT discount; withholding income taxed at its own final
      // rate per income type (design 73 Gap 2), NOT at one pooled rate.
      const totalIncome              = auOrdinaryIncomeYTD + auCapitalGainsYTD;
      const assessableIncome         = Math.max(0, totalIncome);
      const nrSchedule               = applyBracketsDetailed(assessableIncome, this._nonResidentBrackets);
      const baseTax                  = nrSchedule.tax;

      const {
        auNrWithholdingInterestYTD          = 0,
        auNrWithholdingUnfrankedDividendYTD = 0,
      } = state;
      const rates              = this._nrWithholdingRates;
      const interestTax        = auNrWithholdingInterestYTD          * rates.interest;
      const unfrankedDivTax    = auNrWithholdingUnfrankedDividendYTD * rates.unfrankedDividend;
      // The residual untyped pool. Drained to zero by Gap 2 step 3 (capital gains)
      // and Gap 1 (wages); until then its feeders keep the pre-73 flat rate so each
      // step's effect can be measured on its own.
      const pooledTax          = auNonResidentWithholdingYTD * NR_WITHHOLDING_RATE;
      const withholdingIncome  = auNrWithholdingInterestYTD
                               + auNrWithholdingUnfrankedDividendYTD
                               + auNonResidentWithholdingYTD;
      const nonResidentWithholdingTax = interestTax + unfrankedDivTax + pooledTax;

      const nrWithholdingLines = this._nrWithholdingLineItems({
        interestIncome:     auNrWithholdingInterestYTD,          interestTax,
        unfrankedDivIncome: auNrWithholdingUnfrankedDividendYTD, unfrankedDivTax,
        pooledIncome:       auNonResidentWithholdingYTD,         pooledTax,
      });

      // Design 77 §5.3 — super fund tax excluded here too. A non-resident member's
      // Australian fund still pays Div 295 tax on its earnings, and it is still the
      // fund's liability, not theirs.
      const grossTax                 = Math.max(0, baseTax) + nonResidentWithholdingTax;
      const netLiability             = grossTax;

      const totalGrossIncome   = totalIncome + withholdingIncome;
      const effectiveRate      = totalGrossIncome > 0 ? netLiability / totalGrossIncome : 0;
      const marginalRate       = _marginalBracketRate(assessableIncome, this._nonResidentBrackets);

      return {
        inputs: {
          ordinaryIncome:         auOrdinaryIncomeYTD,
          capitalGains:           auCapitalGainsYTD,
          // Total withholding income across every type — what the reader thinks of
          // as "the withholding line". The per-type slices sit beside it so the
          // document can state each rate against the base it actually applies to.
          nonResidentWithholding: withholdingIncome,
          nrWithholdingInterest:          auNrWithholdingInterestYTD,
          nrWithholdingUnfrankedDividend: auNrWithholdingUnfrankedDividendYTD,
          nrWithholdingPooled:            auNonResidentWithholdingYTD,
          superTax:               auSuperTaxYTD,
          frankingCredits:        auFrankingCreditYTD,
          isResident:             false,
        },
        isResident:               false,
        cgtDiscount:              0,
        discountedCapitalGains:   auCapitalGainsYTD,
        assessableIncome,
        baseTax,
        medicareLevy:             0,
        frankingOffset:           0,
        nonResidentWithholdingTax,
        nrWithholdingInterestTax:          interestTax,
        nrWithholdingUnfrankedDividendTax: unfrankedDivTax,
        nrWithholdingPooledTax:            pooledTax,
        superFundTax:             auSuperTaxYTD,
        // The withholding tax lines, label + amount + flat band already paired, for
        // the document to render without re-deriving any of the three.
        nrWithholdingLines,
        grossTax,
        credits:                  0,
        netLiability,
        effectiveRate,
        marginalRate,
        brackets: {
          table: 'Non-Resident',
          // Non-residents get no CGT discount and no separate gains schedule: ordinary
          // income and gains are taxed together on one bracket run, so a single band
          // set explains the whole "Tax on Income" line and `capitalGains` is null.
          ordinary:     nrSchedule.bands,
          capitalGains: null,
          medicareLevy: null,          // non-residents pay no Medicare levy
          // One band per withholding type: each states the rate against the base it
          // is actually applied to, so the exported row keeps `rate × income = tax`
          // true. A single pooled band could not — the pool mixes rates.
          nrWithholdingInterest: flatRateBand(
            rates.interest, auNrWithholdingInterestYTD, interestTax),
          nrWithholdingUnfrankedDividend: flatRateBand(
            rates.unfrankedDividend, auNrWithholdingUnfrankedDividendYTD, unfrankedDivTax),
          nonResidentWithholding: flatRateBand(
            NR_WITHHOLDING_RATE, auNonResidentWithholdingYTD, pooledTax),
        },
        lineItems: [
          { label: 'Ordinary Income',                         amount:  auOrdinaryIncomeYTD },
          { label: 'Capital Gains (no CGT discount)',         amount:  auCapitalGainsYTD },
          { label: 'Total Assessable Income',                 amount:  assessableIncome },
          { label: 'Tax on Income (Non-Resident Brackets)',   amount:  baseTax },
          ...nrWithholdingLines,
          { label: 'Net Tax Liability',                       amount:  netLiability },
          { label: 'Memo: Super Fund Tax (withheld in fund)', amount:  auSuperTaxYTD, memo: true },
        ],
      };
    }
  }

  /**
   * Medicare levy with low-income phase-in (ATO).
   *
   * Below lowerThreshold: no levy.
   * Phase-in band [lowerThreshold, upperThreshold): levy = (income - lowerThreshold) * phaseInRate.
   * Above upperThreshold: levy = income * rate.
   *
   * upperThreshold is the income where phaseInRate × (income − lower) = rate × income,
   * i.e. lowerThreshold / (1 − rate / phaseInRate).
   */
  _computeMedicareLevy(income) {
    return this._medicareLevyDetail(income).tax;
  }

  /**
   * The Medicare levy plus the worksheet record explaining it (design 71 §8.4).
   *
   * The levy is flat-rate but **not a single flat rate**: inside the phase-in band it
   * is `phaseInRate × (income − lowerThreshold)`, above it `rate × income`. Reporting
   * the statutory 2% against full income would therefore be wrong for exactly the
   * low-income years where a reader is most likely to question the number, so the
   * band records the rate and base *actually applied* — keeping `rate × income = tax`
   * true on the exported row — and carries the regime parameters alongside.
   */
  _medicareLevyDetail(income) {
    const { rate, lowerThreshold, phaseInRate } = this._medicareLevy;
    const params = { lowerThreshold, phaseInRate, statutoryRate: rate };

    if (income <= lowerThreshold) {
      return { tax: 0, band: { ...flatRateBand(0, 0, 0), ...params, regime: 'exempt' } };
    }
    const upperThreshold = lowerThreshold / (1 - rate / phaseInRate);
    if (income < upperThreshold) {
      const base = income - lowerThreshold;
      const tax  = base * phaseInRate;
      return { tax, band: { ...flatRateBand(phaseInRate, base, tax), ...params, regime: 'phase-in' } };
    }
    const tax = income * rate;
    return { tax, band: { ...flatRateBand(rate, income, tax), ...params, regime: 'full' } };
  }
}

// ─── Private helpers ──────────────────────────────────────────────────────────

// `_applyBrackets` / `_marginalBracketRate` used to live here as private copies of
// the identical functions in the US federal and US state rate modules. Design 71 §3
// moved them to the shared `../bracket-schedule.js`, imported at the top of this file
// under the same local names. The AU per-band breakdown (design 71 §8.4) lands with
// the AU worksheet phase.
