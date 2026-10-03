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
 * Phase 3 adds:
 *
 *   bequest             inheritanceYear + inheritanceMonth + inheritanceDay → inheritanceDate
 *                       (`bequest.<sk>.inheritanceYear` → `bequest.<sk>.inheritanceDate`)
 *   401(k) rollover     the scenario params k401ToIraConversionYear / Month / Day → each
 *                       person's `k401ToIraConversionDate`, every missing part filled from
 *                       THAT person's retirement date, as us-retirement-toolset did (D9)
 *
 * Phase 4 adds the two moves, Dates pinned to a tax-year boundary (design 117 D5, D8):
 *
 *   moveYear Y        → moveDate      'Y-07-01'   (the AU financial year starts 1 Jul)
 *   stateMoveYear Y   → stateMoveDate 'Y-01-01'   (a state move is pinned to 1 Jan)
 *
 * `DATE_ANCHORS` is the one table of pinned dates: the schema, this migration, the MC and
 * Opt rows, the param editor and the scripts all read it.
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

/** Generated-key prefix → the cascade node type, for the records phases 2–3 convert. */
const NODE_TYPE_BY_PREFIX = Object.freeze({ prop: 'realProperty', coll: 'collectible', equity: 'companyEquity',
  bequest: 'bequest' });

/** Generated-key field renames (the record fields above, plus a bequest's year). */
const KEY_FIELD_RENAMES = Object.freeze({ ...RECORD_FIELD_RENAMES, inheritanceYear: 'inheritanceDate' });

/** The three scenario params the per-person rollover date replaced (design 117 D9). */
export const RETIRED_ROLLOVER_KEYS = Object.freeze(
  ['k401ToIraConversionYear', 'k401ToIraConversionMonth', 'k401ToIraConversionDay']);
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

/**
 * Date params pinned to one day of the year (design 117 D5): key → 'MM-DD'. Until
 * part-year tax is modelled (phase 7) a move on any other day would be taxed wrongly, so
 * the toolsets reject one (`assertOnAnchor`) and every sweep snaps to the day.
 */
export const DATE_ANCHORS = Object.freeze({
  moveDate:      '07-01',   // the AU settle taxes only the resident part of a 1 Jul–30 Jun year
  stateMoveDate: '01-01',   // design 34 §9.1: the destination state taxes the whole calendar year
});

/** The retired move YEAR keys → their anchored date successors. */
export const RETIRED_MOVE_YEAR_KEYS = Object.freeze({ moveYear: 'moveDate', stateMoveYear: 'stateMoveDate' });

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

/** The anchor of a pinned date key as { month0, day }, or null. */
function _anchorOf(key) {
  const a = DATE_ANCHORS[key];
  if (!a) return null;
  const [mm, dd] = a.split('-').map(Number);
  return { month0: mm - 1, day: dd };
}

/**
 * A year as the date it means under `key`: the key's anchor day when it is pinned
 * (`moveDate` → 1 Jul), else a sale's 15 Jan.
 */
export function dateFromYearFor(key, year) {
  const a = _anchorOf(key);
  return a ? yearToIsoDate(year, a.month0, a.day) : yearToIsoDate(year);
}

/** A value as the date it means under `key`: a number is a year (see dateFromYearFor). */
export function toDateFor(key, v) {
  return typeof v === 'number' || (typeof v === 'string' && /^\d{4}$/.test(v.trim()))
    ? dateFromYearFor(key, Number(v)) : toSaleDate(v);
}

/**
 * Throw when a pinned date param is set off its anchor day (design 117 D5). The error is
 * the point: until part-year tax exists (phase 7), a move on another day would be taxed as
 * if it fell on the boundary, which is a silently wrong answer.
 *
 * @param {string} key    the param key ('moveDate', 'stateMoveDate')
 * @param {*}      value  its value; null/undefined is "no move" and passes
 * @returns {string|null} the value as 'YYYY-MM-DD'
 */
export function assertOnAnchor(key, value) {
  if (value == null || value === '') return null;
  const iso = toDateFor(key, value);
  const anchor = DATE_ANCHORS[key];
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new Error(`${key}: "${value}" is not a date ('YYYY-MM-DD').`);
  }
  if (anchor && iso.slice(5) !== anchor) {
    throw new Error(`${key} must fall on ${anchor} (MM-DD) until part-year tax residency is `
      + `modelled (design 117 D5); got ${iso}. Pick the year — the day is fixed.`);
  }
  return iso;
}

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
  if (Object.hasOwn(RETIRED_MOVE_YEAR_KEYS, key)) return RETIRED_MOVE_YEAR_KEYS[key];
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
  if (!NODE_TYPE_BY_PREFIX[prefix] || !Object.hasOwn(KEY_FIELD_RENAMES, field)) return null;
  return `${key.slice(0, lastDot)}.${KEY_FIELD_RENAMES[field]}`;
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
 * @param {function(string, *): *} [opts.toDate] the date an old value becomes under a new
 *        key (a bequest's year keeps its own month and day); default `toSaleDate`
 * @param {Array<object>} [opts.persons] the cfg's people: with them, the retired rollover
 *        params become each 401(k) owner's `person.<id>.k401ToIraConversionDate`. Without
 *        them the three keys are left as they are — nothing reads them, and no single date
 *        can stand for them (design 117 D9).
 */
export function migrateParamBag(bag, { planOf = null, keyFor = null, toDate = null, persons = null } = {}) {
  if (!bag || typeof bag !== 'object') return bag;
  const conv = (next, v) => (toDate ? toDate(next, v) : toDateFor(next, v));
  let rolled = bag;
  if (persons && RETIRED_ROLLOVER_KEYS.some(k => Object.hasOwn(bag, k))) {
    rolled = { ...bag };
    for (const [key, date] of rolloverDatesFor(persons, _rolloverParts(bag))) {
      if (!Object.hasOwn(rolled, key)) rolled[key] = date;
    }
    for (const k of RETIRED_ROLLOVER_KEYS) delete rolled[k];
    bag = rolled;
  }
  const byTarget = new Map();     // new key → old keys, in key order
  for (const key of Object.keys(bag)) {
    const next = keyFor?.(key) ?? migratedParamKey(key);
    if (!next) continue;
    if (!byTarget.has(next)) byTarget.set(next, []);
    byTarget.get(next).push(key);
  }
  if (byTarget.size === 0) return rolled;
  const flatLast = (a, b) => Number(Object.hasOwn(RETIRED_SALE_YEAR_KEYS, a))
    - Number(Object.hasOwn(RETIRED_SALE_YEAR_KEYS, b));
  const out = { ...bag };
  for (const [next, olds] of byTarget) {
    const candidates = [
      ...(Object.hasOwn(bag, next) ? [conv(next, bag[next])] : []),
      ...olds.sort(flatLast).map(k => conv(next, bag[k])),
    ];
    let value = candidates[0];
    const own = planOf ? planOf(next) : undefined;
    if (own !== undefined) {
      const plan  = toDateFor(next, own);
      const moved = candidates.find(v => v !== plan);
      if (moved !== undefined) value = moved;
    }
    out[next] = value;
    for (const k of olds) delete out[k];
  }
  return out;
}

/** The rollover parts a param source carries: { year, month (1–12), day }, each or null. */
function _rolloverParts(get) {
  const read = typeof get === 'function' ? get : (k) => get?.[k];
  const num  = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    year:  num(read('k401ToIraConversionYear')),
    month: num(read('k401ToIraConversionMonth')),
    day:   num(read('k401ToIraConversionDay')),
  };
}

/**
 * The per-person rollover dates the retired scenario params meant (design 117 D9), as
 * `[generatedKey, 'YYYY-MM-DD']` pairs. A part left blank was filled from the OWNER's
 * retirement date — one shared year therefore named a different day for each person — so
 * each date is resolved here per person, exactly as us-retirement-toolset did. A person
 * with no retirement date had no rollover then and gets none now. All parts blank means
 * "at separation", which a blank person field still means: no pair is emitted.
 *
 * @param {Array<object>} persons  cfg person records (`id`, `retirementDate`)
 * @param {{year, month, day}} parts
 * @returns {Array<[string, string]>}
 */
export function rolloverDatesFor(persons, parts) {
  if (!parts || (parts.year == null && parts.month == null && parts.day == null)) return [];
  const out = [];
  for (const person of (Array.isArray(persons) ? persons : [])) {
    const t = person?.retirementDate == null ? NaN
      : (person.retirementDate instanceof Date ? person.retirementDate.getTime() : Date.parse(person.retirementDate));
    if (!person?.id || !Number.isFinite(t)) continue;
    const r = new Date(t);
    const year  = parts.year  ?? r.getUTCFullYear();
    const month = (parts.month ?? (r.getUTCMonth() + 1)) - 1;
    const day   = parts.day   ?? r.getUTCDate();
    // Date.UTC normalizes an out-of-range day the way the toolset's Date.UTC did.
    out.push([`person.${person.id}.k401ToIraConversionDate`,
      new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10)]);
  }
  return out;
}

/**
 * A bequest's inheritance year, month and day as one date, in place. The month (0-based)
 * and day were hidden fields defaulting to January and the 15th, which is what
 * bequest-service built the INHERIT event from.
 */
function _migrateBequest(b) {
  if (!b || typeof b !== 'object') return;
  if (Object.hasOwn(b, 'inheritanceYear')) {
    if (b.inheritanceDate === undefined) {
      b.inheritanceDate = yearToIsoDate(b.inheritanceYear, b.inheritanceMonth ?? 0, b.inheritanceDay ?? 15);
    }
    delete b.inheritanceYear;
  }
  delete b.inheritanceMonth;
  delete b.inheritanceDay;
  const v = b.inheritanceDate;
  if (v instanceof Date || (typeof v === 'string' && v.length > 10)) b.inheritanceDate = toSaleDate(v);
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
function _migrateTypedParam(p, conv) {
  const next = migratedParamKey(p?.name, p?.node);
  if (!next) return null;
  const field = next.slice(next.lastIndexOf('.') + 1);
  p.name  = next;
  p.type  = 'Date';
  p.value = conv(next, p.value);
  if (p.defaultValue !== undefined) p.defaultValue = conv(next, p.defaultValue);
  if (p.node && Object.hasOwn(KEY_FIELD_RENAMES, p.node.field)) p.node = { ...p.node, field };
  return next;
}

/**
 * Convert a scenario cfg's year fields to dates, in place (design 117 phases 2–3): sale
 * and purchase years, a bequest's inheritance year, and the 401(k) rollover params.
 * Records, a bequest's inline assets, the typed `cfg.params` list, the flat
 * `cfg.parameters` bag and a saved `cfg.initialState` are all covered. Idempotent.
 *
 * @param {object} cfg
 * @returns {object} the same cfg
 */
export function migrateYearFieldsToDates(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;

  // A bequest's generated year param keeps the bequest's own month and day, so read them
  // before the records lose them.
  const bequestDay = new Map();
  for (const b of (Array.isArray(cfg.bequests) ? cfg.bequests : [])) {
    const sk = b?.stateKey ?? b?.id;
    if (sk != null) bequestDay.set(`bequest.${sk}.inheritanceDate`, [b.inheritanceMonth ?? 0, b.inheritanceDay ?? 15]);
  }
  const conv = (next, v) => {
    const md = bequestDay.get(next);
    return md && typeof v === 'number' ? yearToIsoDate(v, md[0], md[1]) : toDateFor(next, v);
  };

  // The 401(k) rollover parts, typed entry first (the live store), then the flat bag.
  const typedValue = (k) => {
    const e = Array.isArray(cfg.params) ? cfg.params.find(p => p?.name === k) : undefined;
    return e ? e.value : cfg.parameters?.[k];
  };
  const rollover = rolloverDatesFor(cfg.persons, _rolloverParts(typedValue));
  for (const [key, date] of rollover) {
    const id = key.slice('person.'.length, key.lastIndexOf('.'));
    const person = cfg.persons.find(pe => pe?.id === id);
    if (person && person.k401ToIraConversionDate == null) person.k401ToIraConversionDate = date;
  }
  if (Array.isArray(cfg.params)) cfg.params = cfg.params.filter(p => !RETIRED_ROLLOVER_KEYS.includes(p?.name));
  if (cfg.parameters && RETIRED_ROLLOVER_KEYS.some(k => Object.hasOwn(cfg.parameters, k))) {
    cfg.parameters = { ...cfg.parameters };
    for (const k of RETIRED_ROLLOVER_KEYS) delete cfg.parameters[k];
  }

  for (const b of (Array.isArray(cfg.bequests) ? cfg.bequests : [])) _migrateBequest(b);
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
      const next = _migrateTypedParam(p, conv);
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
    const next = migrateParamBag(cfg.parameters, { keyFor: (k) => keyByOldName.get(k) ?? null, toDate: conv });
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
  const day = (x) => toDateFor(next, x);
  if (DATE_ANCHORS[next]) out.anchor = DATE_ANCHORS[next];   // every draw lands on the day
  switch (v.type) {
    case 'normal':
      out.type = 'normalDate';
      if (v.mean != null) out.mean = day(v.mean);
      if (v.stdDev != null) out.stdDev = Math.round(Number(v.stdDev) * DAYS_PER_YEAR);
      break;
    case 'uniform':
      out.type = 'uniformDate';
      out.min = day(v.min);
      out.max = day(v.max);
      break;
    case 'constant':
      out.value = day(v.value);
      break;
    default:
      break;
  }
  return out;
}

/**
 * A saved optimizer row for a renamed key, converted: an INTEGER year range becomes a
 * DATE range on the same day, its step in months — or in years, on its anchor day, for a
 * pinned date (design 117 §6.2). Any other row is
 * returned unchanged (the same object).
 */
export function migrateOptVariableConfig(v) {
  const next = migratedParamKey(v?.paramKey);
  if (!next) return v;
  const out = { ...v, paramKey: next };
  if (v.type === 'integer' || v.type === 'continuous') {
    const anchor = DATE_ANCHORS[next];
    out.type = 'date';
    out.min  = toDateFor(next, v.min);
    out.max  = toDateFor(next, v.max);
    // A pinned date steps in whole years (design 117 §5.1); any other in months.
    out.step = anchor ? Math.max(1, Math.round(Number(v.step ?? 1)))
      : Math.max(1, Math.round(Number(v.step ?? 1) * 12));
    if (anchor) out.anchor = anchor;
  }
  return out;
}
