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
 * record-edits.js — which parts of a scenario record a config-node Save owns.
 *
 * A node editor's Save (Person, Account, Property, …) changes the service maps, and Rebuild
 * harvests them into the record (`ScenarioSerializer.snapshotDomainRecords`). A RELOAD did
 * not see them until Save to Browser wrote the whole record — params included. Writing the
 * whole record from a node Save would also persist every in-flight Scenario-panel edit, and
 * that is exactly what the recovery overlay relies on NOT being in storage: its "discard the
 * unsaved changes" exit is the stored copy, offered only while it differs from the live one
 * and still compiles (`scenario-load-error-overlay.js`).
 *
 * So a node Save writes only the slice it owns into the STORED copy:
 *   - the record lists themselves, plus `deletedDefaults` (which records the user removed),
 *     `jobs` (the Person editor's Jobs table) and `securities` (the Security editor);
 *   - the generated params of those records. They are the cascade authority the loader
 *     writes ONTO the records at every load, so a record persisted without them would be
 *     overwritten by the stale stored value on the next reload.
 * Every other stored field and param is left exactly as stored.
 */

import { GENERATED_KEY_PREFIXES } from './params/generated-param-keys.js';

/** Top-level record fields a config-node Save owns. */
export const RECORD_FIELDS = Object.freeze([
  'persons', 'accounts', 'realProperties', 'collectibles', 'companyEquities', 'bequests',
  'deletedDefaults', 'jobs', 'securities',
]);

/**
 * The generated namespaces that belong to a RECORD. `pool.`, `gate.` and `shape.` are
 * generated too, but from the `liquidityGraph` param — authored in the Scenario panel, so
 * they are in-flight param edits like any other and stay out of a node Save.
 */
const NON_RECORD_PREFIXES = new Set(['pool.', 'gate.', 'shape.']);
export const RECORD_PARAM_PREFIXES = Object.freeze(
  GENERATED_KEY_PREFIXES.filter(p => !NON_RECORD_PREFIXES.has(p)));

/** True when `key` is a param generated from (and cascaded onto) a domain record. */
export function isRecordParamKey(key) {
  return typeof key === 'string' && RECORD_PARAM_PREFIXES.some(p => key.startsWith(p));
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/**
 * The stored record with the live record's node-owned slice laid over it.
 *
 * @param {object} stored  the persisted record (not mutated)
 * @param {object} live    the live scenario record, already harvested from the services
 * @returns {object} a new record: `stored`, with RECORD_FIELDS and record params from `live`
 */
export function mergeRecordEdits(stored, live) {
  const next = clone(stored);

  for (const field of RECORD_FIELDS) {
    if (live?.[field] === undefined) delete next[field];
    else next[field] = clone(live[field]);
  }

  // The typed list: keep the stored order and every non-record entry; record entries
  // become the live ones (a deleted record's params go with it, a new one's are added).
  const liveRecordParams = (Array.isArray(live?.params) ? live.params : [])
    .filter(p => isRecordParamKey(p?.name));
  const liveByName = new Map(liveRecordParams.map(p => [p.name, p]));
  const params = [];
  const seen = new Set();
  for (const p of (Array.isArray(next.params) ? next.params : [])) {
    if (!isRecordParamKey(p?.name)) { params.push(p); continue; }
    const fresh = liveByName.get(p.name);
    if (fresh) { params.push(clone(fresh)); seen.add(p.name); }
  }
  for (const p of liveRecordParams) if (!seen.has(p.name)) params.push(clone(p));
  if (Array.isArray(next.params) || params.length) next.params = params;

  // The flat bag, only where the stored copy keeps one (two-param-stores: a bag holding
  // nothing but record keys would read every other param as unset).
  if (next.parameters && typeof next.parameters === 'object') {
    for (const key of Object.keys(next.parameters)) {
      if (isRecordParamKey(key)) delete next.parameters[key];
    }
    for (const [key, value] of Object.entries(live?.parameters ?? {})) {
      if (isRecordParamKey(key)) next.parameters[key] = clone(value);
    }
  }

  return next;
}
