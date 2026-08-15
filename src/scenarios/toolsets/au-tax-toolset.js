/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { TaxService }    from '../../finance/tax-service.js';
import { PeriodService } from '../../finance/period/period-service.js';
import { BalanceSnapshotReducer } from '../../simulation-framework/reducers.js';
import { buildAuFiscalYear, applyTo }
  from '../../finance/period/period-builder.js';
import { AuPeriodAdvanceHandler, AuPeriodAdvanceReducer }
  from '../../finance/tax/period-advance-classes.js';
import { AuTaxSettleHandler, AuTaxSettleApplyReducer, AuTaxPaymentDebitReducer }
  from '../../finance/tax/tax-settle-classes.js';
import { ValueType } from '../../simulation-framework/type-registry.js';

/**
 * AU_TAX toolset — declarative shell around TaxService for AU.
 *
 * Capabilities: taxation
 * Depends on: AU_BANKING
 *
 * State ownership:
 *   Initializes: currentPeriods['AU'] (via TaxService), and all AU YTD counters
 *   that the AU tax modules read without null-safety:
 *   auOrdinaryIncomeYTD, auCapitalGainsYTD, auNonResidentWithholdingYTD,
 *   auSuperTaxYTD, auFrankingCreditYTD, ftcYTD (needed for AU→US FTC flows)
 *   Per-person maps initialized to {} (AU modules use ?? {} guard).
 */
export const AU_TAX = {
  id: 'AU_TAX',
  capabilities: ['taxation'],
  dependencies: ['AU_BANKING'],

  types: {
    handlers: [AuPeriodAdvanceHandler, AuTaxSettleHandler],
    reducers: [AuPeriodAdvanceReducer, AuTaxSettleApplyReducer, AuTaxPaymentDebitReducer, BalanceSnapshotReducer],
    actions: [
      { type: 'AU_PERIOD_ADVANCE',  fields: { period: ValueType.any() } },
      { type: 'AU_TAX_SETTLE_APPLY', family: 'TAX_SETTLE_APPLY', cc: 'AU',
        // `fundTax` (design 77 §5.4) — AUD Div 295 super fund tax for the FY. Must be
        // declared: pickPayload keeps ONLY declared fields, so an undeclared field
        // never reaches the journal or the document modules.
        fields: { tax: ValueType.number(), taxDetail: ValueType.any(), personTaxDetails: ValueType.any(),
                  fxRate: ValueType.number(), fundTax: ValueType.currency('AUD') } },
      { type: 'AU_TAX_PAYMENT_DEBIT', family: 'TAX_PAYMENT_DEBIT', cc: 'AU',
        // `escalated` marks the re-issue that pays the part of the SAME bill the
        // first pass could not fund (see TaxPaymentDebitReducerBase). Must be
        // declared: pickPayload keeps ONLY declared fields, and "Tax Paid by Year"
        // filters on it to avoid counting the funded part twice.
        // Design 87 §14.4 item 1 / G12 — the §988 character declaration the currency lot
        // observer reads off this action. Declared for JOURNAL visibility rather than for
        // the mechanism (the observer sees the live action, which pickPayload never
        // filters): undeclared, an AU tax payment out of an AUD pool would dispose
        // correctly and then be invisible in every report that reads the journal.
        fields: { amount: ValueType.currency('AUD'), escalated: ValueType.boolean(),
                  section988: ValueType.any() } },
      { type: 'RECORD_BALANCE',    fields: { fieldPath: ValueType.text(), metricKey: ValueType.text() } },
    ],
  },

  paramSchema(context) {
    return [
      {
        // Dedicated ATO CPI indexation rate for AU CGT cost-base indexation
        // (design 57 Part 2, Item A). Unset ⇒ the InflationAdjustReducer falls
        // back to the effective AU inflation rate, so indexation is byte-identical
        // to using inflationAccumulator. Set a distinct value to decouple the CGT
        // index from household wage/expense inflation.
        key: 'auCpiRate', label: 'AU CGT Indexation (CPI) Rate',
        type: 'Number', group: 'AU Tax', mc: true, opt: true,
        defaultValue: undefined,
        description: 'Annual ATO CPI rate used to index AU capital-gains cost bases (FY2027+). '
          + 'Leave unset to track the AU inflation rate.',
      },
    ];
  },

  state(context) {
    const capture = _getContributions(context);
    const auCpiRate = context.parameters?.auCpiRate;
    const state = {
      ...capture.statePatches,
      // Dedicated ATO CPI series (design 57 Part 2, Item A). Only seed cpiRates.AU
      // when an explicit rate is given; otherwise leave it absent so the reducer
      // falls back to the effective AU inflation rate (no golden movement).
      cpiRates:                         (auCpiRate != null ? { AU: auCpiRate } : {}),
      cpiAccumulator:                   { AU: 1.0 },
      auOrdinaryIncomeYTD:              0,
      auCapitalGainsYTD:                0,
      auDiscountableGainsYTD:           0,   // CGT 50%-discount-eligible slice (design 62 §4)
      // design 83 G7 step 3 — s115-115 residency apportionment of the discount
      auDiscountApportionedBaseYTD:     0,
      auDiscountAllowanceYTD:           0,
      auRealCapitalGainsYTD:            0,   // FY2027 reform: post-indexation gain (design 57)
      auNonResidentWithholdingYTD:      0,
      // Per-type non-resident final withholding (design 73 Gap 2): interest at the
      // Art 11(2) 10% cap, unfranked dividends at the Art 10(2) 15% cap.
      auNrWithholdingInterestYTD:          0,
      auNrWithholdingUnfrankedDividendYTD: 0,
      auSuperTaxYTD:                    0,
      auFrankingCreditYTD:              0,
      auPersonOrdinaryIncomeYTD:        {},
      auPersonCapitalGainsYTD:          {},
      auPersonDiscountableGainsYTD:     {},
      auPersonDiscountApportionedBaseYTD: {},
      auPersonDiscountAllowanceYTD:       {},
      auPersonRealCapitalGainsYTD:      {},
      auPersonNonResidentWithholdingYTD:{},
      auPersonNrWithholdingInterestYTD:          {},
      auPersonNrWithholdingUnfrankedDividendYTD: {},
      auPersonSuperTaxYTD:              {},
      auPersonFrankingCreditYTD:        {},
      auPersonEarnedIncomeYTD:          {},   // FEIE cap accumulator (design 52 §4.2)
      auPersonUsSourceOrdinaryAudYTD:            {},
      auPersonUsSourceCapGainsAudYTD:            {},
      auPersonUsSourceRealCapGainsAudYTD:        {},
    };

    //Zero out some fields that we will need
    context.people.forEach(p => {
      state.auPersonOrdinaryIncomeYTD[p.id] = 0;
      state.auPersonCapitalGainsYTD[p.id] = 0;
      state.auPersonDiscountableGainsYTD[p.id] = 0;
      state.auPersonDiscountApportionedBaseYTD[p.id] = 0;
      state.auPersonDiscountAllowanceYTD[p.id]       = 0;
      state.auPersonRealCapitalGainsYTD[p.id] = 0;
      state.auPersonNonResidentWithholdingYTD[p.id] = 0;
      state.auPersonNrWithholdingInterestYTD[p.id] = 0;
      state.auPersonNrWithholdingUnfrankedDividendYTD[p.id] = 0;
      state.auPersonUsSourceOrdinaryAudYTD[p.id] = 0;
      state.auPersonUsSourceCapGainsAudYTD[p.id] = 0;
      state.auPersonUsSourceRealCapGainsAudYTD[p.id] = 0;
      state.auPersonSuperTaxYTD[p.id] = 0;
      state.auPersonFrankingCreditYTD[p.id] = 0;
      state.auPersonEarnedIncomeYTD[p.id] = 0;
    })

    return state;
  },

  schedules(context) {
    return [..._getContributions(context).events];
  },

  handlers(context) {
    return [..._getContributions(context).handlers];
  },

  reducers(context) {
    return [
      ..._getContributions(context).reducers,
      ..._getBalanceSnapshotReducer(context),
    ];
  },
};

function _getContributions(context) {
  if (context._auTaxCapture) return context._auTaxCapture;
  // AU fiscal year starts Jul 1: include the year before simStart to cover the
  // initial period (e.g. simStart Jan 2026 → need FY2025: Jul 2025–Jun 2026).
  // Use the shared context.periodService when available so AU fiscal years are
  // merged with US calendar years in one service for journal reporting.
  const periodService = context.periodService ?? new PeriodService();
  const startYear = context.startDate.getUTCFullYear();
  const endYear   = context.endDate.getUTCFullYear();
  for (let y = startYear - 1; y <= endYear; y++) applyTo(periodService, buildAuFiscalYear(y));
  context._auTaxCapture = new TaxService().getContributions(
    ['AU'], periodService, context.startDate,
    context.accountService, context.stateRegistry,
  );
  return context._auTaxCapture;
}

function _getBalanceSnapshotReducer(context) {
  if (context._balanceSnapshotRegistered) return [];
  context._balanceSnapshotRegistered = true;
  const r = new BalanceSnapshotReducer('Balance Snapshot');
  r.reducedActionTypes = ['RECORD_BALANCE'];
  return [r];
}
