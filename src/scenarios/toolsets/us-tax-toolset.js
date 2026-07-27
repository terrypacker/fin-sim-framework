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
        fields: { tax: ValueType.number(), taxDetail: ValueType.any() } },
      { type: 'US_TAX_PAYMENT_DEBIT', family: 'TAX_PAYMENT_DEBIT', cc: 'US',
        fields: { amount: ValueType.currency('USD') } },
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
      ftcCurrentGeneral:       0,
      ftcCurrentPassive:       0,
      ftcPoolGeneral:          {},
      ftcPoolPassive:          {},
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
