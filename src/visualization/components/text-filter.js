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
 * The live text filter shared by the State panel and the Parameters panel: how typed text
 * matches a row, and how foldable sections behave while a filter is active.
 *
 * Each panel decides WHAT a row is searched by (the State panel: a path and its display
 * label; the Parameters panel: the fields picked in its field chooser). This decides HOW.
 */

/** Typed text → the filter both panels store: trimmed and lower-cased ('' = no filter). */
export function normalizeFilter(raw) {
  return String(raw ?? '').trim().toLowerCase();
}

/**
 * Whether a row passes: every whitespace-separated word of `filter` appears somewhere in
 * `parts`, case-insensitively. So "terry balance" finds "US Brokerage (Terry) · Balance",
 * which a single substring could not. An empty filter passes everything.
 *
 * @param {string} filter            from normalizeFilter
 * @param {...(string|null)} parts   the texts the row is searched by
 */
export function matchesFilter(filter, ...parts) {
  if (!filter) return true;
  const haystack = parts.filter(p => p != null && p !== '').join('\n').toLowerCase();
  return filter.split(/\s+/).every(term => haystack.includes(term));
}

/**
 * Fold state for sections under a live filter.
 *
 * - With no filter, a section is open only if the user opened it (collapsed by default).
 * - With a filter, every matching section opens, so the matches are visible, EXCEPT the
 *   ones the user folds under that filter. Without that exception a caret did nothing
 *   while a filter was set.
 * - A new filter is a new question, so its matches all start open again.
 * - Folds made under a filter never touch the unfiltered state.
 *
 * The caller passes its current filter on every call, so the state follows the filter
 * however it was set.
 */
export class FilteredFoldState {
  constructor() {
    /** Sections opened with no filter active. Exposed for callers that open one directly. */
    this.expanded = new Set();
    this._folded  = new Set();   // sections folded under `_filter`
    this._filter  = '';
  }

  isExpanded(key, filter) {
    this._follow(filter);
    return filter ? !this._folded.has(key) : this.expanded.has(key);
  }

  toggle(key, filter) {
    this._follow(filter);
    const set = filter ? this._folded : this.expanded;
    if (set.has(key)) set.delete(key);
    else set.add(key);
  }

  _follow(filter) {
    if (filter === this._filter) return;
    this._folded.clear();
    this._filter = filter;
  }
}
