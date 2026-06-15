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
 * CSV round-trip for the flat scenario parameter list (scenario.params).
 *
 * Pure, DOM-free helpers so they can be unit-tested directly. The scenario
 * panel (ScenarioTabView / ScenarioTabPresenter) wires file download/upload
 * around these.
 *
 * Format: long form, one row per param, with a header row.
 *   key,group,type,label,value,currency
 * On export every scalar param becomes a row. On import only `key` + `value`
 * (+ `currency` for Money params) are authoritative — `group`/`type`/`label`
 * are reference columns, ignored when reading back (the live param's own `type`
 * drives coercion). This keeps the round-trip robust to reordering, relabeling,
 * or dropped columns.
 *
 * Runtime param shape (see ScenarioRegistry / ScenarioLoader._toEntry):
 *   { name, label, type, group, value, options?, node?, hidden? }
 * `name` is the stable key (the schema's `key`).
 */

/** Param types that are flat scalars and therefore CSV-representable. */
export const CSV_SCALAR_TYPES = new Set(['Number', 'String', 'Boolean', 'Date', 'Enum', 'Money']);

const COLUMNS = ['key', 'group', 'type', 'label', 'value', 'currency'];

/** RFC-4180 field escaping: quote when the field contains ",\n\r and double inner quotes. */
function escapeCsv(field) {
  const s = field == null ? '' : String(field);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Format a param's live value for the CSV `value` column, by its declared type. */
function formatValue(param) {
  const v = param.value;
  switch (param.type) {
    case 'Date':
      return v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').slice(0, 10);
    case 'Boolean':
      return (v === true || v === 'true') ? 'true' : 'false';
    case 'Number':
    case 'Money':
      return v == null ? '' : String(v);
    default:
      return v == null ? '' : String(v);
  }
}

/**
 * Serialize a scenario's params to CSV text. Skips hidden params and any
 * non-scalar type (EnumMulti / ShockList stay JSON-only).
 *
 * @param {Array<object>} params
 * @returns {string} CSV text (CRLF line endings, trailing newline)
 */
export function paramsToCsv(params = []) {
  const lines = [COLUMNS.join(',')];
  for (const p of params) {
    if (!p || p.hidden) continue;
    if (!CSV_SCALAR_TYPES.has(p.type)) continue;
    if (!p.name) continue;
    lines.push([
      escapeCsv(p.name),
      escapeCsv(p.group ?? ''),
      escapeCsv(p.type ?? ''),
      escapeCsv(p.label ?? ''),
      escapeCsv(formatValue(p)),
      escapeCsv(p.type === 'Money' ? (p.currency ?? '') : ''),
    ].join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/**
 * Tolerant RFC-4180 parser. Returns an array of rows (each an array of string
 * fields). Handles quoted fields containing commas, quotes, and newlines, and
 * both CRLF and LF line endings.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  // Flush a trailing field/row (file without a final newline).
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Parse CSV text into `{ key, rawValue, rawCurrency }` updates. The `key` and
 * `value` columns are required; `currency` is optional (read for Money params).
 * All other columns are ignored. Blank lines and rows with an empty key are
 * skipped.
 *
 * @param {string} text
 * @returns {Array<{key:string, rawValue:string, rawCurrency:string}>}
 * @throws {Error} if the header lacks a `key` or `value` column
 */
export function csvToParamUpdates(text) {
  const rows = parseCsv(text).filter(r => !(r.length === 1 && r[0].trim() === ''));
  if (rows.length === 0) return [];

  const header = rows[0].map(h => h.trim().toLowerCase());
  const keyIdx = header.indexOf('key');
  const valIdx = header.indexOf('value');
  const curIdx = header.indexOf('currency');
  if (keyIdx === -1 || valIdx === -1) {
    throw new Error('CSV must have a header row with "key" and "value" columns');
  }

  const updates = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const key = (cells[keyIdx] ?? '').trim();
    if (!key) continue;
    updates.push({
      key,
      rawValue:    cells[valIdx] ?? '',
      rawCurrency: curIdx === -1 ? '' : (cells[curIdx] ?? ''),
    });
  }
  return updates;
}

/**
 * Coerce a raw CSV string into a param value, using the live param's declared
 * type. Returns `{ ok: true, value }` or `{ ok: false, error }`.
 *
 * @param {object} param  live param (carries type + optional options)
 * @param {string} rawValue
 */
export function coerceParamValue(param, rawValue) {
  const raw = String(rawValue ?? '').trim();
  switch (param.type) {
    case 'Number':
    case 'Money': {
      if (raw === '') return { ok: true, value: null };
      const n = Number(raw);
      if (!Number.isFinite(n)) return { ok: false, error: `not a number: "${raw}"` };
      return { ok: true, value: n };
    }
    case 'Boolean': {
      const l = raw.toLowerCase();
      if (l === 'true') return { ok: true, value: true };
      if (l === 'false' || l === '') return { ok: true, value: false };
      return { ok: false, error: `not a boolean: "${raw}"` };
    }
    case 'Date': {
      if (raw === '') return { ok: true, value: '' };
      if (Number.isNaN(Date.parse(raw))) return { ok: false, error: `not a date: "${raw}"` };
      return { ok: true, value: raw.slice(0, 10) };
    }
    case 'Enum': {
      if (Array.isArray(param.options) && param.options.length && !param.options.includes(raw)) {
        return { ok: false, error: `"${raw}" not one of [${param.options.join(', ')}]` };
      }
      return { ok: true, value: raw };
    }
    default:
      return { ok: true, value: raw };
  }
}
