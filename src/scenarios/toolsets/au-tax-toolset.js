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
import { AuCgtBasisResetHandler, AuCgtBasisResetReducer }
  from '../../finance/account-rules/au/au-cgt-reset-classes.js';
import { OneOffEvent } from '../../simulation-framework/events/one-off-event.js';
import { ValueType } from '../../simulation-framework/type-registry.js';

// AU CGT reform (design 57 §6.4): the 1 July 2027 deemed cost base reset.
const AU_CGT_RESET_DATE = new Date(Date.UTC(2027, 6, 1));

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
    handlers: [AuPeriodAdvanceHandler, AuTaxSettleHandler, AuCgtBasisResetHandler],
    reducers: [AuPeriodAdvanceReducer, AuTaxSettleApplyReducer, AuTaxPaymentDebitReducer, BalanceSnapshotReducer, AuCgtBasisResetReducer],
    actions: [
      { type: 'AU_PERIOD_ADVANCE',  fields: { period: ValueType.any() } },
      { type: 'AU_CGT_BASIS_RESET_APPLY', fields: {} },
      { type: 'AU_TAX_SETTLE_APPLY', family: 'TAX_SETTLE_APPLY', cc: 'AU',
        fields: { tax: ValueType.number(), taxDetail: ValueType.any(), personTaxDetails: ValueType.any() } },
      { type: 'AU_TAX_PAYMENT_DEBIT', family: 'TAX_PAYMENT_DEBIT', cc: 'AU',
        fields: { amount: ValueType.currency('AUD') } },
      { type: 'RECORD_BALANCE',    fields: { fieldPath: ValueType.text(), metricKey: ValueType.text() } },
    ],
  },

  paramSchema(context) {
    return [];
  },

  state(context) {
    const capture = _getContributions(context);
    const state = {
      ...capture.statePatches,
      auOrdinaryIncomeYTD:              0,
      auCapitalGainsYTD:                0,
      auRealCapitalGainsYTD:            0,   // FY2027 reform: post-indexation gain (design 57)
      auNonResidentWithholdingYTD:      0,
      auSuperTaxYTD:                    0,
      auFrankingCreditYTD:              0,
      auPersonOrdinaryIncomeYTD:        {},
      auPersonCapitalGainsYTD:          {},
      auPersonRealCapitalGainsYTD:      {},
      auPersonNonResidentWithholdingYTD:{},
      auPersonSuperTaxYTD:              {},
      auPersonFrankingCreditYTD:        {},
      auPersonEarnedIncomeYTD:          {},   // FEIE cap accumulator (design 52 §4.2)
    };

    //Zero out some fields that we will need
    context.people.forEach(p => {
      state.auPersonOrdinaryIncomeYTD[p.id] = 0;
      state.auPersonCapitalGainsYTD[p.id] = 0;
      state.auPersonRealCapitalGainsYTD[p.id] = 0;
      state.auPersonNonResidentWithholdingYTD[p.id] = 0;
      state.auPersonSuperTaxYTD[p.id] = 0;
      state.auPersonFrankingCreditYTD[p.id] = 0;
      state.auPersonEarnedIncomeYTD[p.id] = 0;
    })

    return state;
  },

  schedules(context) {
    return [..._getContributions(context).events, ..._cgtResetEvents(context)];
  },

  handlers(context) {
    // The reset handler is only registered when its event is actually scheduled;
    // otherwise the handler→event edge would reference a missing event node.
    const resetHandlers = _spansCgtReset(context) ? [new AuCgtBasisResetHandler()] : [];
    return [..._getContributions(context).handlers, ...resetHandlers];
  },

  reducers(context) {
    return [
      ..._getContributions(context).reducers,
      ..._getBalanceSnapshotReducer(context),
      new AuCgtBasisResetReducer({ accountService: context.accountService }),
    ];
  },
};

/**
 * True when the simulation spans the 1 July 2027 reform date (starts before it
 * and ends on/after it). A sim that starts after the reform needs no reset — its
 * lots are already post-reform.
 */
function _spansCgtReset(context) {
  return context.startDate < AU_CGT_RESET_DATE && context.endDate >= AU_CGT_RESET_DATE;
}

/** The 1 July 2027 deemed cost base reset event, scheduled once when in range. */
function _cgtResetEvents(context) {
  if (!_spansCgtReset(context)) return [];
  return [new OneOffEvent({
    name:    'AU CGT Cost Base Reset (1 Jul 2027)',
    type:    'AU_CGT_BASIS_RESET',
    date:    AU_CGT_RESET_DATE,
    enabled: true,
    color:   '#8E24AA',
  })];
}

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
