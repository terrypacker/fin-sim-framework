/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { StateTaxService } from '../../finance/state-tax-service.js';
import {
  StateTaxSettleHandler, StateTaxSettleApplyReducer, StateTaxPaymentDebitReducer,
} from '../../finance/tax/state/state-tax-settle-classes.js';
import { StateIncomeClassificationReducer } from '../../finance/tax/state/state-income-classification.js';
import { ValueType } from '../../simulation-framework/type-registry.js';

/**
 * US_STATE_TAX toolset — declarative shell around StateTaxService (design 34).
 *
 * Capabilities: state-taxation
 * Depends on: US_TAX (needs the US calendar-year periods + the income *_TAX
 *             events the state classification reduces).
 *
 * State ownership:
 *   Initializes: stateOrdinaryIncomeYTD, statePensionIncomeYTD, stateSsIncomeYTD,
 *                stateCapitalGainsYTD
 *   Reads: currentPeriods.US (from US_TAX), people[*].residencyState (the active
 *          state is the primary person's — set by the scenario's residencyState param)
 *
 * The residency state itself is a Person field, owned by the scenario (like
 * `residency`/`birthDate`), not by this toolset.
 */
export const US_STATE_TAX = {
  id: 'US_STATE_TAX',
  capabilities: ['state-taxation'],
  dependencies: ['US_TAX'],

  types: {
    handlers: [StateTaxSettleHandler],
    reducers: [StateTaxSettleApplyReducer, StateTaxPaymentDebitReducer, StateIncomeClassificationReducer],
    actions: [
      { type: 'STATE_TAX_SETTLE_APPLY', family: 'TAX_SETTLE_APPLY', cc: 'US',
        fields: { tax: ValueType.number(), taxDetail: ValueType.any() } },
      { type: 'STATE_TAX_PAYMENT_DEBIT', family: 'TAX_PAYMENT_DEBIT', cc: 'US',
        fields: { amount: ValueType.currency('USD') } },
    ],
  },

  state(context) {
    return _getStateContributions(context).statePatches;
  },

  schedules(context) {
    return _getStateContributions(context).events;
  },

  handlers(context) {
    return _getStateContributions(context).handlers;
  },

  reducers(context) {
    return _getStateContributions(context).reducers;
  },
};

function _getStateContributions(context) {
  if (context._usStateTaxCapture) return context._usStateTaxCapture;
  context._usStateTaxCapture = new StateTaxService().getContributions(
    context.accountService, context.stateRegistry,
  );
  return context._usStateTaxCapture;
}
