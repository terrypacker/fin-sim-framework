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
 * Pure utilities for scenario comparison: state diffing and journal overlay.
 *
 * These are deliberately framework-free so they can be tested in Node without
 * a DOM or a live ServiceRegistry.
 */

/**
 * Recursively flatten a state object to dot-notation leaf paths,
 * keeping only numeric (finite) values.
 *
 * @param {object} obj
 * @param {string} [prefix='']
 * @param {number} [maxDepth=4]
 * @returns {Record<string, number>}
 */
export function flattenNumericState(obj, prefix = '', maxDepth = 4) {
  const out = {};
  if (!obj || typeof obj !== 'object' || maxDepth === 0) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('_')) continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[key] = v;
    } else if (v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
      Object.assign(out, flattenNumericState(v, key, maxDepth - 1));
    }
  }
  return out;
}

/**
 * Compute a side-by-side diff of two simulation final states.
 *
 * @param {object} stateA
 * @param {object} stateB
 * @returns {Array<{ field: string, a: number|null, b: number|null, delta: number|null }>}
 *   Sorted alphabetically by field name.
 */
export function computeStateDiff(stateA, stateB) {
  const flatA = flattenNumericState(stateA ?? {});
  const flatB = flattenNumericState(stateB ?? {});
  const allKeys = new Set([...Object.keys(flatA), ...Object.keys(flatB)]);

  return [...allKeys]
    .sort()
    .map(field => {
      const a     = flatA[field] ?? null;
      const b     = flatB[field] ?? null;
      const delta = (a !== null && b !== null) ? b - a : null;
      return { field, a, b, delta };
    });
}

/**
 * Compute a within-day structural pairing key for a JournalEntry.
 *
 * Two scenarios produce independent action.instanceId UUIDs, so we can't pair
 * by identity. Instead we pair by the config-graph node IDs that *are* stable
 * across A and B for any event originating from the same config node:
 *   1. nid::<event.nodeId>::<action.nodeId>::<scope>   (strongest — direct config-node identity)
 *   2. typ::<action.type>::<scope>                     (fallback when node ids are missing)
 *
 * `scope` disambiguates multi-actor same-type events on the same day (e.g.
 * two WAGES rows, one per earner). It's the first available of
 * personKey / accountKey / ownerKey on the action data payload.
 */
export function journalPairKey(entry) {
  const evNodeId = entry?.event?.nodeId ?? null;
  const acNodeId = entry?.action?.nodeId ?? null;
  const data     = entry?.action?.data ?? {};
  const scope    = data.personKey ?? data.accountKey ?? data.ownerKey ?? null;
  if (evNodeId || acNodeId) {
    return `nid::${evNodeId ?? ''}::${acNodeId ?? ''}::${scope ?? ''}`;
  }
  const type = entry?.action?.type ?? entry?.event?.type ?? '?';
  return `typ::${type}::${scope ?? ''}`;
}

/**
 * Merge the stateDiff arrays from two journal entries on `field`, computing
 * deltaOfDelta = (B.delta ?? 0) − (A.delta ?? 0) for each field, and sorting
 * by |deltaOfDelta| descending (biggest A↔B divergence first).
 *
 * Fields present only on one side render `—` for the other; the missing
 * side's contribution to deltaOfDelta is treated as 0.
 *
 * @param {object|null} aEntry
 * @param {object|null} bEntry
 * @returns {Array<{
 *   field: string,
 *   aBefore: number|null, aAfter: number|null, aDelta: number|null,
 *   bBefore: number|null, bAfter: number|null, bDelta: number|null,
 *   deltaOfDelta: number|null,
 * }>}
 */
export function mergeEntryFieldRows(aEntry, bEntry) {
  const aDiff = aEntry?.stateDiff ?? [];
  const bDiff = bEntry?.stateDiff ?? [];
  if (aDiff.length === 0 && bDiff.length === 0) return [];

  const aByField = new Map(aDiff.map(d => [d.field, d]));
  const bByField = new Map(bDiff.map(d => [d.field, d]));
  const allFields = [...new Set([...aByField.keys(), ...bByField.keys()])];

  const rows = [];
  for (const field of allFields) {
    const a = aByField.get(field) ?? null;
    const b = bByField.get(field) ?? null;
    const aBefore = a?.before ?? null;
    const aAfter  = a?.after  ?? null;
    const bBefore = b?.before ?? null;
    const bAfter  = b?.after  ?? null;

    // Skip rows where every observable value is either null or a NaN numeric.
    // NaN === NaN is false in JS so diffStates includes NaN→NaN fields (e.g. uninitialised
    // earningsBasis) as if they changed; we drop them as noise.  Booleans and strings
    // (typeof !== 'number') are kept — they are legitimate non-numeric state changes.
    const isUsable = v => v !== null && v !== undefined &&
      (typeof v !== 'number' || Number.isFinite(v));
    if (!isUsable(aBefore) && !isUsable(aAfter) && !isUsable(bBefore) && !isUsable(bAfter)) continue;

    // Use isFinite for deltas so NaN propagation is stopped at the source.
    const aDelta = Number.isFinite(a?.delta) ? a.delta : null;
    const bDelta = Number.isFinite(b?.delta) ? b.delta : null;
    const deltaOfDelta = (aDelta !== null || bDelta !== null)
      ? (bDelta ?? 0) - (aDelta ?? 0)
      : null;

    rows.push({
      field,
      aBefore, aAfter, aDelta,
      bBefore, bAfter, bDelta,
      deltaOfDelta: Number.isFinite(deltaOfDelta) ? deltaOfDelta : null,
    });
  }

  rows.sort((x, y) => {
    const ax = x.deltaOfDelta !== null ? Math.abs(x.deltaOfDelta) : 0;
    const ay = y.deltaOfDelta !== null ? Math.abs(y.deltaOfDelta) : 0;
    return ay !== ax ? ay - ax : x.field.localeCompare(y.field);
  });

  return rows;
}

/**
 * Pair entries from A and B within a single day by structural key.
 *
 * Buckets each side by `journalPairKey`, then walks A's encounter order
 * emitting paired rows up to min(|aGroup|, |bGroup|); extra items in either
 * group spill as a-only / b-only. Finally, any B-key never seen on A's side
 * is appended as b-only rows.
 *
 * Each pair also carries `fieldRows` — the field-aligned stateDiff merge from
 * `mergeEntryFieldRows` — so the presenter doesn't have to compute it.
 *
 * @returns {Array<{
 *   key: string,
 *   aEntry: object|null,
 *   bEntry: object|null,
 *   kind: 'paired'|'a-only'|'b-only',
 *   fieldRows: ReturnType<mergeEntryFieldRows>,
 * }>}
 */
export function pairEntriesWithinDay(aList, bList) {
  const bucket = (list) => {
    const m = new Map();
    for (const e of list) {
      const k = journalPairKey(e);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(e);
    }
    return m;
  };
  const aBuckets = bucket(aList);
  const bBuckets = bucket(bList);

  const pairs = [];
  const seen  = new Set();

  for (const e of aList) {
    const k = journalPairKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    const aGroup = aBuckets.get(k) ?? [];
    const bGroup = bBuckets.get(k) ?? [];
    const n = Math.max(aGroup.length, bGroup.length);
    for (let i = 0; i < n; i++) {
      const a = aGroup[i] ?? null;
      const b = bGroup[i] ?? null;
      pairs.push({
        key:       k,
        aEntry:    a,
        bEntry:    b,
        kind:      a && b ? 'paired' : a ? 'a-only' : 'b-only',
        fieldRows: mergeEntryFieldRows(a, b),
      });
    }
  }

  for (const e of bList) {
    const k = journalPairKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    for (const b of bBuckets.get(k) ?? []) {
      pairs.push({
        key:       k,
        aEntry:    null,
        bEntry:    b,
        kind:      'b-only',
        fieldRows: mergeEntryFieldRows(null, b),
      });
    }
  }

  return pairs;
}

/**
 * Return the first ISO date (YYYY-MM-DD) in the overlay at which the two
 * scenarios diverge — defined as the earliest day with either:
 *   • an a-only or b-only row (structural divergence), or
 *   • a paired row whose fieldRows contain a non-zero deltaOfDelta.
 *
 * Returns null if the overlay is empty or the scenarios are identical.
 *
 * @param {ReturnType<buildJournalOverlay>} overlay
 * @returns {string|null}
 */
export function firstDivergenceDate(overlay) {
  for (const day of overlay ?? []) {
    for (const pair of day.pairs ?? []) {
      if (pair.kind !== 'paired') return day.date;
      if ((pair.fieldRows ?? []).some(r => r.deltaOfDelta !== null && r.deltaOfDelta !== 0)) {
        return day.date;
      }
    }
  }
  return null;
}

/**
 * Compute a running net-worth approximation for a sequence of journal entries.
 *
 * Uses the "cheap" approach from §5.4.3: maintain a running dict of last-known
 * field values (updated from each entry's stateDiff `after` values), then sum
 * all paths ending in `.balance` at each step.  No FX conversion — the value
 * is a display-only gutter and the KPI strip is the source of truth.
 *
 * @param {Array} entries  JournalEntry[] in journal order
 * @returns {number[]}     One value per entry, same length as input
 */
export function runningNetWorthSeries(entries) {
  const running = {};
  return (entries ?? []).map(entry => {
    for (const d of entry.stateDiff ?? []) {
      if (d.after !== null && typeof d.after === 'number') {
        running[d.field] = d.after;
      }
    }
    let total = 0;
    for (const [path, val] of Object.entries(running)) {
      if (path.endsWith('.balance') && Number.isFinite(val)) total += val;
    }
    return total;
  });
}

/**
 * Group journal entries by ISO date (YYYY-MM-DD) for overlay rendering.
 *
 * Within each day, entries from A and B are paired by `journalPairKey` so the
 * presenter can render row-aligned: equivalent events sit next to each other
 * even when journal-sequence order differs across scenarios.
 *
 * @param {Array} entriesA  JournalEntry[] from scenario A
 * @param {Array} entriesB  JournalEntry[] from scenario B
 * @returns {Array<{ date: string, aEntries: Array, bEntries: Array, pairs: Array }>}
 *   Sorted chronologically by date. `aEntries`/`bEntries` preserved for callers
 *   that just need raw counts; `pairs` is the row-aligned view.
 */
export function buildJournalOverlay(entriesA, entriesB) {
  const toDay = (e) => {
    const d = e.date;
    if (!d) return null;
    if (typeof d.toISOString === 'function') return d.toISOString().slice(0, 10);
    return String(d).slice(0, 10);
  };

  const groupByDay = (entries) => {
    const map = new Map();
    for (const e of entries) {
      const key = toDay(e);
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(e);
    }
    return map;
  };

  const byDateA = groupByDay(entriesA ?? []);
  const byDateB = groupByDay(entriesB ?? []);

  const allDates = [...new Set([...byDateA.keys(), ...byDateB.keys()])].sort();

  return allDates.map(date => {
    const aList = byDateA.get(date) ?? [];
    const bList = byDateB.get(date) ?? [];
    return {
      date,
      aEntries: aList,
      bEntries: bList,
      pairs:    pairEntriesWithinDay(aList, bList),
    };
  });
}
