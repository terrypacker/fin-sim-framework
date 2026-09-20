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
 * The generated help index, loaded once per session and shared (design 111 §6).
 *
 * Two readers need it now — the Help panel and the node-field decorator that puts a `?` on
 * every control in an edit form — and they must agree, because they show the SAME words:
 * the tooltip and the panel are one description rendered two ways. Two fetches of one
 * gitignored artifact could also disagree mid-session, which is a bug nobody would find.
 *
 * Everything here is defensive about the index being ABSENT, which is a real state and not
 * an error state: `public/help/help-index.json` is a build artifact (design 108 D4), so a
 * checkout that has never run `npm run help:build` has none, and jsdom — where the whole
 * workbench boots in tests — has no `fetch` at all. Both resolve to `null`, and every
 * caller degrades to showing nothing rather than throwing inside a render.
 */

let _index   = null;   // the resolved index, or null when there is none
let _loading = null;   // the in-flight promise, so N callers share one fetch

/**
 * The index, or `null`.
 *
 * @param {object} [preloaded] — inject an index (how tests avoid `fetch`). Passing one
 *   also seeds the shared cache, so a panel constructed with a test index and a decorator
 *   that asks for it later see the same thing.
 */
export function loadHelpIndex(preloaded = null) {
  if (preloaded) { _index = preloaded; return Promise.resolve(_index); }
  if (_index)    return Promise.resolve(_index);
  if (_loading)  return _loading;

  if (typeof fetch !== 'function') {
    _loading = Promise.resolve(null);
    return _loading;
  }

  const base = (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '/';
  _loading = fetch(`${base}help/help-index.json`)
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((idx) => { _index = idx; return idx; });
  return _loading;
}

/** The index if it is already here, without waiting — for a synchronous render path. */
export function peekHelpIndex() { return _index; }

/** Drop the cache. Tests only: one suite's injected index must not leak into the next. */
export function _resetHelpIndex() { _index = null; _loading = null; }
