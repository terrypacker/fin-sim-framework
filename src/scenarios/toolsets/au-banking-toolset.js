/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { EventBuilder }            from '../../simulation-framework/builders/event-builder.js';
import { ACCOUNT_ROLES }           from '../../finance/state/account-roles.js';
import { AuSavingsInterestHandler }
  from '../../finance/handlers/earnings-handlers.js';

/**
 * AU_BANKING toolset — AU savings account interest machinery.
 *
 * Capabilities: banking
 * Depends on: (none)
 *
 * State ownership:
 *   Contributes: INTL_AU_SAVINGS_INTEREST schedule, per-account handlers.
 *   AU account module reducers (AuSavingsEarningsApplyReducer) come from
 *   AU_TAX via TaxService, not from this toolset.
 */
export const AU_BANKING = {
  id: 'AU_BANKING',
  capabilities: ['banking'],
  dependencies: [],

  paramSchema(context) {
    return [
      {
        key: 'auSavingsInterestRate', label: 'AU Savings Interest Rate',
        type: 'Number', group: 'AU Banking', mc: true, opt: true,
        defaultValue: 0.045,
        description: 'Annual interest rate for AU savings accounts',
      },
    ];
  },

  state(context) {
    return {};
  },

  schedules(context) {
    const accounts = context.accounts.filter(a => a.role === ACCOUNT_ROLES.AU_SAVINGS);
    if (accounts.length === 0) return [];
    return [
      EventBuilder.eventSeries()
        .name('AU Savings Interest').type('INTL_AU_SAVINGS_INTEREST')
        .interval('year-end').startOffset(1).enabled(true).color('#FF9800').build(),
    ];
  },

  handlers(context) {
    const accounts = context.accounts.filter(a => a.role === ACCOUNT_ROLES.AU_SAVINGS);
    if (accounts.length === 0) return [];
    const event = context.schedulesById['INTL_AU_SAVINGS_INTEREST'];
    const rate  = context.parameters.auSavingsInterestRate;
    return accounts.map(acct => {
      const h = new AuSavingsInterestHandler({
        stateRegistry: context.stateRegistry,
        role:          ACCOUNT_ROLES.AU_SAVINGS,
        ownerId:       acct.ownerId,
        interestRate:  rate,
      });
      h.handledEvents.push(event);
      return h;
    });
  },

  reducers(context) {
    return [];
  },
};
