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
import { buildUsCalendarYear, applyTo }
  from '../../finance/period/period-builder.js';
import { UsPeriodAdvanceHandler, UsPeriodAdvanceReducer }
  from '../../finance/tax/period-advance-classes.js';
import { UsTaxSettleHandler, UsTaxSettleApplyReducer, UsTaxPaymentDebitReducer }
  from '../../finance/tax/tax-settle-classes.js';
import { ValueType } from '../../simulation-framework/type-registry.js';

/**
 * US_TAX toolset — declarative shell around TaxService.
 *
 * Capabilities: taxation
 * Depends on: US_BANKING
 *
 * State ownership:
 *   Initializes: currentPeriods (via TaxService), usOrdinaryIncomeYTD,
 *                usNegativeIncomeYTD, usCapitalGainsYTD, usPenaltyYTD,
 *                usFilingSingle
 *   Reads: (none from other toolsets)
 */
export const US_TAX = {
  id: 'US_TAX',
  capabilities: ['taxation'],
  dependencies: ['US_BANKING'],

  types: {
    handlers: [UsPeriodAdvanceHandler, UsTaxSettleHandler],
    reducers: [UsPeriodAdvanceReducer, UsTaxSettleApplyReducer, UsTaxPaymentDebitReducer, BalanceSnapshotReducer],
    actions: [
      { type: 'US_PERIOD_ADVANCE',  fields: { period: ValueType.any() } },
      { type: 'US_TAX_SETTLE_APPLY', family: 'TAX_SETTLE_APPLY', cc: 'US',
        // fxRate — USD/AUD in force at the settle, reported on the return
        // (design 71 §5.5). Must be declared: pickPayload keeps ONLY declared
        // fields, so an undeclared field never reaches the document modules.
        // usTaxPaidOnUsSourceAud — the AUD restatement of the US tax attributable to
        // US-source income (design 83 G5), the number AU credits as a FITO. It is a
        // treaty INPUT computed on the US settle and consumed a fiscal year later by
        // the AU settle; undeclared, an FTC/FITO reconciliation could not be drilled
        // from the journal even though the run used it. AUD, deliberately: it is
        // already converted at the settle-date rate, and the declaration keeps
        // report-currency normalisation from re-reading it as USD.
        fields: { tax: ValueType.number(), taxDetail: ValueType.any(), fxRate: ValueType.number(),
                  usTaxPaidOnUsSourceAud: ValueType.currency('AUD') } },
      { type: 'US_TAX_PAYMENT_DEBIT', family: 'TAX_PAYMENT_DEBIT', cc: 'US',
        // `escalated` — see AU_TAX_PAYMENT_DEBIT: the cross-border re-issue of the
        // unfunded part of this same bill. Declared so "Tax Paid by Year" can
        // exclude it; pickPayload would otherwise drop it and the filter would
        // silently pass everything.
        // `section988` — see AU_TAX_PAYMENT_DEBIT. Inert on this action as long as the US
        // savings pool is USD (the taxpayer's functional currency is never §988 property),
        // and declared anyway so the shared base's stamp stays visible if it is not.
        fields: { amount: ValueType.currency('USD'), escalated: ValueType.boolean(),
                  section988: ValueType.any() } },
      { type: 'RECORD_BALANCE',    fields: { fieldPath: ValueType.text(), metricKey: ValueType.text() } },
    ],
  },

  paramSchema(context) {
    return [
      {
        key: 'usFilingSingle', label: 'Filing Single',
        type: 'Boolean', group: 'US Tax', mc: false, opt: true,
        defaultValue: undefined,
        description: 'Override filing status auto-detection (true = single, false = MFJ)',
      },
    ];
  },

  state(context) {
    const capture = _getContributions(context);
    const filingSingle = context.parameters.usFilingSingle !== undefined
      ? Boolean(context.parameters.usFilingSingle)
      : context.people.length <= 1;
    return {
      ...capture.statePatches,
      usOrdinaryIncomeYTD: 0,
      usNegativeIncomeYTD: 0,
      usCapitalGainsYTD:   0,
      usPenaltyYTD:        0,
      // Self-employment tax (SECA) accumulators — design 69. Net SE earnings and
      // SS-covered wages (the latter fills the SS wage base ahead of SE income).
      usSeEarningsYTD:     0,
      usSsWagesYTD:        0,
      usFilingSingle:      filingSingle,
      // Cross-border relief accumulators (design 52) — initialised so the runtime
      // state (and the journal state-diff) always carries them, matching
      // IntlRetirementState. §904 numerators + FITO removal set + carryforward pools.
      foreignGeneralIncomeYTD: 0,
      foreignPassiveIncomeYTD: 0,
      usSourceOrdinaryUsdYTD:  0,
      usSourceCapGainsUsdYTD:  0,
      usSourceOrdinaryAudYTD:  0,
      usSourceCapGainsAudYTD:  0,
      // US-source *real* (indexed) AU cap gain (AUD) — funds the FY2027 FITO
      // "without" pass's CG slice (design 57 Part 2, Item D).
      usSourceRealCapGainsAudYTD: 0,
      // Design 83 G3 — US-source income re-sourced to foreign by Art. 27(1)(c),
      // split by the §904 category it lands in. Kept apart from foreign*IncomeYTD
      // so the FITO counterfactual can remove it from the baskets (design 83 G8).
      auCgtEffectiveRate:      null,
      usSourceDividendsUsdYTD: 0,
      usSourceInterestUsdYTD:  0,
      usSourceGeneralUsdYTD:   0,
      usSourcePassiveUsdYTD:   0,
      ftcCurrentGeneral:       0,
      ftcCurrentPassive:       0,
      // Design 72 §1 — treaty re-sourced basket (Form 1116 category F).
      ftcCurrentResourced:     0,
      ftcPoolGeneral:          {},
      ftcPoolPassive:          {},
      ftcPoolResourced:        {},
      usTaxPaidOnUsSourceAud:  0,
    };
  },

  schedules(context) {
    return _getContributions(context).events;
  },

  handlers(context) {
    return _getContributions(context).handlers;
  },

  reducers(context) {
    return [..._getContributions(context).reducers, ..._getBalanceSnapshotReducer(context)];
  },
};

function _getContributions(context) {
  if (context._usTaxCapture) return context._usTaxCapture;
  // Use the shared context.periodService when available (ScenarioCompiler injects
  // one so US + AU periods end up in a single service for journal reporting).
  const periodService = context.periodService ?? new PeriodService();
  const startYear = context.startDate.getUTCFullYear();
  const endYear   = context.endDate.getUTCFullYear();
  for (let y = startYear; y <= endYear; y++) applyTo(periodService, buildUsCalendarYear(y));
  context._usTaxCapture = new TaxService().getContributions(
    ['US'], periodService, context.startDate,
    context.accountService, context.stateRegistry,
  );
  return context._usTaxCapture;
}

function _getBalanceSnapshotReducer(context) {
  if (context._balanceSnapshotRegistered) return [];
  context._balanceSnapshotRegistered = true;
  const r = new BalanceSnapshotReducer('Balance Snapshot');
  r.reducedActionTypes = ['RECORD_BALANCE'];
  return [r];
}
