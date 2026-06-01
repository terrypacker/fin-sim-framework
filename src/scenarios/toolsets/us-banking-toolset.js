/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { EventBuilder }               from '../../simulation-framework/builders/event-builder.js';
import { ACCOUNT_ROLES }              from '../../finance/state/account-roles.js';
import { UsSavingsInterestMonthlyHandler }
  from '../../finance/handlers/us-savings-interest-handler.js';
import { UsSavingsInterestCreditReducer }
  from '../../finance/reducers/us-savings-interest-credit-reducer.js';
import { ValueType } from '../../simulation-framework/type-registry.js';

/**
 * US_BANKING toolset — US savings account interest machinery.
 *
 * Capabilities: banking
 * Depends on: (none)
 *
 * State ownership:
 *   Initializes: (none — account state entries are owned by US_RETIREMENT)
 *   Contributes: US_SAVINGS_INTEREST_MONTHLY schedule, per-account handlers,
 *                UsSavingsInterestCreditReducer
 */
export const US_BANKING = {
  id: 'US_BANKING',
  capabilities: ['banking'],
  dependencies: [],

  types: {
    handlers: [UsSavingsInterestMonthlyHandler],
    reducers: [UsSavingsInterestCreditReducer],
    actions: [
      { type: 'US_SAVINGS_INTEREST_CREDIT', fields: { amount: ValueType.currency('USD') } },
    ],
  },

  paramSchema(context) {
    return [
      {
        key: 'usSavingsInterestRate', label: 'US Savings Interest Rate',
        type: 'Number', group: 'US Banking', mc: true, opt: true,
        defaultValue: 0.03,
        description: 'Annual interest rate for US savings accounts',
      },
    ];
  },

  state(context) {
    return {};
  },

  schedules(context) {
    const accounts = context.accounts.filter(a => a.role === ACCOUNT_ROLES.US_SAVINGS);
    if (accounts.length === 0) return [];
    return [
      EventBuilder.eventSeries()
        .name('Monthly US Savings Interest').type('US_SAVINGS_INTEREST_MONTHLY')
        .interval('month-end').enabled(true).color('#00BCD4').build(),
    ];
  },

  handlers(context) {
    const accounts = context.accounts.filter(a => a.role === ACCOUNT_ROLES.US_SAVINGS);
    if (accounts.length === 0) return [];
    const intEvent = context.schedulesById['US_SAVINGS_INTEREST_MONTHLY'];
    const rate = context.parameters.usSavingsInterestRate;

    return accounts.map(acct => {
      const h = new UsSavingsInterestMonthlyHandler({
        stateRegistry: context.stateRegistry,
        role: ACCOUNT_ROLES.US_SAVINGS,
        ownerId: acct.ownerId,
        interestRate: rate,
      });
      h.handledEvents.push(intEvent);
      return h;
    });
  },

  reducers(context) {
    const accounts = context.accounts.filter(a => a.role === ACCOUNT_ROLES.US_SAVINGS);
    if (accounts.length === 0) return [];
    const primaryId = accounts[0].ownerId;
    return [
      new UsSavingsInterestCreditReducer({
        accountService: context.accountService,
        stateRegistry:  context.stateRegistry,
        role:           ACCOUNT_ROLES.US_SAVINGS,
        ownerId:        primaryId,
      }),
    ];
  },
};
