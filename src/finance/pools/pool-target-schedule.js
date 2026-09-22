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
 * DESIGN 112 — dated pool targets: `liquidityTargetSchedule: [{ year, pool, scale, by? }]`.
 *
 * One row sets pool `pool`'s target to `scale` × its authored target from 1 January of `year`
 * until the next row for the same pool. The rows become more steps in design 109's step
 * function (`resolveLiquidityGraphSchedule`), so every consumer that already selects a graph by
 * date sees them without learning anything new.
 *
 * ── why a LEAF module ───────────────────────────────────────────────────────────────────
 *
 * The row rules are needed by three things that must not import each other's worlds: the
 * resolver in `liquidity-graph.js`, the shape reducer (which compares a step's scales against
 * the ones stamped on state), and design 81's fold in `lever-schedule.js`, which is under a
 * leaf-imports-only rule (design 81 §16.5). This module imports nothing, so all three can.
 *
 * ── the three rules a row obeys (§2.2) ─────────────────────────────────────────────────
 *
 *   1. A factor is relative to the AUTHORED target, never to the previous row: 1.5 then 1.2
 *      is 1.2 × authored. The latest row per pool REPLACES the earlier one.
 *   2. A row is about the POOL, not a shape (design 110 §6.4): it persists across a later shape
 *      switch, is dormant while the shape in force lacks the pool, and applies again when a
 *      later shape brings the id back.
 *   3. `by` is provenance only (R12). Nothing here reads it, so it cannot change a run.
 */

const err = (msg) => { throw new Error(`liquidityGraph: ${msg}`); };

/** Float noise off a product, so `1.5 × 1.2` is 1.8 and not 1.7999999999999998. */
const trim = (n) => Number(n.toPrecision(12));

/**
 * The rows, validated and sorted by year then pool. Absent or empty ⇒ `[]`, which is what keeps
 * a plan without rows on exactly today's path.
 *
 * @param {*} raw                 the authored `liquidityTargetSchedule`
 * @param {Set<string>} knownPools every pool id in the base graph and every shape
 * @returns {Array<{year:number, pool:string, scale:number}>}
 */
export function normalizeTargetSchedule(raw, knownPools) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) err('`liquidityTargetSchedule` has to be an array of { year, pool, scale } rows');
  const seen = new Set();
  const rows = raw.map((r, i) => {
    if (!r || typeof r !== 'object') err(`liquidityTargetSchedule[${i}] is not a { year, pool, scale } row`);
    const year = Number(r.year);
    if (!Number.isInteger(year)) err(`liquidityTargetSchedule[${i}] year '${r.year}' is not a whole year`);
    const pool = r.pool;
    if (typeof pool !== 'string' || !pool) err(`liquidityTargetSchedule[${i}] (year ${year}) names no pool`);
    // A pool no graph contains is a typo, not a dormant row: rule 2 lets a row sleep while the
    // shape in force lacks its pool, but a pool that NO shape has can never wake it.
    if (!knownPools.has(pool)) {
      err(`liquidityTargetSchedule[${i}] (year ${year}) names pool '${pool}', which is in no graph `
        + `(${knownPools.size ? [...knownPools].map(s => `'${s}'`).join(', ') : 'there are no pools'})`);
    }
    const scale = typeof r.scale === 'number' ? r.scale : NaN;
    // Zero is allowed ("hold nothing from this year"), negative and non-numeric are not. The
    // same rule the hidden axis applies (`poolTargetScalesFrom`).
    if (!Number.isFinite(scale) || scale < 0) {
      err(`liquidityTargetSchedule[${i}] (year ${year}, pool '${pool}') scale '${r.scale}' is not a `
        + 'factor ≥ 0');
    }
    const key = `${year}|${pool}`;
    if (seen.has(key)) {
      err(`liquidityTargetSchedule has two rows for pool '${pool}' in ${year} — only one factor can `
        + 'be in force for a pool at a time');
    }
    seen.add(key);
    return { year, pool, scale };
  });
  return rows.sort((a, b) => a.year - b.year || (a.pool < b.pool ? -1 : a.pool > b.pool ? 1 : 0));
}

/**
 * The factor in force per pool at `year` — the latest row at or before it (rule 1).
 *
 * @param {Array} rows  `normalizeTargetSchedule` output
 * @param {number|null} year  null ⇒ before every row
 * @returns {Map<string, number>}
 */
export function scalesInForceAt(rows, year) {
  const out = new Map();
  if (year == null) return out;
  for (const r of rows) {
    if (r.year > year) break;
    out.set(r.pool, r.scale);
  }
  return out;
}

/**
 * The factors that actually APPLY to one graph: pools the graph contains (rule 2), and not
 * identity. A row of 1.0 is "back to the authored target", which changes nothing, so it is not
 * stamped and does not make a new step — which is also what keeps an MPC scaffold row (it
 * carries the factor already in force, usually 1) byte-identical to the plan.
 *
 * @param {Map<string, number>} inForce
 * @param {object|null} rawGraph  the authored `{ pools, flows }` the step runs
 * @returns {Object<string, number>} sorted by pool id, so the signature is stable
 */
export function appliedScales(inForce, rawGraph) {
  const out = {};
  if (!inForce.size || !Array.isArray(rawGraph?.pools)) return out;
  const ids = new Set(rawGraph.pools.map(p => p?.id).filter(id => typeof id === 'string'));
  for (const id of [...inForce.keys()].sort()) {
    const k = inForce.get(id);
    if (ids.has(id) && k !== 1) out[id] = k;
  }
  return out;
}

/**
 * The step's identity: the shape plus the factors applied to it (§2.2). The shape reducer
 * restamps when this changes. A plan with no rows has an empty factor set everywhere, so its
 * key is exactly the shape id and the reducer behaves as it always has.
 *
 * @param {string|null} shapeId
 * @param {Object<string, number>|null|undefined} scales
 */
export function stepKeyOf(shapeId, scales) {
  const id = shapeId ?? '';
  const entries = scales ? Object.keys(scales).sort().map(k => `${k}=${scales[k]}`) : [];
  return entries.length ? `${id}|${entries.join(',')}` : id;
}

/**
 * The axis factors composed with a step's row factors: effective = axis × row (§5 Q4).
 * Returns the axis map itself when the step has no row factors.
 *
 * @param {Map<string, number>} axis   `poolTargetScalesFrom(params)`
 * @param {Object<string, number>|null} rows  `appliedScales(...)`
 * @returns {Map<string, number>}
 */
export function composeScales(axis, rows) {
  if (!rows || !Object.keys(rows).length) return axis;
  const out = new Map(axis);
  for (const [id, k] of Object.entries(rows)) out.set(id, trim((axis.get(id) ?? 1) * k));
  return out;
}

/**
 * Every pool id in a raw base graph and raw shape map — the set a row's pool is checked against.
 * Reads the RAW values, so it never throws on a graph that will not compile (that error belongs
 * to the normalizer, which runs next and names the graph).
 */
export function knownPoolIds(rawGraph, rawShapes) {
  const out = new Set();
  const add = (g) => {
    for (const p of (Array.isArray(g?.pools) ? g.pools : [])) {
      if (p && typeof p.id === 'string' && p.id) out.add(p.id);
    }
  };
  add(rawGraph);
  if (rawShapes && typeof rawShapes === 'object' && !Array.isArray(rawShapes)) {
    for (const s of Object.values(rawShapes)) add(s);
  }
  return out;
}

/**
 * Design 112 R13 — the rows as RUNS, for display only.
 *
 * An MPC session that re-decides every year writes a row per pool per year, and most of them
 * repeat the factor already in force. That is correct and replayable, so storage keeps every
 * row; this is what the editor shows above the table, one line per run of an unchanged factor:
 * `{ pool, scale, fromYear, lastYear, count, by }`. `by` is the set of provenance marks in the
 * run (hand-written rows contribute none).
 *
 * Takes RAW rows (it runs in the editor, on whatever is typed) and skips any it cannot read, so
 * it never throws on a half-finished row.
 *
 * @param {Array} raw  the authored `liquidityTargetSchedule`
 * @returns {Array<{pool:string, scale:number, fromYear:number, lastYear:number, count:number, by:string[]}>}
 */
export function collapseTargetRuns(raw) {
  const rows = (Array.isArray(raw) ? raw : [])
    .filter(r => r && Number.isInteger(Number(r.year)) && typeof r.pool === 'string' && r.pool
      && Number.isFinite(r.scale))
    .map(r => ({ year: Number(r.year), pool: r.pool, scale: r.scale,
                 by: typeof r.by === 'string' && r.by ? r.by : null }))
    .sort((a, b) => (a.pool < b.pool ? -1 : a.pool > b.pool ? 1 : 0) || a.year - b.year);
  const out = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.pool === r.pool && last.scale === r.scale) {
      last.lastYear = r.year;
      last.count += 1;
      if (r.by && !last.by.includes(r.by)) last.by.push(r.by);
      continue;
    }
    out.push({ pool: r.pool, scale: r.scale, fromYear: r.year, lastYear: r.year, count: 1,
               by: r.by ? [r.by] : [] });
  }
  return out;
}
