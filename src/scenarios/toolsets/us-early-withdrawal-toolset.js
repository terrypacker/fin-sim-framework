/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { OneOffEvent }   from '../../simulation-framework/events/one-off-event.js';
import { ACCOUNT_ROLES } from '../../finance/state/account-roles.js';
import { ValueType }     from '../../simulation-framework/type-registry.js';
import { BRACKET_BASE_YEAR } from './us-roth-conversion-toolset.js';
import {
  ScheduledEarlyWithdrawalApplyReducer,
  EarlyWithdrawalPolicyHandler,
} from '../../finance/account-rules/us/early-withdrawal-classes.js';

// Same-date ordering (design 45 Q2 / design 34 §13): when a year holds both a
// Roth conversion (order 0) and a scheduled early withdrawal, conversions must
// apply FIRST so the withdrawal draws against the post-conversion balances.
// A higher `order` sorts later in the queue's (date, then order) comparator.
const EARLY_WITHDRAWAL_ORDER = 10;

/**
 * Forward-effective re-target of queued SCHEDULED_EARLY_WITHDRAWAL events from a
 * per-year schedule (design 45 Phase 3) — the rollout-side twin of the live
 * `COCKPIT_CONTROLS.EARLY_WITHDRAWAL.actuate`, mirroring `retargetRothConversionEvents`.
 *
 * Snapshot-seeded rollouts inject a frozen queue, so editing `earlyWithdrawalSchedule`
 * params alone doesn't move the rollout; this rewrites the **future** (`date > nowMs`)
 * queued events for each scheduled year to that year's nominal per-class amounts (the
 * same real→nominal inflation path `schedules()` uses). Years absent from `schedule`
 * keep their queued amounts; events only exist to tune when the toolset seeded them
 * (explicit entries or the opt-in optimization window).
 *
 * @param {Array}  queue    - the heap's backing array (e.g. `sim.queue.data`).
 * @param {Array}  schedule - [{ year, taxDeferredAmount, rothAmount }] in real base-year USD.
 * @param {object} [opts]
 * @param {number} [opts.inflationRate=0.03]
 * @param {number} [opts.nowMs=-Infinity] - only events strictly after this fire forward.
 * @returns {number} count of events re-targeted.
 */
export function retargetEarlyWithdrawalEvents(queue, schedule, { inflationRate = 0.03, nowMs = -Infinity } = {}) {
  if (!Array.isArray(queue) || !Array.isArray(schedule) || schedule.length === 0) return 0;
  const byYear = new Map();
  for (const e of schedule) {
    if (e && Number.isFinite(e.year)) byYear.set(e.year, e);
  }
  if (byYear.size === 0) return 0;

  let hits = 0;
  for (const item of queue) {
    if (item?.type !== 'SCHEDULED_EARLY_WITHDRAWAL' || !item.data) continue;
    const d = new Date(item.date);
    if (d.getTime() <= nowMs) continue;                 // forward-effective only
    const year = d.getUTCFullYear();
    if (!byYear.has(year)) continue;                    // year not controlled → keep
    const entry  = byYear.get(year);
    const factor = Math.pow(1 + inflationRate, year - BRACKET_BASE_YEAR);
    if (Number.isFinite(entry.taxDeferredAmount)) item.data.taxDeferredAmount = entry.taxDeferredAmount * factor;
    if (Number.isFinite(entry.rothAmount))        item.data.rothAmount        = entry.rothAmount * factor;
    hits++;
  }
  return hits;
}

/**
 * US_EARLY_WITHDRAWAL toolset — the scheduled early-withdrawal "decant" lever
 * (design 45 Phase 1). Manually parameterized for now (no MPC); the cockpit
 * control (Phase 3) and joint MPC search (Phase 4) layer on top of this schedule.
 *
 * Capabilities: early-withdrawal
 * Depends on: US_RETIREMENT (the IRA/401k/Roth accounts + withdrawal-tax actions
 *             this chains), US_BROKERAGE (the default landing account), US_TAX.
 *
 * Emits one SCHEDULED_EARLY_WITHDRAWAL event per (scheduled year, owner). Each
 * carries the per-class GROSS amounts (nominal, compounded from the schedule's
 * real base-year USD) plus the resolved account state keys, so the reducer needs
 * no role lookups.
 *
 * Parameters:
 *   earlyWithdrawalEnabled  — master switch; if false nothing is scheduled
 *   earlyWithdrawalOwner    — 'primary' | 'spouse' | 'both' (amounts are per-owner)
 *   earlyWithdrawalMonth    — month (1–12) the withdrawal fires each scheduled year
 *   earlyWithdrawalDay      — day of month it fires
 *   earlyWithdrawalSchedule — [{ year, taxDeferredAmount, rothAmount, destinationKey? }]
 *                             amounts in REAL base-year (2025) USD; destinationKey
 *                             defaults to the owner's US brokerage.
 */
export const US_EARLY_WITHDRAWAL = {
  id: 'US_EARLY_WITHDRAWAL',
  capabilities: ['early-withdrawal'],
  dependencies: ['US_RETIREMENT', 'US_BROKERAGE', 'US_TAX'],

  types: {
    handlers: [EarlyWithdrawalPolicyHandler],
    reducers: [ScheduledEarlyWithdrawalApplyReducer],
    actions: [
      // The per-class withdrawal-tax actions this chains are declared by
      // US_RETIREMENT; only the apply action is owned here.
      { type: 'SCHEDULED_EARLY_WITHDRAWAL_APPLY', fields: {
        taxDeferredAmount: ValueType.currency('USD'),
        rothAmount:        ValueType.currency('USD'),
        residency:         ValueType.text(),
      } },
    ],
  },

  paramSchema(context) {
    return [
      {
        key: 'earlyWithdrawalEnabled', label: 'Early Withdrawal Enabled',
        type: 'Boolean', group: 'Early Withdrawal', mc: false, opt: false,
        defaultValue: false,
        description: 'Enable the scheduled early-withdrawal decant lever (design 45)',
      },
      {
        key: 'earlyWithdrawalOwner', label: 'Early Withdrawal Owner',
        type: 'Enum', group: 'Early Withdrawal', mc: false, opt: false,
        options: ['primary', 'spouse', 'both'],
        defaultValue: 'primary',
        description: "Whose accounts to draw: 'primary', 'spouse', or 'both' (amounts apply per owner)",
      },
      {
        key: 'earlyWithdrawalMonth', label: 'Early Withdrawal Month',
        type: 'Number', group: 'Early Withdrawal', mc: false, opt: false,
        defaultValue: 12,
        description: 'Month (1–12) the withdrawal fires each scheduled year',
      },
      {
        key: 'earlyWithdrawalDay', label: 'Early Withdrawal Day',
        type: 'Number', group: 'Early Withdrawal', mc: false, opt: false,
        defaultValue: 1,
        description: 'Day of month the withdrawal fires',
      },
      {
        // (B) drawdown-ordering variant (design 45 §7). Independent of the
        // scheduled decant (A) above: governs only the INVOLUNTARY replenishSavings
        // fallback once a real cash deficit appears.
        key: 'earlyWithdrawalBeforeBrokerage', label: 'Early Withdrawal Before Brokerage',
        type: 'Boolean', group: 'Early Withdrawal', mc: false, opt: false,
        defaultValue: false,
        description: 'When covering a spending shortfall, tap penalty early withdrawal BEFORE selling taxable brokerage (avoid realizing capital gains), rather than strictly last. Default off.',
      },
      {
        // Opt-in optimization window (design 45 Phase 3). When both years are set,
        // schedules() seeds a 0-amount tunable SCHEDULED_EARLY_WITHDRAWAL event for
        // each year in [start, end] so the MPC cockpit's EARLY_WITHDRAWAL lever has
        // events to re-target (snapshot rollouts can only tune EXISTING events).
        // null = no window → manual schedule only (no phantom events).
        key: 'earlyWithdrawalStartYear', label: 'Early Withdrawal Optimization Start Year',
        type: 'Number', group: 'Early Withdrawal', mc: false, opt: false,
        defaultValue: null,
        description: 'First year of the opt-in optimization window. Set with the end year to let the MPC cockpit tune/discover early withdrawals. null = no window (manual schedule only).',
      },
      {
        key: 'earlyWithdrawalEndYear', label: 'Early Withdrawal Optimization End Year',
        type: 'Number', group: 'Early Withdrawal', mc: false, opt: false,
        defaultValue: null,
        description: 'Last year of the opt-in optimization window. null = no window.',
      },
      {
        key: 'earlyWithdrawalSchedule', label: 'Early Withdrawal Schedule (per-year per-class amounts)',
        type: 'EarlyWithdrawalScheduleList', group: 'Early Withdrawal', mc: false, opt: false,
        controllable: true,
        defaultValue: [],
        description: 'Per-year decant schedule [{ year, taxDeferredAmount, rothAmount, destinationKey? }]. Amounts are REAL base-year (2025) USD GROSS, compounded by inflation to the year\'s nominal draw; routed NET (gross − 10% penalty) to destinationKey (default the owner\'s US brokerage). Years absent = no withdrawal.',
      },
    ];
  },

  state(context) {
    // (B) flag read by AccountService.replenishSavings — hold taxable brokerage
    // back from the penalty-free Phase 1 so the penalty early-withdrawal runs
    // first (design 45 §7). The scheduled decant (A) needs no state flag.
    return { earlyWithdrawalBeforeBrokerage: context.parameters?.earlyWithdrawalBeforeBrokerage === true };
  },

  schedules(context) {
    const p = context.parameters;
    if (!p.earlyWithdrawalEnabled) return [];

    const schedule  = Array.isArray(p.earlyWithdrawalSchedule) ? p.earlyWithdrawalSchedule : [];
    const startYear = Number.isFinite(p.earlyWithdrawalStartYear) ? p.earlyWithdrawalStartYear : null;
    const endYear   = Number.isFinite(p.earlyWithdrawalEndYear)   ? p.earlyWithdrawalEndYear   : null;
    const hasWindow = startYear != null && endYear != null && endYear >= startYear;
    if (schedule.length === 0 && !hasWindow) return [];

    const people   = context.people   ?? [];
    const accounts = context.accounts ?? [];
    const primary  = people[0];
    const spouse   = people[1];

    const owners = p.earlyWithdrawalOwner === 'both'
      ? [primary, spouse].filter(Boolean)
      : p.earlyWithdrawalOwner === 'spouse'
        ? [spouse].filter(Boolean)
        : [primary].filter(Boolean);

    const month = (p.earlyWithdrawalMonth ?? 12) - 1;
    const day   = p.earlyWithdrawalDay   ?? 1;
    const infl  = p.inflationRate ?? 0.03;

    const keyOf = (role, ownerId) => accounts.find(a => a.role === role && a.ownerId === ownerId)?.stateKey ?? null;

    // Real per-class amounts (and any destination override) by year from the
    // explicit schedule. The opt-in optimization window contributes additional
    // years at 0 amount — tunable placeholders for the MPC cockpit lever.
    const byYear = new Map();
    for (const entry of schedule) {
      if (!entry || !Number.isFinite(entry.year)) continue;
      byYear.set(entry.year, {
        tdReal:   Number.isFinite(entry.taxDeferredAmount) ? entry.taxDeferredAmount : 0,
        rothReal: Number.isFinite(entry.rothAmount)        ? entry.rothAmount        : 0,
        destinationKey: entry.destinationKey ?? null,
      });
    }
    const years = new Set(byYear.keys());
    if (hasWindow) for (let y = startYear; y <= endYear; y++) years.add(y);

    const events = [];
    for (const year of [...years].sort((a, b) => a - b)) {
      const entry    = byYear.get(year);
      const tdReal   = entry?.tdReal   ?? 0;
      const rothReal = entry?.rothReal ?? 0;
      const inWindow = hasWindow && year >= startYear && year <= endYear;
      // A pure-zero year outside the window is a manual skip-year; inside the window
      // it's a tunable placeholder, so still emit it (the handler no-ops at 0).
      if (tdReal <= 0 && rothReal <= 0 && !inWindow) continue;

      const factor = Math.pow(1 + infl, year - BRACKET_BASE_YEAR);
      for (const person of owners) {
        const destinationKey = entry?.destinationKey ?? keyOf(ACCOUNT_ROLES.US_STOCK, person.id);
        if (!destinationKey) continue;          // nowhere to land the cash → skip

        events.push(new OneOffEvent({
          name:  `Early Withdrawal (${person.name}, ${year})`,
          type:  'SCHEDULED_EARLY_WITHDRAWAL',
          date:  new Date(Date.UTC(year, month, day)),
          order: EARLY_WITHDRAWAL_ORDER,
          data: {
            taxDeferredAmount: tdReal   * factor,
            rothAmount:        rothReal * factor,
            iraKey:  keyOf(ACCOUNT_ROLES.IRA,  person.id),
            k401Key: keyOf(ACCOUNT_ROLES.K401, person.id),
            rothKey: keyOf(ACCOUNT_ROLES.ROTH, person.id),
            destinationKey,
            owner:   person.id,
          },
          enabled: true,
          color:   '#C2185B',
        }));
      }
    }
    return events;
  },

  handlers(context) {
    return [new EarlyWithdrawalPolicyHandler()];
  },

  reducers(context) {
    return [new ScheduledEarlyWithdrawalApplyReducer({ accountService: context.accountService })];
  },
};
