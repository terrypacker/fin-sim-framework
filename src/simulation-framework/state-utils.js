/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

// ── Diff ──────────────────────────────────────────────────────────────────

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
    } else if (JSON.stringify(b) !== JSON.stringify(a)) {
      const delta = typeof a === 'number' && typeof b === 'number' ? a - b : null;
      changes.push({ field: prefix, before: b ?? null, after: a ?? null, delta });
    }
  };

  for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    walk(prev[key], next[key], key);
  }

  return changes;
}
