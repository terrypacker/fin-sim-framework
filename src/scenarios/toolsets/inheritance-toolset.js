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
import { EventSeries } from '../../simulation-framework/events/event-series.js';
import { ValueType }   from '../../simulation-framework/type-registry.js';
import {
  InheritHandler, InheritApplyReducer, InheritanceNeTaxApplyReducer,
  InheritedRaDistributionHandler, InheritedRaDistributionApplyReducer,
} from '../../finance/account-rules/inheritance-classes.js';
import { inheritedAssetMeta } from '../../finance/services/bequest-service.js';
import { INHERITED_RA_WINDOW } from '../../finance/account-rules/inherited-ra-distribution-strategy.js';
import { ACCOUNT_ROLES, INHERITED_RETIREMENT_ROLES } from '../../finance/state/account-roles.js';

const RA_DISTRIBUTION_TYPE = 'INHERITED_RA_DISTRIBUTION';

/** Handler-side defaults for the per-account SECURE-drawdown knobs (design 63 §6.2). */
const DEFAULT_STRATEGY     = 'bracketFill';
const DEFAULT_FILL_CEILING = 100_000;   // real base-year USD
const DEFAULT_LUMP_YEAR    = 0;
const DEFAULT_WEIGHT       = 1 / INHERITED_RA_WINDOW;

/**
 * Collect the inherited pre-tax/Roth RA accounts across all active bequests (not
 * super). The SECURE-drawdown knobs (strategy / ceiling / lump-year / weights) are
 * read PER ACCOUNT from the inherited-asset descriptor (design 63 §12.3 — the
 * design-55 generated params `raAsset.<stateKey>.<field>` cascade onto it), with
 * blanks falling back to the defaults.
 */
function _inheritedRaAccounts(context) {
  const out  = [];
  const seen = new Set();
  // Build one stream row from an RA descriptor (`a`) whose SECURE-drawdown knobs have
  // been cascaded onto it — identical shape whether `a` is an inline bequest asset or
  // a promoted `cfg.accounts` record. `b` is its (active) owning bequest.
  const row = (a, isRoth, b) => {
    if (seen.has(a.stateKey)) return;   // never count an RA twice
    seen.add(a.stateKey);
    out.push({
      stateKey:        a.stateKey,
      isRoth,
      inheritanceYear: b.inheritanceYear,
      heirId:          b.heirId ?? null,
      strategyId:      a.distributionMode ?? DEFAULT_STRATEGY,
      fillCeilingReal: a.fillCeiling ?? DEFAULT_FILL_CEILING,
      lumpYear:        a.lumpYear ?? DEFAULT_LUMP_YEAR,
      weights:         Array.isArray(a.weights) && a.weights.length === INHERITED_RA_WINDOW
                         ? a.weights
                         : Array.from({ length: INHERITED_RA_WINDOW }, () => DEFAULT_WEIGHT),
    });
  };

  // Inline retirement assets — inert-bequest fallback, or any RA promotion did not run.
  for (const b of (context.bequests ?? [])) {
    if (b.inheritanceYear == null) continue;
    for (const a of (b.assets ?? [])) {
      const meta = inheritedAssetMeta(a.__type);
      if (!meta?.isRetirement || meta.isSuper || !a.stateKey) continue;
      row(a, meta.isRoth, b);
    }
  }

  // PROMOTED inherited RAs (design 63 §15, P8): they live in `context.accounts` under a
  // dedicated `inherited-*` role, linked to their (active) bequest by `bequestId ===
  // bequest.stateKey`. Discovering them here is what keeps the SECURE stream intact after
  // promotion hoists the RA out of `bequest.assets` (§15.1 Coupling 2).
  const activeByKey = new Map();
  for (const b of (context.bequests ?? [])) {
    if (b.inheritanceYear != null) activeByKey.set(b.stateKey ?? b.id, b);
  }
  for (const a of (context.accounts ?? [])) {
    if (!a.inherited || !a.stateKey || !INHERITED_RETIREMENT_ROLES.has(a.role)) continue;
    const b = activeByKey.get(a.bequestId);
    if (b) row(a, a.role === ACCOUNT_ROLES.INHERITED_ROTH, b);
  }
  return out;
}

/**
 * INHERITANCE toolset — wires Bequest containers (design 63) into the balance
 * sheet via seed-at-zero, fund-on-event (§5), and arms the SECURE 10-year
 * inherited-RA drawdown lever (§6.2).
 *
 * Capabilities: inheritance
 * Depends on: US_TAX (step-up + IRD classifiers), AU_TAX (inherited base + super
 *   death tax), US_INCOME (cash-destination resolution).
 *
 * Contributes:
 *   - state()     — zero-value seeds (one per inherited asset).
 *   - schedules() — one INHERIT one-off per Bequest at its inheritance date, plus
 *                   a year-end INHERITED_RA_DISTRIBUTION series (order 50: after
 *                   the year's income/RMDs/drawdowns, before the tax settle at 100)
 *                   when any inherited RA exists.
 *   - handlers()  — InheritHandler + InheritedRaDistributionHandler.
 *   - reducers()  — InheritApplyReducer + InheritedRaDistributionApplyReducer.
 *   - paramSchema()— inherited-RA distribution strategy + `::`-flat tunable params.
 */
export const INHERITANCE = {
  id: 'INHERITANCE',
  capabilities: ['inheritance'],
  dependencies: ['US_TAX', 'AU_TAX', 'US_INCOME'],

  types: {
    handlers: [InheritHandler, InheritedRaDistributionHandler],
    reducers: [InheritApplyReducer, InheritanceNeTaxApplyReducer, InheritedRaDistributionApplyReducer],
    actions: [
      { type: 'SUPER_DEATH_BENEFIT_TAX', fields: { amount: ValueType.currency('AUD') } },
      { type: 'NE_INHERITANCE_TAX',      fields: { amount: ValueType.currency('USD') } },
      { type: 'INHERIT_APPLY', fields: {
        stateKey:       ValueType.text(),
        name:           ValueType.text(),
        category:       ValueType.text(),
        country:        ValueType.text(),
        inheritedValue: ValueType.number(),
        usCitizen:      ValueType.text(),
        auResident:     ValueType.text(),
      } },
      { type: 'INHERITED_RA_DISTRIBUTION_APPLY', fields: {
        amount:    ValueType.currency('USD'),
        stateKey:  ValueType.text(),
        isRoth:    ValueType.text(),
        residency: ValueType.text(),
      } },
      { type: 'INHERITED_RA_DISTRIBUTION_TAX', fields: {
        amount:    ValueType.currency('USD'),
        residency: ValueType.text(),
        stateKey:  ValueType.text(),
      } },
    ],
  },

  // All inheritance params are GENERATED per-record from Bequest records + their
  // inherited-RA assets (design 63 §12.3 / design 55 template path), so they exist
  // only when an inheritance does and each carries a node (linked, design 32). See
  // BEQUEST_PARAM_TEMPLATE / INHERITED_RA_PARAM_TEMPLATE. No static params here.
  paramSchema(context) {
    return [];
  },

  state(context) {
    const patches = {};
    const svc = context.bequestService;
    if (!svc) return patches;
    // Only ACTIVE bequests (a set inheritanceYear) seed state. An inert example
    // bequest (inheritanceYear null) contributes nothing, so the default scenario
    // stays byte-identical until the user sets a year — the design-63 §9 guard.
    const active = (context.bequests ?? []).filter(b => b.inheritanceYear != null);
    for (const bequest of active) {
      Object.assign(patches, svc.expand(bequest).seeds);
    }
    // Death-tax reporting buckets (design 63 §6.4/§6.5). Reset yearly via YTD_FIELDS.
    if (active.length > 0) {
      patches.neInheritanceTaxYTD = 0;
      patches.auSuperDeathTaxYTD  = 0;
    }
    return patches;
  },

  schedules(context) {
    const svc = context.bequestService;
    if (!svc) return [];
    const events = [];
    for (const bequest of (context.bequests ?? [])) {
      if (bequest.inheritanceYear == null) continue;
      const { inherited, inheritanceDateMs } = svc.expand(bequest);
      if (!inherited.length || inheritanceDateMs == null) continue;
      events.push(new OneOffEvent({
        name:    `Inherit ${bequest.name || bequest.decedentName || bequest.id}`,
        type:    'INHERIT',
        date:    new Date(inheritanceDateMs),
        data:    {
          bequestId:      bequest.id,
          heirId:         bequest.heirId ?? null,
          relationship:   bequest.relationship ?? 'immediate',
          decedentState:  bequest.decedentState ?? null,
          paidViaEstate:  bequest.paidViaEstate ?? false,
          inheritanceDateMs,
          assets:         inherited,
        },
        enabled: true,
        color:   '#00838F',
      }));
    }
    // One shared year-end distribution stream if any inherited RA exists. Order 50:
    // after the year's income / RMDs / design-58 drawdowns / Roth conversions
    // (order 0) so usOrdinaryIncomeYTD is complete, but before the tax settle (100).
    if (_inheritedRaAccounts(context).length > 0) {
      events.push(new EventSeries({
        name:     'Inherited RA Distribution',
        type:     RA_DISTRIBUTION_TYPE,
        interval: 'year-end',
        order:    50,
        enabled:  true,
        color:    '#00695C',
      }));
    }
    return events;
  },

  handlers(context) {
    const svc = context.bequestService;
    const handlers = [];
    const hasFunded = (context.bequests ?? []).some(b =>
      b.inheritanceYear != null && (svc?.expand(b).inherited.length ?? 0) > 0);
    if (hasFunded) handlers.push(new InheritHandler());

    const accounts = _inheritedRaAccounts(context);
    const distEvent = context.schedulesById?.[RA_DISTRIBUTION_TYPE];
    if (accounts.length > 0 && distEvent) {
      const h = new InheritedRaDistributionHandler({ accounts });
      h.handledEvents = [distEvent];
      handlers.push(h);
    }
    return handlers;
  },

  reducers(context) {
    const svc = context.bequestService;
    const reducers = [];
    const hasFunded = (context.bequests ?? []).some(b =>
      b.inheritanceYear != null && (svc?.expand(b).inherited.length ?? 0) > 0);
    if (hasFunded) {
      reducers.push(new InheritApplyReducer({
        accountService: context.accountService,
        stateRegistry:  context.stateRegistry,
      }));
      reducers.push(new InheritanceNeTaxApplyReducer({
        accountService: context.accountService,
        stateRegistry:  context.stateRegistry,
      }));
    }

    if (_inheritedRaAccounts(context).length > 0) {
      reducers.push(new InheritedRaDistributionApplyReducer({
        accountService: context.accountService,
        stateRegistry:  context.stateRegistry,
      }));
    }
    return reducers;
  },
};
