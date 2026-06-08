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
import { ValueType } from '../../simulation-framework/type-registry.js';

/**
 * US_AU_CROSS_BORDER toolset — residency transition and bilateral transfer wiring.
 *
 * Capabilities: cross-border
 * Depends on: US_TAX, AU_TAX
 *
 * State ownership:
 *   Initializes: people[*].residency (overrides per-person default to startingResidency),
 *                ftcYTD (reset to 0), combined inflationRates and inflationAccumulator
 *                for both countries
 *   Reads: us* keys from US_TAX; au* keys from AU_TAX
 *
 * Typical usage: toolsets: ["US_RETIREMENT", "AU_RETIREMENT", "US_AU_CROSS_BORDER"]
 * For AU→US migrants, set startingResidency: 'AUS' in parameters.
 */
export const US_AU_CROSS_BORDER = {
  id: 'US_AU_CROSS_BORDER',
  capabilities: ['cross-border'],
  dependencies: ['US_TAX', 'AU_TAX'],

  types: {
    handlers: [ChangeResidencyHandler, IntlTransferToAuHandler, IntlTransferToUsHandler],
    reducers: [ChangeResidencyApplyReducer, IntlTransferApplyReducer],
    actions: [
      { type: 'CHANGE_RESIDENCY_APPLY' },
      { type: 'INTL_TRANSFER_APPLY', fields: { amount: ValueType.number() } },
    ],
  },

  paramSchema(context) {
    return [
      {
        key: 'moveYear', label: 'US→AU Move Year',
        type: 'Number', group: 'Cross Border', mc: false, opt: true,
        defaultValue: undefined,
        description: 'Calendar year of US→AU migration (Jul 1). Leave unset for no move.',
      },
      {
        key: 'startingResidency', label: 'Starting Residency',
        type: 'Text', group: 'Cross Border', mc: false, opt: true,
        defaultValue: null,
        description: 'Starting country of tax residency for all persons (e.g. "US", "AUS"). Defaults to "US" when unset.',
      },
      {
        key: 'auInflationRate', label: 'AU Inflation Rate (cross-border)',
        type: 'Number', group: 'Cross Border', mc: true, opt: true,
        defaultValue: 0.03,
        description: 'AU inflation rate when running combined US+AU scenario',
      },
      {
        key: 'exchangeRateUsdToAud', label: 'Exchange Rate USD→AUD',
        type: 'Number', group: 'Cross Border', mc: true, opt: false,
        defaultValue: 1.55,
        description: 'USD to AUD exchange rate applied on international transfers',
      },
      {
        key: 'intlTransferFeeUsd', label: 'International Transfer Fee (USD)',
        type: 'Number', group: 'Cross Border', mc: true, opt: false,
        defaultValue: 15,
        description: 'Fixed fee per international wire transfer in USD',
      },
    ];
  },

  state(context) {
    const p = context.parameters;
    const startingResidency = p.startingResidency ?? (p.isAuResident ? 'AUS' : 'US');

    // Build a full people map from PersonService so we can override residency.
    // context.state does not exist in the compiler — context.people is the source of truth.
    // Because _mergeStatePatches does a shallow (key-level) merge for 'people', we must
    // emit the complete person entries here; a partial { residency } object would discard
    // fields set by US_RETIREMENT / AU_RETIREMENT.
    const people = {};
    for (const person of context.people) {
      people[person.id] = {
        id:                    person.id,
        name:                  person.name,
        birthDate:             person.birthDate,
        monthlyWage:           person.monthlyWage           ?? 0,
        retirementDate:        person.retirementDate        ?? null,
        socialSecurityMonthly: person.socialSecurityMonthly ?? 0,
        lifeExpectancy:        person.lifeExpectancy        ?? 90,
        citizen:               person.citizen               ?? ['US'],
        residency:             startingResidency,
      };
    }

    const patches = {
      ftcYTD:               0,
      exchangeRateUsdToAud: p.exchangeRateUsdToAud ?? 1.55,
      intlTransferFeeUsd:   p.intlTransferFeeUsd   ?? 15,
      inflationRates:       {
        US: p.inflationRate    ?? 0.03,
        AU: p.auInflationRate  ?? 0.03,
      },
      inflationAccumulator: { US: 1.0, AU: 1.0 },
    };

    if (Object.keys(people).length > 0) patches.people = people;
    return patches;
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
