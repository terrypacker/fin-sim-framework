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
 * DESIGN 123 — what a cockpit session's pool rows mean after the session.
 *
 * `liquidityTargetSchedule` and `liquidityGraphSchedule` rows are open-ended: a row holds until
 * the next one. A cockpit session writes a row per decided year, so its LAST row holds to the
 * end of the plan unless something follows it. That is what the controller priced (every
 * rollout scores to `simEnd`), so it is the default — but nobody decided it, and a six-year
 * session that leaves ×2 in force for four decades reads like a run that ended in its sixth year.
 *
 * This module holds the three rules every surface shares:
 *
 *   · `sessionTails`    — the advisory (§4.2): a pool's FINAL row (or the shape schedule's) was
 *                         written by a session, carries no end mark, and departs from what the
 *                         plan's own rows have in force at that year.
 *   · `endSessionRows`  — End session (§4.3): HOLD stamps `end: 'hold'` on the session's final
 *                         rows; REVERT appends, from 1 January after `afterYear`, a closing row
 *                         carrying the AUTHORED value — the factor/shape the schedule has in
 *                         force there once the session's rows are set aside.
 *   · `describeSessionTail` — the one sentence the harvest, the editors and the cockpit print.
 *
 * "The plan's own rows" means every row the session did not write (`by` ≠ the session's run):
 * hand-written rows and rows another session wrote. A row the session OVERWROTE (same year and
 * pool) is gone, so its value cannot be recovered; a revert lands on the row in force before it.
 *
 * `by` and `end` are marks only. Nothing that resolves a schedule reads them, so a plan without
 * them runs exactly as before and a hold changes no output. Only a revert's closing rows do.
 *
 * A LEAF module: it imports nothing, so the editors, the cockpit and the harvest can all use it.
 */

export const SESSION_END = Object.freeze({ HOLD: 'hold', REVERT: 'revert' });

const byOf = (r) => (typeof r?.by === 'string' && r.by ? r.by : null);
const yearOf = (r) => { const y = Number(r?.year); return Number.isInteger(y) ? y : null; };
const isTarget = (r) => r && yearOf(r) != null && typeof r.pool === 'string' && r.pool && Number.isFinite(r.scale);
const isShape = (r) => r && yearOf(r) != null
  && ((typeof r.shape === 'string' && r.shape) || (r.shape === null && Object.hasOwn(r, 'shape')));

/**
 * The factor the plan's own rows (every row `by` did not write) hold `pool` at on 1 January of
 * `year`: the latest such row at or before it, 1 when there is none.
 */
export function authoredFactorAt(rows, pool, year, by) {
  let k = 1;
  let at = -Infinity;
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (!isTarget(r) || r.pool !== pool || byOf(r) === by) continue;
    const y = yearOf(r);
    if (y <= year && y > at) { k = r.scale; at = y; }
  }
  return k;
}

/** The shape the plan's own rows have in force at `year`; null (the base graph) before any. */
export function authoredShapeAt(rows, year, by) {
  let shape = null;
  let at = -Infinity;
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (!isShape(r) || byOf(r) === by) continue;
    const y = yearOf(r);
    if (y <= year && y > at) { shape = r.shape; at = y; }
  }
  return shape;
}

/** The latest row at or before `year` (all rows, any author), or null. */
function _inForce(rows, year, match) {
  let best = null;
  for (const r of rows) {
    if (!match(r)) continue;
    const y = yearOf(r);
    if (y <= year && (best == null || y > yearOf(best))) best = r;
  }
  return best;
}

/** Each pool's final row. Rows with an unreadable year or factor are skipped. */
function _finalTargetRows(rows) {
  const last = new Map();
  for (const r of rows) {
    if (!isTarget(r)) continue;
    const prev = last.get(r.pool);
    if (!prev || yearOf(r) > yearOf(prev)) last.set(r.pool, r);
  }
  return [...last.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, r]) => r);
}

function _finalShapeRow(rows) {
  let last = null;
  for (const r of rows) if (isShape(r) && (!last || yearOf(r) > yearOf(last))) last = r;
  return last;
}

/**
 * §4.2 — the session decisions that hold past the session with nobody having said so.
 *
 * A target tail is a pool whose final row a session wrote (`by`), with no `end` mark, at a
 * factor other than the one the plan's own rows hold it at in that year. A shape tail is the
 * same for the schedule's final row. An authored row is never a tail (§6 Q1): its author meant it.
 *
 * Takes RAW rows (it runs in an editor on whatever is typed) and never throws.
 *
 * @param {{targets?: Array, shapes?: Array}} schedules
 * @returns {Array<{kind:'target'|'shape', pool?:string, scale?:number, shape?:string|null,
 *                  authored:number|string|null, year:number, by:string}>}
 */
export function sessionTails({ targets = null, shapes = null } = {}) {
  const out = [];
  const T = Array.isArray(targets) ? targets : [];
  for (const r of _finalTargetRows(T)) {
    const by = byOf(r);
    if (!by || r.end) continue;
    const authored = authoredFactorAt(T, r.pool, yearOf(r), by);
    if (r.scale !== authored) {
      out.push({ kind: 'target', pool: r.pool, scale: r.scale, authored, year: yearOf(r), by });
    }
  }
  const S = Array.isArray(shapes) ? shapes : [];
  const last = _finalShapeRow(S);
  const by = byOf(last);
  if (last && by && !last.end) {
    const authored = authoredShapeAt(S, yearOf(last), by);
    if (last.shape !== authored) {
      out.push({ kind: 'shape', shape: last.shape, authored, year: yearOf(last), by });
    }
  }
  return out;
}

/**
 * The advisory sentence. `planEndYear` is named when the surface knows it (an editor, the
 * cockpit); the harvest does not, and says "the end of the plan".
 */
export function describeSessionTail(t, { planEndYear = null } = {}) {
  const until = Number.isInteger(planEndYear) ? `to ${planEndYear}` : 'to the end of the plan';
  const what = t.kind === 'target'
    ? `Liquidity Pool Target: the session's last decision for ${t.pool} (×${t.scale}, ${t.year})`
    : `Liquidity Pool Shape: the session's last decision (${t.shape == null ? 'the base graph' : `'${t.shape}'`}, ${t.year})`;
  return `${what} holds ${until} — the controller priced it as held for the rest of the plan. `
    + 'End the session in the MPC cockpit to choose hold or revert.';
}

/**
 * The last year the session `runId` decided anything for, over both schedules; null if none.
 * A closing row this session wrote earlier is not a decision and does not count.
 */
export function lastSessionYear({ targets = null, shapes = null } = {}, runId) {
  let last = null;
  for (const r of [...(Array.isArray(targets) ? targets : []), ...(Array.isArray(shapes) ? shapes : [])]) {
    if (byOf(r) !== runId || r?.end === SESSION_END.REVERT) continue;
    const y = yearOf(r);
    if (y != null && (last == null || y > last)) last = y;
  }
  return last;
}

/**
 * §4.3 — End session. Pure: returns new row arrays and never mutates the caller's.
 *
 * Idempotent: an earlier end by the same session is undone first (its closing rows removed,
 * its hold marks stripped), so ending twice REPLACES the first choice rather than stacking.
 *
 * `afterYear` defaults to the session's last decided year and may not be earlier: a closing row
 * before the session's own later rows would collide with one of them (the normalizer refuses
 * two rows for a pool in a year) or be overridden by them a year later. Truncating a session is
 * an edit the author makes in the row editor.
 *
 * @param {object} o
 * @param {Array|null} o.targets   raw `liquidityTargetSchedule`
 * @param {Array|null} o.shapes    raw `liquidityGraphSchedule`
 * @param {string} o.runId         the session whose rows these are (`by`)
 * @param {'hold'|'revert'} o.policy
 * @param {number|null} [o.afterYear]
 * @returns {{ targets: Array, shapes: Array, end: {policy:string, afterYear:number},
 *             closing: Array<{lever:'POOL_TARGET'|'POOL_SHAPE', year:number, pool?:string, value:*}> }}
 */
export function endSessionRows({ targets = null, shapes = null, runId, policy, afterYear = null } = {}) {
  if (typeof runId !== 'string' || !runId) throw new Error('End session: no session (run id) to end');
  if (policy !== SESSION_END.HOLD && policy !== SESSION_END.REVERT) {
    throw new Error(`End session: policy '${policy}' is neither 'hold' nor 'revert'`);
  }
  const clean = (rows) => (Array.isArray(rows) ? rows : [])
    .filter(r => !(byOf(r) === runId && r?.end === SESSION_END.REVERT))
    .map(r => {
      if (byOf(r) !== runId || !r?.end) return (r && typeof r === 'object') ? { ...r } : r;
      const { end, ...rest } = r;   // eslint-disable-line no-unused-vars
      return rest;
    });
  const T = clean(targets);
  const S = clean(shapes);

  const last = lastSessionYear({ targets: T, shapes: S }, runId);
  if (last == null) throw new Error(`End session: session '${runId}' wrote no pool rows — nothing to end`);
  const after = afterYear == null ? last : Number(afterYear);
  if (!Number.isInteger(after)) throw new Error(`End session: '${afterYear}' is not a whole year`);
  if (after < last) {
    throw new Error(`End session: cannot revert after ${after} — the session decided ${last}, and a `
      + 'closing row before its own later rows would be overridden by them. Remove those rows in '
      + 'the row editor first.');
  }

  const closing = [];
  const pools = [...new Set(T.filter(r => isTarget(r) && byOf(r) === runId).map(r => r.pool))].sort();

  if (policy === SESSION_END.HOLD) {
    for (const r of _finalTargetRows(T)) if (byOf(r) === runId) r.end = SESSION_END.HOLD;
    const s = _finalShapeRow(S);
    if (s && byOf(s) === runId) s.end = SESSION_END.HOLD;
  } else {
    const year = after + 1;
    for (const pool of pools) {
      const now = _inForce(T, year, r => isTarget(r) && r.pool === pool);
      if (!now || byOf(now) !== runId) continue;          // the plan's own row already governs
      const scale = authoredFactorAt(T, pool, year, runId);
      if (scale === now.scale) continue;                  // nothing to revert
      T.push({ year, pool, scale, by: runId, end: SESSION_END.REVERT });
      closing.push({ lever: 'POOL_TARGET', year, pool, value: scale });
    }
    const now = _inForce(S, year, isShape);
    if (now && byOf(now) === runId) {
      const shape = authoredShapeAt(S, year, runId);
      if (shape !== now.shape) {
        S.push({ year, shape, by: runId, end: SESSION_END.REVERT });
        closing.push({ lever: 'POOL_SHAPE', year, value: shape });
      }
    }
  }

  T.sort((a, b) => (yearOf(a) ?? 0) - (yearOf(b) ?? 0) || String(a?.pool).localeCompare(String(b?.pool)));
  S.sort((a, b) => (yearOf(a) ?? 0) - (yearOf(b) ?? 0));
  return { targets: T, shapes: S, end: { policy, afterYear: after }, closing };
}
