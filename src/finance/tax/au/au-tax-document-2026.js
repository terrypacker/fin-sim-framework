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
import { taxYearLabel }          from '../tax-year-label.js';

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
 *   Tax Computation — Income tax, Medicare levy, gross tax
 *   Credits         — Franking credits
 *
 * Non-resident sections:
 *   Income          — Ordinary income, capital gains (no discount), NR withholding income
 *   Tax Computation — Income tax (NR brackets), NR withholding tax (15%)
 *
 * Both Tax Computation sections end with a `memo: true` line disclosing the Div 295
 * superannuation FUND tax. Design 77 §5.3 took it out of Gross Tax and Net Liability
 * — it is the fund's tax, withheld from fund assets, never assessed on the member —
 * so it must stay out of every footing sum. `memo` is the flag that says so; the
 * section-reconciliation tests filter on it exactly as they do on `sub`.
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
    const fyLabel = taxYearLabel('AU', taxYear);
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
          this._residentIncomeSection(taxDetail, drill),
          this._residentTaxComputationSection(taxDetail),
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
          ...this._reliefWorksheet(taxDetail),
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
            // Withholding income is stated as a total with its per-type slices as
            // SUBLINEs beneath it (design 73 Gap 2): the types carry different final
            // rates, so a reader checking the tax lines below needs to see which base
            // each rate is applied to. `sub: true` keeps them out of the footing sums.
            { label: 'Non-Resident Withholding Income', amount: inputs.nonResidentWithholding,   drillReport: drill('nr-withholding-income-by-source') },
            { label: 'Interest',                        amount: inputs.nrWithholdingInterest,          sub: true },
            { label: 'Unfranked Dividends',             amount: inputs.nrWithholdingUnfrankedDividend, sub: true },
            ...(inputs.nrWithholdingPooled
              ? [{ label: 'Other (pooled)',             amount: inputs.nrWithholdingPooled,            sub: true }]
              : []),
          ],
        },
        {
          heading: 'Tax Computation',
          lineItems: [
            { label: 'Tax on Income (Non-Resident Brackets)', amount: taxDetail.baseTax,                  bands: taxDetail.brackets?.ordinary },
            // One line per withholding type, each stating its own final rate against
            // the base it is applied to. Built by the rates module alongside the rate
            // table itself (design 73 Gap 2), so a label can never name a rate the
            // computation did not use.
            ...(taxDetail.nrWithholdingLines ?? []),
            // The non-resident section previously stopped short of a total, so its
            // lines had nothing to foot against (design 71 §11.4). Gross Tax is the
            // sum the summary already reports; stating it makes the section checkable
            // by the same rule as every other return.
            { label: 'Gross Tax',                             amount: taxDetail.grossTax },
            // Memo, outside the total — the fund's Div 295 liability, not the
            // member's (design 77 §5.3).
            { label: 'Memo: Super Fund Tax (withheld in fund)', amount: inputs.superTax, memo: true },
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

  /**
   * Resident "Income" section. FY2027+ (AuTaxDocument2027) overrides this to
   * relabel the CGT relief line from the 50% discount to cost-base indexation
   * (design 57 §6.3). The amounts flow straight from the TaxComputationResult;
   * only labels differ by year.
   */
  _residentIncomeSection(taxDetail, drill) {
    const { inputs } = taxDetail;
    return {
      heading: 'Income',
      lineItems: [
        { label: 'Ordinary Income',                 amount:  inputs.ordinaryIncome, drillReport: drill('ordinary-income-by-source')  },
        { label: 'Capital Gains (before discount)', amount:  inputs.capitalGains,   drillReport: drill('capital-gains-by-disposal')  },
        { label: 'CGT 50% Discount',                amount: -taxDetail.cgtDiscount },
        { label: 'Net Capital Gains',               amount:  taxDetail.discountedCapitalGains },
        { label: 'Total Assessable Income',         amount:  taxDetail.assessableIncome },
      ],
    };
  }

  /**
   * Resident "Tax Computation" section. FY2027+ overrides this to surface the
   * 30% minimum-tax top-up (design 57 §6.3) — without it the listed lines do not
   * reconcile to Gross Tax, which includes the top-up.
   */
  _residentTaxComputationSection(taxDetail) {
    const { inputs } = taxDetail;
    const br = taxDetail.brackets ?? {};
    return {
      heading: 'Tax Computation',
      lineItems: [
        this._taxOnIncomeLine(taxDetail),
        ...this._taxOnIncomeSubRows(taxDetail),
        { label: 'Medicare Levy',   amount: taxDetail.medicareLevy, flat: br.medicareLevy ?? undefined },
        { label: 'Gross Tax',       amount: taxDetail.grossTax },
        // Memo, BELOW Gross Tax and outside it: Div 295 fund tax is the super fund's
        // liability, withheld from fund assets, never assessed on the member
        // (design 77 §5.3). Kept visible so the reader sees the whole burden — but
        // inside the subtotal it would stop the section footing.
        { label: 'Memo: Super Fund Tax (withheld in fund)', amount: inputs.superTax, memo: true },
      ],
    };
  }

  /**
   * The "Tax on Income" line, carrying the ordinary bracket schedule **only when
   * there are no sub-rows** to carry it instead (design 71 §8.4).
   *
   * With no assessable gain, `assessableIncome === ordinaryIncome`, so the ordinary
   * bands explain this line exactly. With a gain, the schedule splits across the two
   * sub-rows below and attaching it here as well would double-count it in the export.
   * Without this branch the common AU year — wages, no disposals — would export with
   * no bracket detail at all.
   */
  _taxOnIncomeLine(taxDetail) {
    const line = { label: 'Tax on Income', amount: taxDetail.baseTax };
    if (taxDetail.discountedCapitalGains > 0) return line;
    return { ...line, bands: taxDetail.brackets?.ordinary };
  }

  /**
   * Breakdown sub-rows for "Tax on Income", shown only when there is an
   * assessable net capital gain. AU has no separate CGT rate schedule: the
   * relieved gain is stacked on top of ordinary income and taxed at the
   * resulting marginal brackets. So "Tax on Capital Gains" is the *incremental*
   * bracket tax the gain adds — baseTax(ordinary+gain) − baseTax(ordinary) — and
   * the two sub-rows sum exactly to the "Tax on Income" total above them. Any
   * FY2027 30% minimum-tax top-up is reported separately, not folded in here.
   */
  _taxOnIncomeSubRows(taxDetail) {
    if (!(taxDetail.discountedCapitalGains > 0)) return [];
    const br = taxDetail.brackets ?? {};
    return [
      { label: 'Tax on Ordinary Income', amount: taxDetail.ordinaryIncomeTax, sub: true, bands: br.ordinary },
      { label: 'Tax on Capital Gains',   amount: taxDetail.capitalGainsTax,   sub: true, bands: br.capitalGains },
    ];
  }

  /**
   * "Worksheet — Foreign Relief" (design 71 §13): the intermediates behind the
   * Foreign Income Tax Offset, the AU counterpart of the US §904 worksheet.
   *
   * The Credits section states the offset taken but not the ATO "step 1 − step 2"
   * limit that capped it — and that limit is derived by re-assessing the whole return
   * with the US-source income disregarded, so it is impossible to reconstruct from
   * anything else the return shows. Below A$1,000 the limit is skipped entirely by
   * the de-minimis shortcut, which the worksheet states explicitly rather than
   * leaving the reader to infer from an absent limit.
   *
   * Rows are `WORKSHEET`, never `LINE` — supporting arithmetic, not lines of the
   * return (§5.2). Returns [] when there is no foreign tax to relieve.
   */
  _reliefWorksheet(taxDetail) {
    const foreignTax = taxDetail.inputs?.foreignIncomeTaxOffset ?? 0;
    if (!(foreignTax > 0)) return [];

    const money = (label, amount) => ({ label, amount, rowType: 'WORKSHEET' });
    const lineItems = [money('FITO — foreign (US) tax paid on US-source income', foreignTax)];

    if (taxDetail.fitoDeMinimis) {
      // The shortcut credits the whole amount; there is no limit to report because
      // none was computed.
      lineItems.push(money('FITO — de-minimis shortcut (≤ A$1,000), limit not computed', foreignTax));
    } else {
      lineItems.push(money('FITO — §770-75 limit (step 1 − step 2)', taxDetail.fitoLimit ?? 0));
    }
    lineItems.push(money('FITO — offset allowed', taxDetail.fito ?? 0));
    // Unlike the US FTC there is NO carryforward: any excess is simply lost, which is
    // the deliberate asymmetry design 52 §4.5 models. Stating it makes the loss
    // visible rather than silent.
    lineItems.push(money('FITO — excess forfeited (no carryforward)',
      Math.max(0, foreignTax - (taxDetail.fito ?? 0))));

    return [{ heading: 'Worksheet — Foreign Relief', lineItems }];
  }

  _generateCgtSchedule(saleRecords, taxYear) {
    const fyLabel        = taxYearLabel('AU', taxYear);
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
