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

  generate(taxDetail, taxYear) {
    const { inputs } = taxDetail;

    return {
      title:         `U.S. Federal Income Tax Return — ${taxYear}`,
      country:       'US',
      taxYear,
      filingStatus:  'Married Filing Jointly',
      sections: [
        {
          heading: 'Income',
          lineItems: [
            { label: 'Gross Ordinary Income',               amount:  inputs.grossOrdinaryIncome },
            { label: 'Adjustments (Pre-tax Contributions)', amount: -inputs.adjustments },
            { label: 'Adjusted Gross Income',               amount:  taxDetail.adjustedGrossIncome },
            { label: 'Standard Deduction',                  amount: -inputs.standardDeduction },
            { label: 'Taxable Ordinary Income',             amount:  taxDetail.taxableIncome },
            { label: 'Long-Term Capital Gains',             amount:  inputs.capitalGains },
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
          lineItems: [
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
}
