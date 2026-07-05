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
import {
  RothConversionApplyReducer,
  RothConversionHandler, RothConversionPolicyHandler,
} from '../../finance/account-rules/us/roth-conversion-classes.js';
import { ValueType } from '../../simulation-framework/type-registry.js';

// Base year for the per-year income-target schedule (design 39 §12.3): real
// targets are quoted in this year's USD and compounded by inflation, matching
// the base usBracketGrossIncomeCeiling indexes the statutory brackets from.
const BRACKET_BASE_YEAR = 2025;

/**
 * US_ROTH_CONVERSION toolset — bracket-fill Roth conversion policy scheduling.
 *
 * Capabilities: roth-conversion
 * Depends on: US_TAX
 *
 * This toolset generates one ROTH_CONVERSION_POLICY_EVALUATE one-off event
 * per (year, owner) pair within the conversion window.  Each event carries:
 *   - targetIncome: gross income ceiling for the chosen bracket
 *   - iraKey / rothKey: state keys of the IRA and Roth accounts to convert
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

  types: {
    handlers: [RothConversionHandler, RothConversionPolicyHandler],
    reducers: [RothConversionApplyReducer],
    actions: [
      { type: 'ROTH_CONVERSION_APPLY', fields: { amount: ValueType.currency('USD') } },
      { type: 'ROTH_CONVERSION_TAX',   fields: { amount: ValueType.currency('USD'), residency: ValueType.text() } },
    ],
  },

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
        controllable: true,
        defaultValue: 0.22,
        description: 'Fill ordinary income up to top of this marginal bracket',
      },
      {
        key: 'rothConversionOwner', label: 'Roth Conversion Owner',
        type: 'Enum', group: 'Roth Conversion', mc: false, opt: false,
        options: ['primary', 'spouse', 'both'],
        defaultValue: 'both',
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
      {
        // Design 39 control form (design 38 §6.3, Q6): a per-year bracket-ceiling
        // schedule — the EXPLICIT_BANDS analog for conversions — so the MPC
        // controller can re-decide each year's ceiling from realized state
        // instead of committing to one window. The batch optimizer keeps using
        // the cheap start/end/maxBracket triple above; this array is the
        // higher-resolution form the controller actuates. `controllable` and
        // round-tripped here; consumed by design 39 (inert in batch).
        key: 'rothConversionSchedule', label: 'Roth Conversion Schedule (per-year income targets)',
        type: 'RothScheduleList', group: 'Roth Conversion', mc: false, opt: false,
        controllable: true,
        defaultValue: [],
        description: 'Per-year income-fill schedule [{ year, incomeTarget }] for the closed-loop controller (design 39 §12). incomeTarget is real base-year (2025) USD, compounded by inflation to the year\'s nominal ordinary-income ceiling. Years absent = not converted (skip-years). Legacy { year, bracketCeiling } (statutory rate) entries are still accepted. Empty = use the start/end/maxBracket window.',
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

    const primary = people[0];
    const spouse  = people[1];

    const ownersToConvert = p.rothConversionOwner === 'both'
      ? [primary, spouse].filter(Boolean)
      : p.rothConversionOwner === 'spouse'
        ? [spouse].filter(Boolean)
        : [primary].filter(Boolean);

    const month = (p.rothConversionMonth ?? 12) - 1;
    const day   = p.rothConversionDay   ?? 1;
    const inflationRate = p.inflationRate ?? 0.03;

    // Emit one ROTH_CONVERSION_POLICY_EVALUATE per (year, owner) at the given
    // gross-income ceiling. Shared by the legacy window path and the per-year
    // schedule path. A non-finite/negative target is skipped (no conversion);
    // the policy handler also no-ops when there is no bracket room left.
    const events = [];
    const emitYear = (year, targetIncome) => {
      if (!(Number.isFinite(targetIncome) && targetIncome >= 0)) return;
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
    };

    // Per-year income-target form (design 39 §12) — the closed-loop controller's
    // higher-resolution control. Each entry is { year, incomeTarget } in REAL
    // base-year USD, compounded to the year's nominal ceiling by the same
    // inflation path the brackets use (usBracketGrossIncomeCeiling). A legacy
    // { year, bracketCeiling } entry (statutory marginal rate) is still accepted
    // and resolved through usBracketGrossIncomeCeiling. Years absent from the
    // schedule are simply not converted (skip-years), so the schedule expresses
    // both "which years" and "how much". Empty schedule ⇒ the legacy window below.
    const schedule = Array.isArray(p.rothConversionSchedule) ? p.rothConversionSchedule : [];
    if (schedule.length > 0) {
      for (const entry of schedule) {
        if (!entry || !Number.isFinite(entry.year)) continue;
        const targetIncome = Number.isFinite(entry.incomeTarget)
          ? entry.incomeTarget * Math.pow(1 + inflationRate, entry.year - BRACKET_BASE_YEAR)
          : Number.isFinite(entry.bracketCeiling)
            ? usBracketGrossIncomeCeiling(entry.bracketCeiling, entry.year, inflationRate)
            : NaN;
        emitYear(entry.year, targetIncome);
      }
      return events;
    }

    // Legacy window form: one bracket ceiling applied every year in [start, end].
    const toFiniteYear = (v, fallback) =>
      (typeof v === 'number' && Number.isFinite(v)) ? v : fallback;

    const defaultStartYear = primary?.retirementDate
      ? new Date(primary.retirementDate).getUTCFullYear()
      : context.startDate.getUTCFullYear();
    const defaultEndYear = new Date(primary?.birthDate ?? context.startDate).getUTCFullYear() + 72;

    const convStartYear = toFiniteYear(p.rothConversionStartYear, defaultStartYear);
    const convEndYear   = toFiniteYear(p.rothConversionEndYear,   defaultEndYear);

    for (let year = convStartYear; year <= convEndYear; year++) {
      emitYear(year, usBracketGrossIncomeCeiling(p.rothConversionMaxBracket, year, inflationRate));
    }
    return events;
  },

  handlers(context) {
    return [new RothConversionHandler(), new RothConversionPolicyHandler()];
  },

  reducers(context) {
    return [new RothConversionApplyReducer({ accountService: context.accountService })];
  },
};
