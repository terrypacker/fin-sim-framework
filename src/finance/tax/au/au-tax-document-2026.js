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
 * AuTaxDocument2026 — Australian individual income tax document formatter for FY2026+.
 *
 * Generates an ITR-style TaxDocument from a TaxComputationResult.
 * Handles both resident and non-resident paths (taxDetail.isResident).
 *
 * taxYear is the financial year start (e.g. 2025 = FY2025-26, beginning July 2025).
 *
 * Resident sections:
 *   Income          — Ordinary income, capital gains with 50% CGT discount, assessable income
 *   Tax Computation — Income tax, Medicare levy, super tax, gross tax
 *   Credits         — Franking credits
 *
 * Non-resident sections:
 *   Income          — Ordinary income, capital gains (no discount), NR withholding income
 *   Tax Computation — Income tax (NR brackets), NR withholding tax (15%), super tax
 */
const CGT_SCHEDULE_THRESHOLD = 10_000;

export class AuTaxDocument2026 extends BaseTaxDocumentModule {
  get countryCode() { return 'AU'; }
  get year()        { return 2026; }

  /**
   * @param {object}   taxDetail
   * @param {number}   taxYear
   * @param {object[]} [saleRecords]  - Capital gain transactions from journal mining.
   * @returns {object|object[]}  Single ITR, or [ITR, CGT Schedule] array when schedule rules apply.
   */
  generate(taxDetail, taxYear, saleRecords = [], period = null) {
    const itr = this._generateItr(taxDetail, taxYear, period);
    const needsSchedule = taxDetail.isResident
      && saleRecords.length > 0
      && Math.abs(taxDetail.inputs.capitalGains) > CGT_SCHEDULE_THRESHOLD;
    return needsSchedule
      ? [itr, this._generateCgtSchedule(saleRecords, taxYear)]
      : itr;
  }

  _generateItr(taxDetail, taxYear, period = null) {
    const fyLabel = `FY ${taxYear}–${(taxYear + 1).toString().slice(-2)}`;
    const { inputs } = taxDetail;
    const drill = (reportId) => period
      ? { reportId, params: { cc: 'AU', period } }
      : undefined;

    if (taxDetail.isResident) {
      return {
        title:        `Australian Individual Tax Return — ${fyLabel}`,
        country:      'AU',
        taxYear,
        filingStatus: 'Individual Resident',
        sections: [
          {
            heading: 'Income',
            lineItems: [
              { label: 'Ordinary Income',                 amount:  inputs.ordinaryIncome, drillReport: drill('ordinary-income-by-source')  },
              { label: 'Capital Gains (before discount)', amount:  inputs.capitalGains,   drillReport: drill('capital-gains-by-disposal')  },
              { label: 'CGT 50% Discount',                amount: -taxDetail.cgtDiscount },
              { label: 'Net Capital Gains',               amount:  taxDetail.discountedCapitalGains },
              { label: 'Total Assessable Income',         amount:  taxDetail.assessableIncome },
            ],
          },
          {
            heading: 'Tax Computation',
            lineItems: [
              { label: 'Tax on Income',   amount: taxDetail.baseTax },
              { label: 'Medicare Levy',   amount: taxDetail.medicareLevy },
              { label: 'Super Tax',       amount: inputs.superTax },
              { label: 'Gross Tax',       amount: taxDetail.grossTax },
            ],
          },
          {
            heading: 'Credits',
            lineItems: [
              { label: 'Franking Credits', amount: -taxDetail.frankingOffset },
              // Foreign Income Tax Offset (design 52 §6) — US tax paid on US-source
              // income, single bucket, no carryforward. The de-minimis flag marks
              // the A$1,000 shortcut (limit calc skipped).
              ...(taxDetail.fito > 0
                ? [{ label: `Foreign Income Tax Offset${taxDetail.fitoDeMinimis ? ' (de-minimis)' : ''}`, amount: -taxDetail.fito }]
                : []),
            ],
          },
        ],
        summary: {
          grossIncome:   inputs.ordinaryIncome + Math.max(0, inputs.capitalGains),
          grossTax:      taxDetail.grossTax,
          credits:       taxDetail.credits,
          netLiability:  taxDetail.netLiability,
          effectiveRate: taxDetail.effectiveRate,
          marginalRate:  taxDetail.marginalRate,
        },
      };
    }

    // Non-resident path
    return {
      title:        `Australian Individual Tax Return — ${fyLabel} (Non-Resident)`,
      country:      'AU',
      taxYear,
      filingStatus: 'Individual Non-Resident',
      sections: [
        {
          heading: 'Income',
          lineItems: [
            { label: 'Ordinary Income',                 amount: inputs.ordinaryIncome,           drillReport: drill('ordinary-income-by-source') },
            { label: 'Capital Gains (no CGT discount)', amount: inputs.capitalGains,             drillReport: drill('capital-gains-by-disposal') },
            { label: 'Total Assessable Income',         amount: taxDetail.assessableIncome },
            { label: 'Non-Resident Withholding Income', amount: inputs.nonResidentWithholding,   drillReport: drill('nr-withholding-income-by-source') },
          ],
        },
        {
          heading: 'Tax Computation',
          lineItems: [
            { label: 'Tax on Income (Non-Resident Brackets)', amount: taxDetail.baseTax },
            { label: 'Non-Resident Withholding Tax (15%)',    amount: taxDetail.nonResidentWithholdingTax },
            { label: 'Super Tax',                             amount: inputs.superTax },
          ],
        },
      ],
      summary: {
        grossIncome:   inputs.ordinaryIncome
          + Math.max(0, inputs.capitalGains)
          + inputs.nonResidentWithholding,
        grossTax:      taxDetail.grossTax,
        credits:       taxDetail.credits,
        netLiability:  taxDetail.netLiability,
        effectiveRate: taxDetail.effectiveRate,
        marginalRate:  taxDetail.marginalRate,
      },
    };
  }

  _generateCgtSchedule(saleRecords, taxYear) {
    const fyLabel        = `FY ${taxYear}–${(taxYear + 1).toString().slice(-2)}`;
    const totalProceeds  = saleRecords.reduce((s, r) => s + r.proceeds,  0);
    const totalCostBasis = saleRecords.reduce((s, r) => s + r.costBasis, 0);
    const totalGain      = saleRecords.reduce((s, r) => s + r.gain,      0);
    return {
      title:        `CGT Schedule — ${fyLabel}`,
      country:      'AU',
      taxYear,
      filingStatus: 'Capital Gains Tax Schedule',
      table: {
        heading: 'Disposal of Capital Assets',
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
  return new Date(date).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}
