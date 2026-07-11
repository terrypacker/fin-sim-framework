/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

// ── MutationTracker ───────────────────────────────────────────────────────
//
// Lightweight recorder used by FieldReducer.setValueByPath and
// AccountTransactionReducer to capture exactly which fields changed,
// replacing the per-reducer structuredClone + diffStates round-trip.
//
// Usage (simulation.js):
//   MutationTracker.begin();
//   reducerFn(state, action, date);
//   const sd = MutationTracker.flush(); // [{field, before, after, delta}] or null

let _mutations = null;

/**
 * Detach an object/array leaf from live state before it is recorded in the
 * journal. The journal is a durable historical record: a diff's `before`/`after`
 * must not alias a live state object, or a later in-place mutation (e.g. a
 * synthetic holding whose marketValue is rescaled each event) silently rewrites
 * every past entry to the final value. Primitives are immutable — pass through.
 */
function _snapshot(v) {
  return (v !== null && typeof v === 'object') ? structuredClone(v) : v;
}

export const MutationTracker = {
  begin()                    { _mutations = []; },
  record(field, before, after) {
    const delta = typeof after === 'number' && typeof before === 'number' ? after - before : null;
    _mutations.push({ field, before: _snapshot(before ?? null), after: _snapshot(after ?? null), delta });
  },
  flush() {
    const m = _mutations;
    _mutations = null;
    return m && m.length > 0 ? m : null;
  },
  get isActive() { return _mutations !== null; },
};

// ── Diff ──────────────────────────────────────────────────────────────────

/**
 * Shallow equality for leaf values (primitives, null, arrays of primitives).
 * Avoids JSON.stringify for the common case.
 */
function _leafEqual(b, a) {
  if (b === a) return true;
  if (!Array.isArray(b) || !Array.isArray(a)) return false;
  if (b.length !== a.length) return false;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === a[i]) continue;
    if (typeof b[i] === 'object' && typeof a[i] === 'object' && b[i] !== null && a[i] !== null) {
      // Object array elements: deep-equal so that structuredClone'd snapshots
      // (where refs differ but values match) don't produce spurious diffs.
      if (!_deepObjectEqual(b[i], a[i])) return false;
    } else {
      return false;
    }
  }
  return true;
}

function _deepObjectEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    const av = a[k], bv = b[k];
    if (av === bv) continue;
    if (typeof av === 'object' && typeof bv === 'object' && av !== null && bv !== null) {
      if (!_deepObjectEqual(av, bv)) return false;
    } else {
      return false;
    }
  }
  return true;
}

/**
 * Compute the difference between two state snapshots.
 * Returns an array of { field, before, after, delta } records.
 */
export function diffStates(prev, next) {
  const changes = [];
  if (!prev || !next) return changes;

  // Ledger arrays grow on every transaction — skip them to keep diffs readable.
  const SKIP_KEYS = new Set(['credits', 'debits']);

  const walk = (b, a, prefix) => {
    if (b === a) return;  // structural sharing fast-path — skip identical references
    const leafKey = prefix.split('.').pop();
    if (SKIP_KEYS.has(leafKey)) return;
    const bIsObj = typeof b === 'object' && b !== null && !Array.isArray(b);
    const aIsObj = typeof a === 'object' && a !== null && !Array.isArray(a);
    if (bIsObj && aIsObj) {
      for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
        walk(b[key], a[key], prefix ? `${prefix}.${key}` : key);
      }
    } else if (!_leafEqual(b, a)) {
      const delta = typeof a === 'number' && typeof b === 'number' ? a - b : null;
      // `a` is a live reference into this.state; `b` may be too depending on the
      // caller. Snapshot object/array leaves so the recorded diff can't be
      // rewritten by later in-place mutation of the same object.
      changes.push({ field: prefix, before: _snapshot(b ?? null), after: _snapshot(a ?? null), delta });
    }
  };

  for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    walk(prev[key], next[key], key);
  }

  return changes;
}
