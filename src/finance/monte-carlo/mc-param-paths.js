/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { isGeneratedParamKey } from '../../scenarios/params/generated-param-keys.js';

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
 *   'acct.usSavingsAccount.minimumBalance' → a generated param key: ONE flat key
 *
 * The `[key=value]` form (design 31 / R11) addresses an array element by a
 * stable field rather than position, so a watchlisted holding survives a sale
 * that shifts indices. Matching is by string-equality on element[key].
 *
 * get/set are no-ops (return undefined / do nothing) when an intermediate
 * segment is missing — no implicit shape creation.
 *
 * Flat keys (design 98 W0). A key the object already carries verbatim is read and
 * written as that one key, whatever it contains. And a generated per-record param
 * key (`acct.` `person.` `prop.` `coll.` `equity.` `bequest.` `raAsset.`, see
 * generated-param-keys.js) that cannot be walked as a path is written flat rather than
 * dropped: in `cfg.parameters` those keys are always flat, and the loader's generated-key
 * cascade reads them that way. Before this, `set(params, 'acct.x.minimumBalance', v)` was
 * a silent no-op, so every optimizer candidate keyed on a generated key never reached the
 * sim. A generated-looking path whose parent IS a nested object (state addressing) still
 * walks, so the chart and state panel are unaffected.
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

/** True when `obj` carries `path` verbatim as one of its own keys. */
function _hasFlatKey(obj, path) {
  return obj != null && typeof obj === 'object' && Object.hasOwn(obj, path);
}

/**
 * Read a nested value from obj using a path expression.
 * Returns undefined when any intermediate is null/undefined.
 * An own key equal to the whole path wins (see "Flat keys" above).
 */
export function get(obj, path) {
  if (_hasFlatKey(obj, path)) return obj[path];
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
 * No-op if any intermediate segment is missing (never creates nodes) — except that a
 * generated param key which cannot be walked is written as one flat key, and an own key
 * equal to the whole path is overwritten in place (see "Flat keys" above).
 * A `[key=value]` matcher as the final segment is unsupported for set (no-op).
 * Only mutates obj — callers must pass a structuredClone if immutability is needed.
 */
export function set(obj, path, value) {
  if (obj == null) return;
  if (_hasFlatKey(obj, path)) { obj[path] = value; return; }
  const writeFlat = () => { if (isGeneratedParamKey(path)) obj[path] = value; };
  const segs = parsePath(path);
  if (segs.length === 0) return;
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const next = _step(cur, segs[i]);
    if (next == null) return writeFlat();
    cur = next;
  }
  const last = segs[segs.length - 1];
  if (typeof last === 'object' && last !== null) return;  // matcher-as-target unsupported
  cur[last] = value;
}
