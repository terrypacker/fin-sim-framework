/*
 * Copyright (c) 2026 Terry Packer.
 *
 * This file is part of Terry Packer's Work.
 * See www.terrypacker.com for further info.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { loanKeyForProperty } from '../../finance/account-rules/loan-classes.js';

/**
 * WatchlistModel — design 101 W1. Named, ordered lists of watch entries, one of
 * them active, persisted in the scenario cfg. Pure: no DOM, no bus.
 *
 * A watch entry points at one state path and says how to show it:
 *   { path, label: string|null, charted: boolean, axis: 'auto'|'left'|'right' }
 *
 * Persistence (§8.1):
 *   cfg.watchlists       = [{ id, name, entries: [entry…] }, …]
 *   cfg.activeWatchlistId = id | null
 *
 * `activeWatchlistId` doubles as the migration marker. A scenario the model has
 * written always carries the key (null once every list is deleted); one saved
 * before W1 never does. That is what tells a deliberately empty `watchlists: []`
 * apart from the legacy empty array, which is seeded with "Overview" (§5.4).
 *
 * Reads return copies; every mutation goes through a method and fires onChange.
 */

export const OVERVIEW_NAME      = 'Overview';
export const LEGACY_LIST_NAME   = 'Watchlist';
export const OVERVIEW_SEED_PATH = 'metrics.netWorth';
export const WATCH_AXES         = Object.freeze(['auto', 'left', 'right']);

/**
 * The stateKeys whose `metrics.<stateKey>` was a balance copy written by
 * RECORD_BALANCE (§2.5 b): the scenario's accounts, the loans synthesized from its
 * properties, and its inherited bequest accounts.
 *
 * @param {object} cfg  scenario cfg
 * @returns {Set<string>}
 */
export function balanceCopyKeys(cfg) {
  const keys = new Set();
  for (const a of cfg?.accounts ?? []) if (a?.stateKey) keys.add(a.stateKey);
  for (const p of cfg?.realProperties ?? []) if (p?.stateKey) keys.add(loanKeyForProperty(p.stateKey));
  for (const b of cfg?.bequests ?? []) {
    for (const a of b?.assets ?? []) {
      if (a?.stateKey && a.__type !== 'RealProperty' && a.__type !== 'Collectible') keys.add(a.stateKey);
    }
  }
  return keys;
}

/**
 * Rewrite a saved balance-copy watch (`metrics.usSavingsAccount`) to the balance it
 * copied (`usSavingsAccount.balance`), which is never stale (§7 migrate). Any other
 * path is returned unchanged.
 *
 * @param {string}      path
 * @param {Set<string>} keys  from balanceCopyKeys()
 */
export function aliasWatchPath(path, keys) {
  // `metrics.monthly_expenses` was a copy of the top-level `monthlyExpenses` (§7.1, M3).
  // The other retired flow amounts have no state equivalent: they are kept, and show muted.
  if (path === 'metrics.monthly_expenses') return 'monthlyExpenses';
  const m = /^metrics\.([^.[\]]+)$/.exec(path);
  return m && keys.has(m[1]) ? `${m[1]}.balance` : path;
}

function cleanName(name) {
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

/** A legacy string or an entry object → a canonical entry, or null when it names no path. */
function normalizeEntry(raw) {
  const isString = typeof raw === 'string';
  const path     = isString ? raw : raw?.path;
  if (typeof path !== 'string' || !path.trim()) return null;
  return {
    path:    path.trim(),
    label:   isString ? null : cleanName(raw.label),
    charted: isString ? true : raw.charted !== false,
    axis:    !isString && WATCH_AXES.includes(raw.axis) ? raw.axis : 'auto',
  };
}

const cloneList = l => ({ id: l.id, name: l.name, entries: l.entries.map(e => ({ ...e })) });

export class WatchlistModel {
  constructor() {
    this._lists     = [];    // [{ id, name, entries }]
    this._activeId  = null;
    this._seq       = 0;     // highest numeric id suffix handed out; never decreases
    this._listeners = new Set();
  }

  /**
   * Build the model from a scenario cfg, migrating as needed:
   *   - no `activeWatchlistId` key and no entries → seed "Overview" = [netWorth] (§5.4);
   *   - a legacy `string[]` → one list "Watchlist", every entry charted (today's behaviour);
   *   - saved `metrics.<stateKey>` balance copies → `<stateKey>.balance` (§7).
   * Never mutates `cfg`; call applyTo() to write back.
   *
   * @param {object} cfg
   * @returns {WatchlistModel}
   */
  static fromCfg(cfg) {
    const model    = new WatchlistModel();
    const raw      = Array.isArray(cfg?.watchlists) ? cfg.watchlists : [];
    const migrated = cfg != null && Object.hasOwn(cfg, 'activeWatchlistId');
    const keys     = balanceCopyKeys(cfg);

    const legacy = raw.filter(x => typeof x === 'string');
    const lists  = raw.filter(x => x !== null && typeof x === 'object' && !Array.isArray(x));

    if (!migrated && legacy.length === 0 && lists.length === 0) {
      model._pushList({ name: OVERVIEW_NAME, entries: [OVERVIEW_SEED_PATH] }, keys);
    } else {
      if (legacy.length) model._pushList({ name: LEGACY_LIST_NAME, entries: legacy }, keys);
      for (const l of lists) model._pushList(l, keys);
    }

    const wanted = cfg?.activeWatchlistId;
    model._activeId = model._find(wanted) ? wanted : (model._lists[0]?.id ?? null);
    return model;
  }

  /** Normalize and append one list during construction (no event). @private */
  _pushList({ id, name, entries }, keys = new Set()) {
    const list = {
      id:      (typeof id === 'string' && id && !this._find(id)) ? id : this._nextId(),
      name:    cleanName(name) ?? LEGACY_LIST_NAME,
      entries: [],
    };
    this._noteId(list.id);
    for (const raw of Array.isArray(entries) ? entries : []) {
      const entry = normalizeEntry(raw);
      if (!entry) continue;
      entry.path = aliasWatchPath(entry.path, keys);
      if (!list.entries.some(e => e.path === entry.path)) list.entries.push(entry);
    }
    this._lists.push(list);
    return list;
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  /** The persisted shape (§8.1), deep-copied. Always carries `activeWatchlistId`. */
  toCfg() {
    return { watchlists: this._lists.map(cloneList), activeWatchlistId: this._activeId };
  }

  /** Write the persisted shape onto a cfg in place. */
  applyTo(cfg) {
    Object.assign(cfg, this.toCfg());
    return cfg;
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /** Every list, in order. */
  get lists()    { return this._lists.map(cloneList); }
  get activeId() { return this._activeId; }

  /** One list by id, or null. */
  list(id) {
    const l = this._find(id);
    return l ? cloneList(l) : null;
  }

  /** The active list, or null when there are none. */
  active() { return this.list(this._activeId); }

  /** Whether `path` is in a list (default: the active one). */
  has(path, listId = this._activeId) {
    return this._find(listId)?.entries.some(e => e.path === path) ?? false;
  }

  /** The charted paths of the active list, in list order: what the chart plots (W-D1). */
  chartedPaths() {
    return (this._find(this._activeId)?.entries ?? []).filter(e => e.charted).map(e => e.path);
  }

  /** Every path in every list, deduplicated: what is captured at full resolution (W-D2). */
  capturePaths() {
    return [...new Set(this._lists.flatMap(l => l.entries.map(e => e.path)))];
  }

  // ── Entries ───────────────────────────────────────────────────────────────

  /**
   * Add a watch to a list (default: the active one). Charted by default, which keeps
   * the State panel's "check it and it appears on the chart" gesture (W-D4).
   * @returns {boolean} false when there is no such list, the path is blank, or it is already there
   */
  add(path, { label = null, charted = true, axis = 'auto' } = {}, listId = this._activeId) {
    const list  = this._find(listId);
    const entry = normalizeEntry({ path, label, charted, axis });
    if (!list || !entry || list.entries.some(e => e.path === entry.path)) return false;
    list.entries.push(entry);
    this._emit('add', list.id, entry.path);
    return true;
  }

  /** @returns {boolean} false when the path is not in the list */
  remove(path, listId = this._activeId) {
    const list = this._find(listId);
    const i    = list?.entries.findIndex(e => e.path === path) ?? -1;
    if (i === -1) return false;
    list.entries.splice(i, 1);
    this._emit('remove', list.id, path);
    return true;
  }

  setCharted(path, charted, listId = this._activeId) {
    return this._updateEntry(path, listId, 'charted', !!charted);
  }

  /** A display label for the entry; blank clears it back to the derived label. */
  setLabel(path, label, listId = this._activeId) {
    return this._updateEntry(path, listId, 'label', cleanName(label));
  }

  setAxis(path, axis, listId = this._activeId) {
    if (!WATCH_AXES.includes(axis)) return false;
    return this._updateEntry(path, listId, 'axis', axis);
  }

  /** Move an entry from one position to another within its list. */
  moveEntry(from, to, listId = this._activeId) {
    const list = this._find(listId);
    if (!list || !this._moveIn(list.entries, from, to)) return false;
    this._emit('reorder', list.id);
    return true;
  }

  // ── Lists ─────────────────────────────────────────────────────────────────

  /** Create an empty list at the end and make it active. @returns {string} its id */
  create(name) {
    const list = { id: this._nextId(), name: cleanName(name) ?? LEGACY_LIST_NAME, entries: [] };
    this._noteId(list.id);
    this._lists.push(list);
    this._activeId = list.id;
    this._emit('create', list.id);
    return list.id;
  }

  /** @returns {boolean} false for an unknown id, a blank name, or no change */
  rename(id, name) {
    const list = this._find(id);
    const next = cleanName(name);
    if (!list || !next || next === list.name) return false;
    list.name = next;
    this._emit('rename', id);
    return true;
  }

  /** Copy a list (entries included) in after it, and make the copy active. @returns {string|null} */
  duplicate(id, name = null) {
    const src = this._find(id);
    if (!src) return null;
    const copy = { ...cloneList(src), id: this._nextId(), name: cleanName(name) ?? `${src.name} copy` };
    this._noteId(copy.id);
    this._lists.splice(this._lists.indexOf(src) + 1, 0, copy);
    this._activeId = copy.id;
    this._emit('duplicate', copy.id);
    return copy.id;
  }

  /**
   * Delete a list. Deleting the active one activates the list that takes its place
   * (or the one before, when it was last). Deleting the last list leaves none and
   * a null active id, which is a legitimate state and is never re-seeded (§5.4).
   */
  delete(id) {
    const i = this._lists.findIndex(l => l.id === id);
    if (i === -1) return false;
    this._lists.splice(i, 1);
    if (this._activeId === id) {
      this._activeId = (this._lists[i] ?? this._lists[i - 1])?.id ?? null;
    }
    this._emit('delete', id);
    return true;
  }

  /**
   * Append lists read from a definition file (W4 import, §8.1). Each list gets a fresh
   * id, a name made unique among the lists already here ("Markets (imported)"), and the same
   * normalization and `metrics.<stateKey>` aliasing as a load. The first imported list
   * becomes active. One `import` event, not one per entry.
   *
   * @param {{ name: string, entries: any[] }[]} lists
   * @param {Set<string>} [keys]  from balanceCopyKeys() of the target scenario
   * @returns {string[]} the new ids, in order
   */
  importLists(lists, keys = new Set()) {
    const ids = [];
    for (const l of Array.isArray(lists) ? lists : []) {
      if (l === null || typeof l !== 'object') continue;
      const name = this._uniqueName(cleanName(l.name) ?? LEGACY_LIST_NAME);
      ids.push(this._pushList({ name, entries: l.entries }, keys).id);
    }
    if (ids.length === 0) return ids;
    this._activeId = ids[0];
    this._emit('import', ids[0]);
    return ids;
  }

  setActive(id) {
    if (!this._find(id) || id === this._activeId) return false;
    this._activeId = id;
    this._emit('activate', id);
    return true;
  }

  moveList(from, to) {
    if (!this._moveIn(this._lists, from, to)) return false;
    this._emit('reorder-lists', this._lists[to].id);
    return true;
  }

  // ── Events ────────────────────────────────────────────────────────────────

  /**
   * Subscribe to changes. The listener gets `{ reason, watchlistId, path? }`; it is
   * not called for a no-op.
   * @returns {() => void} unsubscribe
   */
  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _find(id) {
    return id == null ? null : (this._lists.find(l => l.id === id) ?? null);
  }

  /**
   * `name`, or "name (imported)", "name (imported 2)", …, whichever is free. Not
   * "name (2)": the list picker already appends each list's size in parentheses, and
   * "Overview (2) (3)" reads as nonsense.
   */
  _uniqueName(name) {
    const taken = new Set(this._lists.map(l => l.name));
    if (!taken.has(name)) return name;
    for (let n = 1; ; n++) {
      const candidate = `${name} (imported${n === 1 ? '' : ` ${n}`})`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  _updateEntry(path, listId, field, value) {
    const list  = this._find(listId);
    const entry = list?.entries.find(e => e.path === path);
    if (!entry || entry[field] === value) return false;
    entry[field] = value;
    this._emit(field, list.id, path);
    return true;
  }

  _moveIn(arr, from, to) {
    const ok = i => Number.isInteger(i) && i >= 0 && i < arr.length;
    if (!ok(from) || !ok(to) || from === to) return false;
    arr.splice(to, 0, arr.splice(from, 1)[0]);
    return true;
  }

  /** Track a `w<n>` id so a generated one never collides with it, even after a delete. */
  _noteId(id) {
    const m = /^w(\d+)$/.exec(id);
    if (m) this._seq = Math.max(this._seq, Number(m[1]));
  }

  _nextId() {
    let id;
    do { id = `w${++this._seq}`; } while (this._find(id));
    return id;
  }

  _emit(reason, watchlistId, path) {
    const evt = path === undefined ? { reason, watchlistId } : { reason, watchlistId, path };
    for (const fn of [...this._listeners]) fn(evt);
  }
}
