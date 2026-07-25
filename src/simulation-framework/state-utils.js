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

// ── Deep clone ────────────────────────────────────────────────────────────

/**
 * Deep-clone a simulation state tree.
 *
 * A hand-rolled replacement for `structuredClone`, which is the single largest
 * cost in a long run (the journal/diff machinery clones state per event and per
 * untracked reducer). `structuredClone` pays for the full HTML structured-clone
 * algorithm — cycle detection, transferables, every exotic built-in — none of
 * which sim state uses. Measured on a real 44-year scenario state it is ~3.3x
 * slower than this walk (199us vs 61us per clone).
 *
 * Equivalence notes vs. structuredClone, for this state shape (plain objects,
 * arrays, Dates, and plain-data class instances):
 *   - Class prototypes: structuredClone ALSO returns plain objects for class
 *     instances, so dropping the prototype here matches existing behaviour.
 *   - Cycles: structuredClone preserves them; this recurses until the stack
 *     blows. Sim state is JSON-serialisable by construction (it is persisted and
 *     journalled), so cycles cannot occur — both outcomes are a hard crash.
 *   - Functions: structuredClone throws; this copies the reference. A function
 *     in state is a bug either way, but it will no longer be caught here.
 *
 * @param {*} v
 * @returns {*} a deep copy
 */
export function deepClone(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    const n = v.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = deepClone(v[i]);
    return out;
  }
  if (v instanceof Date) return new Date(v.getTime());
  if (v instanceof Map) {
    const m = new Map();
    for (const [k, x] of v) m.set(k, deepClone(x));
    return m;
  }
  if (v instanceof Set) {
    const s = new Set();
    for (const x of v) s.add(deepClone(x));
    return s;
  }
  const out = {};
  for (const k in v) out[k] = deepClone(v[k]);
  return out;
}

/**
 * Journal-immutability enforcement.
 *
 * The journal is a durable historical record: once a diff records an object/array
 * leaf of state, that leaf must never change again, or the past entry is silently
 * rewritten. We enforce that invariant instead of defending against its violation:
 *
 *   STRICT (dev + tests): _snapshot deep-FREEZES the recorded leaf. Because ES
 *     modules run in strict mode, any later in-place write to it
 *     (holding.marketValue = …, holdings.push(…), costBaseByCountry[c] = …) throws
 *     a TypeError AT THE MUTATION SITE — turning a would-be silent corruption into
 *     a loud, stack-traced failure the first time that reducer path runs. Running
 *     the suite (and the dev app) is therefore a proof, over every exercised path,
 *     that no reducer mutates recorded state in place. No clone, no allocation.
 *
 *   FAST (production build): _snapshot is the identity function — zero overhead.
 *     Safe because the STRICT run in CI has proven the copy-on-write invariant.
 *
 * Rationale over the old "structuredClone to tolerate mutation": the clone paid a
 * full deep copy on every changed object leaf, forever, to hide bugs rather than
 * surface them. Freeze-in-dev makes the invariant testable; identity-in-prod
 * removes the cost. Override with JOURNAL_STRICT=on|off.
 */
const _JOURNAL_STRICT = _detectStrict();

function _detectStrict() {
  try {
    if (typeof process !== 'undefined' && process.env) {
      if (process.env.JOURNAL_STRICT === 'off') return false;
      if (process.env.JOURNAL_STRICT === 'on')  return true;
      if (process.env.NODE_ENV === 'production') return false;
    }
  } catch { /* no process (browser) */ }
  try {
    // Bundlers (Vite) statically replace import.meta.env; bare Node ESM leaves it
    // undefined. A PROD build runs FAST; dev / test / SSR run STRICT.
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.PROD) return false;
  } catch { /* import.meta.env absent */ }
  return true; // default: enforce (dev + Node/Jest test runners)
}

/** Recursively Object.freeze an object/array leaf; skips already-frozen subtrees. */
function _deepFreeze(v) {
  if (v === null || typeof v !== 'object' || Object.isFrozen(v)) return v;
  Object.freeze(v);
  if (Array.isArray(v)) {
    for (const el of v) _deepFreeze(el);
  } else {
    for (const k of Object.keys(v)) _deepFreeze(v[k]);
  }
  return v;
}

/**
 * Record-time guard for an object/array leaf. STRICT: freeze it so any later
 * in-place mutation throws at the culprit. FAST: return it untouched (identity).
 * Primitives are immutable — pass through either way.
 */
function _snapshot(v) {
  if (v === null || typeof v !== 'object') return v;
  return _JOURNAL_STRICT ? _deepFreeze(v) : v;
}

/**
 * Numeric delta for a field transition, or null when the change is not numeric.
 *
 * A field that *materializes* — absent (or explicitly null) before, a number
 * after — counts as a delta of its full value, not "unknown". YTD accumulators
 * are the case that matters: a scenario whose initial state omits, say,
 * `usNetInvestmentIncomeYTD` gets `undefined → 213.43` on the first accrual of
 * the run, and a null delta there silently drops that accrual from every report
 * that sums `stateDelta` (ordinary-income-by-source, niit-base-by-component),
 * so the drill under-foots the tax line by exactly the first month's accrual.
 * Only the first period of a run is affected — the annual settle writes a real
 * 0 afterwards.
 */
function _numericDelta(before, after) {
  if (typeof after !== 'number') return null;
  if (typeof before === 'number')      return after - before;
  if (before === undefined || before === null) return after;   // field materialized
  return null;                                                  // e.g. string → number
}

export const MutationTracker = {
  begin()                    { _mutations = []; },
  record(field, before, after) {
    const delta = _numericDelta(before, after);
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
      const delta = _numericDelta(b, a);
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
