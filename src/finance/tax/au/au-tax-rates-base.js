/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { div293 } from './div293.js';
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
/**
 * The s290-150 personal super deduction, clamped by s26-55 (design 95 §9.1, 6b).
 *
 * s26-55(1)(d) puts the deduction on the limited list; s26-55(2) sets the limit at
 * *assessable income less all your deductions except tax losses* (and s393-5 farm
 * deposits, which this model has none of). So a deductible contribution can reduce
 * taxable income to zero but **cannot create or increase a tax loss** — the excess
 * is simply not deductible, and is not carried anywhere.
 *
 * That is the whole reason this is applied BEFORE the Div 36 loss pool and computed
 * against income measured before it: s26-55(2)(a) names tax losses as the one thing
 * NOT subtracted when working out the limit. Applying the two in the other order
 * would let a loss-year contribution deduct against income the losses had already
 * absorbed, and manufacture relief the Act denies twice over.
 *
 * @param {number} contributed  gross deductible contributions for the year
 * @param {number} assessable   assessable income before tax losses
 * @returns {number} the allowable deduction
 */
function _superDeductionAllowed(contributed, assessable) {
  return Math.min(Math.max(0, contributed), Math.max(0, assessable));
}

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
   * ITAA 1997 s102-5 Steps 1–2 — capital losses, applied BEFORE the Div 115 discount
   * (design 90 §5). Pure; the settle owns the pool write-back.
   *
   * **The ordering is the whole point, and it is the Act's.** The s102-5(1) method
   * statement reduces gross capital gains by the year's capital losses (Step 1) and
   * then by carried-forward net capital losses (Step 2), and only reaches the discount
   * percentage at Step 5. Discounting first and netting after would halve the gain and
   * then let the loss eat the halved figure, wasting half of every loss.
   *
   * **s102-10(2): "You cannot deduct from your assessable income a net capital loss for
   * any income year."** So an unused loss goes to a pool that only ever meets future
   * capital gains — never wages, never rent. That is the one hard difference from the
   * US §1211(b) allowance, and it is why this pool must stay distinct from the Div 36
   * `auTaxLossPool` sitting a few lines below in `_assessResidentPreFito`: merging them
   * would let a capital loss shelter ordinary income, which this subsection forbids in
   * as many words.
   *
   * **Which gains the losses eat first is a CHOICE the Act grants**, and design 90 §5.3
   * records it: s102-5(1) Step 1 Note 3 lets the taxpayer "choose the order in which you
   * reduce them", so losses are applied to NON-discountable gains first. A dollar of
   * loss spent on a non-discount gain saves a full dollar of assessable income; spent on
   * a discount gain it saves fifty cents, because the discount would have halved that
   * dollar anyway. The alternative models a taxpayer who volunteers to waste half of
   * every loss.
   *
   * Runs on the PER-PERSON state `computeAuTaxPerPerson` builds, so `auCapitalLossPool`
   * here is one taxpayer's pool — see design 90 §5.1 for why it is never a household
   * scalar.
   *
   * @param {object} state  a single taxpayer's slice
   * @returns {{ total:number, discountable:number, real:number, apportionedBase:number,
   *   apportionedAllowance:number, opening:number, applied:number, closing:number,
   *   steps:object }}
   *   The first five are post-netting inputs for `_cgtRelief`; `closing` is the pool;
   *   `steps` is the per-s102-5-step working the CGT summary worksheet reports.
   */
  _applyCapitalLosses(state) {
    const opening = Math.max(0, state?.auCapitalLossPool ?? 0);
    const total   = state?.auCapitalGainsYTD ?? 0;
    // ABSENT means "all of it qualifies", not "none of it" — the same old-save rule
    // `_cgtRelief` applies, and it has to be applied HERE too now that this function
    // hands `_cgtRelief` a state with the key always materialized. Defaulting to 0
    // instead silently withdrew the Division 115 discount from every synthetic state
    // and every pre-design-62 save.
    const discountable = (state != null && 'auDiscountableGainsYTD' in state)
      ? (state.auDiscountableGainsYTD ?? 0)
      : total;

    // The two halves of the year's gross result, each signed.
    const dGainRaw = discountable;
    const nGainRaw = total - discountable;

    const currentYearLosses = Math.max(0, -dGainRaw) + Math.max(0, -nGainRaw);
    let dGain  = Math.max(0, dGainRaw);
    let nGain  = Math.max(0, nGainRaw);

    // s102-5 Step 1 THEN Step 2, tracked separately rather than as one pooled figure.
    //
    // The arithmetic is unchanged — min(CYL, g) + min(PY, g − min(CYL, g)) is exactly
    // min(CYL + PY, g), so every total below is bit-identical to the single-pass version
    // this replaced. What the split buys is the ability to SAY which step consumed what,
    // and that is not cosmetic: the ATO CGT summary worksheet gives current-year losses
    // and prior-year net capital losses their own tables (2 and 3), each broken down by
    // method column, and a reader checking our net capital gain against the worksheet
    // cannot get past table 2 without those two numbers apart.
    //
    // §5.3: within each step, non-discountable first. A dollar of loss spent on a
    // non-discount gain saves a full dollar of assessable income; spent on a discount
    // gain it saves fifty cents.
    let cy = currentYearLosses;
    const cyN = Math.min(cy, nGain); cy -= cyN; nGain -= cyN;
    const cyD = Math.min(cy, dGain); cy -= cyD; dGain -= cyD;

    let py = opening;
    const pyN = Math.min(py, nGain); py -= pyN; nGain -= pyN;
    const pyD = Math.min(py, dGain); py -= pyD; dGain -= pyD;

    const takeN = cyN + pyN;
    const takeD = cyD + pyD;
    const loss  = cy + py;

    // The s115-115 apportionment (design 83 G7) is sized against the PRE-loss
    // discountable base, so it has to shrink with it. Leaving it alone would grant
    // apportioned relief computed on a gain the losses had already removed — relief
    // exceeding the gain it relieves.
    const dScale = dGainRaw > 0 ? dGain / dGainRaw : 0;
    const nettedTotal = dGain + nGain;
    const applied     = takeN + takeD;

    // FY2027+ replaces the discount with CPI indexation, so the reform module assesses
    // a REAL gain rather than the nominal one. Only the PRIOR-YEAR pool comes off it.
    //
    // Both reductions are absolute amounts, not a ratio of the nominal reduction. That
    // distinction is load-bearing and was got wrong first time. Scaling the real bucket
    // by `netted / gross` couples it to *every* reduction in the nominal figure,
    // including ones that have nothing to do with capital losses — most importantly the
    // FITO counterfactual, which strips US-source gain from the nominal bucket and
    // relies on a SEPARATE signal (`usSourceRealCapGainsAudYTD`) to strip the real one.
    // Under a ratio, the real bucket would shrink on its own and silently paper over a
    // missing signal, which is precisely the design 57 Part 2 D defect
    // `tax-cross-border-relief.test.mjs` FITO-D exists to detect.
    //
    // ─── why the CURRENT-year loss is NOT subtracted here (design 57 Part 6) ─────
    // It is already inside `auRealCapitalGainsYTD`. Both accumulators are signed and
    // booked per disposal from the same action, and `auRealCapitalGain` gives a loss its
    // un-indexed figure under s960-275 — so a capital loss reduces the real bucket by
    // exactly what it reduced the nominal one by, as it happens. `currentYearLosses`
    // above is not new information: it is that same loss RECONSTRUCTED from a bucket
    // that came out negative, re-applied to the floored positives so `nettedTotal`
    // re-derives a figure the accumulator already held. Subtracting it from the real
    // bucket as well took the loss twice.
    //
    // The prior-year pool is different in kind: it lives outside the year's
    // accumulators, so it has to be applied to both. A carried-forward loss carries no
    // indexation of its own — the Act gives it none — so it comes off the real gain at
    // face value.
    const pyApplied = pyN + pyD;
    const rawReal   = Math.max(0, state?.auRealCapitalGainsYTD ?? 0);

    return {
      total:        +nettedTotal.toFixed(2),
      discountable: +dGain.toFixed(2),
      real:         +Math.max(0, rawReal - pyApplied).toFixed(2),
      apportionedBase:      +(Math.max(0, state?.auDiscountApportionedBaseYTD ?? 0) * dScale).toFixed(2),
      apportionedAllowance: +(Math.max(0, state?.auDiscountAllowanceYTD ?? 0) * dScale).toFixed(2),
      opening,
      applied: +applied.toFixed(2),
      closing: +loss.toFixed(2),
      // The worksheet's own working, one entry per s102-5 step. `grossDiscountable`
      // and `grossOther` are the row-1 figures each step starts from, so a reader can
      // foot table 2 and table 3 downwards without re-deriving them.
      //
      // NOTE on `losses`: this is the loss visible at BUCKET level — a bucket whose
      // signed total came out negative. It is not the year's gross capital losses,
      // because the accumulators are signed (design 90 §4): a bucket with +1,000 of
      // gains and −400 of losses reaches here as +600, and the 400 is unrecoverable.
      // So this understates worksheet cell 2A whenever gains and losses landed in the
      // same bucket. Splitting them needs gross accumulators at the booking sites.
      steps: {
        grossDiscountable: +Math.max(0, dGainRaw).toFixed(2),
        grossOther:        +Math.max(0, nGainRaw).toFixed(2),
        currentYear: {
          losses:        +currentYearLosses.toFixed(2),
          appliedOther:  +cyN.toFixed(2),
          appliedDiscountable: +cyD.toFixed(2),
          applied:       +(cyN + cyD).toFixed(2),
          unapplied:     +cy.toFixed(2),
        },
        priorYear: {
          opening,
          appliedOther:  +pyN.toFixed(2),
          appliedDiscountable: +pyD.toFixed(2),
          applied:       +(pyN + pyD).toFixed(2),
          unapplied:     +py.toFixed(2),
        },
      },
    };
  }

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
    // Design 83 G7 step 3 — s115-105/110/115. The discount is not a flat 50%: it is
    // 50% × (days an Australian resident ÷ days in the discount testing period). Where a
    // classifier knew the asset's real testing period it recorded the apportioned base
    // and the relief it earned; everything else keeps the flat rate, which is the right
    // answer for it — design 62's deemed acquisition restarts the clock at the move, so
    // a non-TAP asset's testing period lies wholly inside the residency.
    //
    // Splitting the base in two rather than scaling one number is what keeps this
    // additive: a year can contain both an apportioned property disposal and a flat-rate
    // share sale, and they must not be averaged into a rate neither of them attracts.
    const apportionedBase  = Math.min(discountBase, Math.max(0, state?.auDiscountApportionedBaseYTD ?? 0));
    const flatBase         = Math.max(0, discountBase - apportionedBase);
    const apportionedRelief = Math.max(0, state?.auDiscountAllowanceYTD ?? 0);
    const reliefAmount   = flatBase * this._cgtDiscountRate + apportionedRelief;
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
      // Design 95 §9.1 phase 6b — s290-150 personal deductible super contributions
      // for the year, GROSS of the fund's Div 295 tax. The member pays 15% inside
      // the fund and deducts the whole contribution outside it; that gap is where
      // the concession lives for anyone whose marginal rate exceeds 15%.
      auDeductibleSuperYTD = 0,
    } = state;

    // s102-5 Steps 1–2 FIRST (design 90 §5): capital losses come off the GROSS gain,
    // before the discount at Step 5. `_cgtRelief` is then handed a state whose gain
    // figures are already net, so neither rate module — the flat-discount one here nor
    // the FY2027 indexation override — needs to know capital losses exist. That is
    // deliberate: `_cgtRelief` is an override point about RELIEF, and threading loss
    // netting through both implementations would have duplicated the ordering rule in
    // the one place a future rate module is most likely to get it wrong.
    const capLoss = this._applyCapitalLosses(state);
    const nettedGains = capLoss.total;
    const cgtState = {
      ...state,
      auCapitalGainsYTD:            nettedGains,
      auDiscountableGainsYTD:       capLoss.discountable,
      auDiscountApportionedBaseYTD: capLoss.apportionedBase,
      auDiscountAllowanceYTD:       capLoss.apportionedAllowance,
      ...('auRealCapitalGainsYTD' in state ? { auRealCapitalGainsYTD: capLoss.real } : {}),
    };

    // Apply the year's CGT relief. Base = flat 50% Div 115 discount and no
    // minimum-tax floor (minTaxRate 0). FY2027+ removes the discount and sets
    // minTaxRate to 0.30 (design 57 §6.3).
    const { netTaxableGain, reliefAmount: cgtDiscount, minTaxRate } =
      this._cgtRelief(cgtState, nettedGains);

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
    // s290-150, limited by s26-55 — see `_superDeductionAllowed`. It comes off HERE,
    // between assessable income and the loss pool, because the s26-55(2) limit is
    // measured on income before tax losses and the deduction may not create one.
    const superDeduction        = _superDeductionAllowed(auDeductibleSuperYTD, grossDiscountedIncome);
    const incomeAfterSuperDed   = grossDiscountedIncome - superDeduction;
    const openingLossPool       = Math.max(0, auTaxLossPool);
    const lossDeducted          = Math.min(openingLossPool, Math.max(0, incomeAfterSuperDed));
    // A loss year adds its own excess to the pool; deduction and creation are
    // mutually exclusive, since one needs positive income and the other negative.
    const lossCreated           = Math.max(0, -incomeAfterSuperDed);
    const closingLossPool       = openingLossPool - lossDeducted + lossCreated;

    const discountedIncome = incomeAfterSuperDed - lossDeducted;
    const assessableIncome = Math.max(0, discountedIncome);
    // `.tax` is identical to the scalar applyBrackets these lines used before; the
    // bands ride along for the worksheet export (design 71 §8.4).
    const assessableSchedule = applyBracketsDetailed(assessableIncome, this._brackets);
    const baseTax          = assessableSchedule.tax;
    const medicare         = this._medicareLevyDetail(discountedIncome);
    const medicareLevy     = medicare.tax;
    // Design 90 §8 / design 76 §8.2 Gap 3 — ITAA 1997 s67-25(1): Division 207 offsets
    // "are subject to the refundable tax offset rules" for everyone outside its listed
    // carve-outs (non-complying super funds, certain trustees, corporate tax entities).
    // An individual is not in any of them, so the offset is REFUNDABLE: it is not capped
    // at base tax, it applies against the whole liability including the Medicare levy,
    // and any excess is paid out.
    //
    // The old `Math.min(…, baseTax)` forfeited that excess. It ran AGAINST the household
    // and hit exactly one taxpayer — the low-income retiree whose base tax is too small
    // to absorb the credit, which is the same person design 84 G10 landed on for the
    // same structural reason. It was also the smallest of design 76 §8.2's three gaps
    // and pointed the other way from the two above, so it never cancelled them.
    const frankingOffset   = Math.max(0, auFrankingCreditYTD);

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
    // A refundable offset can drive this NEGATIVE — that is a refund owed, not a
    // violation, and clamping it at 0 is precisely how the excess used to be destroyed.
    // The FITO limit below reads this figure, so it is clamped THERE (a refund creates
    // no room for a foreign tax offset) rather than here, keeping the two distinct:
    // "the Commissioner owes you" and "there is no liability left to relieve" are
    // different states that a single Math.max conflated.
    const netLiabilityPreFito = baseTax + medicareLevy + minTaxTopUp - frankingOffset;

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
      // s290-150 / s26-55 (design 95 §9.1 phase 6b). Both figures, not just the
      // allowed one: a contribution the s26-55(2) limit cut down is exactly the case
      // a reader needs to see, and `allowed < contributed` is the only place the
      // return can say so.
      superDeductionContributed: Math.max(0, auDeductibleSuperYTD),
      superDeductionAllowed:     superDeduction,
      // s102-5 / s102-15 net capital losses (design 90 §5). A SEPARATE pool from the
      // Div 36 trio above — s102-10(2) bars a net capital loss from ever reducing
      // assessable income, so the two must never be summed.
      capitalLoss: capLoss,
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
      // design 95 §9.1 — read here for the NON-RESIDENT branch; the resident branch
      // destructures its own copy inside `_assessResidentPreFito`.
      auDeductibleSuperYTD        = 0,
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
            // Marks the counterfactual so `AuTaxRates2027._cgtRelief` leaves its
            // indexation partition invariant unenforced here. This pass subtracts two
            // removal sets that a broken classifier can make inconsistent, and the
            // resulting degenerate limit is a DETECTOR (FITO-D) rather than a defect to
            // repair: clamping it would silently paper over the missing
            // `usSourceRealCapGainsAudYTD` signal, which is the one failure mode this
            // whole "without" pass was built to expose. Nothing assessed on a return is
            // computed from this pass — it only sizes a limit.
            _fitoCounterfactual: true,
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
        // Clamp at 0 as well as at the liability: `netLiabilityPreFito` can now be
        // NEGATIVE (a refundable franking offset exceeding the whole liability), and a
        // negative cap would turn the FITO into a charge. A refund owed leaves nothing
        // for a foreign tax offset to relieve, so the right answer is zero FITO.
        fito = Math.min(fito, Math.max(0, a.netLiabilityPreFito));
      }

      // Design 77 §5.3 — super fund tax excluded (see _assessResidentPreFito).
      //
      // Still no clamp, but the reason has changed (design 90 §8). It used to be that
      // `frankingOffset` was capped at `baseTax`, so this could not go negative. Under
      // s67-25 the franking offset is REFUNDABLE and uncapped, so this genuinely can —
      // and must be allowed to. A negative Net Tax Liability is a REFUND OWED; clamping
      // it at zero would destroy the excess credit all over again, one line further
      // down. `fito` is separately floored at 0 above, so it can only ever reduce.
      //
      // The plain subtraction is what keeps "Gross Tax + credits = Net Tax Liability"
      // exact (design 71 §6) — the footing identity holds whether the result is
      // positive or negative, which is the whole reason it is stated as a subtraction.
      const netLiabilityIncomeTax = a.baseTax + a.medicareLevy + a.minTaxTopUp
                                  - a.frankingOffset - fito;

      // ─── Division 293 (design 95 §9.4, phase 8) ─────────────────────────────
      //
      // Added AFTER the offsets, and that placement is the substantive decision on
      // this line. Div 293 is imposed by its own Act on a base of its own — taxable
      // CONTRIBUTIONS, not income — so it is not part of the income tax assessment
      // that franking credits and the FITO reduce. Folding it in before them would
      // let a refundable franking offset wipe out a liability it has no reach over,
      // which is the same mistake design 84 G10 found in the CGT minimum-tax top-up,
      // running the other way. `assessableIncome` is the model's name for TAXABLE
      // income here — it is computed after the s290-150 deduction and after Div 36
      // losses — which is exactly limb (a) of s293-20(1).
      const d293 = div293({
        taxableIncome:             a.assessableIncome,
        concessionalContributions: state.auLowTaxContributionsYTD ?? 0,
      });
      const netLiability = netLiabilityIncomeTax + d293.tax;

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
        // s290-150 personal super deduction and what s26-55 actually allowed.
        superDeductionContributed: a.superDeductionContributed ?? 0,
        superDeductionAllowed:     a.superDeductionAllowed     ?? 0,
        // Div 293 (design 95 §9.4). `div293Tax` is INSIDE netLiability and outside
        // grossTax, because it is a separate imposition rather than part of the
        // income tax the offsets reduce — the same treatment `superFundTax` gets for
        // the opposite reason (that one is not the member's liability at all).
        div293Tax:                 d293.tax,
        div293TaxableContributions: d293.taxableContributions,
        div293LowTaxContributions:  d293.lowTaxContributions,
        div293Binding:              d293.binding,
        // design 90 §5 — `closingCapitalLossPool` is what the AU settle persists.
        openingCapitalLossPool:   a.capitalLoss?.opening ?? 0,
        capitalLossApplied:       a.capitalLoss?.applied ?? 0,
        closingCapitalLossPool:   a.capitalLoss?.closing ?? 0,
        // The s102-5 method statement's own working — gains by method column, and what
        // each of Steps 1 and 2 consumed. Carried on the return because the AU CGT
        // summary worksheet is footed from it (`AuTaxDocument2026._generateCgtSummary`),
        // and none of it can be reconstructed from the three scalars above: they state
        // the pool's opening, movement and close, not which gains the movement ate.
        capitalLossSteps:         a.capitalLoss?.steps ?? null,
        // The two gain figures the worksheet's Part 4 needs, both AFTER the s102-5
        // loss steps and BEFORE relief. Which one is the relief base is a year
        // question, not a presentational one: Division 115 discounts only the
        // ≥12-month slice, while the FY2027 reform indexes the whole gain — so the
        // return carries both and each year's document module names the one it used.
        nettedCapitalGains:       a.capitalLoss?.total ?? 0,
        discountableGainsNetted:  a.capitalLoss?.discountable ?? 0,
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
          // s290-150, before the loss lines because that is the order it is applied
          // in — s26-55(2) measures its limit on income BEFORE tax losses. The second
          // line appears only when the limit actually bit, so an ordinary return that
          // deducts the whole contribution shows one line, not two.
          ...(a.superDeductionContributed > 0
            ? [
                { label: 'Personal Super Contributions Deducted (s290-150)',
                  amount: -a.superDeductionAllowed },
                ...(a.superDeductionContributed > a.superDeductionAllowed
                  ? [{ label: 'Deduction Denied by s26-55 Limit',
                       amount: a.superDeductionContributed - a.superDeductionAllowed }]
                  : []),
              ]
            : []),
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
          // Div 293 (design 95 §9.4) — the member's OWN liability, on its own base.
          // BELOW the two offset lines because neither reaches it, and ABOVE the Net
          // Tax Liability line because it is INSIDE that total: the footing identity
          // (design 71 §6) has to hold line by line, and a Div 293 printed under the
          // total it is part of would leave the visible lines not summing to it.
          //
          // Shown only when it bites, so an ordinary return is unchanged. The second
          // line names which limb of the s293-20(1) "lesser of" bound, because they
          // mean different things to a reader deciding whether to sacrifice more:
          // EXCESS is the phase-in band, where a dollar of income costs 15c;
          // CONTRIBUTIONS is past it, where every concessional dollar costs 15c.
          ...(d293.tax > 0
            ? [
                { label: 'Div 293 Taxable Contributions', amount: d293.taxableContributions },
                { label: `Div 293 Tax (15%, bound by ${d293.binding === 'EXCESS'
                    ? 'the $250,000 threshold' : 'contributions'})`, amount: d293.tax },
              ]
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
      // s290-150 applies on this branch too (design 95 §9.1). Dropping it while the
      // branch still charges Div 295 in the fund AND Div 293 below left a non-resident
      // making a deductible contribution strictly WORSE OFF than making none — the
      // 15% going in, possibly 15% again on top, and no deduction coming back.
      // s26-55's limit is measured the same way: assessable income before tax losses.
      const grossIncome              = auOrdinaryIncomeYTD + auCapitalGainsYTD;
      const superDeduction           = _superDeductionAllowed(auDeductibleSuperYTD, grossIncome);
      const totalIncome              = grossIncome - superDeduction;
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

      // Div 293 applies to a NON-RESIDENT too (design 95 §9.4, phase 8). Nothing in
      // s293-15 or s293-20 conditions the liability on residency — it attaches to
      // taxable contributions, and a foreign resident working in Australia has an
      // employer paying the Super Guarantee for them just the same. Their "income for
      // surcharge purposes" is built on their taxable income, which on this branch is
      // their Australian-source income alone; that is the correct reading rather than
      // a simplification. Omitting it here would have let the US-resident spouse of a
      // cross-border household escape it silently, which is exactly the shape of
      // defect design 73 §6b was about.
      const d293 = div293({
        taxableIncome:             assessableIncome,
        concessionalContributions: state.auLowTaxContributionsYTD ?? 0,
      });
      const netLiability             = grossTax + d293.tax;

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
        div293Tax:                  d293.tax,
        div293TaxableContributions: d293.taxableContributions,
        div293LowTaxContributions:  d293.lowTaxContributions,
        div293Binding:              d293.binding,
        superDeductionContributed:  Math.max(0, auDeductibleSuperYTD),
        superDeductionAllowed:      superDeduction,
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
          // s290-150 — same placement as the resident branch: before the total, and
          // before the tax lines it reduces.
          ...(auDeductibleSuperYTD > 0
            ? [{ label: 'Personal Super Contributions Deducted (s290-150)',
                 amount: -superDeduction }]
            : []),
          // Div 293 — see the resident branch for why it sits below the offsets and
          // above the total it is part of.
          ...(d293.tax > 0
            ? [
                { label: 'Div 293 Taxable Contributions', amount: d293.taxableContributions },
                { label: `Div 293 Tax (15%, bound by ${d293.binding === 'EXCESS'
                    ? 'the $250,000 threshold' : 'contributions'})`, amount: d293.tax },
              ]
            : []),
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
