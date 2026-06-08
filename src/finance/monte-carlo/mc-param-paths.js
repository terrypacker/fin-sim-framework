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
 * Path-walking helpers for nested MC parameter keys (and, since design 31,
 * general state-path addressing for the chart/state-panel).
 *
 * Accepted path forms:
 *   'rothGrowthRate'               → top-level key
 *   'people.primary.lifeExpectancy'→ dot-separated
 *   'shocks[0].severity'           → bracketed positional index
 *   'shocks[1].recovery.durationMonths' → mixed
 *   'usSavingsAccount.holdings[id=abc].marketValue' → key-matched array element
 *
 * The `[key=value]` form (design 31 / R11) addresses an array element by a
 * stable field rather than position, so a watchlisted holding survives a sale
 * that shifts indices. Matching is by string-equality on element[key].
 *
 * get/set are no-ops (return undefined / do nothing) when an intermediate
 * segment is missing — no implicit shape creation.
 */

/**
 * Parse a path into segments. Each segment is one of:
 *   - string   → object key
 *   - number   → positional array index
 *   - {key,value} → array-element matcher (`[key=value]`)
 */
function parsePath(path) {
  const segs = [];
  let buf = '';
  const flush = () => {
    if (buf !== '') { segs.push(/^\d+$/.test(buf) ? Number(buf) : buf); buf = ''; }
  };
  for (let i = 0; i < path.length; i++) {
    const c = path[i];
    if (c === '.') {
      flush();
    } else if (c === '[') {
      flush();
      const end = path.indexOf(']', i);
      if (end === -1) { buf += c; continue; }   // unterminated — treat literally
      const inner = path.slice(i + 1, end);
      const eq = inner.indexOf('=');
      if (/^\d+$/.test(inner))      segs.push(Number(inner));
      else if (eq >= 0)             segs.push({ key: inner.slice(0, eq), value: inner.slice(eq + 1) });
      else                          segs.push(inner);
      i = end;                                   // loop ++ moves past ']'
    } else {
      buf += c;
    }
  }
  flush();
  return segs;
}

function _step(cur, seg) {
  if (typeof seg === 'object' && seg !== null) {
    if (!Array.isArray(cur)) return undefined;
    return cur.find(el => el != null && String(el[seg.key]) === seg.value);
  }
  return cur[seg];
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
    cur = _step(cur, seg);
  }
  return cur;
}

/**
 * Write a value into obj at the given path expression.
 * No-op if any intermediate segment is missing (never creates nodes).
 * A `[key=value]` matcher as the final segment is unsupported for set (no-op).
 * Only mutates obj — callers must pass a structuredClone if immutability is needed.
 */
export function set(obj, path, value) {
  const segs = parsePath(path);
  if (segs.length === 0) return;
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    if (cur == null) return;
    const next = _step(cur, segs[i]);
    if (next == null) return;
    cur = next;
  }
  if (cur == null) return;
  const last = segs[segs.length - 1];
  if (typeof last === 'object' && last !== null) return;  // matcher-as-target unsupported
  cur[last] = value;
}
