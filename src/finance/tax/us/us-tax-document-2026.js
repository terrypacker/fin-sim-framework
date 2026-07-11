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
            { label: 'Adjusted Gross Income',               amount:  taxDetail.adjustedGrossIncome },
            { label: 'Standard Deduction',                  amount: -inputs.standardDeduction },
            ...(taxDetail.feieExcluded > 0
              ? [{ label: 'Foreign Earned Income Exclusion (Form 2555)', amount: -taxDetail.feieExcluded }]
              : []),
            { label: 'Taxable Ordinary Income',             amount:  taxDetail.taxableIncome },
            { label: 'Long-Term Capital Gains (Sch. D)',    amount:  inputs.capitalGains,         drillReport: drill('capital-gains-by-disposal')     },
            { label: 'Collectible Gains',                   amount:  inputs.collectibleGains },
          ],
        },
        {
          heading: 'Tax Computation',
          lineItems: [
            { label: 'Tax on Ordinary Income',      amount: taxDetail.ordinaryTax },
            { label: 'Long-Term Capital Gains Tax', amount: taxDetail.capitalGainsTax },
            { label: 'Collectibles Tax (28%)',      amount: taxDetail.collectiblesTax },
            { label: 'Early Withdrawal Penalties',  amount: taxDetail.penaltyTax },
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

  _generateScheduleD(saleRecords, taxYear) {
    const totalProceeds  = saleRecords.reduce((s, r) => s + r.proceeds,  0);
    const totalCostBasis = saleRecords.reduce((s, r) => s + r.costBasis, 0);
    const totalGain      = saleRecords.reduce((s, r) => s + r.gain,      0);
    return {
      title:        `Schedule D — ${taxYear}`,
      country:      'US',
      taxYear,
      filingStatus: 'Capital Gains and Losses',
      sections: [
        {
          heading: 'Part II — Long-Term Capital Gains and Losses',
          lineItems: [
            { label: 'Total Proceeds (from Form 8949)',    amount: totalProceeds  },
            { label: 'Total Cost Basis (from Form 8949)',  amount: totalCostBasis },
            { label: 'Net Long-Term Gain / (Loss)',        amount: totalGain      },
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

  _generateForm8949(saleRecords, taxYear) {
    const totalProceeds  = saleRecords.reduce((s, r) => s + r.proceeds,  0);
    const totalCostBasis = saleRecords.reduce((s, r) => s + r.costBasis, 0);
    const totalGain      = saleRecords.reduce((s, r) => s + r.gain,      0);
    return {
      title:        `Form 8949 — ${taxYear}`,
      country:      'US',
      taxYear,
      filingStatus: 'Part II — Long-Term (held more than one year)',
      table: {
        heading: 'Sales and Other Dispositions of Capital Assets',
        columns: ['Description', 'Date Acquired', 'Date Sold', 'Proceeds', 'Cost Basis', 'Gain / (Loss)'],
        rows: saleRecords.map(r => [
          r.description,
          r.dateAcquired,
          _fmtDate(r.dateSold),
          r.proceeds,
          r.costBasis,
          r.gain,
        ]),
        totals: ['Totals', '', '', totalProceeds, totalCostBasis, totalGain],
      },
    };
  }
}

function _fmtDate(date) {
  if (!date) return '—';
  return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
