/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ACCOUNT_ROLES }              from '../../finance/state/account-roles.js';
import { OneOffEvent }                from '../../simulation-framework/events/one-off-event.js';
import { ChangeResidencyHandler }     from '../../finance/handlers/change-residency-handler.js';
import { IntlTransferToAuHandler,
         IntlTransferToUsHandler }    from '../../finance/handlers/intl-transfer-handlers.js';
import { ChangeResidencyApplyReducer }
  from '../../finance/reducers/change-residency-apply-reducer.js';
import { IntlTransferApplyReducer }   from '../../finance/reducers/intl-transfer-apply-reducer.js';

/**
 * US_AU_CROSS_BORDER toolset — residency transition and bilateral transfer wiring.
 *
 * Capabilities: cross-border
 * Depends on: US_TAX, AU_TAX
 *
 * State ownership:
 *   Initializes: isAuResident (overrides AU_RETIREMENT's true default to false for
 *                US→AU migration scenarios), ftcYTD (reset to 0), combined
 *                inflationRates and inflationAccumulator for both countries
 *   Reads: us* keys from US_TAX; au* keys from AU_TAX
 *
 * Typical usage: toolsets: ["US_RETIREMENT", "AU_RETIREMENT", "US_AU_CROSS_BORDER"]
 * For AU→US migrants, override isAuResident: true in parameters.
 */
export const US_AU_CROSS_BORDER = {
  id: 'US_AU_CROSS_BORDER',
  capabilities: ['cross-border'],
  dependencies: ['US_TAX', 'AU_TAX'],

  paramSchema(context) {
    return [
      {
        key: 'moveYear', label: 'US→AU Move Year',
        type: 'Number', group: 'Cross Border', mc: false, opt: true,
        defaultValue: undefined,
        description: 'Calendar year of US→AU migration (Jul 1). Leave unset for no move.',
      },
      {
        key: 'isAuResident', label: 'Starts as AU Resident',
        type: 'Boolean', group: 'Cross Border', mc: false, opt: true,
        defaultValue: false,
        description: 'Initial residency status. Overrides AU_RETIREMENT default of true.',
      },
      {
        key: 'auInflationRate', label: 'AU Inflation Rate (cross-border)',
        type: 'Number', group: 'Cross Border', mc: true, opt: true,
        defaultValue: 0.03,
        description: 'AU inflation rate when running combined US+AU scenario',
      },
    ];
  },

  state(context) {
    const p = context.parameters;
    // Override isAuResident (AU_RETIREMENT defaults to true; cross-border starts in US)
    // Combined inflation rates for both jurisdictions
    return {
      isAuResident:         p.isAuResident ?? false,
      ftcYTD:               0,
      inflationRates:       {
        US: p.inflationRate    ?? 0.03,
        AU: p.auInflationRate  ?? 0.03,
      },
      inflationAccumulator: { US: 1.0, AU: 1.0 },
    };
  },

  schedules(context) {
    const moveYear = context.parameters.moveYear;
    if (!moveYear) return [];
    // CHANGE_RESIDENCY fires on Jul 1 of moveYear (matches IntlRetirementScenario)
    const moveDate = new Date(Date.UTC(moveYear, 6, 1));
    return [
      new OneOffEvent({
        name:    'Change Residency',
        type:    'CHANGE_RESIDENCY',
        date:    moveDate,
        data:    {},
        enabled: true,
        color:   '#FF5722',
      }),
    ];
  },

  handlers(context) {
    const p        = context.parameters;
    const accounts = context.accounts;
    const people   = context.people;
    const sr       = context.stateRegistry;

    const usSavAccts = accounts.filter(a => a.role === ACCOUNT_ROLES.US_SAVINGS);
    const auSavAccts = accounts.filter(a => a.role === ACCOUNT_ROLES.AU_SAVINGS);
    const primaryId  = usSavAccts[0]?.ownerId ?? auSavAccts[0]?.ownerId
                     ?? (people[0]?.id ?? null);
    const handlers = [];

    // Bilateral transfer handlers (no event binding — handle on-demand events)
    if (usSavAccts.length > 0 && auSavAccts.length > 0) {
      handlers.push(new IntlTransferToAuHandler({
        stateRegistry: sr,
        usRole: ACCOUNT_ROLES.US_SAVINGS, usOwnerId: primaryId,
        auRole: ACCOUNT_ROLES.AU_SAVINGS, auOwnerId: primaryId,
      }));
      handlers.push(new IntlTransferToUsHandler({
        stateRegistry: sr,
        usRole: ACCOUNT_ROLES.US_SAVINGS, usOwnerId: primaryId,
        auRole: ACCOUNT_ROLES.AU_SAVINGS, auOwnerId: primaryId,
      }));
    }

    // Residency change handler
    if (p.moveYear) {
      const changeResEvent = context.schedulesById['CHANGE_RESIDENCY'];
      const changeResHandler = new ChangeResidencyHandler();
      if (changeResEvent) changeResHandler.handledEvents.push(changeResEvent);
      handlers.push(changeResHandler);
    }

    return handlers;
  },

  reducers(context) {
    const accountSvc = context.accountService;
    const sr         = context.stateRegistry;
    return [
      new ChangeResidencyApplyReducer({ accountService: accountSvc, stateRegistry: sr }),
      new IntlTransferApplyReducer({ accountService: accountSvc }),
    ];
  },
};
