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
import { InheritHandler, InheritApplyReducer } from '../../finance/account-rules/inheritance-classes.js';

/**
 * INHERITANCE toolset — wires Bequest containers (design 63) into the balance
 * sheet via the seed-at-zero, fund-on-event mechanism (§5).
 *
 * Capabilities: inheritance
 * Depends on:
 *   - US_TAX     — US step-up basis + IRD ordinary-income classifiers (§6.1/§6.2)
 *   - AU_TAX     — AU inherited cost base + super death-benefit tax (§6.3/§6.4)
 *   - US_INCOME  — cash-destination resolution for lump-sum proceeds (§5)
 *
 * Contributes:
 *   - state()     — expands every Bequest into zero-valued state seeds (one per
 *                   inherited asset). A zero-valued record contributes 0 to net
 *                   worth and is ineligible for drawdown automatically (no new
 *                   gating code), so inherited assets are invisible until funded.
 *   - schedules() — one INHERIT one-off event per Bequest at its inheritance
 *                   date, carrying the baked per-asset funding descriptors.
 *   - handlers()  — InheritHandler (INHERIT → INHERIT_APPLY per asset).
 *   - reducers()  — InheritApplyReducer (funds each record + stamps basis).
 *
 * Phase 3 adds the INHERITED_RA_DISTRIBUTION forced-drawdown stream (§6.2);
 * Phase 4 adds AU super lump-sum tax (§6.4) + NE inheritance tax (§6.5).
 */
export const INHERITANCE = {
  id: 'INHERITANCE',
  capabilities: ['inheritance'],
  dependencies: ['US_TAX', 'AU_TAX', 'US_INCOME'],

  types: {
    handlers: [InheritHandler],
    reducers: [InheritApplyReducer],
    actions: [
      { type: 'INHERIT_APPLY', fields: {
        stateKey:       ValueType.text(),
        name:           ValueType.text(),
        category:       ValueType.text(),
        country:        ValueType.text(),
        inheritedValue: ValueType.number(),
        usCitizen:      ValueType.text(),
        auResident:     ValueType.text(),
      } },
    ],
  },

  paramSchema(context) {
    return [];
  },

  state(context) {
    const patches = {};
    const svc = context.bequestService;
    if (!svc) return patches;
    for (const bequest of (context.bequests ?? [])) {
      Object.assign(patches, svc.expand(bequest).seeds);
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
          bequestId:         bequest.id,
          heirId:            bequest.heirId ?? null,
          inheritanceDateMs,
          assets:            inherited,
        },
        enabled: true,
        color:   '#00838F',
      }));
    }
    return events;
  },

  handlers(context) {
    // Only wire the handler when at least one funded bequest exists (keeps the
    // no-bequest regression path byte-identical).
    const svc = context.bequestService;
    const hasFunded = (context.bequests ?? []).some(b =>
      b.inheritanceYear != null && (svc?.expand(b).inherited.length ?? 0) > 0);
    return hasFunded ? [new InheritHandler()] : [];
  },

  reducers(context) {
    const svc = context.bequestService;
    const hasFunded = (context.bequests ?? []).some(b =>
      b.inheritanceYear != null && (svc?.expand(b).inherited.length ?? 0) > 0);
    return hasFunded ? [new InheritApplyReducer()] : [];
  },
};
