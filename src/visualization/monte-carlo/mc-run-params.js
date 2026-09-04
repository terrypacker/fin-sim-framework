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
 * Cross-run statistics for the param bags a Monte Carlo batch produced.
 *
 * The question a user opens a run's params to answer is not "what were the params" —
 * it is "what was DIFFERENT about this one". A bag carries every scenario param,
 * ~100 of them, of which perhaps a dozen were actually sampled; listing all of them
 * in bag order buries the answer. So the paths are split by whether they VARY across
 * the batch, and the varying ones are ranked per run by how far that run sits from
 * the batch median, in standard deviations.
 *
 * Varying-ness is measured from the runs themselves rather than read off the MC
 * variable list on purpose: a run record is self-contained (it survives a reload, and
 * `McRunsPanel` never sees the config that produced it), and a param that moved for
 * some other reason is exactly as interesting as one the sampler moved.
 */

/** Leaves worth showing: scalars and dates. Everything else is structure. */
function isLeaf(v) {
  return v === null || v instanceof Date
    || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean';
}

/**
 * Flatten a param bag to `Map(dottedPath → leafValue)`.
 *
 * Array indices are bracketed (`shocks[0].severity`) to match the path form the MC
 * variable list uses, so a row's label is the same string the config panel shows.
 */
export function flattenParams(obj, prefix = '', out = new Map(), depth = 0) {
  if (depth > 6 || obj == null) return out;
  for (const [k, v] of Object.entries(obj)) {
    const path = Array.isArray(obj) ? `${prefix}[${k}]` : (prefix ? `${prefix}.${k}` : k);
    if (isLeaf(v)) out.set(path, v);
    else if (typeof v === 'object') flattenParams(v, path, out, depth + 1);
  }
  return out;
}

/** Comparable scalar for a leaf, or null when it has no ordering (strings, booleans). */
function numeric(v) {
  if (v instanceof Date) return v.getTime();
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function median(sorted) {
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Build `Map(path → { varying, median, stdDev, isDate })` over every run's params.
 *
 * @param {Array<{params: object}>} runs
 * @returns {Map<string, object>}
 */
export function buildParamStats(runs) {
  const stats = new Map();
  if (!runs?.length) return stats;

  const flattened = runs.map(r => flattenParams(r.params ?? {}));

  // Union of paths, not just the first run's: a shock or a person present in one bag
  // and absent from another still deserves a row.
  const paths = new Set();
  for (const f of flattened) for (const p of f.keys()) paths.add(p);

  for (const path of paths) {
    const raw  = flattened.map(f => f.get(path));
    const nums = raw.map(numeric).filter(v => v != null);

    // Distinct-value test runs on the RAW values (via a string key) so a varying string
    // param — a strategy name, a residency — is still detected as varying.
    const distinct = new Set(raw.map(v => (v instanceof Date ? v.getTime() : String(v))));

    let med = null, sd = null;
    if (nums.length > 1) {
      med = median([...nums].sort((a, b) => a - b));
      const mean = nums.reduce((s, v) => s + v, 0) / nums.length;
      sd = Math.sqrt(nums.reduce((s, v) => s + (v - mean) ** 2, 0) / nums.length);
    }

    stats.set(path, {
      varying: distinct.size > 1,
      median:  med,
      stdDev:  sd,
      isDate:  raw.some(v => v instanceof Date),
    });
  }
  return stats;
}

/**
 * One run's params as display rows.
 *
 * Varying rows come first, ordered by |z| descending — the run's most unusual draw at
 * the top, which is the row that answers "why did this one fail". Fixed rows follow in
 * alphabetical order, because among values that are identical everywhere there is no
 * more meaningful ranking than one you can scan.
 *
 * @param {object} run    an MC run record
 * @param {Map}    stats  from buildParamStats over the whole batch
 * @returns {{ varying: Array, fixed: Array }} rows of { path, value, delta, z }
 */
export function paramRowsForRun(run, stats) {
  const flat    = flattenParams(run?.params ?? {});
  const varying = [];
  const fixed   = [];

  for (const [path, value] of flat) {
    const st = stats.get(path) ?? { varying: false };
    if (!st.varying) { fixed.push({ path, value, delta: null, z: null }); continue; }

    const n = numeric(value);
    const delta = (n != null && st.median != null) ? n - st.median : null;
    // A zero stdDev with a non-zero delta cannot happen (they come from the same
    // sample), so guarding on it only skips the degenerate all-identical case.
    const z = (delta != null && st.stdDev) ? delta / st.stdDev : null;
    varying.push({ path, value, delta, z });
  }

  varying.sort((a, b) => Math.abs(b.z ?? 0) - Math.abs(a.z ?? 0) || a.path.localeCompare(b.path));
  fixed.sort((a, b) => a.path.localeCompare(b.path));
  return { varying, fixed };
}

/**
 * Format a param value for a dense table.
 *
 * Deliberately NOT the money formatter: a bag mixes rates (0.0713), counts (2031),
 * money (3_100_000) and dates, with nothing on the value to say which is which. So the
 * rule is by magnitude — small numbers keep the precision that makes a rate readable,
 * large ones lose the digits nobody reads.
 */
export function fmtParamValue(v) {
  if (v === null)           return '—';
  if (v instanceof Date)    return v.toISOString().slice(0, 10);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v !== 'number') return String(v);
  if (!Number.isFinite(v))  return String(v);
  const abs = Math.abs(v);
  if (abs === 0)      return '0';
  if (abs < 1)        return v.toFixed(4);
  if (abs < 10_000)   return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return Math.round(v).toLocaleString('en-US');
}

/** Signed delta with an arrow, or '' when the row has no comparable delta. */
export function fmtParamDelta(row) {
  if (row.delta == null || row.delta === 0) return '';
  const arrow = row.delta > 0 ? '▲' : '▼';
  const mag   = Math.abs(row.delta);
  const shown = mag < 1 ? mag.toFixed(4)
    : mag < 10_000 ? mag.toFixed(2)
    : Math.round(mag).toLocaleString('en-US');
  const z = row.z != null ? ` ${Math.abs(row.z).toFixed(1)}σ` : '';
  return `${arrow}${shown}${z}`;
}
