/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * StateTaxDocumentReporter (design 34 Phase 2).
 *
 * Renders a STATE_TAX_SETTLE_APPLY journal entry as a TaxDocument for the
 * timeline tax-document modal — the state analog of TaxDocumentRegistry, but a
 * single generic formatter: the per-state-per-year rates module already emits a
 * structured `lineItems` array in its result, so there is no need for
 * per-state-per-year document modules. The state and year ride on the
 * settlement's `taxDetail`.
 *
 * Returns null when the entry carries no state taxDetail (e.g. no residency
 * state configured) — the settle handler already skips emitting in that case.
 */
export class StateTaxDocumentReporter {
  /**
   * @param {object} journalEntry - a STATE_TAX_SETTLE_APPLY entry
   * @returns {object|null} TaxDocument
   */
  generate(journalEntry) {
    const taxDetail = journalEntry?.action?.data?.taxDetail;
    if (!taxDetail || !taxDetail.stateCode) return null;

    const taxYear = taxDetail.taxYear ?? new Date(journalEntry.date).getUTCFullYear();
    const grossTax = (taxDetail.ordinaryTax ?? 0) + (taxDetail.capitalGainsTax ?? 0);
    const inputs   = taxDetail.inputs ?? {};

    return {
      title:        `${taxDetail.stateCode} State Income Tax — ${taxYear}`,
      country:      'US',
      state:        taxDetail.stateCode,
      taxYear,
      filingStatus: taxDetail.filingStatus ?? 'Married Filing Jointly',
      sections: [
        {
          heading: `${taxDetail.stateCode} Resident Return`,
          lineItems: taxDetail.lineItems ?? [],
        },
      ],
      summary: {
        grossIncome: (inputs.ordinaryIncome ?? 0)
          + Math.max(0, inputs.pensionIncome ?? 0)
          + Math.max(0, inputs.capitalGains ?? 0),
        grossTax,
        credits:       0,
        netLiability:  taxDetail.netLiability ?? 0,
        effectiveRate: taxDetail.effectiveRate ?? 0,
        marginalRate:  taxDetail.marginalRate ?? 0,
      },
    };
  }
}
