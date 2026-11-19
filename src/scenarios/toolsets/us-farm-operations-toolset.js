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
import { normalizeFarm } from '../../finance/farm/farm-records.js';
import { compileFarmEvents, contractedByPool } from '../../finance/farm/farm-postings.js';
import {
  FarmPostHandler, FarmGrainInHandler, FarmGrainOutHandler, FarmPaymentHandler,
  FarmLedgerReducer, FARM_ACTION_TYPES,
} from '../../finance/farm/farm-classes.js';

/**
 * US_FARM_OPERATIONS toolset (design 134 §4–§5): the farm calendar, its cost and revenue
 * flows, grain pools and the job-cost ledger.
 *
 * Capabilities: farm-operations
 * Depends on: nothing. A farm scenario has no persons and no accounts (design 134 §9, the
 * phase 1 spike). It does not touch household state, so it is inert in a household scenario
 * that does not author `cfg.farm`: every list below is empty and nothing is scheduled, which
 * keeps the household goldens byte-identical.
 *
 * The records are `cfg.farm` (`farm-records.js`); the loader validates them before compile
 * and throws on any problem.
 */
export const US_FARM_OPERATIONS = {
  id: 'US_FARM_OPERATIONS',
  capabilities: ['farm-operations'],
  dependencies: [],

  types: {
    handlers: [FarmPostHandler, FarmGrainInHandler, FarmGrainOutHandler, FarmPaymentHandler],
    reducers: [FarmLedgerReducer],
    actions:  FARM_ACTION_TYPES,
  },

  paramSchema(_context) { return []; },

  state(context) {
    const farm = _farm(context);
    if (!farm) return {};
    return {
      farm: {
        cropYear:    farm.season.cropYear,
        pools:       {},
        contracted:  contractedByPool(farm),
        receivables: {},
        cash:        Object.fromEntries(farm.operators.map(o => [o.id, 0])),
      },
    };
  },

  schedules(context) {
    const farm = _farm(context);
    if (!farm) return [];
    return compileFarmEvents(farm).map(e => new OneOffEvent({
      name:  e.name,
      type:  e.type,
      date:  new Date(`${e.date}T00:00:00.000Z`),
      order: e.order,
      data:  e.data,
      color: '#6D8B3A',
    }));
  },

  handlers(context) {
    if (!_farm(context)) return [];
    return [new FarmPostHandler(), new FarmGrainInHandler(), new FarmGrainOutHandler(), new FarmPaymentHandler()];
  },

  reducers(context) {
    return _farm(context) ? [new FarmLedgerReducer()] : [];
  },
};

function _farm(context) {
  const raw = context?.farm;
  if (!raw || !Array.isArray(raw.seasons) || raw.seasons.length === 0) return null;
  return normalizeFarm(raw);
}
