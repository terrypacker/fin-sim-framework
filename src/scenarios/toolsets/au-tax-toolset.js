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
import { buildAuFiscalYear, applyTo }
  from '../../finance/period/period-builder.js';
import { OneOffEvent }   from '../../simulation-framework/events/one-off-event.js';
import { EventSeries }  from '../../simulation-framework/events/event-series.js';

/**
 * AU_TAX toolset — thin declarative shell around TaxService for AU.
 *
 * TaxService is internally imperative (calls services directly).  This toolset
 * wraps both phases of TaxService setup using a capture collector so that the
 * resulting state patches, events, handlers, and reducers can be returned to
 * ScenarioCompiler for registration through the real service layer.
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

  paramSchema(context) {
    return [];
  },

  state(context) {
    const capture = _getCapture(context);
    return {
      ...capture.statePatches,
      auOrdinaryIncomeYTD:              0,
      auCapitalGainsYTD:                0,
      auNonResidentWithholdingYTD:      0,
      auSuperTaxYTD:                    0,
      auFrankingCreditYTD:              0,
      ftcYTD:                           0,
      auPersonOrdinaryIncomeYTD:        {},
      auPersonCapitalGainsYTD:          {},
      auPersonNonResidentWithholdingYTD:{},
      auPersonSuperTaxYTD:              {},
      auPersonFrankingCreditYTD:        {},
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
  if (context._auTaxCapture) return context._auTaxCapture;

  // Build PeriodService for the full simulation range.
  // AU fiscal year starts Jul 1, so we need the year before simStart to cover
  // the initial period (e.g. simStart Jan 2026 → need FY2025: Jul 2025–Jun 2026)
  const periodService = new PeriodService();
  const startYear = context.startDate.getUTCFullYear();
  const endYear   = context.endDate.getUTCFullYear();
  for (let y = startYear - 1; y <= endYear; y++) applyTo(periodService, buildAuFiscalYear(y));

  // Phase 1: setup() — use a fake sim object so we can capture state patches.
  // NOTE: TaxService.setup() replaces sim.state via assignment, so we must
  // read fakeSim.state AFTER the call, not capture fakeState beforehand.
  const fakeSim    = { state: {}, currentDate: context.startDate };
  const taxService = new TaxService();
  taxService.setup(fakeSim, ['AU'], periodService);
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
  taxService.registerHandlersAndReducers(captureServices, ['AU']);

  context._auTaxCapture = {
    statePatches: capturedStatePatches,
    events:       capturedEvents,
    handlers:     capturedHandlers,
    reducers:     capturedReducers,
  };
  return context._auTaxCapture;
}
