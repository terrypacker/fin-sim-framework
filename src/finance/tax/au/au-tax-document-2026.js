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
export class AuTaxDocument2026 extends BaseTaxDocumentModule {
  get countryCode() { return 'AU'; }
  get year()        { return 2026; }

  /**
   * @param {object}   taxDetail
   * @param {number}   taxYear
   * @param {object|object[]} [saleRecords]  Per-disposal rows from journal mining —
   *   either a bare array or `{ rows, unattributed }` from `_worksheetRowsFor`.
   * @param {object}   [period]
   * @returns {object|object[]}  The ITR alone, or the ITR followed by its supplementary
   *   forms: the CGT summary worksheet, then the per-disposal worksheet.
   */
  generate(taxDetail, taxYear, saleRecords = [], period = null) {
    const itr  = this._generateItr(taxDetail, taxYear, period);
    const docs = [itr];

    // The CGT summary worksheet — the ATO's own footing form for item 18 (§ below).
    // Emitted for any resident with CGT activity, including a pure loss year, because
    // a year that produces only a carried-forward loss still has a label V to state.
    if (this._needsCgtSummary(taxDetail)) {
      docs.push(this._generateCgtSummary(taxDetail, taxYear));
    }

    if (taxDetail.isResident && (saleRecords.rows ?? saleRecords).length > 0) {
      docs.push(this._generateCgtWorksheet(saleRecords, taxYear));
    }

    return docs.length === 1 ? itr : docs;
  }

  /**
   * Whether this return has anything for a CGT summary worksheet to say.
   *
   * Deliberately NOT the A$10,000 test that gates the CGT schedule above: that
   * threshold is the *entity* lodgment trigger for a company/trust/fund, and it does
   * not govern this worksheet at all. The worksheet is working paper — the ATO's
   * guidance is that individuals with more complex CGT affairs "may also find it
   * useful" — so the only sensible gate is "was there CGT activity".
   *
   * A zero-gain year with a live loss pool still qualifies: it carries the pool
   * forward, and that movement is exactly what a reader needs to see stated.
   */
  _needsCgtSummary(taxDetail) {
    if (!taxDetail.isResident) return false;
    return (taxDetail.inputs?.capitalGains ?? 0) !== 0
      || (taxDetail.openingCapitalLossPool ?? 0) > 0
      || (taxDetail.closingCapitalLossPool ?? 0) > 0;
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

  /**
   * Column labels for the three ways ITAA 1997 lets a capital gain be measured, as
   * the ATO CGT summary worksheet names them. FY2027+ overrides `discount`: the
   * reform replaces the Division 115 discount with cost-base indexation, so the
   * same ≥12-month slice is still a distinct column but is no longer a discount one.
   */
  _cgtMethodLabels() {
    return { discount: 'Discount Method', other: "'Other' Method" };
  }

  /** Part 4's heading and relief line. FY2027+ overrides both. */
  _cgtPart4Heading()       { return 'Part 4 — CGT Discount on Capital Gains'; }
  _cgtSummaryReliefLabel() { return 'CGT Discount Applied (4A)'; }

  /**
   * The gain the year's relief is computed ON — stated so the relief line below it
   * has a visible base rather than appearing from nowhere.
   *
   * Division 115 discounts the ≥12-month slice ALONE, so that slice is the base here.
   * FY2027+ overrides this: the reform indexes the whole gain, and reporting the
   * ≥12-month slice as its base would invite a reader to check 385.85 against 1,426.99
   * and conclude the arithmetic is broken when the relief never looked at that figure.
   */
  _cgtReliefBase(taxDetail) {
    return {
      label:  `Capital Gains eligible for relief (${this._cgtMethodLabels().discount})`,
      amount: taxDetail.discountableGainsNetted ?? 0,
    };
  }

  /**
   * CGT summary worksheet — the ATO's footing form for item 18 of the individual
   * supplementary return (`docs/au-tax/ato-forms/cgt-summary-worksheet-2025-form.txt`).
   *
   * **Why this exists at all.** The return's Income section states the gain, the
   * relief and the net gain — H, the discount, and A. It does not state either loss
   * step or the carried-forward balance, so its capital-gains figure cannot be
   * checked: a reader given "capital gains 10,107" and "net capital gains 5,054" has
   * no way to tell a clean year from one where a loss pool absorbed half the gain.
   * The ATO's answer to exactly that problem is this worksheet, and its shape here is
   * the ATO's, cell references included, so a figure can be tied straight across.
   *
   * **The parts we do not emit.** Part 2C (net capital losses transferred in) is
   * companies only. Part 5 (small business concessions) and Part 7 (earnout
   * arrangements) are unmodelled. Part 9 (collectables losses carried forward) is
   * unmodelled and NOT merely absent — see the note on the loss sections below.
   *
   * **The method columns.** ITAA 1997 measures a gain three ways — indexation,
   * discount, and 'other' — and the worksheet is a grid because *which column a loss
   * lands on changes the tax*. We carry two of the three: `auDiscountableGainsYTD`
   * is the discount column and the remainder is 'other'. That is the same split
   * `_applyCapitalLosses` applies losses across, so the grid here is a view of the
   * engine's own working rather than a reconstruction of it.
   */
  _generateCgtSummary(taxDetail, taxYear) {
    const fyLabel = taxYearLabel('AU', taxYear);
    const steps   = taxDetail.capitalLossSteps ?? null;
    const m       = this._cgtMethodLabels();

    return {
      title:        `CGT Summary Worksheet — ${fyLabel}`,
      country:      'AU',
      taxYear,
      filingStatus: 'CGT Summary Worksheet',
      sections: [
        this._cgtPart1(taxDetail, steps, m),
        ...this._cgtLossParts(taxDetail, steps, m),
        this._cgtPart4(taxDetail, steps),
        this._cgtPart6(taxDetail),
        this._cgtReturnLabels(taxDetail),
      ],
    };
  }

  /**
   * Part 1 / Table 1 — the year's gains and losses by method column.
   *
   * The ATO's table 1 is a grid of asset CATEGORY (listed shares, other shares, real
   * estate in Australia, other real estate, collectables, …) × method, and only its
   * bottom row is a pure column total. We emit that bottom row: the category
   * breakdown lives one level down, in the per-disposal capital gain or capital loss
   * worksheet, and cannot be built from a `TaxComputationResult` — which is a
   * per-person aggregate with no disposals left in it.
   */
  _cgtPart1(taxDetail, steps, m) {
    const gross = taxDetail.inputs?.capitalGains ?? 0;
    const lineItems = [];

    if (steps) {
      lineItems.push(
        { label: `Capital Gains: ${m.discount}`, amount: steps.grossDiscountable, sub: true },
        { label: `Capital Gains: ${m.other}`,    amount: steps.grossOther,        sub: true },
      );
    }
    lineItems.push({ label: 'Total Current Year Capital Gains (1J)', amount: Math.max(0, gross) });
    if (steps) {
      lineItems.push({ label: 'Total Current Year Capital Losses (2A)', amount: steps.currentYear.losses });
    }
    return { heading: 'Part 1 — Total Current Year Capital Gains and Losses', lineItems };
  }

  /**
   * Parts 2A, 2B and 3 — the two s102-5 loss steps and what they leave behind.
   *
   * **Ordering is the Act's, not a presentational choice.** s102-5(1) reduces gains by
   * the year's own capital losses at Step 1, by carried-forward net capital losses at
   * Step 2, and only reaches the discount percentage at Step 5. Discounting first
   * would halve the gain and then let the loss eat the halved figure, wasting half of
   * every loss — which is why Part 4 below comes after these and not before.
   *
   * Per-column sub-rows appear only when a step actually consumed something, so a
   * clean year prints three short lines instead of nine zeros. The step TOTALS are
   * always printed even at zero, because those are the cells a reader ties across.
   *
   * **Collectables are not separated, and that is a real gap, not a simplification.**
   * s108-10(1) quarantines a collectables loss to collectables gains, which is what
   * the worksheet's Part 9 and its separate carried-forward balance exist to enforce.
   * `COLLECTIBLE_SALE_TAX` books into the same `auCapitalGainsYTD` as everything else,
   * so a bullion loss here would shelter ordinary capital gains. Narrow — it needs a
   * collectable sold below its cost base — but stated rather than silently footed.
   */
  _cgtLossParts(taxDetail, steps, m) {
    if (!steps) return [];
    const { currentYear, priorYear } = steps;
    const afterCurrent = steps.grossDiscountable + steps.grossOther - currentYear.applied;
    const afterPrior   = afterCurrent - priorYear.applied;

    // A per-column breakdown is worth its rows only when the two columns disagree;
    // when a step took everything from one column it says nothing the total does not.
    const columns = (step) => (step.appliedOther > 0 && step.appliedDiscountable > 0)
      ? [
          { label: `Applied against ${m.other}`,    amount: -step.appliedOther,        sub: true },
          { label: `Applied against ${m.discount}`, amount: -step.appliedDiscountable, sub: true },
        ]
      : [];

    const parts = [
      {
        heading: 'Part 2A — Applying Current Year Capital Losses',
        lineItems: [
          ...columns(currentYear),
          { label: 'Current Year Capital Losses Applied (2B)', amount: -currentYear.applied },
          { label: 'Capital Gains after Current Year Losses',  amount:  afterCurrent },
        ],
      },
      {
        heading: 'Part 2B — Applying Prior Year Net Capital Losses',
        lineItems: [
          { label: 'Prior Year Net Capital Losses Available (Z1)', amount: priorYear.opening },
          ...columns(priorYear),
          { label: 'Prior Year Net Capital Losses Applied (2C)',   amount: -priorYear.applied },
          { label: 'Net Capital Gains after All Capital Losses',   amount:  afterPrior },
        ],
      },
    ];

    // Part 3 states the pool the settle will persist. Shown only when there IS a pool
    // — on the common year it is zero in all three cells and says nothing.
    if (currentYear.unapplied > 0 || priorYear.unapplied > 0) {
      parts.push({
        heading: 'Part 3 — Unapplied Net Capital Losses Carried Forward',
        lineItems: [
          { label: 'Unapplied Current Year Capital Losses (K)',   amount: currentYear.unapplied, sub: true },
          { label: 'Unapplied Prior Year Net Capital Losses (L)', amount: priorYear.unapplied,   sub: true },
          { label: 'Net Capital Losses Carried Forward (3B)',     amount: taxDetail.closingCapitalLossPool ?? 0 },
        ],
      });
    }
    return parts;
  }

  /**
   * Part 4 / Table 6 — the Division 115 discount, applied to the discount column only.
   *
   * `cgtDiscount` is the relief the return actually took, so this line is the return's
   * own figure rather than a re-derived 50%: the s115-115 apportionment (design 83 G7)
   * can make the effective reduction less than half, and recomputing it here would
   * quietly disagree with the Income section a tab away.
   */
  _cgtPart4(taxDetail, steps) {
    const base = this._cgtReliefBase(taxDetail);
    return {
      heading: this._cgtPart4Heading(),
      lineItems: [
        ...(steps ? [{ ...base, sub: true }] : []),
        { label: this._cgtSummaryReliefLabel(), amount: -(taxDetail.cgtDiscount ?? 0) },
        { label: 'Capital Gains after Relief',  amount: taxDetail.discountedCapitalGains ?? 0 },
      ],
    };
  }

  /** Part 6 / Table 8 — the net capital gain, cell 6A. */
  _cgtPart6(taxDetail) {
    return {
      heading: 'Part 6 — Net Capital Gain Calculation',
      lineItems: [
        { label: 'Net Capital Gain (6A)', amount: taxDetail.discountedCapitalGains ?? 0 },
      ],
    };
  }

  /**
   * Where the worksheet lands on the return. These three labels are the whole point
   * of the form, and V in particular has no other home: the Income section states the
   * gain and the relief, but a year whose losses exceeded its gains reports nothing at
   * A and everything at V, and until now the return showed neither.
   */
  _cgtReturnLabels(taxDetail) {
    return {
      heading: 'Tax Return — Item 18 Capital Gains',
      lineItems: [
        { label: 'H — Total Current Year Capital Gains',            amount: Math.max(0, taxDetail.inputs?.capitalGains ?? 0) },
        { label: 'A — Net Capital Gain',                            amount: taxDetail.discountedCapitalGains ?? 0 },
        { label: 'V — Net Capital Losses Carried Forward',          amount: taxDetail.closingCapitalLossPool ?? 0 },
      ],
    };
  }

  /**
   * Capital gain or capital loss worksheet — NAT 4151, one row per CGT event
   * (`docs/au-tax/ato-forms/capital-gain-or-loss-worksheet-2026-NAT4151.txt`).
   *
   * **This replaced a "CGT Schedule" that was the wrong form three times over.** The
   * CGT schedule is a company/trust/fund lodgment — *"Individuals, including individual
   * partners in a partnership, who lodge using a paper tax return are not required to
   * complete a CGT schedule"* — and the A$10,000 test that gated it is the entity
   * threshold, which also fires on total LOSSES, a leg the gate never had. Beyond
   * being the wrong form it stated the wrong figures: every household disposal under
   * one taxpayer's name, the US gain rather than the s855-45 AU gain, and USD amounts
   * on a document the modal formats as AUD.
   *
   * Everything below is per person, AU-measure and AUD, so the gain columns total to
   * the same figure the CGT summary worksheet reports at 1J and the return reports at
   * label H.
   *
   * **Columns.** NAT 4151 computes a gain three ways and a loss a fourth, and the
   * split is not presentational — the ATO's summary worksheet applies losses per
   * method column because which column a loss lands on changes the tax. Date acquired
   * is deliberately absent: holdings are consumed FIFO from a pool, so there is no
   * single acquisition date to state and printing "Various" on every row would be a
   * column of noise.
   */
  _generateCgtWorksheet(saleRecords, taxYear) {
    const fyLabel = taxYearLabel('AU', taxYear);
    const rows    = saleRecords.rows ?? saleRecords;
    const unattr  = saleRecords.unattributed ?? null;
    const m       = this._cgtMethodLabels();
    const sum     = (f) => rows.reduce((s, r) => s + (r[f] ?? 0), 0);

    return {
      title:        `CGT Worksheet — ${fyLabel}`,
      country:      'AU',
      taxYear,
      filingStatus: 'Capital Gain or Capital Loss Worksheet',
      // Stated on the document rather than left for the reader to wonder about: both
      // are real limits of what the journal records, and both change how a row reads.
      notes: [
        'Cost base is the AU cost base (ITAA 1997 s855-45 step-up where the asset was held before AU residency), not the US basis.',
        'Assets are consumed FIFO from a pooled holding, so no single acquisition date applies to a row.',
        ...(unattr?.count > 0
          ? [`${unattr.count} disposal(s) totalling ${unattr.proceeds.toFixed(2)} in proceeds produced no AU gain and could not be attributed to an owner; they are excluded above and contribute nothing to any gain column.`]
          : []),
      ],
      table: {
        heading: 'Capital Gain or Capital Loss for Each CGT Event',
        columns: [
          'CGT Asset or Event', 'Category', 'Date of CGT Event',
          'Capital Proceeds', 'Cost Base',
          `Gain: ${m.discount}`, `Gain: ${m.other}`, 'Capital Loss',
        ],
        rows: rows.map(r => [
          // Keyed cell: the modal resolves it to the account's display name, and
          // falls back to this text wherever no registry is in scope (design 70).
          r.stateKey ? { stateKey: r.stateKey, text: r.description } : r.description,
          r.category,
          _fmtDate(r.dateSold),
          r.proceeds,
          r.costBase,
          r.discountGain,
          r.otherGain,
          r.loss,
        ]),
        totals: [
          'Totals', '', '',
          sum('proceeds'), sum('costBase'),
          sum('discountGain'), sum('otherGain'), sum('loss'),
        ],
      },
    };
  }
}

function _fmtDate(date) {
  if (!date) return '—';
  return new Date(date).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}
