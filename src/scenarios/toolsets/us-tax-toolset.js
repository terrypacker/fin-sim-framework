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
    };
  },

  schedules(context) {
    return _getContributions(context).events;
  },

  handlers(context) {
    return _getContributions(context).handlers;
  },

  reducers(context) {
    return _getContributions(context).reducers;
  },
};

function _getContributions(context) {
  if (context._usTaxCapture) return context._usTaxCapture;
  const periodService = new PeriodService();
  const startYear = context.startDate.getUTCFullYear();
  const endYear   = context.endDate.getUTCFullYear();
  for (let y = startYear; y <= endYear; y++) applyTo(periodService, buildUsCalendarYear(y));
  context._usTaxCapture = new TaxService().getContributions(
    ['US'], periodService, context.startDate,
    context.accountService, context.stateRegistry,
  );
  return context._usTaxCapture;
}
