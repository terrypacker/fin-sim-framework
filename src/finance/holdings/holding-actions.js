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
 * What KIND of value change a HOLDING_TRANSACT carries (design 94 §9.4).
 *
 * Design 93 §4 made the distinction impossible to leave implicit at the primitive layer —
 * `reprice` for a price move, `addValue` for new money — but the ACTION that reaches those
 * primitives had no way to say which it was. `_patchHolding` inferred it, by enumerating
 * its callers and concluding they were all price moves. That enumeration was true only
 * while equity was scalar: a reinvested dividend is new money, and the moment equity is
 * unitised (design 94 step 3) inferring "price" for it inflates the price of the units
 * already held instead of buying more.
 *
 * The defect conserves money exactly, so no golden moves and no invariant fires — design
 * 94 §9.5b measured it running under a spike, with a position holding the same 600 units
 * for a 44-year run that reinvested dividends into it every year, and all 5,505 tests
 * green. An inference that cannot be checked is the thing to remove; this is the
 * discriminator that removes it.
 *
 *   PRICE  the per-unit price moved; the count did not — appreciation, a rate mark,
 *          a TIPS accretion. The default, so every existing emitter is unchanged.
 *   UNITS  money bought more of the instrument at its prevailing price — a reinvested
 *          dividend or distribution.
 *
 * On a SCALAR holding the two are indistinguishable and both land on `marketValue`, which
 * is why adding this is behaviour-neutral until equity is unitised.
 */
export const VALUE_KIND = Object.freeze({
  PRICE: 'PRICE',
  UNITS: 'UNITS',
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
    description: 'Net change to a single holding\'s marketValue and costBasis (contribution, withdrawal, dividend reinvest, appreciation); valueKind says whether the move is a PRICE change or new money buying UNITS; cpiIndexRatioFactor also steps an inflation-linked bond\'s indexation.',
    fields:      {
      stateKey:            {},
      holdingId:           {},
      marketValueDelta:    {},
      costBasisDelta:      {},
      cpiIndexRatioFactor: {},
      // Declared because `TypeRegistry.pickPayload` copies only the fields named here —
      // an undeclared field is dropped from the journal silently, which is how payload
      // manifests drift away from the actions they describe (design 91).
      valueKind:           {},
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
 *
 * `valueKind` says which of design 93 §4's two primitives the delta means — see
 * `VALUE_KIND`. It is the emitter's statement about its own money, not something the
 * reducer may infer.
 */
export class HoldingTransactAction extends Action {
  static type        = 'HoldingTransactAction';
  static description = 'Holding net-change: marketValue and costBasis deltas on one holding.';

  /**
   * `cpiIndexRatioFactor` (design 93 §5b) is the ONE thing on this action that is not a
   * dollar delta, and it is here rather than in a separate action type because a TIPS
   * accretion is a single event: the principal indexes, the price follows it and the basis
   * steps up with it. Splitting them would let a replay apply two of the three.
   *
   * Null (the default) on every other path, which is every path but accretion, so no
   * existing payload gains a field.
   */
  constructor({ stateKey = null, holdingId = null, marketValueDelta = 0, costBasisDelta = 0,
                cpiIndexRatioFactor = null, valueKind = VALUE_KIND.PRICE, name = null } = {}) {
    super(HOLDING_ACTION_TYPES.HOLDING_TRANSACT, name ?? `Holding ${holdingId ?? '?'} transact`);
    this.stateKey         = stateKey;
    this.holdingId        = holdingId;
    this.marketValueDelta = marketValueDelta;
    this.costBasisDelta   = costBasisDelta;
    if (cpiIndexRatioFactor != null) this.cpiIndexRatioFactor = cpiIndexRatioFactor;
    // Stored only when it is NOT the default, for the same reason `cpiIndexRatioFactor`
    // is: an explicit 'PRICE' on every action would add a field to every journal payload
    // and every whole-state fixture in the repo, for no information. The reducer defaults
    // the same way, so an absent field and an explicit PRICE are one behaviour.
    if (valueKind !== VALUE_KIND.PRICE) this.valueKind = valueKind;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      stateKey:         this.stateKey,
      holdingId:        this.holdingId,
      marketValueDelta: this.marketValueDelta,
      costBasisDelta:   this.costBasisDelta,
      // Emitted only when set — an explicit null on every non-accretion action would put a
      // new field in every journal payload and every fixture (design 93 §5a's discipline).
      ...(this.cpiIndexRatioFactor == null ? {} : { cpiIndexRatioFactor: this.cpiIndexRatioFactor }),
      ...(this.valueKind == null ? {} : { valueKind: this.valueKind }),
    };
  }

  static fromJSON(d, _ctx) {
    const a = new this({
      stateKey:         d.stateKey,
      holdingId:        d.holdingId,
      marketValueDelta: d.marketValueDelta ?? 0,
      costBasisDelta:   d.costBasisDelta   ?? 0,
      cpiIndexRatioFactor: d.cpiIndexRatioFactor ?? null,
      valueKind:        d.valueKind ?? VALUE_KIND.PRICE,
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
