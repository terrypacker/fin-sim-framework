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
 * year-date-migration.js — year fields that became Dates (design 117), and what a saved
 * plan, param bag or sweep config that still carries one becomes.
 *
 * The rule (design 117 D3): a year converts to EXACTLY the date the code built from it
 * before, so a migrated plan produces the same numbers. A sale or a purchase in year Y
 * ran on 15 January of Y, so it becomes `Y-01-15`.
 *
 * Phase 2 covers the sale and purchase years:
 *
 *   record field        plannedSaleYear → plannedSaleDate   (property, collectible, company,
 *                                                            and a bequest's inline assets)
 *                       purchaseYear    → purchaseDate      (property)
 *   generated key       prop.<sk>.plannedSaleYear → prop.<sk>.plannedSaleDate (coll., equity. too)
 *   retired flat keys   usHouseSaleYear, auHouseSaleYear, companySaleYear → the generated key
 *
 * Every function here is IDEMPOTENT and cheap, because a cfg reaches the engine by more
 * than one road and each one calls it: `ScenarioLoader.load`, `applyParamBagToConfig` (a
 * MC iteration or an optimizer candidate is applied BEFORE the loader runs),
 * `resolveRecordCenters` (the sweep harvest reads an unloaded cfg) and the record
 * deserializers. A road that skipped it would leave a lever silently inert — the failure
 * designs 98 and 25a both met.
 */

/** A sale or purchase in year Y ran on 15 January of Y (design 117 §6.1). */
export const SALE_MONTH0 = 0;
export const SALE_DAY    = 15;

/** Record field renames, by the field's old name. */
export const RECORD_FIELD_RENAMES = Object.freeze({
  plannedSaleYear: 'plannedSaleDate',
  purchaseYear:    'purchaseDate',
});

/** Generated-key prefix → the cascade node type, for the records phase 2 converts. */
const NODE_TYPE_BY_PREFIX = Object.freeze({ prop: 'realProperty', coll: 'collectible', equity: 'companyEquity' });
const PREFIX_BY_NODE_TYPE = Object.freeze(Object.fromEntries(
  Object.entries(NODE_TYPE_BY_PREFIX).map(([p, t]) => [t, p])));

/**
 * Retired flat keys → the generated key that replaced them. `companySaleYear` was
 * node-linked to `companyEquityAccount`; a typed entry's own node wins when it has one.
 */
export const RETIRED_SALE_YEAR_KEYS = Object.freeze({
  usHouseSaleYear: 'prop.usHouseProperty.plannedSaleDate',
  auHouseSaleYear: 'prop.auHouseProperty.plannedSaleDate',
  companySaleYear: 'equity.companyEquityAccount.plannedSaleDate',
});

const _pad2 = (n) => String(n).padStart(2, '0');

/**
 * A calendar year → `YYYY-MM-DD` on (month0, day). Null for null / '' / a non-number,
 * which is how a blank year ("no sale") stays blank.
 */
export function yearToIsoDate(year, month0 = SALE_MONTH0, day = SALE_DAY) {
  if (year == null || year === '') return null;
  const y = Math.round(Number(year));
  if (!Number.isFinite(y)) return null;
  return `${y}-${_pad2(month0 + 1)}-${_pad2(day)}`;
}

/** A year as a sale/purchase date. */
export const saleDateFromYear = (year) => yearToIsoDate(year);

/**
 * A value that is already a date passes through as `YYYY-MM-DD`; a number is a legacy
 * year and converts. Anything else is returned as it is, for the loader to reject.
 */
export function toSaleDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return saleDateFromYear(v);
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v === 'string' && /^\d{4}$/.test(v.trim())) return saleDateFromYear(Number(v));
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString().slice(0, 10);
  return v;
}

/**
 * A sale or purchase date as the UTC midnight its event fires at. For a migrated year this
 * is exactly the `Date.UTC(Y, 0, 15)` the toolsets built before (design 117 D3).
 * @returns {Date|null}
 */
export function saleDateToUtc(v) {
  const iso = toSaleDate(v);
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** The calendar year of a sale/purchase date (or of a legacy year), or null. */
export function yearOfDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Math.round(v);
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? new Date(t).getUTCFullYear() : null;
}

/**
 * The new key for a param key, or null when it is not one this migration renames.
 * `node` (a typed entry's cascade node) decides a retired flat key's record.
 */
export function migratedParamKey(key, node = null) {
  if (typeof key !== 'string') return null;
  if (Object.hasOwn(RETIRED_SALE_YEAR_KEYS, key)) {
    const prefix = PREFIX_BY_NODE_TYPE[node?.type];
    return prefix && node?.stateKey ? `${prefix}.${node.stateKey}.plannedSaleDate`
      : RETIRED_SALE_YEAR_KEYS[key];
  }
  const firstDot = key.indexOf('.');
  const lastDot  = key.lastIndexOf('.');
  if (firstDot < 0 || lastDot === firstDot) return null;
  const prefix = key.slice(0, firstDot);
  const field  = key.slice(lastDot + 1);
  if (!NODE_TYPE_BY_PREFIX[prefix] || !Object.hasOwn(RECORD_FIELD_RENAMES, field)) return null;
  return `${key.slice(0, lastDot)}.${RECORD_FIELD_RENAMES[field]}`;
}

/**
 * A flat param bag with every renamed key moved and its year converted. Returns the same
 * object when nothing changes, else a copy; the caller's bag (a run's recorded params) is
 * never mutated.
 *
 * Several keys can name one quantity: an old MC run recorded BOTH the flat
 * `usHouseSaleYear` and `prop.usHouseProperty.plannedSaleYear`, one moved by the lever and
 * one at the plan value. Keeping a fixed one would make every cell of a grid on the other
 * run the plan's sale — the inert-lever failure `reconcileAliasPairs` exists for. So, given
 * `planOf(newKey)` (the cfg's own value), the key that DIFFERS from the plan wins; with no
 * plan to compare, or none differing, the new key wins, then the old generated key, then
 * the flat key.
 *
 * @param {object} bag
 * @param {object} [opts]
 * @param {function(string): *} [opts.planOf]  the plan's own value for a new key
 * @param {function(string): ?string} [opts.keyFor] the new key for an old one, when the
 *        caller knows better than the default (a retired flat key's record, from its typed
 *        entry's node); null falls back to `migratedParamKey`
 */
export function migrateParamBag(bag, { planOf = null, keyFor = null } = {}) {
  if (!bag || typeof bag !== 'object') return bag;
  const byTarget = new Map();     // new key → old keys, in key order
  for (const key of Object.keys(bag)) {
    const next = keyFor?.(key) ?? migratedParamKey(key);
    if (!next) continue;
    if (!byTarget.has(next)) byTarget.set(next, []);
    byTarget.get(next).push(key);
  }
  if (byTarget.size === 0) return bag;
  const flatLast = (a, b) => Number(Object.hasOwn(RETIRED_SALE_YEAR_KEYS, a))
    - Number(Object.hasOwn(RETIRED_SALE_YEAR_KEYS, b));
  const out = { ...bag };
  for (const [next, olds] of byTarget) {
    const candidates = [
      ...(Object.hasOwn(bag, next) ? [toSaleDate(bag[next])] : []),
      ...olds.sort(flatLast).map(k => toSaleDate(bag[k])),
    ];
    let value = candidates[0];
    const own = planOf ? planOf(next) : undefined;
    if (own !== undefined) {
      const plan  = toSaleDate(own);
      const moved = candidates.find(v => v !== plan);
      if (moved !== undefined) value = moved;
    }
    out[next] = value;
    for (const k of olds) delete out[k];
  }
  return out;
}

/**
 * Rename one asset record's year fields in place. With `normalize`, a date already
 * present but stored as a Date or a full ISO string is cut to `YYYY-MM-DD`. Never applied
 * to a state entry that is not an asset: a holding's `purchaseDate` is epoch ms, and
 * reading it as a year would be a silent corruption.
 */
function _migrateRecord(rec, { normalize = true } = {}) {
  if (!rec || typeof rec !== 'object') return;
  for (const [oldField, newField] of Object.entries(RECORD_FIELD_RENAMES)) {
    if (!Object.hasOwn(rec, oldField)) continue;
    if (rec[newField] === undefined) rec[newField] = toSaleDate(rec[oldField]);
    delete rec[oldField];
  }
  if (!normalize) return;
  for (const newField of Object.values(RECORD_FIELD_RENAMES)) {
    const v = rec[newField];
    if (v instanceof Date || (typeof v === 'string' && v.length > 10)) rec[newField] = toSaleDate(v);
  }
}

/** The state-entry kinds that carry a sale or purchase year. */
const ASSET_STATE_KINDS = new Set(['real-property', 'collectible', 'company']);

/** Rename one typed param entry in place, or report that it is superseded. */
function _migrateTypedParam(p) {
  const next = migratedParamKey(p?.name, p?.node);
  if (!next) return null;
  const field = next.slice(next.lastIndexOf('.') + 1);
  p.name  = next;
  p.type  = 'Date';
  p.value = toSaleDate(p.value);
  if (p.defaultValue !== undefined) p.defaultValue = toSaleDate(p.defaultValue);
  if (p.node && Object.hasOwn(RECORD_FIELD_RENAMES, p.node.field)) p.node = { ...p.node, field };
  return next;
}

/**
 * Convert a scenario cfg's sale and purchase years to dates, in place (design 117
 * phase 2). Records, a bequest's inline assets, the typed `cfg.params` list, the flat
 * `cfg.parameters` bag and a saved `cfg.initialState` are all covered. Idempotent.
 *
 * @param {object} cfg
 * @returns {object} the same cfg
 */
export function migrateYearFieldsToDates(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  for (const list of [cfg.realProperties, cfg.collectibles, cfg.companyEquities]) {
    for (const rec of (Array.isArray(list) ? list : [])) _migrateRecord(rec);
  }
  for (const b of (Array.isArray(cfg.bequests) ? cfg.bequests : [])) {
    for (const a of (Array.isArray(b?.assets) ? b.assets : [])) _migrateRecord(a);
  }
  if (cfg.initialState && typeof cfg.initialState === 'object') {
    for (const entry of Object.values(cfg.initialState)) {
      if (ASSET_STATE_KINDS.has(entry?.kind)) _migrateRecord(entry, { normalize: false });
    }
  }

  // A retired flat key's record comes from its typed entry's node, so the flat bag must
  // move it to the same record the typed entry does.
  const keyByOldName = new Map();
  if (Array.isArray(cfg.params)) {
    const renamed = new Set();
    for (const p of cfg.params) {
      const old  = p?.name;
      const next = _migrateTypedParam(p);
      if (next) { renamed.add(p); keyByOldName.set(old, next); }
    }
    if (renamed.size) {
      // Two entries for one key (a saved legacy key beside its generated successor): keep
      // the one that was already new — it is what the plan has been running — in the
      // position of the key's first entry.
      const chosen = new Map();
      for (const p of cfg.params) {
        const prev = chosen.get(p.name);
        if (!prev || (renamed.has(prev) && !renamed.has(p))) chosen.set(p.name, p);
      }
      const placed = new Set();
      cfg.params = cfg.params.flatMap(p => {
        if (placed.has(p.name)) return [];
        placed.add(p.name);
        return [chosen.get(p.name)];
      });
    }
  }
  if (cfg.parameters && typeof cfg.parameters === 'object') {
    const next = migrateParamBag(cfg.parameters, { keyFor: (k) => keyByOldName.get(k) ?? null });
    if (next !== cfg.parameters) cfg.parameters = next;
  }
  return cfg;
}

// ─── Saved sweep configs ────────────────────────────────────────────────────

const DAYS_PER_YEAR = 365.25;

/**
 * A saved Monte Carlo row for a renamed key, converted: the key moves, a NORMAL year
 * becomes a NORMAL_DATE (σ in days, so a saved sweep keeps its shape — design 117 D10),
 * a UNIFORM year range becomes UNIFORM_DATE, a CONSTANT year becomes a date. Any other
 * row is returned unchanged (the same object).
 *
 * @param {object} v  a saved MC variable config
 * @returns {object}
 */
export function migrateMcVariableConfig(v) {
  const next = migratedParamKey(v?.paramKey);
  if (!next) return v;
  const out = { ...v, paramKey: next };
  delete out.integer;
  switch (v.type) {
    case 'normal':
      out.type = 'normalDate';
      if (v.mean != null) out.mean = toSaleDate(v.mean);
      if (v.stdDev != null) out.stdDev = Math.round(Number(v.stdDev) * DAYS_PER_YEAR);
      break;
    case 'uniform':
      out.type = 'uniformDate';
      out.min = toSaleDate(v.min);
      out.max = toSaleDate(v.max);
      break;
    case 'constant':
      out.value = toSaleDate(v.value);
      break;
    default:
      break;
  }
  return out;
}

/**
 * A saved optimizer row for a renamed key, converted: an INTEGER year range becomes a
 * DATE range on the same day, its step in months (design 117 §6.2). Any other row is
 * returned unchanged (the same object).
 */
export function migrateOptVariableConfig(v) {
  const next = migratedParamKey(v?.paramKey);
  if (!next) return v;
  const out = { ...v, paramKey: next };
  if (v.type === 'integer' || v.type === 'continuous') {
    out.type = 'date';
    out.min  = toSaleDate(v.min);
    out.max  = toSaleDate(v.max);
    out.step = Math.max(1, Math.round(Number(v.step ?? 1) * 12));
  }
  return out;
}
