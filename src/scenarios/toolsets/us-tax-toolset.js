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
import { buildUsCalendarYear, applyTo }
  from '../../finance/period/period-builder.js';
import { OneOffEvent }   from '../../simulation-framework/events/one-off-event.js';
import { EventSeries }  from '../../simulation-framework/events/event-series.js';

/**
 * US_TAX toolset — thin declarative shell around TaxService.
 *
 * TaxService is internally imperative (calls services directly).  This toolset
 * wraps both phases of TaxService setup using a capture collector so that the
 * resulting state patches, events, handlers, and reducers can be returned to
 * ScenarioCompiler for registration through the real service layer.
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
    const capture = _getCapture(context);
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
    };
  },

  schedules(context) {
    return _getCapture(context).events;
  },

  handlers(context) {
    return _getCapture(context).handlers;
  },

  reducers(context) {
    return _getCapture(context).reducers;
  },
};

/**
 * Run TaxService both phases using a capture collector, caching the result on
 * the compilation context so each toolset method shares a single run.
 *
 * @param {object} context — CompilationContext
 */
function _getCapture(context) {
  if (context._usTaxCapture) return context._usTaxCapture;

  // Build PeriodService for the full simulation range
  const periodService = new PeriodService();
  const startYear = context.startDate.getUTCFullYear();
  const endYear   = context.endDate.getUTCFullYear();
  for (let y = startYear; y <= endYear; y++) applyTo(periodService, buildUsCalendarYear(y));

  // Phase 1: setup() — use a fake sim object so we can capture state patches.
  // NOTE: TaxService.setup() replaces sim.state via assignment, so we must
  // read fakeSim.state AFTER the call, not capture fakeState beforehand.
  const fakeSim   = { state: {}, currentDate: context.startDate };
  const taxService = new TaxService();
  taxService.setup(fakeSim, ['US'], periodService);
  // fakeSim.state was replaced by setup(); read the new reference.
  const capturedStatePatches = fakeSim.state;

  // Phase 2: registerHandlersAndReducers() — use capture collector
  const capturedEvents   = [];
  const capturedHandlers = [];
  const capturedReducers = [];

  const captureServices = {
    eventService: {
      createOneOffEvent(params) {
        const event = new OneOffEvent(params);
        capturedEvents.push(event);
        return event;
      },
      createEventSeries(params) {
        const event = new EventSeries(params);
        capturedEvents.push(event);
        return event;
      },
    },
    handlerService:  { register: (h) => capturedHandlers.push(h) },
    reducerService:  { register: (r) => capturedReducers.push(r) },
    accountService:  context.accountService,
    stateRegistry:   context.stateRegistry,
  };
  taxService.registerHandlersAndReducers(captureServices, ['US']);

  context._usTaxCapture = {
    statePatches: capturedStatePatches,
    events:       capturedEvents,
    handlers:     capturedHandlers,
    reducers:     capturedReducers,
  };
  return context._usTaxCapture;
}
