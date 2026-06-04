/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Action } from '../../simulation-framework/actions.js';

/**
 * HOLDING_* action type discriminators (design 25 §6.1).
 * The HOLDING action family covers every mutation to account.holdings.
 */
export const HOLDING_ACTION_TYPES = Object.freeze({
  HOLDING_TRANSACT:    'HOLDING_TRANSACT',
  HOLDING_REVALUE:     'HOLDING_REVALUE',
  HOLDING_SET_BASIS:   'HOLDING_SET_BASIS',
  HOLDING_SPLIT:       'HOLDING_SPLIT',
  HOLDING_RETITLE:     'HOLDING_RETITLE',
});

/**
 * TypeRegistry ActionTypeEntries for the HOLDING family.
 * Registered via TypeRegistry.registerActionType so the workbench's action-
 * detail panel renders payloads correctly and the strict-mode payload picker
 * accepts these types.
 */
export const HOLDING_ACTION_ENTRIES = Object.freeze([
  {
    type:        HOLDING_ACTION_TYPES.HOLDING_TRANSACT,
    family:      'HOLDING',
    cc:          null,
    description: 'Net change to a single holding\'s marketValue and costBasis (contribution, withdrawal, dividend reinvest, appreciation).',
    fields:      {
      stateKey:         {},
      holdingId:        {},
      marketValueDelta: {},
      costBasisDelta:   {},
    },
  },
  {
    type:        HOLDING_ACTION_TYPES.HOLDING_REVALUE,
    family:      'HOLDING',
    cc:          null,
    description: 'Mark-to-market: targets a single holdingId or every holding under rateKey; applies multiplier OR adds priceDelta.',
    fields:      {
      stateKey:    {},
      holdingId:   {},
      rateKey:     {},
      multiplier:  {},
      priceDelta:  {},
    },
  },
  {
    type:        HOLDING_ACTION_TYPES.HOLDING_SET_BASIS,
    family:      'HOLDING',
    cc:          null,
    description: 'Explicit costBasis correction (rollover step-up, residency reset, manual override).',
    fields:      {
      stateKey:  {},
      holdingId: {},
      costBasis: {},
    },
  },
  {
    type:        HOLDING_ACTION_TYPES.HOLDING_SPLIT,
    family:      'HOLDING',
    cc:          null,
    description: 'Split one holding into N. Used by toolset bootstrap (60/40 split) and rebalance handlers.',
    fields:      {
      stateKey:  {},
      holdingId: {},
      splits:    {},
    },
  },
  {
    type:        HOLDING_ACTION_TYPES.HOLDING_RETITLE,
    family:      'HOLDING',
    cc:          null,
    description: 'Change holding metadata (allocation, rateKey, label) without moving value.',
    fields:      {
      stateKey:   {},
      holdingId:  {},
      allocation: {},
      rateKey:    {},
      label:      {},
    },
  },
]);

// ─── Action classes ────────────────────────────────────────────────────────────

/**
 * Net change to a single Holding's marketValue and/or costBasis.
 *
 * marketValueDelta + costBasisDelta semantics:
 *   - Contribution:        delta = +amount, +amount (basis matches deposit)
 *   - Earnings (unrealized): delta = +amount, 0   (appreciation doesn't add to basis)
 *   - Dividend cash payout:  delta = 0, 0          (cash flows elsewhere; no holding move)
 *   - Withdrawal:           delta = -amount, -consumedBasis
 */
export class HoldingTransactAction extends Action {
  static type        = 'HoldingTransactAction';
  static description = 'Holding net-change: marketValue and costBasis deltas on one holding.';

  constructor({ stateKey = null, holdingId = null, marketValueDelta = 0, costBasisDelta = 0, name = null } = {}) {
    super(HOLDING_ACTION_TYPES.HOLDING_TRANSACT, name ?? `Holding ${holdingId ?? '?'} transact`);
    this.stateKey         = stateKey;
    this.holdingId        = holdingId;
    this.marketValueDelta = marketValueDelta;
    this.costBasisDelta   = costBasisDelta;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      stateKey:         this.stateKey,
      holdingId:        this.holdingId,
      marketValueDelta: this.marketValueDelta,
      costBasisDelta:   this.costBasisDelta,
    };
  }

  static fromJSON(d, _ctx) {
    const a = new this({
      stateKey:         d.stateKey,
      holdingId:        d.holdingId,
      marketValueDelta: d.marketValueDelta ?? 0,
      costBasisDelta:   d.costBasisDelta   ?? 0,
      name:             d.name,
    });
    a.id = d.id;
    return a;
  }
}

/**
 * Mark-to-market revalue. Exactly one of multiplier / priceDelta is supplied:
 *   - multiplier: applies marketValue *= (1 + multiplier) for matching holdings
 *   - priceDelta: adds priceDelta to marketValue
 *
 * Targeting: if holdingId is set, exactly that holding. Otherwise rateKey
 * matches every holding under that rateKey.
 */
export class HoldingRevalueAction extends Action {
  static type        = 'HoldingRevalueAction';
  static description = 'Mark-to-market revalue by holdingId or rateKey: multiplier or priceDelta.';

  constructor({ stateKey = null, holdingId = null, rateKey = null, multiplier = null, priceDelta = null, name = null } = {}) {
    super(HOLDING_ACTION_TYPES.HOLDING_REVALUE, name ?? `Holding revalue ${holdingId ?? rateKey ?? ''}`);
    this.stateKey   = stateKey;
    this.holdingId  = holdingId;
    this.rateKey    = rateKey;
    this.multiplier = multiplier;
    this.priceDelta = priceDelta;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      stateKey:   this.stateKey,
      holdingId:  this.holdingId,
      rateKey:    this.rateKey,
      multiplier: this.multiplier,
      priceDelta: this.priceDelta,
    };
  }

  static fromJSON(d, _ctx) {
    const a = new this({
      stateKey:   d.stateKey,
      holdingId:  d.holdingId,
      rateKey:    d.rateKey,
      multiplier: d.multiplier ?? null,
      priceDelta: d.priceDelta ?? null,
      name:       d.name,
    });
    a.id = d.id;
    return a;
  }
}

/** Explicit costBasis overwrite. No balance impact. */
export class HoldingSetBasisAction extends Action {
  static type        = 'HoldingSetBasisAction';
  static description = 'Overwrite a holding\'s costBasis (rollover step-up, residency reset, etc.).';

  constructor({ stateKey = null, holdingId = null, costBasis = 0, name = null } = {}) {
    super(HOLDING_ACTION_TYPES.HOLDING_SET_BASIS, name ?? `Holding ${holdingId ?? '?'} set basis`);
    this.stateKey  = stateKey;
    this.holdingId = holdingId;
    this.costBasis = costBasis;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      stateKey:  this.stateKey,
      holdingId: this.holdingId,
      costBasis: this.costBasis,
    };
  }

  static fromJSON(d, _ctx) {
    const a = new this({
      stateKey:  d.stateKey,
      holdingId: d.holdingId,
      costBasis: d.costBasis ?? 0,
      name:      d.name,
    });
    a.id = d.id;
    return a;
  }
}

/**
 * Split one holding into N. Each split entry is a delta off the source —
 * marketValueDelta values sum to the original holding's marketValue (positive
 * carry-over) so the §4.4 invariant is preserved.
 *
 * splits: [{ marketValueDelta, costBasisDelta, allocation?, rateKey?, label? }, ...]
 */
export class HoldingSplitAction extends Action {
  static type        = 'HoldingSplitAction';
  static description = 'Split one holding into N child holdings whose deltas sum to the source.';

  constructor({ stateKey = null, holdingId = null, splits = [], name = null } = {}) {
    super(HOLDING_ACTION_TYPES.HOLDING_SPLIT, name ?? `Holding ${holdingId ?? '?'} split`);
    this.stateKey  = stateKey;
    this.holdingId = holdingId;
    this.splits    = splits;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      stateKey:  this.stateKey,
      holdingId: this.holdingId,
      splits:    this.splits,
    };
  }

  static fromJSON(d, _ctx) {
    const a = new this({
      stateKey:  d.stateKey,
      holdingId: d.holdingId,
      splits:    d.splits ?? [],
      name:      d.name,
    });
    a.id = d.id;
    return a;
  }
}

/** Change holding metadata (allocation, rateKey, label) without moving value. */
export class HoldingRetitleAction extends Action {
  static type        = 'HoldingRetitleAction';
  static description = 'Patch holding metadata fields (allocation, rateKey, label).';

  constructor({ stateKey = null, holdingId = null, allocation = null, rateKey = null, label = null, name = null } = {}) {
    super(HOLDING_ACTION_TYPES.HOLDING_RETITLE, name ?? `Holding ${holdingId ?? '?'} retitle`);
    this.stateKey   = stateKey;
    this.holdingId  = holdingId;
    this.allocation = allocation;
    this.rateKey    = rateKey;
    this.label      = label;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      stateKey:   this.stateKey,
      holdingId:  this.holdingId,
      allocation: this.allocation,
      rateKey:    this.rateKey,
      label:      this.label,
    };
  }

  static fromJSON(d, _ctx) {
    const a = new this({
      stateKey:   d.stateKey,
      holdingId:  d.holdingId,
      allocation: d.allocation,
      rateKey:    d.rateKey,
      label:      d.label,
      name:       d.name,
    });
    a.id = d.id;
    return a;
  }
}

export const HOLDING_ACTION_CLASSES = {
  HoldingTransactAction,
  HoldingRevalueAction,
  HoldingSetBasisAction,
  HoldingSplitAction,
  HoldingRetitleAction,
};

/**
 * Register every HOLDING_* action class + action-type entry with the given
 * TypeRegistry. Idempotent — safe to call from ServiceRegistry bootstrap and
 * from ScenarioSerializer._populateRegistry.
 */
export function registerHoldingActionTypes(typeRegistry) {
  if (!typeRegistry) return;
  for (const ctor of Object.values(HOLDING_ACTION_CLASSES)) {
    typeRegistry.registerClass(ctor);
  }
  for (const entry of HOLDING_ACTION_ENTRIES) {
    typeRegistry.registerActionType(entry);
  }
}
