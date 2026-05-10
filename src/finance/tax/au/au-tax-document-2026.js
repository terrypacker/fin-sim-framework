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
export class AuTaxDocument2026 extends BaseTaxDocumentModule {
  get countryCode() { return 'AU'; }
  get year()        { return 2026; }

  generate(taxDetail, taxYear) {
    const fyLabel = `FY ${taxYear}–${(taxYear + 1).toString().slice(-2)}`;
    const { inputs } = taxDetail;

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
              { label: 'Ordinary Income',                 amount:  inputs.ordinaryIncome },
              { label: 'Capital Gains (before discount)', amount:  inputs.capitalGains },
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
            { label: 'Ordinary Income',                 amount: inputs.ordinaryIncome },
            { label: 'Capital Gains (no CGT discount)', amount: inputs.capitalGains },
            { label: 'Total Assessable Income',         amount: taxDetail.assessableIncome },
            { label: 'Non-Resident Withholding Income', amount: inputs.nonResidentWithholding },
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
}
