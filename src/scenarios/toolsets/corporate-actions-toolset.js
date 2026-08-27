/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { OneOffEvent } from '../../simulation-framework/events/one-off-event.js';
import { ValueType }   from '../../simulation-framework/type-registry.js';
import {
  CorporateActionHandler, CorporateActionApplyReducer,
} from '../../finance/holdings/corporate-action-classes.js';
import { normalizeCorporateAction } from '../../finance/holdings/corporate-action.js';

/**
 * CORPORATE_ACTIONS toolset — design 94 §7, step 8.
 *
 * Capabilities: corporate-actions
 * Depends on: US_TAX (a merger's boot and a return of capital in excess of basis both chain
 *   `STOCK_WITHDRAWAL_TAX`, which the US tax module assesses).
 *
 * ─── it authors nothing unless the scenario does ────────────────────────────────────
 *
 * `schedules()`, `handlers()` and `reducers()` all return `[]` for a scenario with no
 * `corporateActions`, which is every scenario in the repo today. That is not politeness:
 * design 94 §12's **F5** measured that the event queue's comparator is not a total order,
 * so ADDING ANY EVENT re-resolves ties among unrelated events elsewhere — 560 fields across
 * eleven goldens, worst \$391,453. Until F5 has its own design, a toolset that scheduled an
 * event unconditionally would re-gold the repo for a feature nobody had switched on.
 *
 * ─── the authored shape ─────────────────────────────────────────────────────────────
 *
 * ```js
 * cfg.corporateActions = [
 *   { kind: 'SPLIT',    date: '2030-06-01', securityId: 'sec-acme', ratio: 2 },
 *   { kind: 'RENAME',   date: '2031-01-15', securityId: 'sec-acme', symbol: 'ACME2' },
 *   { kind: 'SPIN_OFF', date: '2032-03-01', securityId: 'sec-acme', fmvFraction: 0.05,
 *     unitsPerShare: 0.5, newSecurity: { id: 'sec-spinco', symbol: 'SPN', rateKey: 'EQUITY_US' } },
 *   { kind: 'MERGER',   date: '2033-05-01', securityId: 'sec-spinco', cashFraction: 0.2,
 *     exchangeRatio: 0.8, acquirerSecurityId: 'sec-acme' },
 *   { kind: 'RETURN_OF_CAPITAL', date: '2034-02-01', securityId: 'sec-acme', fmvFraction: 0.03 },
 * ];
 * ```
 *
 * Sizes are FRACTIONS of the position's market value, which is both what a corporate-action
 * notice publishes and what the two basis rules ask for — §1.358-2(a)(2)(iv)'s "in
 * proportion to their fair market values" and s125-80(3)'s proportion "having regard to the
 * market values". `corporate-action.js`'s header has the rest of the reasoning.
 *
 * Malformed entries THROW at compile time rather than being skipped. A corporate action has
 * no default, so one silently dropped is a run that completes having modelled something the
 * author did not write.
 */
export const CORPORATE_ACTIONS = {
  id: 'CORPORATE_ACTIONS',
  capabilities: ['corporate-actions'],
  dependencies: ['US_TAX'],

  types: {
    handlers: [CorporateActionHandler],
    reducers: [CorporateActionApplyReducer],
    actions: [
      // `spec` is the whole authored action, carried as `any` on purpose: its shape depends
      // on `kind`, and five per-kind declarations would put five near-identical manifests in
      // the journal for one event family. `kind` and `securityId` are hoisted out of it so a
      // report can group and filter without reaching into an opaque blob.
      { type: 'CORPORATE_ACTION_APPLY',
        fields: {
          kind:       ValueType.text(),
          securityId: ValueType.text(),
          stateKeys:  ValueType.any(),
          residency:  ValueType.text(),
          spec:       ValueType.any(),
        } },
    ],
  },

  paramSchema(_context) { return []; },
  state(_context)       { return {}; },

  schedules(context) {
    return _authored(context).map((a, i) => new OneOffEvent({
      name:    `${a.kind} — ${a.securityId}`,
      type:    'CORPORATE_ACTION',
      date:    new Date(a.date),
      data:    { action: a },
      enabled: a.enabled !== false,
      color:   '#5E35B1',
      // Ties on a date are resolved by `order` and then by array position (design 94 F5),
      // so authored actions at least keep the order they were WRITTEN in relative to each
      // other — a split and a spin-off on one day are not commutative.
      order:   i,
    }));
  },

  handlers(context) {
    return _authored(context).length ? [new CorporateActionHandler()] : [];
  },

  reducers(context) {
    return _authored(context).length ? [new CorporateActionApplyReducer()] : [];
  },
};

/** Validated, in authored order. Throws on a malformed entry — see the header. */
function _authored(context) {
  const list = context?.corporateActions;
  if (!Array.isArray(list) || list.length === 0) return [];
  return list.map(normalizeCorporateAction);
}
