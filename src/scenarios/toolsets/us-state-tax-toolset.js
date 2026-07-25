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
import { ChangeStateResidencyHandler }
  from '../../finance/handlers/change-state-residency-handler.js';
import { ChangeStateResidencyApplyReducer }
  from '../../finance/reducers/change-state-residency-apply-reducer.js';
import { OneOffEvent } from '../../simulation-framework/events/one-off-event.js';
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
 *
 * State move (design 34 §9, Phase 3): when `stateMoveYear` is set, schedules a
 * CHANGE_STATE_RESIDENCY one-off on Jan 1 of that year that flips every person's
 * residencyState to `stateMoveDestination`. Pinned to Jan 1 so the destination
 * state taxes the whole calendar year (no part-year apportionment — deferred).
 */
export const US_STATE_TAX = {
  id: 'US_STATE_TAX',
  capabilities: ['state-taxation'],
  dependencies: ['US_TAX'],

  types: {
    handlers: [StateTaxSettleHandler, ChangeStateResidencyHandler],
    reducers: [
      StateTaxSettleApplyReducer, StateTaxPaymentDebitReducer,
      StateIncomeClassificationReducer, ChangeStateResidencyApplyReducer,
    ],
    actions: [
      { type: 'STATE_TAX_SETTLE_APPLY', family: 'TAX_SETTLE_APPLY', cc: 'US',
        fields: { tax: ValueType.number(), taxDetail: ValueType.any(), fxRate: ValueType.number() } },
      { type: 'STATE_TAX_PAYMENT_DEBIT', family: 'TAX_PAYMENT_DEBIT', cc: 'US',
        fields: { amount: ValueType.currency('USD') } },
      { type: 'CHANGE_STATE_RESIDENCY_APPLY', cc: 'US',
        fields: { destination: ValueType.text() } },
    ],
  },

  paramSchema() {
    return [
      {
        key: 'stateMoveYear', label: 'State Move Year',
        type: 'Number', group: 'US Tax', mc: false, opt: true,
        defaultValue: undefined,
        description: 'Calendar year to establish residency in the destination state (effective Jan 1). Leave unset for no state move.',
      },
      {
        key: 'stateMoveDestination', label: 'State Move Destination',
        type: 'Enum', options: ['NE', 'HI', 'SD'], group: 'US Tax', mc: false, opt: true,
        defaultValue: null,
        description: 'Destination US state for the Jan-1 state move (design 34 §9).',
      },
    ];
  },

  state(context) {
    return _getStateContributions(context).statePatches;
  },

  schedules(context) {
    const events    = [..._getStateContributions(context).events];
    const moveEvent = _buildStateMoveEvent(context.parameters);
    if (moveEvent) events.push(moveEvent);
    return events;
  },

  handlers(context) {
    const handlers = [..._getStateContributions(context).handlers];
    if (context.parameters.stateMoveYear) {
      const moveEvent = context.schedulesById['CHANGE_STATE_RESIDENCY'];
      const moveHandler = new ChangeStateResidencyHandler();
      if (moveEvent) moveHandler.handledEvents.push(moveEvent);
      handlers.push(moveHandler);
    }
    return handlers;
  },

  reducers(context) {
    return [
      ..._getStateContributions(context).reducers,
      new ChangeStateResidencyApplyReducer(),
    ];
  },
};

function _getStateContributions(context) {
  if (context._usStateTaxCapture) return context._usStateTaxCapture;
  context._usStateTaxCapture = new StateTaxService().getContributions(
    context.accountService, context.stateRegistry,
  );
  return context._usStateTaxCapture;
}

/**
 * Build the CHANGE_STATE_RESIDENCY one-off event for a Jan-1 state move, or null
 * when no `stateMoveYear` is configured. Mirrors how US_AU_CROSS_BORDER builds
 * CHANGE_RESIDENCY from `moveYear`.
 */
function _buildStateMoveEvent(parameters) {
  const year = parameters.stateMoveYear;
  if (!year) return null;
  const destination = parameters.stateMoveDestination || null;
  return new OneOffEvent({
    name:    'Change State Residency',
    type:    'CHANGE_STATE_RESIDENCY',
    date:    new Date(Date.UTC(year, 0, 1)),   // Jan 1 — destination taxes the full year (design 34 §9.1)
    data:    { destination },
    enabled: true,
    color:   '#FF8A65',
  });
}
