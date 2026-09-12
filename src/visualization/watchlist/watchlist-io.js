/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { get }      from '../../finance/monte-carlo/mc-param-paths.js';
import { stripBom } from '../../utils/csv.js';

/**
 * Watchlist export and import — design 101 W4 (§8.1). Pure: no DOM, no model.
 *
 * Two of §8.1's three export forms live here (the third, "with the scenario", is
 * automatic because `serializeScenario` carries the key):
 *
 *   - **Definition JSON**: one list or all of them, to move between scenarios. It
 *     carries names and entries but no ids, since ids are per scenario and an import
 *     is given fresh ones.
 *   - **Series CSV**: the active list's captured values over time, one column per
 *     entry, with a column saying how finely each row was captured.
 */

export const WATCHLIST_FORMAT         = 'finsim.watchlists';
export const WATCHLIST_FORMAT_VERSION = 1;

/**
 * The definition file for some lists.
 * @param {{ name: string, entries: object[] }[]} lists
 */
export function toDefinition(lists, { exportedAt = new Date() } = {}) {
  return {
    format:     WATCHLIST_FORMAT,
    version:    WATCHLIST_FORMAT_VERSION,
    exportedAt: new Date(exportedAt).toISOString(),
    watchlists: (lists ?? []).map(({ name, entries }) => ({
      name,
      entries: (entries ?? []).map(({ path, label, charted, axis }) => ({ path, label, charted, axis })),
    })),
  };
}

/**
 * Read a definition file into `[{ name, entries }]`, ready for
 * `WatchlistModel.importLists` (which normalizes and aliases each entry).
 *
 * Besides our own format it accepts anything with a `watchlists` array, which covers a
 * scenario cfg, including the legacy `string[]` shape. It throws an Error whose message
 * is fit to show the user.
 *
 * @param {string|object} input  file text, or already-parsed JSON
 * @returns {{ name: string, entries: any[] }[]}
 */
export function parseDefinition(input) {
  let data = input;
  if (typeof input === 'string') {
    try { data = JSON.parse(stripBom(input)); }
    catch (e) { throw new Error(`The file is not valid JSON (${e.message}).`); }
  }
  if (data?.format != null && data.format !== WATCHLIST_FORMAT) {
    throw new Error(`The file is not a watchlist export (its format is "${data.format}").`);
  }
  if (data?.format === WATCHLIST_FORMAT && !(Number(data.version) <= WATCHLIST_FORMAT_VERSION)) {
    throw new Error(`The file was made by a newer version (format version ${data.version}); `
      + `this app reads version ${WATCHLIST_FORMAT_VERSION}.`);
  }
  const raw = Array.isArray(data?.watchlists) ? data.watchlists : null;
  if (!raw) {
    throw new Error('The file has no "watchlists" array. Export one from the Watchlist panel, '
      + 'or use a scenario JSON that has watchlists.');
  }
  const strings = raw.filter(x => typeof x === 'string');
  const lists = [
    ...(strings.length ? [{ name: 'Watchlist', entries: strings }] : []),
    ...raw.filter(x => x !== null && typeof x === 'object' && !Array.isArray(x))
      .map(l => ({ name: l.name, entries: Array.isArray(l.entries) ? l.entries : [] })),
  ];
  if (!lists.length) throw new Error('The file has no watchlists in it.');
  return lists;
}

/**
 * The paths among `lists` that do not resolve in `state`, deduplicated, in order. A
 * different scenario names different stateKeys and holding ids, and an import keeps
 * those entries (muted in the panel) rather than dropping them (§8.1). Returns null when
 * there is no state to check against.
 */
export function unresolvedPaths(lists, state) {
  if (!state) return null;
  const out = new Set();
  for (const l of lists ?? []) {
    for (const e of l.entries ?? []) {
      const path = typeof e === 'string' ? e : e?.path;
      if (typeof path !== 'string' || out.has(path)) continue;
      const v = get(state, path);
      if (v == null || (typeof v === 'number' && !Number.isFinite(v))) out.add(path);
    }
  }
  return [...out];
}

/**
 * The series CSV (§8.1 form 3): `date, <one column per entry>, resolution`.
 *
 * - **One row per day.** The engine steps in days, and several events on one day
 *   leave several captured points; the last is the state at the end of that day.
 * - **A blank cell** means no value was captured that day. Nothing is carried forward,
 *   so a snapshot-resolution column reads as sparse rather than as flat.
 * - **`resolution`** is `full` when every value in the row came from the live capture,
 *   `snapshot` when all came from snapshot backfill (a field watched after the run, at
 *   about one point a year), and `mixed` otherwise.
 * - **Values are as they are in state**, in each account's own currency, which the
 *   caller puts in the header. They are not converted to the display currency.
 *
 * @param {{ path: string, header: string, series: {date, value}[], backfilled: boolean }[]} columns
 * @returns {string|null}  null when nothing has been captured
 */
export function buildSeriesCsv(columns) {
  const cols = columns ?? [];
  const rows = new Map();   // 'YYYY-MM-DD' → value per column
  cols.forEach((c, i) => {
    for (const p of c.series ?? []) {
      if (typeof p?.value !== 'number' || !Number.isFinite(p.value)) continue;
      const day = new Date(p.date).toISOString().slice(0, 10);
      if (!rows.has(day)) rows.set(day, new Array(cols.length).fill(null));
      rows.get(day)[i] = p.value;
    }
  });
  if (rows.size === 0) return null;

  // Two entries with the same label (a label is the user's) would give two identical
  // headers; the path tells them apart.
  const seen    = new Map();
  for (const c of cols) seen.set(c.header, (seen.get(c.header) ?? 0) + 1);
  const headers = cols.map(c => (seen.get(c.header) > 1 ? `${c.header} [${c.path}]` : c.header));

  const lines = [['date', ...headers, 'resolution'].map(_cell).join(',')];
  for (const day of [...rows.keys()].sort()) {
    const values = rows.get(day);
    const kinds  = new Set(values.flatMap((v, i) => (v == null ? [] : [cols[i].backfilled ? 'snapshot' : 'full'])));
    const res    = kinds.size === 1 ? [...kinds][0] : 'mixed';
    lines.push([day, ...values.map(v => (v == null ? '' : String(v))), res].map(_cell).join(','));
  }
  return lines.join('\n');
}

/**
 * One CSV cell. A text cell that a spreadsheet would read as a formula gets a leading
 * apostrophe: labels come from the user, and an imported definition carries someone
 * else's.
 */
function _cell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
