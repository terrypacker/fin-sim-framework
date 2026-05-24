/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { OneOffEvent }  from '../../simulation-framework/events/one-off-event.js';
import { ACCOUNT_ROLES } from '../../finance/state/account-roles.js';
import { usBracketGrossIncomeCeiling } from '../../finance/tax/us/us-tax-rates-2025.js';

/**
 * US_ROTH_CONVERSION toolset — bracket-fill Roth conversion policy scheduling.
 *
 * Capabilities: roth-conversion
 * Depends on: US_TAX (RothConversionPolicyHandler and RothConversionApplyReducer
 *   are registered by TaxService via the US account module)
 *
 * This toolset generates one ROTH_CONVERSION_POLICY_EVALUATE one-off event
 * per (year, owner) pair within the conversion window.  Each event carries:
 *   - targetIncome: gross income ceiling for the chosen bracket
 *   - iraKey / rothKey: state keys of the IRA and Roth accounts to convert
 *
 * No handlers or reducers are registered here — those come from US_TAX.
 *
 * Parameters:
 *   rothConversionEnabled    — master switch; if false nothing is scheduled
 *   rothConversionStartYear  — null → primary person's retirement year
 *   rothConversionEndYear    — null → year before primary turns 73 (RMD start)
 *   rothConversionMaxBracket — fill ordinary income to top of this marginal rate
 *   rothConversionOwner      — 'primary' | 'spouse' | 'both'
 *   rothConversionMonth      — month (1–12) when the policy fires each year
 *   rothConversionDay        — day of month when the policy fires
 */
export const US_ROTH_CONVERSION = {
  id: 'US_ROTH_CONVERSION',
  capabilities: ['roth-conversion'],
  dependencies: ['US_TAX'],

  paramSchema(context) {
    return [
      {
        key: 'rothConversionEnabled', label: 'Roth Conversion Enabled',
        type: 'Boolean', group: 'Roth Conversion', mc: false, opt: false,
        defaultValue: false,
        description: 'Enable bracket-fill Roth conversion policy',
      },
      {
        key: 'rothConversionStartYear', label: 'Roth Conversion Start Year',
        type: 'Number', group: 'Roth Conversion', mc: false, opt: true,
        defaultValue: null,
        description: 'First year to convert; null = primary person\'s retirement year',
      },
      {
        key: 'rothConversionEndYear', label: 'Roth Conversion End Year',
        type: 'Number', group: 'Roth Conversion', mc: false, opt: true,
        defaultValue: null,
        description: 'Last year to convert; null = year before RMD start at primary age 73',
      },
      {
        key: 'rothConversionMaxBracket', label: 'Roth Conversion Max Bracket Rate',
        type: 'Number', group: 'Roth Conversion', mc: false, opt: true,
        defaultValue: 0.22,
        description: 'Fill ordinary income up to top of this marginal bracket',
      },
      {
        key: 'rothConversionOwner', label: 'Roth Conversion Owner',
        type: 'String', group: 'Roth Conversion', mc: false, opt: false,
        defaultValue: 'primary',
        description: "Whose IRA to convert: 'primary', 'spouse', or 'both'",
      },
      {
        key: 'rothConversionMonth', label: 'Roth Conversion Month',
        type: 'Number', group: 'Roth Conversion', mc: false, opt: false,
        defaultValue: 12,
        description: 'Month (1–12) when the policy fires each year',
      },
      {
        key: 'rothConversionDay', label: 'Roth Conversion Day',
        type: 'Number', group: 'Roth Conversion', mc: false, opt: false,
        defaultValue: 1,
        description: 'Day of month when the policy fires',
      },
    ];
  },

  state(context) {
    return {};
  },

  schedules(context) {
    const p = context.parameters;
    if (!p.rothConversionEnabled) return [];

    const people   = context.people   ?? [];
    const accounts = context.accounts ?? [];

    const toFiniteYear = (v, fallback) =>
      (typeof v === 'number' && Number.isFinite(v)) ? v : fallback;

    const primary = people[0];
    const spouse  = people[1];

    const defaultStartYear = primary?.retirementDate
      ? new Date(primary.retirementDate).getUTCFullYear()
      : context.startDate.getUTCFullYear();

    const defaultEndYear = new Date(primary?.birthDate ?? context.startDate).getUTCFullYear() + 72;

    const convStartYear = toFiniteYear(p.rothConversionStartYear, defaultStartYear);
    const convEndYear   = toFiniteYear(p.rothConversionEndYear,   defaultEndYear);

    const ownersToConvert = p.rothConversionOwner === 'both'
      ? [primary, spouse].filter(Boolean)
      : p.rothConversionOwner === 'spouse'
        ? [spouse].filter(Boolean)
        : [primary].filter(Boolean);

    const month = (p.rothConversionMonth ?? 12) - 1;
    const day   = p.rothConversionDay   ?? 1;
    const inflationRate = p.inflationRate ?? 0.03;

    const events = [];
    for (let year = convStartYear; year <= convEndYear; year++) {
      const targetIncome = usBracketGrossIncomeCeiling(p.rothConversionMaxBracket, year, inflationRate);

      for (const person of ownersToConvert) {
        const iraAcct  = accounts.find(a => a.role === ACCOUNT_ROLES.IRA  && a.ownerId === person.id);
        const rothAcct = accounts.find(a => a.role === ACCOUNT_ROLES.ROTH && a.ownerId === person.id);
        if (!iraAcct || !rothAcct) continue;

        events.push(new OneOffEvent({
          name:    `Roth Conversion (${person.name}, ${year})`,
          type:    'ROTH_CONVERSION_POLICY_EVALUATE',
          date:    new Date(Date.UTC(year, month, day)),
          data:    { targetIncome, iraKey: iraAcct.stateKey, rothKey: rothAcct.stateKey },
          enabled: true,
          color:   '#7E57C2',
        }));
      }
    }
    return events;
  },

  handlers(context) {
    return [];
  },

  reducers(context) {
    return [];
  },
};
