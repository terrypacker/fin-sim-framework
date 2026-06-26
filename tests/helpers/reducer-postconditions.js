/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Reusable reducer postcondition assertions.
 *
 * Centralizes the local invariants every reducer must preserve so that
 * per-reducer tests stay a few lines and new invariants are added in one place.
 * See design/37-reducer-test-framework.md for the invariant taxonomy (I1–I10).
 */

import assert from 'node:assert/strict';
// Legacy (loose) deepEqual: ignores prototypes so a structuredClone (plain
// objects) compares to live class instances (e.g. Holding) by structure.
import { deepEqual as looseDeepEqual } from 'node:assert';

/** Currency-precision tolerance: half a cent. */
export const CURRENCY_EPS = 0.005;

/** True for a state node that looks like an account (has a holdings array). */
function isAccountNode(node) {
  return node && typeof node === 'object' && Array.isArray(node.holdings);
}

/** Σ holdings[i].marketValue for one account node. */
export function sumHoldings(account) {
  return (account.holdings ?? []).reduce((s, h) => s + (h?.marketValue ?? 0), 0);
}

/**
 * I3 — §4.4 balance sync. For every account node in `state` (or the named
 * subset), assert `balance === Σ holdings[i].marketValue` within currency tol.
 */
export function assertBalanceInvariant(state, stateKeys = null) {
  for (const [key, node] of Object.entries(state)) {
    if (!isAccountNode(node)) continue;
    if (stateKeys && !stateKeys.includes(key)) continue;
    const sum = sumHoldings(node);
    assert.ok(
      Math.abs((node.balance ?? 0) - sum) <= CURRENCY_EPS,
      `§4.4 (I3) violated for "${key}": balance=${node.balance} Σmv=${sum}`,
    );
  }
}

/**
 * I4 — non-negativity. marketValue ≥ 0, costBasis ≥ 0 on every holding, and
 * balance ≥ 0 on every account (opt out per stateKey for documented exceptions).
 */
export function assertNonNegative(state, { allowNegativeBalance = [] } = {}) {
  for (const [key, node] of Object.entries(state)) {
    if (!isAccountNode(node)) continue;
    for (const h of node.holdings) {
      assert.ok((h?.marketValue ?? 0) >= -CURRENCY_EPS, `I4: marketValue<0 in "${key}" (${h?.marketValue})`);
      assert.ok((h?.costBasis ?? 0) >= -CURRENCY_EPS, `I4: costBasis<0 in "${key}" (${h?.costBasis})`);
    }
    if (!allowNegativeBalance.includes(key)) {
      assert.ok((node.balance ?? 0) >= -CURRENCY_EPS, `I4: balance<0 in "${key}" (${node.balance})`);
    }
  }
}

/**
 * I1 — input not mutated. Pass the pre-call clone (`before`) and the *same*
 * state object you handed to reduce() (`inputAfter`). Uses loose deepEqual so a
 * structuredClone (which drops class prototypes) still compares to live Holding
 * instances by structure.
 */
export function assertNoInputMutation(before, inputAfter) {
  looseDeepEqual(inputAfter, before, 'I1: reducer mutated its input state');
}

/**
 * I7 — no-op semantics. Asserts two states are equal *ignoring* the reducer
 * orchestration queue `state.next` (every `Reducer.newState()` appends a fresh
 * `next: []`, so a domain-level no-op still differs by that key). Use this for
 * "missing target leaves state unchanged" and identity-reducer checks.
 */
export function assertStateUnchanged(before, after, msg = 'I7: state changed') {
  const strip = (s) => { const { next: _next, ...rest } = s ?? {}; return rest; };
  looseDeepEqual(strip(after), strip(before), msg);
}

/**
 * I5 — money conservation between two account stateKeys in the same currency.
 * `Δsource + Δdest + fee === 0` within currency tolerance. `fee` captures any
 * intended leakage (tax withheld, transfer cost) so it is explicit, not silent.
 */
export function assertConserved(prev, next, srcKey, dstKey, { fee = 0 } = {}) {
  const dSrc = (next[srcKey].balance ?? 0) - (prev[srcKey].balance ?? 0);
  const dDst = (next[dstKey].balance ?? 0) - (prev[dstKey].balance ?? 0);
  assert.ok(
    Math.abs(dSrc + dDst + fee) <= CURRENCY_EPS,
    `I5: money not conserved between "${srcKey}"→"${dstKey}": Δsrc=${dSrc} Δdst=${dDst} fee=${fee}`,
  );
}

/**
 * I5 (FX) — cross-currency conservation. `|Δsource| · rate === |Δdest|` within
 * a relative tolerance (FX math accumulates rounding, so default 0.5%).
 */
export function assertConservedFx(prev, next, srcKey, dstKey, rate, relTol = 0.005) {
  const dSrc = Math.abs((next[srcKey].balance ?? 0) - (prev[srcKey].balance ?? 0));
  const dDst = Math.abs((next[dstKey].balance ?? 0) - (prev[dstKey].balance ?? 0));
  const expected = dSrc * rate;
  const denom = Math.max(expected, 1);
  assert.ok(
    Math.abs(expected - dDst) / denom <= relTol,
    `I5(FX): |Δsrc|·rate=${expected} but |Δdst|=${dDst} (rate=${rate})`,
  );
}

/**
 * Run a reducer and assert the standard postcondition bundle.
 *
 * @param {object}   opts
 * @param {boolean}  [opts.checkNoMutation=true] - assert I1 (no input mutation)
 * @param {boolean|string[]} [opts.balance]      - assert I3; pass stateKey[] to scope
 * @param {boolean|object}   [opts.nonNegative]  - assert I4; pass options object to scope
 * @returns {*} the next state returned by reduce()
 */
export function runReducer(reducer, state, action, date = new Date('2030-01-15'), opts = {}) {
  const before = structuredClone(state);
  const next = reducer.reduce(state, action, date);

  if (opts.checkNoMutation !== false) assertNoInputMutation(before, state);
  if (opts.balance) assertBalanceInvariant(next, opts.balance === true ? null : opts.balance);
  if (opts.nonNegative) assertNonNegative(next, opts.nonNegative === true ? {} : opts.nonNegative);

  return next;
}
