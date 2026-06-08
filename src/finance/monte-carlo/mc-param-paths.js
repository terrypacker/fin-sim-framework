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
 * Path-walking helpers for nested MC parameter keys.
 *
 * Accepted path forms:
 *   'rothGrowthRate'               → top-level key
 *   'people.primary.lifeExpectancy'→ dot-separated
 *   'shocks[0].severity'           → bracketed index + dot
 *   'shocks[1].recovery.durationMonths' → mixed
 *
 * get/set are no-ops (return undefined / do nothing) when an intermediate
 * segment is missing — no implicit shape creation.
 */

function parsePath(path) {
  // Split on '.' or '[N]' (optionally followed by '.'), keeping captured indices.
  // 'shocks[1].severity' → ['shocks', '1', 'severity']
  return path.split(/\.|\[(\d+)\]\.?/).filter(Boolean)
             .map(s => (/^\d+$/.test(s) ? Number(s) : s));
}

/**
 * Read a nested value from obj using a path expression.
 * Returns undefined when any intermediate is null/undefined.
 */
export function get(obj, path) {
  const segs = parsePath(path);
  let cur = obj;
  for (const seg of segs) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * Write a value into obj at the given path expression.
 * No-op if any intermediate segment is missing (never creates nodes).
 * Only mutates obj — callers must pass a structuredClone if immutability is needed.
 */
export function set(obj, path, value) {
  const segs = parsePath(path);
  if (segs.length === 0) return;
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    if (cur[segs[i]] == null) return;
    cur = cur[segs[i]];
  }
  cur[segs[segs.length - 1]] = value;
}
