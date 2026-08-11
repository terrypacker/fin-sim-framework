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
            { label: 'Collectible Gains',                   amount:  inputs.collectibleGains },
          ],
        },
        {
          heading: 'Tax Computation',
          lineItems: [
            { label: 'Tax on Ordinary Income',      amount: taxDetail.ordinaryTax,     bands: br.ordinary },
            { label: 'Long-Term Capital Gains Tax', amount: taxDetail.capitalGainsTax, bands: br.ltcg },
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
          + Math.max(0, inputs.collectibleGains),
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
      const baskets = [['General', ftc.general], ['Passive', ftc.passive]];
      for (const [name, basket] of baskets) {
        lineItems.push(
          money(`${name} — gross foreign income (3d)`,  basket.gross ?? 0),
          ...(basket.excluded > 0
            ? [money(`${name} — less Form 2555 exclusion`, -basket.excluded)]
            : []),
          money(`${name} — less apportioned deduction (3g)`, -(basket.apportionedDeduction ?? 0)),
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
   */
  _generateScheduleD(saleRecords, taxYear) {
    const totalProceeds   = saleRecords.reduce((s, r) => s + r.proceeds,  0);
    const totalCostBasis  = saleRecords.reduce((s, r) => s + r.costBasis, 0);
    const totalAdjustment = saleRecords.reduce((s, r) => s + (r.adjustment ?? 0), 0);
    const totalGain       = saleRecords.reduce((s, r) => s + r.gain,      0);
    return {
      title:        `Schedule D — ${taxYear}`,
      country:      'US',
      taxYear,
      filingStatus: 'Capital Gains and Losses',
      sections: [
        {
          heading: 'Part II — Long-Term Capital Gains and Losses',
          lineItems: [
            { label: 'Total Proceeds (from Form 8949)',    amount: totalProceeds   },
            { label: 'Total Cost Basis (from Form 8949)',  amount: totalCostBasis  },
            { label: 'Adjustments to Gain or Loss (Form 8949, column (g))',
                                                           amount: totalAdjustment },
            { label: 'Net Long-Term Gain / (Loss)',        amount: totalGain       },
          ],
        },
        {
          heading: 'Net Capital Gain',
          lineItems: [
            { label: 'Net Capital Gain (Line 15)',          amount: totalGain },
            { label: 'Transfer to Form 1040, Line 7',       amount: totalGain },
          ],
        },
      ],
    };
  }

  /** Form 8949 Part II, including columns (f) Code and (g) Amount of adjustment. */
  _generateForm8949(saleRecords, taxYear) {
    const totalProceeds   = saleRecords.reduce((s, r) => s + r.proceeds,  0);
    const totalCostBasis  = saleRecords.reduce((s, r) => s + r.costBasis, 0);
    const totalAdjustment = saleRecords.reduce((s, r) => s + (r.adjustment ?? 0), 0);
    const totalGain       = saleRecords.reduce((s, r) => s + r.gain,      0);
    return {
      title:        `Form 8949 — ${taxYear}`,
      country:      'US',
      taxYear,
      filingStatus: 'Part II — Long-Term (held more than one year)',
      table: {
        heading: 'Sales and Other Dispositions of Capital Assets',
        columns: ['Description', 'Date Acquired', 'Date Sold', 'Proceeds', 'Cost Basis',
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
          r.proceeds,
          r.costBasis,
          r.code ?? '',
          r.adjustment ?? 0,
          r.gain,
        ]),
        totals: ['Totals', '', '', totalProceeds, totalCostBasis, '', totalAdjustment, totalGain],
      },
    };
  }
}

function _fmtDate(date) {
  if (!date) return '—';
  return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
