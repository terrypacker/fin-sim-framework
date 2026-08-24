/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY } from '../../simulation-framework/reducers.js';
import { HOLDING_ACTION_TYPES } from './holding-actions.js';
import { applyCashBasisInvariant } from './holding.js';

/**
 * Sum holdings → balance with currency-precision rounding.
 * Currency precision defaults to 2 decimal places (USD / AUD); accounts
 * whose currency carries an explicit precision override could supply it.
 */
function _syncBalance(account) {
  if (!account || !Array.isArray(account.holdings)) return account;
  // GHOST PAR. `faceValue` is a parallel field, and not every path that moves value out
  // of a holding maintains it — a cross-border transfer that sweeps an account leaves its
  // bond lots at zero market value still carrying full par. Par is authoritative for
  // BOTH pull-to-par and redemption, so a zero-value lot with live par is money waiting to
  // be minted. Normalizing it here catches every mutation path at once, because this runs
  // after all of them. Only the exactly-empty case is touched: a lot with any units left
  // keeps whatever par it has, so a legitimate deep discount is not "repaired" away.
  let holdings = account.holdings;
  if (holdings.some(h => h?.faceValue > 0 && (h?.marketValue ?? 0) <= 0.005)) {
    holdings = holdings.map(h =>
      (h?.faceValue > 0 && (h?.marketValue ?? 0) <= 0.005) ? { ...h, faceValue: 0 } : h);
  }
  const sum = holdings.reduce((s, h) => s + (h?.marketValue ?? 0), 0);
  return { ...account, holdings, balance: +sum.toFixed(2) };
}

/**
 * Shallow-clone a holding and apply patch.
 *
 * The single write choke point for HoldingTransact / Revalue / SetBasis / Retitle, so
 * it is where the CASH basis invariant (design 87 §11 — `costBasis === marketValue`)
 * is re-asserted. Enforcing it here rather than per-reducer means a new reducer cannot
 * reopen the gap, and it reads the PATCHED allocation, so a Retitle into CASH heals the
 * lot on the way in.
 */
function _patchHolding(holding, patch) {
  return applyCashBasisInvariant({ ...holding, ...patch });
}

/** Replace one holding by id; returns a new array. Unmatched id → original array. */
function _replaceHolding(holdings, id, replacement) {
  let changed = false;
  const next = holdings.map(h => {
    if (h?.id === id) { changed = true; return replacement; }
    return h;
  });
  return changed ? next : holdings;
}

/** Replace one holding by id with N replacements. */
function _splitHolding(holdings, id, replacements) {
  const out = [];
  let found = false;
  for (const h of holdings) {
    if (h?.id === id) {
      found = true;
      out.push(...replacements);
    } else {
      out.push(h);
    }
  }
  return found ? out : holdings;
}

/**
 * HoldingTransactReducer — applies marketValueDelta + costBasisDelta to one
 * holding, then re-syncs account.balance to Σ marketValue.
 */
export class HoldingTransactReducer extends Reducer {
  static description = 'Adds marketValueDelta to holding.marketValue and costBasisDelta to holding.costBasis; syncs account.balance.';
  static type        = 'HoldingTransactReducer';

  constructor() {
    super('Holding Transact', PRIORITY.POSITION_UPDATE);
    this.reducedActionTypes = [HOLDING_ACTION_TYPES.HOLDING_TRANSACT];
  }

  reduce(state, action) {
    const { stateKey, holdingId, marketValueDelta = 0, costBasisDelta = 0 } = action;
    const account = state?.[stateKey];
    if (!account || !Array.isArray(account.holdings)) return this.newState(state);

    const target = account.holdings.find(h => h?.id === holdingId);
    if (!target) return this.newState(state);

    // Floor both at zero: a withdrawal delta must never drive a position (or its
    // basis) negative. account.balance is re-synced to Σ marketValue below, so
    // the §4.4 invariant is preserved after the floor.
    const patched = _patchHolding(target, {
      marketValue: Math.max(0, (target.marketValue ?? 0) + marketValueDelta),
      costBasis:   Math.max(0, (target.costBasis   ?? 0) + costBasisDelta),
    });
    const nextHoldings = _replaceHolding(account.holdings, holdingId, patched);
    const nextAccount  = _syncBalance({ ...account, holdings: nextHoldings });
    return this.newState(state, { [stateKey]: nextAccount });
  }
}

/**
 * HoldingRevalueReducer — applies a multiplier or priceDelta to one holding
 * (by holdingId) or every holding under a rateKey, then re-syncs balance.
 *
 * multiplier semantics: marketValue *= (1 + multiplier) — matches design 21's
 * RegimeApply convention where multiplier -0.40 = "drop 40%".
 */
export class HoldingRevalueReducer extends Reducer {
  static description = 'Marks holdings to market by holdingId or rateKey; multiplier OR priceDelta; syncs account.balance.';
  static type        = 'HoldingRevalueReducer';

  constructor() {
    super('Holding Revalue', PRIORITY.POSITION_UPDATE);
    this.reducedActionTypes = [HOLDING_ACTION_TYPES.HOLDING_REVALUE];
  }

  reduce(state, action) {
    const { stateKey, holdingId, rateKey, multiplier, priceDelta } = action;
    const account = state?.[stateKey];
    if (!account || !Array.isArray(account.holdings)) return this.newState(state);

    const applyRevalue = (mv) => {
      if (multiplier != null) return +(mv * (1 + multiplier)).toFixed(2);
      if (priceDelta != null) return +(mv + priceDelta).toFixed(2);
      return mv;
    };

    let touched = false;
    const nextHoldings = account.holdings.map(h => {
      if (!h) return h;
      const match = holdingId != null ? h.id === holdingId : h.rateKey === rateKey;
      if (!match) return h;
      touched = true;
      return _patchHolding(h, { marketValue: Math.max(0, applyRevalue(h.marketValue ?? 0)) });
    });
    if (!touched) return this.newState(state);

    const nextAccount = _syncBalance({ ...account, holdings: nextHoldings });
    return this.newState(state, { [stateKey]: nextAccount });
  }
}

/**
 * HoldingSetBasisReducer — overwrites costBasis on one holding.
 * No balance impact; runs at COST_BASIS so it lands after position updates.
 */
export class HoldingSetBasisReducer extends Reducer {
  static description = 'Overwrites holding.costBasis. No balance impact.';
  static type        = 'HoldingSetBasisReducer';

  constructor() {
    super('Holding Set Basis', PRIORITY.COST_BASIS);
    this.reducedActionTypes = [HOLDING_ACTION_TYPES.HOLDING_SET_BASIS];
  }

  reduce(state, action) {
    const { stateKey, holdingId, costBasis = 0 } = action;
    const account = state?.[stateKey];
    if (!account || !Array.isArray(account.holdings)) return this.newState(state);

    const target = account.holdings.find(h => h?.id === holdingId);
    if (!target) return this.newState(state);

    const patched      = _patchHolding(target, { costBasis });
    const nextHoldings = _replaceHolding(account.holdings, holdingId, patched);
    return this.newState(state, { [stateKey]: { ...account, holdings: nextHoldings } });
  }
}

/**
 * HoldingSplitReducer — replaces one holding with N. Each split entry carries
 * deltas off the source; allocation/rateKey/label inherit from the source
 * when absent. The new holdings re-use the source id namespace (caller is
 * responsible for assigning ids).
 *
 * Invariant: Σ splits[*].marketValueDelta should equal the source's
 * marketValue (caller's contract). The reducer does not enforce this; it
 * trusts the action and re-syncs balance unconditionally so any over/under
 * shoot surfaces immediately in the invariant test.
 */
export class HoldingSplitReducer extends Reducer {
  static description = 'Replaces one holding with N children; each split carries marketValue/costBasis deltas off the source.';
  static type        = 'HoldingSplitReducer';

  constructor() {
    super('Holding Split', PRIORITY.POSITION_UPDATE);
    this.reducedActionTypes = [HOLDING_ACTION_TYPES.HOLDING_SPLIT];
  }

  reduce(state, action) {
    const { stateKey, holdingId, splits = [] } = action;
    const account = state?.[stateKey];
    if (!account || !Array.isArray(account.holdings)) return this.newState(state);
    if (!splits.length) return this.newState(state);

    const target = account.holdings.find(h => h?.id === holdingId);
    if (!target) return this.newState(state);

    // applyCashBasisInvariant: a CASH child's basis is its value regardless of what the
    // caller put in costBasisDelta (design 87 §11) — the split is the one path that
    // mints holdings without the Holding constructor's guard.
    const replacements = splits.map((s, i) => applyCashBasisInvariant({
      id:           s.id ?? `${target.id}.${i}`,
      allocation:   s.allocation ?? target.allocation,
      rateKey:      s.rateKey    ?? target.rateKey,
      label:        s.label      ?? target.label ?? '',
      purchaseDate: s.purchaseDate ?? target.purchaseDate ?? null,
      marketValue:  +((s.marketValueDelta ?? 0)).toFixed(2),
      costBasis:    +((s.costBasisDelta   ?? 0)).toFixed(2),
    }));

    const nextHoldings = _splitHolding(account.holdings, holdingId, replacements);
    const nextAccount  = _syncBalance({ ...account, holdings: nextHoldings });
    return this.newState(state, { [stateKey]: nextAccount });
  }
}

/**
 * HoldingRetitleReducer — patches metadata fields (allocation, rateKey, label)
 * without moving value. Runs at PRE_PROCESS so any value-touching reducer
 * for the same action batch sees the new metadata.
 */
export class HoldingRetitleReducer extends Reducer {
  static description = 'Patches holding metadata (allocation, rateKey, label).';
  static type        = 'HoldingRetitleReducer';

  constructor() {
    super('Holding Retitle', PRIORITY.PRE_PROCESS);
    this.reducedActionTypes = [HOLDING_ACTION_TYPES.HOLDING_RETITLE];
  }

  reduce(state, action) {
    const { stateKey, holdingId, allocation, rateKey, label } = action;
    const account = state?.[stateKey];
    if (!account || !Array.isArray(account.holdings)) return this.newState(state);

    const target = account.holdings.find(h => h?.id === holdingId);
    if (!target) return this.newState(state);

    const patch = {};
    if (allocation != null) patch.allocation = allocation;
    if (rateKey    != null) patch.rateKey    = rateKey;
    if (label      != null) patch.label      = label;
    if (Object.keys(patch).length === 0) return this.newState(state);

    const patched      = _patchHolding(target, patch);
    const nextHoldings = _replaceHolding(account.holdings, holdingId, patched);
    return this.newState(state, { [stateKey]: { ...account, holdings: nextHoldings } });
  }
}

export const HOLDING_REDUCER_CLASSES = {
  HoldingTransactReducer,
  HoldingRevalueReducer,
  HoldingSetBasisReducer,
  HoldingSplitReducer,
  HoldingRetitleReducer,
};

// Re-export the sync helper so tests can assert against the same rounding.
export { _syncBalance };
