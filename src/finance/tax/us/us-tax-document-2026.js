/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseTaxDocumentModule } from '../base-tax-document-module.js';

/**
 * UsTaxDocument2026 — US federal income tax document formatter for 2026+.
 *
 * Generates a 1040-style TaxDocument from a TaxComputationResult.
 * Filing status: Married Filing Jointly (MFJ).
 *
 * Sections:
 *   Income          — Gross income, pre-tax adjustments, AGI, standard deduction
 *   Tax Computation — Ordinary tax, LTCG tax, collectibles, penalties, gross tax
 *   Credits         — Foreign Tax Credit
 */
export class UsTaxDocument2026 extends BaseTaxDocumentModule {
  get countryCode() { return 'US'; }
  get year()        { return 2026; }

  /**
   * @param {object}   taxDetail
   * @param {number}   taxYear
   * @param {object[]} [saleRecords]  - Capital gain transactions from journal mining.
   * @returns {object|object[]}  Single TaxDocument, or [Form 1040, Schedule D, Form 8949] array.
   */
  generate(taxDetail, taxYear, saleRecords = [], period = null) {
    const form1040 = this._generateForm1040(taxDetail, taxYear, period);
    if (!saleRecords.length) return form1040;
    return [form1040, this._generateScheduleD(saleRecords, taxYear), this._generateForm8949(saleRecords, taxYear)];
  }

  _generateForm1040(taxDetail, taxYear, period = null) {
    const { inputs } = taxDetail;
    const drill = (reportId) => period
      ? { reportId, params: { cc: 'US', period } }
      : undefined;
    // Per-band detail from computeTax (design 71 §3.3), attached to the line each
    // band set explains. The modal ignores these fields; the worksheet export reads
    // them generically, which is what keeps the flattener country-agnostic (§8).
    const br = taxDetail.brackets ?? {};
    return {
      title:        `Form 1040 — ${taxYear}`,
      country:      'US',
      taxYear,
      filingStatus: taxDetail.filingStatus ?? 'Married Filing Jointly',
      sections: [
        {
          heading: 'Income',
          lineItems: [
            { label: 'Gross Ordinary Income',               amount:  inputs.grossOrdinaryIncome, drillReport: drill('ordinary-income-by-source')     },
            { label: 'Adjustments (Pre-tax Contributions)', amount: -inputs.adjustments,          drillReport: drill('pretax-adjustments-by-source')  },
            // Half the SECA liability is an above-the-line deduction (IRC §164(f)),
            // so without this line AGI does not follow from the lines above it
            // (design 69, surfaced by design 71 §2.2).
            ...(taxDetail.selfEmploymentTaxDeduction > 0
              ? [{ label: '½ Self-Employment Tax Deduction', amount: -taxDetail.selfEmploymentTaxDeduction }]
              : []),
            // §1211/§1212 (design 90 §4), the AGI half. Both of these are ABOVE the line —
            // short-term gain is ordinary income for rate purposes (§1(h) reserves the
            // preferential rates for net LONG-term gain, §1222(11)) and the loss
            // allowance is a §62(a)(3) deduction — so without them AGI does not follow
            // from the lines above it, which is the design 71 §2.2 defect in a fourth
            // guise. Surfaced by the Schedule D tie in `verifyWorksheetRows`: the
            // schedule reported short-term disposals the return's face never mentioned.
            ...(taxDetail.capitalLoss?.shortTermGain > 0
              ? [{ label: 'Short-Term Capital Gain (taxed at ordinary rates, \u00a71(h))',
                   amount: taxDetail.capitalLoss.shortTermGain }]
              : []),
            ...(taxDetail.capitalLoss?.allowance > 0
              ? [{ label: 'Capital Loss Deduction (\u00a71211(b))',
                   amount: -taxDetail.capitalLoss.allowance }]
              : []),
            { label: 'Adjusted Gross Income',               amount:  taxDetail.adjustedGrossIncome },
            { label: 'Standard Deduction',                  amount: -inputs.standardDeduction },
            // The exclusion APPLIED (stacking-capped), not the uncapped qualifying
            // amount — design 71 §7.1. Reporting the uncapped figure overstated the
            // relief and broke the footing to Taxable Ordinary Income.
            ...(taxDetail.feieExcluded > 0
              ? [{
                  label:  'Foreign Earned Income Exclusion (Form 2555)',
                  amount: -(taxDetail.feieApplied ?? taxDetail.feieExcluded),
                  bands:  br.feieStacked,
                }]
              : []),
            { label: 'Taxable Ordinary Income',             amount:  taxDetail.taxableIncome },
            { label: 'Long-Term Capital Gains (Sch. D)',    amount:  inputs.capitalGains,         drillReport: drill('capital-gains-by-disposal')     },
            // Named for where it ties: this is the 28%-rate slice, which Schedule D
            // reports INSIDE its Part II totals and restates on line 18. The line
            // above is therefore the rest of the net capital gain, not all of it —
            // Schedule D's "Transfer to Form 1040, Line 7" is the sum of the two.
            { label: 'Collectible Gains (28% rate, Sch. D line 18)',
                                                            amount:  inputs.collectibleGains },
            // The depreciation slice of a real-property gain (§1(h)(1)(D)). Named for
            // where it ties, like the collectibles line above it: Schedule D restates it
            // on line 19 for the Schedule D Tax Worksheet, and it does NOT add to the
            // capital-gain line — the two accumulators partition the taxable gain. The
            // disposal reducers carve the slice OUT of `gain` before booking it, so the
            // line above already excludes it and the two must be added, never netted.
            //
            // Emitted only when there is one, following the accumulator's own precedent:
            // a household that never depreciated a property has no slice, and a permanent
            // zero row reads as an assertion that the carve-out was computed.
            ...(taxDetail.unrecapturedSection1250Gain > 0
              ? [
                  { label: 'Unrecaptured \u00a71250 Gain (25% rate, Sch. D line 19)',
                    amount: taxDetail.unrecapturedSection1250Gain },
                  // §1(h)(1)(D)(ii): a standard deduction larger than ordinary income
                  // is absorbed by THIS layer first, before collectibles and before the
                  // 0/15/20 layer. Without the row the tax line's bands span less than
                  // the gain above them and nothing on the return says why — and the
                  // §1250 layer is the only place the reader can ever see this shelter,
                  // since it is exhausted here before it reaches the other two.
                  ...(br.unrecap1250 && br.unrecap1250.gain < taxDetail.unrecapturedSection1250Gain
                    ? [{ label:  '  …less unused standard deduction absorbed (\u00a71(h)(1)(D)(ii))',
                         amount: -(taxDetail.unrecapturedSection1250Gain - br.unrecap1250.gain),
                         sub:    true }]
                    : []),
                ]
              : []),
            // §1212(b) pools — what the year's losses did NOT get to deduct. `memo`
            // because they are stated, not assessed: a reader seeing a \$3,000 deduction
            // against a much larger loss must be able to find the rest, and no footing
            // sum may count it. Same rowType the AU Div 295 disclosure uses.
            ...(taxDetail.capitalLoss?.closingShort > 0
              ? [{ label: 'Short-Term Capital Loss — carried forward (\u00a71212(b)(1)(A))',
                   amount: taxDetail.capitalLoss.closingShort, memo: true }]
              : []),
            ...(taxDetail.capitalLoss?.closingLong > 0
              ? [{ label: 'Long-Term Capital Loss — carried forward (\u00a71212(b)(1)(B))',
                   amount: taxDetail.capitalLoss.closingLong, memo: true }]
              : []),
          ],
        },
        {
          heading: 'Tax Computation',
          lineItems: [
            { label: 'Tax on Ordinary Income',      amount: taxDetail.ordinaryTax,     bands: br.ordinary },
            { label: 'Long-Term Capital Gains Tax', amount: taxDetail.capitalGainsTax, bands: br.ltcg },
            // §1(h)(1)(D). Inside `grossTax` since design 83 G7 but never listed, so on a
            // return with a depreciated property the visible lines did not sum to the
            // stated total — the same defect design 71 §2.2 found for SECA, and what
            // `export:tax --check` catches as a Tax Computation footing violation.
            //
            // The tax is the LESSER of the ordinary bracket differential and 25% of the
            // slice, so the supporting detail is whichever limb actually set it: the
            // differenced bands, or a flat 25% row. See `_bracketBreakdown`.
            ...(taxDetail.unrecapturedSection1250Tax > 0
              ? [{
                  label:  'Unrecaptured \u00a71250 Gain Tax (25% max)',
                  amount: taxDetail.unrecapturedSection1250Tax,
                  ...(br.unrecap1250?.ceilingApplied
                    ? { flat: { rate:   br.unrecap1250.ceilingRate,
                                income: br.unrecap1250.gain,
                                tax:    br.unrecap1250.tax } }
                    : { bands: br.unrecap1250?.bands ?? [] }),
                }]
              : []),
            { label: 'Collectibles Tax (28%)',      amount: taxDetail.collectiblesTax, flat: br.collectibles },
            { label: 'Early Withdrawal Penalties',  amount: taxDetail.penaltyTax },
            // The drill hangs off the NII sub-row, NOT the tax line (design 73
            // §0b.2). What `niit-base-by-component` explains is the §1411 base —
            // linking it to the tax made a reader (and the cross-foot) compare a
            // 694k report against a 26k line. The two sub-rows are also the whole
            // computation: the tax applies to the LESSER of NII and MAGI over the
            // threshold, so without them a year where the MAGI cap binds cannot be
            // reconciled at 3.8% of anything shown.
            ...(taxDetail.niitTax > 0
              ? [
                  {
                    label: 'Net Investment Income Tax (Form 8960, 3.8%)',
                    amount: taxDetail.niitTax,
                    flat: br.niit,
                  },
                  {
                    label: 'Net Investment Income (Form 8960 line 12)',
                    amount: br.niit?.netInvestmentIncome,
                    sub: true,
                    drillReport: drill('niit-base-by-component'),
                  },
                  {
                    label: 'MAGI over §1411 threshold',
                    amount: br.niit?.magi != null && br.niit?.threshold != null
                      ? Math.max(0, br.niit.magi - br.niit.threshold)
                      : undefined,
                    sub: true,
                  },
                ]
              : []),
            // SECA and the Additional Medicare surtax are inside grossTax but were
            // never listed, so for a self-employed filer the visible lines did not
            // sum to the stated total (design 71 §2.2). The SS/Medicare split rides
            // as sub-rows — they are to SECA what bracket bands are to the ordinary
            // tax, and `sub: true` keeps them out of any line-footing sum.
            ...(taxDetail.selfEmploymentTax > 0
              ? [
                  { label: 'Self-Employment Tax (Schedule SE)', amount: taxDetail.selfEmploymentTax },
                  { label: 'Social Security portion (12.4%)',   amount: br.seca?.socialSecurity?.tax, flat: br.seca?.socialSecurity, sub: true },
                  { label: 'Medicare portion (2.9%)',           amount: br.seca?.medicare?.tax,       flat: br.seca?.medicare,       sub: true },
                ]
              : []),
            // Employee FICA (design 95 phase 4). Inside grossTax like SECA, so it has
            // to be LISTED here or the visible lines stop summing to the stated total
            // — the cross-form footing check is the only test that spans two forms and
            // it caught this immediately. The OASDI/Medicare split rides as sub-rows,
            // exactly as SECA's does.
            ...(taxDetail.ficaTax > 0
              ? [
                  { label: 'FICA \u2014 Employee (Form W-2)',  amount: taxDetail.ficaTax },
                  { label: 'Social Security portion (6.2%)',  amount: taxDetail.ficaSsTax,       sub: true },
                  { label: 'Medicare portion (1.45%)',        amount: taxDetail.ficaMedicareTax, sub: true },
                ]
              : []),
            ...(taxDetail.additionalMedicareTax > 0
              ? [{ label: 'Additional Medicare Tax (0.9%)', amount: taxDetail.additionalMedicareTax, flat: br.seca?.additionalMedicare }]
              : []),
            { label: 'Gross Tax',                   amount: taxDetail.grossTax },
          ],
        },
        {
          heading: 'Credits',
          // Per-§904-basket Foreign Tax Credit (design 52 §6): each basket shows
          // the credit taken plus its remaining carryforward pool. Falls back to a
          // single line when there is no foreign activity (pure-US returns).
          lineItems: taxDetail.ftc?.hasActivity
            ? [
                { label: 'Foreign Tax Credit — General (§904)', amount: -taxDetail.ftc.general.credit },
                ...(taxDetail.ftc.general.carryforwardRemaining > 0
                  ? [{ label: '  General carryforward remaining', amount: taxDetail.ftc.general.carryforwardRemaining }]
                  : []),
                { label: 'Foreign Tax Credit — Passive (§904)', amount: -taxDetail.ftc.passive.credit },
                ...(taxDetail.ftc.passive.carryforwardRemaining > 0
                  ? [{ label: '  Passive carryforward remaining', amount: taxDetail.ftc.passive.carryforwardRemaining }]
                  : []),
              ]
            : [
                { label: 'Foreign Tax Credit', amount: -taxDetail.credits },
              ],
        },
        ...this._reliefWorksheet(taxDetail),
      ],
      summary: {
        grossIncome:   inputs.grossOrdinaryIncome
          + Math.max(0, inputs.capitalGains)
          + Math.max(0, inputs.collectibleGains)
          // The §1250 slice is income the return taxes and the other two lines do not
          // contain — it is carved out of `capitalGains`, not folded into it.
          + Math.max(0, taxDetail.unrecapturedSection1250Gain ?? 0),
        grossTax:      taxDetail.grossTax,
        credits:       taxDetail.credits,
        netLiability:  taxDetail.netLiability,
        effectiveRate: taxDetail.effectiveRate,
        marginalRate:  taxDetail.marginalRate,
      },
    };
  }

  /**
   * "Worksheet — Foreign Relief" (design 71 §13): the intermediates behind the FEIE
   * exclusion and the per-§904-basket Foreign Tax Credit.
   *
   * These are the two hardest numbers on a cross-border return to check by hand,
   * because the return states only their *results*: the Credits section shows a
   * credit but not the limitation that capped it, and the Income section shows an
   * exclusion but not the cap that trimmed it. Every value here is already computed
   * by `_computeFtc` / `_computeFeie`; the worksheet just stops hiding them.
   *
   * Rows are `WORKSHEET` / `RATE`, never `LINE` — they are supporting arithmetic, not
   * lines of the return, and must not be summed into it (§5.2). Returns [] when the
   * return has no foreign activity, so a purely domestic year is unchanged.
   */
  _reliefWorksheet(taxDetail) {
    const ftc  = taxDetail.ftc;
    const feie = taxDetail.feieExcluded > 0;
    if (!ftc?.hasActivity && !feie) return [];

    const money = (label, amount) => ({ label, amount, rowType: 'WORKSHEET' });
    const ratio = (label, amount) => ({ label, amount, rowType: 'RATE' });
    const lineItems = [];

    if (feie) {
      lineItems.push(
        money('FEIE — qualifying foreign earned income', taxDetail.feieExcluded),
        // The stacking rule caps the exclusion at taxable ordinary income; when the
        // two differ, the difference is exclusion that could not be used.
        money('FEIE — excluded (stacking-capped)',       taxDetail.feieApplied ?? taxDetail.feieExcluded),
      );
    }

    if (ftc?.hasActivity) {
      // §904 limitation denominators — `frac` and `limit` cannot be checked without
      // them, and neither appears anywhere else on the return. The Form 1116 line-3
      // pair is here for the same reason: without 3e and 3c, the apportioned
      // deduction on each basket is an unexplained subtraction (design 83 G1).
      lineItems.push(
        money('§904 limitation base (§26(b)(1) regular tax)',       ftc.limitationBase),
        money('§904 total taxable income (denominator)',            ftc.totalTaxable),
        money('Form 1116 line 3e — gross income, all sources',      ftc.grossIncomeAllSources ?? 0),
        money('Form 1116 line 3c — deductions not definitely related', ftc.unrelatedDeductions ?? 0),
      );
      // §904(b)(2)(B)(ii) — shown only when it bit, so an ordinary return is unchanged.
      // The denominator two lines above is already net of it; the row exists so a reader
      // can see why it is smaller than taxable income (design 90 §4.5 step 9).
      const rd = taxDetail.rateDifferential;
      if (rd?.worldwide > 0) {
        lineItems.push(
          money('  …less §904(b)(2) rate differential (worldwide)', -rd.worldwide),
          ratio('  …capital gain included at',                       rd.includedFraction),
        );
      }
      const baskets = [['General', ftc.general], ['Passive', ftc.passive]];
      for (const [name, basket] of baskets) {
        lineItems.push(
          money(`${name} — gross foreign income (3d)`,  basket.gross ?? 0),
          ...(basket.excluded > 0
            ? [money(`${name} — less Form 2555 exclusion`, -basket.excluded)]
            : []),
          money(`${name} — less apportioned deduction (3g)`, -(basket.apportionedDeduction ?? 0)),
          ...(basket.capGainAdjustment > 0
            ? [money(`${name} — less §904(b)(2) rate differential`, -basket.capGainAdjustment)]
            : []),
          money(`${name} — foreign taxable income (line 7)`, basket.numerator),
          ratio(`${name} — limitation fraction`,        basket.frac),
          money(`${name} — §904 limit`,                 basket.limit),
          money(`${name} — current-year foreign tax`,   basket.currentTax),
          money(`${name} — carryforward pool opening`,  basket.poolTotal),
          money(`${name} — available (current + pool)`, basket.avail),
          money(`${name} — credit taken`,               basket.credit),
          money(`${name} — drawn from current year`,    basket.currentYearUsed),
          money(`${name} — drawn from carryover`,       basket.carryoverUsed),
          money(`${name} — carryforward remaining`,     basket.carryforwardRemaining),
        );
      }
    }

    return [{ heading: 'Worksheet — Foreign Relief', lineItems }];
  }

  /**
   * Schedule D Part II, laid out in the real form's columns: (d) Proceeds,
   * (e) Cost, (g) Adjustments to gain or loss from Form 8949 column (g), and
   * (h) Gain or (loss) = (d) − (e) + (g).
   *
   * The adjustments line is what lets a main-home sale foot. §121 excludes gain
   * without reducing proceeds or basis, so a return reports the disposal gross and
   * carries the exclusion as a negative column (g) figure (Form 8949 code H) — see
   * `_saleAdjustment` in tax-document-registry.js. Netting it into the gain instead
   * would foot arithmetically while misstating the sale.
   *
   * **Line 18 does not add to the return; it partitions it.** A collectible is inside
   * the Part II totals above like any other long-term sale, and line 18 restates the
   * 28%-rate slice so the Schedule D Tax Worksheet can rate it separately — adding it
   * to the net gain would double-count the disposal. Only worksheet line 1 (the
   * collectibles gain reported on Form 8949, Part II) is modelled; lines 2–6 are
   * §1202 exclusions, Forms 4684/6252/6781/8824, 1099-DIV box 2d / 2439 / K-1
   * collectibles gain, and the long-term loss-carryover interaction, none of which
   * this model produces. Line 7's floor at zero IS applied, which is what keeps a
   * collectible LOSS out of line 18 while leaving it in the net gain above — the
   * §1(h)(4) rate attaches to net collectible GAIN only.
   * Reference: docs/us-tax/IRS-Schedule-D-Instructions-2025.txt, "28% Rate Gain
   * Worksheet—Line 18".
   */
  _generateScheduleD(saleRecords, taxYear) {
    const totalProceeds   = saleRecords.reduce((s, r) => s + r.proceeds,  0);
    const totalCostBasis  = saleRecords.reduce((s, r) => s + r.costBasis, 0);
    const totalAdjustment = saleRecords.reduce((s, r) => s + (r.adjustment ?? 0), 0);
    const totalGain       = saleRecords.reduce((s, r) => s + r.gain,      0);
    const collectibles    = saleRecords.filter(r => r.collectible);
    const rateGain28      = Math.max(0, collectibles.reduce((s, r) => s + r.gain, 0));
    // Line 19, the §1250 counterpart of line 18. Same partitioning rule: the slice is
    // already inside the Part II totals, and this restates it so the Schedule D Tax
    // Worksheet can rate it at its own 25% ceiling.
    const rateGain25      = Math.max(0, saleRecords.reduce((s, r) => s + (r.depreciationGain ?? 0), 0));
    // Schedule D line 7. Restated, not separated: this model's disposal payloads carry
    // ONE sale price per disposal, and a sale that consumed both seasoned and fresh lots
    // cannot apportion it between Part I and Part II. Reporting the combined totals with
    // the short-term slice named is the honest form of that limit — dropping the slice
    // instead is what left short-term disposals on no form at all.
    const shortTermGain   = saleRecords.reduce((s, r) => s + (r.shortTermGain ?? 0), 0);
    return {
      title:        `Schedule D — ${taxYear}`,
      country:      'US',
      taxYear,
      filingStatus: 'Capital Gains and Losses',
      sections: [
        {
          heading: 'Parts I & II — Capital Gains and Losses',
          lineItems: [
            { label: 'Total Proceeds (from Form 8949)',    amount: totalProceeds   },
            { label: 'Total Cost Basis (from Form 8949)',  amount: totalCostBasis  },
            { label: 'Adjustments to Gain or Loss (Form 8949, column (g))',
                                                           amount: totalAdjustment },
            { label: 'Net Capital Gain / (Loss)',          amount: totalGain       },
          ],
        },
        {
          heading: 'Net Capital Gain',
          lineItems: [
            { label: 'Net Capital Gain (Line 16)',          amount: totalGain },
            // Printed only when the year produced short-term character, on the same
            // terms as lines 18 and 19 below. It is taxed at ordinary rates and shows on
            // the 1040's own Short-Term Capital Gain line, so restating it here is what
            // lets a reader see which part of this schedule did NOT reach line 18/19 or
            // the preferential brackets.
            ...(shortTermGain !== 0
              ? [{ label: 'Net Short-Term Gain / (Loss) (Line 7)',
                   amount: shortTermGain, sub: true }]
              : []),
            // Printed only when there is a collectible in the year — the real form
            // leaves line 18 blank unless line 17 is "Yes" and a 28%-rate item was
            // reported, and a permanent zero here reads as an assertion that the
            // worksheet was run rather than that it did not apply.
            ...(collectibles.length
              ? [{ label: '28% Rate Gain (Line 18, from the 28% Rate Gain Worksheet)',
                   amount: rateGain28, sub: true }]
              : []),
            // Printed on the same terms as line 18 above: only when the year actually
            // produced a depreciation slice. A permanent zero would assert that the
            // Unrecaptured Section 1250 Gain Worksheet was run and came to nothing.
            ...(rateGain25 > 0
              ? [{ label: 'Unrecaptured §1250 Gain (Line 19, from the §1250 Worksheet)',
                   amount: rateGain25, sub: true }]
              : []),
            { label: 'Transfer to Form 1040, Line 7',       amount: totalGain },
          ],
        },
      ],
    };
  }

  /**
   * Form 8949, including columns (f) Code and (g) Amount of adjustment.
   *
   * **The two FX columns are not on the real form, and are here for the reason the
   * rest of the form is:** every figure on this table is USD, but a foreign-situated
   * disposal was struck in another currency, and a reader given only the translated
   * numbers cannot check a single one of them. `§1.988-1(d)` requires a named spot
   * rate per transaction; naming it beside the row is the honest form of that. The
   * columns appear only when the year actually contains a foreign disposal, so a
   * purely domestic 8949 is exactly the eight columns of the real form.
   *
   * The rate is the one the run held AT THE DISPOSAL, not at the settlement — see
   * `_extractUsSaleRecords` and `FxTimeline`.
   */
  _generateForm8949(saleRecords, taxYear) {
    const totalProceeds   = saleRecords.reduce((s, r) => s + r.proceeds,  0);
    const totalCostBasis  = saleRecords.reduce((s, r) => s + r.costBasis, 0);
    const totalAdjustment = saleRecords.reduce((s, r) => s + (r.adjustment ?? 0), 0);
    const totalGain       = saleRecords.reduce((s, r) => s + r.gain,      0);
    const hasForeign      = saleRecords.some(r => r.fxRate != null);
    const fxCells         = r => (hasForeign
      ? [r.currency ?? 'USD', r.fxRate ?? '']
      : []);
    return {
      title:        `Form 8949 — ${taxYear}`,
      country:      'US',
      taxYear,
      filingStatus: 'Parts I & II — Sales and Other Dispositions',
      table: {
        heading: 'Sales and Other Dispositions of Capital Assets',
        columns: ['Description', 'Date Acquired', 'Date Sold',
                  ...(hasForeign ? ['Currency', 'FX Rate'] : []),
                  'Proceeds', 'Cost Basis',
                  'Code', 'Adjustment', 'Gain / (Loss)'],
        rows: saleRecords.map(r => [
          // Keyed cell (design 70): the modal resolves the account's display name,
          // falling back to this text where no registry is in scope. Without it a
          // disposal reads `usStockAccount` whenever the account carries no explicit
          // name, which is the common case — the emitter's `account.name || stateKey`
          // has nothing better to fall back to.
          r.stateKey ? { stateKey: r.stateKey, text: r.description } : r.description,
          r.dateAcquired,
          _fmtDate(r.dateSold),
          ...fxCells(r),
          r.proceeds,
          r.costBasis,
          r.code ?? '',
          r.adjustment ?? 0,
          r.gain,
        ]),
        totals: ['Totals', '', '', ...(hasForeign ? ['', ''] : []),
                 totalProceeds, totalCostBasis, '', totalAdjustment, totalGain],
      },
    };
  }
}

function _fmtDate(date) {
  if (!date) return '—';
  // `timeZone: 'UTC'` is load-bearing, not tidiness. Every date in the run is a UTC
  // instant, and rendering one west of Greenwich rolls it back a day — a disposal
  // settled on 15 Jan printed as 14 Jan on Form 8949, which is a column (c) entry
  // that disagrees with the journal and, near a year boundary, with the tax year of
  // the return it sits on. Same trap the plugin date layer already pays for.
  return new Date(date).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
}
