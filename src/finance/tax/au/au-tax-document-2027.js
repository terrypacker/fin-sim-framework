/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { AuTaxDocument2026 } from './au-tax-document-2026.js';

/**
 * AuTaxDocument2027 — Australian individual tax document formatter for FY2027-28+.
 *
 * Reflects the CGT reform (design 57). For CGT events on/after 1 July 2027 the
 * flat 50% Division 115 discount is removed and replaced by cost-base indexation
 * plus a 30% minimum effective tax rate. The TaxComputationResult already carries
 * the reform figures — `cgtDiscount` is the indexation reduction (gross nominal
 * gain − indexed real gain, not a 50% cut) and `discountedCapitalGains` is the
 * indexed real gain — so this class only relabels/re-sections them:
 *
 *   Income          — relabels "CGT 50% Discount" → "Cost-Base Indexation Relief".
 *   Tax Computation — surfaces the 30% minimum-tax top-up so the section
 *                     reconciles to Gross Tax (which includes it).
 *
 * Without a FY2027+ document module, TaxDocumentRegistry falls back to
 * AuTaxDocument2026, which mislabels the indexation relief as a "50% Discount"
 * and hides the min-tax top-up — the report bug this module fixes. The underlying
 * tax computed by AuTaxRates2027 was already correct.
 */
export class AuTaxDocument2027 extends AuTaxDocument2026 {
  get year() { return 2027; }

  _residentIncomeSection(taxDetail, drill) {
    const { inputs } = taxDetail;
    return {
      heading: 'Income',
      lineItems: [
        { label: 'Ordinary Income',                   amount:  inputs.ordinaryIncome, drillReport: drill('ordinary-income-by-source')  },
        { label: 'Capital Gains (before indexation)', amount:  inputs.capitalGains,   drillReport: drill('capital-gains-by-disposal')  },
        { label: 'Cost-Base Indexation Relief',       amount: -taxDetail.cgtDiscount },
        { label: 'Net Capital Gains (indexed)',       amount:  taxDetail.discountedCapitalGains },
        { label: 'Total Assessable Income',           amount:  taxDetail.assessableIncome },
      ],
    };
  }

  _residentTaxComputationSection(taxDetail) {
    const { inputs } = taxDetail;
    const topUp = taxDetail.cgtMinimumTaxTopUp ?? 0;
    const br    = taxDetail.brackets ?? {};
    return {
      heading: 'Tax Computation',
      lineItems: [
        // Band attachment is inherited from FY2026 (design 71 §8.4); only the
        // min-tax top-up line below is FY2027-specific.
        this._taxOnIncomeLine(taxDetail),
        ...this._taxOnIncomeSubRows(taxDetail),
        { label: 'Medicare Levy', amount: taxDetail.medicareLevy, flat: br.medicareLevy ?? undefined },
        ...(topUp > 0
          ? [{ label: 'CGT Minimum Tax Top-up (30%)', amount: topUp }]
          : []),
        { label: 'Gross Tax', amount: taxDetail.grossTax },
        // Memo, BELOW Gross Tax and outside it: Div 295 fund tax is the super fund's
        // liability, withheld from fund assets, never assessed on the member
        // (design 77 §5.3). Kept visible so the reader sees the whole burden — but
        // inside the subtotal it would stop the section footing.
        { label: 'Memo: Super Fund Tax (withheld in fund)', amount: inputs.superTax, memo: true },
      ],
    };
  }
}
