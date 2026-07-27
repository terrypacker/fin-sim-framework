/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { TAX_FX_PAIR }  from '../tax-fx.js';
import { taxYearLabel } from '../tax-year-label.js';

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
    const fxRate   = journalEntry?.action?.data?.fxRate;

    return {
      title:        `${taxDetail.stateCode} State Income Tax — ${taxYearLabel('US', taxYear)}`,
      country:      'US',
      state:        taxDetail.stateCode,
      taxYear,
      // The state return is USD-only, but its base comes from FX-normalized
      // federal accumulators, so it reports the same rate (see taxFxRate).
      ...(fxRate != null ? { fxRate, fxPair: TAX_FX_PAIR } : {}),
      filingStatus: taxDetail.filingStatus ?? 'Married Filing Jointly',
      sections:     this._sections(taxDetail, grossTax),
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

  /**
   * Split the rate module's flat `lineItems` into Income and Tax Computation
   * sections, mirroring Form 1040 (design 71 §11.3).
   *
   * This is not cosmetic. A single mixed section cannot be checked: income lines and
   * tax lines summed together mean nothing. Split, each section foots — income lines
   * arrive at Taxable Income, tax lines arrive at Gross Tax — and the generic
   * worksheet verifier applies to state returns with no state-specific rules.
   *
   * A `Gross Tax` line replaces the module's `Net State Tax Liability` line: no state
   * credits are modeled, so the two are equal, and `Gross Tax` is the label the
   * footing check keys on. Net liability is not lost — it is the Summary block's
   * headline, which is where the federal documents put it too.
   */
  _sections(taxDetail, grossTax) {
    const items  = taxDetail.lineItems ?? [];
    const br     = taxDetail.brackets ?? {};
    const pick   = labels => items.filter(li => labels.includes(li.label));

    const income = pick([
      'State Ordinary Income', 'Pension/Retirement Income', 'Pension Excluded',
      'Social Security (taxable)', 'Capital Gains (in ordinary)',
      'Standard Deduction', 'Taxable Income',
    ]);

    const computation = [
      ...pick(['Tax on Ordinary Income']).map(li => ({ ...li, bands: br.ordinary })),
      ...pick(['Capital Gains Tax (alternative)']).map(li => ({ ...li, flat: br.capitalGains ?? undefined })),
      { label: 'Gross Tax', amount: grossTax },
    ];

    // Fall back to the module's own flat list if the labels ever diverge from what
    // this reporter expects — a mislabeled line must not silently vanish from the
    // document. Losing a line is far worse than an unsplit section.
    if (income.length + computation.length - 1 < items.length - 1) {
      return [{ heading: `${taxDetail.stateCode} Resident Return`, lineItems: items }];
    }

    return [
      { heading: 'Income',          lineItems: income },
      { heading: 'Tax Computation', lineItems: computation },
    ];
  }
}
