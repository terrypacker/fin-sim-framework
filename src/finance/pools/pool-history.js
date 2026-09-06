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
 * DESIGN 97 §20.11 — the per-period pool history, reconstructed from the journal.
 *
 * `PoolFlowReducer` stamps `state.liquidityPools` every period and `state.poolRefillPlan`
 * alongside it. Until this module nothing read either, which is what §20.11 records as the
 * gap worth closing: *"the graph can be authored and cannot be observed"* — and §20.2's
 * clairvoyant gate, §20.4b's identically-zero headroom and §20.3's unwired knob were all
 * visible in that cube from the first period of the first run, and each took a study to find.
 *
 * ─── why the JOURNAL and not the run's sampler ───────────────────────────────────
 *
 * `diffStates` walks nested objects, so every `liquidityPools.<id>.<field>` movement is
 * already a journal diff carrying `before`/`after`, and the cube's first write lands as one
 * whole-object diff that seeds every pool. Replaying those diffs gives the cube at **every**
 * period, where the workbench's year-boundary sampler would give one snapshot a year.
 *
 * That difference is not cosmetic here. `gatedFlows` and `firedFlows` — the run's only
 * per-edge record, and for an in-portfolio edge the only record of a firing anywhere — are
 * overwritten on every advance, and this reducer fires on BOTH `US_PERIOD_ADVANCE` and
 * `AU_PERIOD_ADVANCE`, six months apart. A year-boundary sample would drop half of them.
 *
 * Both are re-read from the cube at every period record rather than accumulated from diffs,
 * which is what makes two consecutive identical firings (or an unchanged gate) come out
 * right: the second emits no diff, the carried-forward array still describes that period,
 * and the row is regenerated from it.
 *
 * ─── what a carried-forward field means ──────────────────────────────────────────
 *
 * A diff is only emitted for a field that CHANGED, so the reconstruction carries the last
 * value forward. For every field on this cube that is the honest reading: the reducer writes
 * all of them every period, so an absent diff means the period recomputed the same number —
 * a gate still shut for the same reason, a pool still at the same balance. The one thing it
 * cannot distinguish is a period in which the ENTIRE cube was unchanged, which emits no diff
 * and therefore no record; `balance` and `marketReturnYear` move in any real run, so this is
 * a fixture-shaped case rather than a scenario-shaped one, and `periods` carrying a `seq`
 * makes it visible when it happens.
 */

/** The cube fields carried per pool per period, in the order the CSV writes them. */
export const POOL_CUBE_FIELDS = Object.freeze([
  'balance', 'capacity', 'utilised', 'target', 'yearsOfCover', 'high',
  'marketReturn', 'priorYearReturn', 'inflow', 'outflow',
]);

/** Kinds of row in the flow log. Only FIRED moved money; the other two are non-events. */
export const POOL_EVENT_KIND = Object.freeze({
  FIRED:  'FIRED',
  GATED:  'GATED',
  VETOED: 'VETOED',
});

/**
 * Replay the journal into a per-period pool history.
 *
 * @param {object} opts
 * @param {{journal: Array}} opts.journal   the run's journal
 * @param {{pools: Array, flows: Array}} [opts.graph]  the normalized graph, for labels and
 *   for the pool ORDER — a history read off the journal alone can only order pools by the
 *   order they were first written, which is not the spend order the author wrote.
 * @returns {{periods: Array, events: Array, poolIds: string[], labels: Object<string,string>,
 *            flowIds: string[], firedFromCube: boolean, hasCube: boolean}}
 *   `firedFromCube` is false for a run predating `firedFlows`, where the FIRED rows come from
 *   the action stream and therefore cover cross-account edges only.
 */
export function buildPoolHistory({ journal, graph = null } = {}) {
  const entries = Array.isArray(journal?.journal) ? journal.journal
                : Array.isArray(journal)          ? journal
                : [];

  let cube    = {};                    // running reconstruction of state.liquidityPools
  let plan    = {};                    // running reconstruction of state.poolRefillPlan
  // The household reserve, replayed exactly like the cube. Carried forward on a period with
  // no diff for the same reason every cube field is: the reducer writes it every period, so
  // an absent diff means the number did not move.
  let reserve = {};
  const periods = [];
  const events  = [];
  const fromActions = [];              // FIRED rows read from POOL_FLOW_APPLY (the fallback)
  let   sawFiredField = false;         // did any period carry the cube's own `firedFlows`?
  const seen    = new Set();           // pool ids, in first-seen order

  for (const entry of entries) {
    let touched = false;

    for (const diff of entry.stateDiff ?? []) {
      const field = diff.field ?? '';
      if (field === 'liquidityPools') {
        cube = _clone(diff.after ?? {});
        touched = true;
      } else if (field.startsWith('liquidityPools.')) {
        _setPath(cube, field.split('.').slice(1), diff.after);
        touched = true;
      } else if (field === 'liquidityReserve') {
        reserve = _clone(diff.after ?? {});
        touched = true;
      } else if (field.startsWith('liquidityReserve.')) {
        _setPath(reserve, field.split('.').slice(1), diff.after);
        touched = true;
      } else if (field === 'poolRefillPlan') {
        plan = _clone(diff.after ?? {});
      } else if (field.startsWith('poolRefillPlan.')) {
        _setPath(plan, field.split('.').slice(1), diff.after);
      }
    }

    // A cross-account transfer, read from the action. Used ONLY when no period carried the
    // cube's own `firedFlows` (a run recorded before that field existed) — for such a run the
    // action stream is the only record of a firing there is, and it covers TRANSFER edges only.
    if (entry.action?.type === 'POOL_FLOW_APPLY') {
      const d = entry.action.data ?? entry.action;
      fromActions.push({
        seq:    entry.seq ?? events.length,
        at:     new Date(entry.date),
        year:   new Date(entry.date).getUTCFullYear(),
        kind:   POOL_EVENT_KIND.FIRED,
        flowId: d.flowId ?? null,
        from:   d.from ?? null,
        to:     d.to ?? null,
        amount: d.amountBase ?? null,
        wanted: null,
        reason: null,
        executor: 'TRANSFER',
      });
    }

    if (!touched) continue;

    const at   = new Date(entry.date);
    const year = at.getUTCFullYear();
    for (const id of Object.keys(cube)) seen.add(id);

    const pools = {};
    for (const [id, raw] of Object.entries(cube)) {
      pools[id] = _derive(raw);
      // Every gated flow this period, as a log row. The array is rewritten every period, so
      // a repeated row means the gate was shut again — not that one event was double-counted.
      for (const g of raw?.gatedFlows ?? []) {
        events.push({
          seq: entry.seq ?? events.length, at, year,
          kind:   POOL_EVENT_KIND.GATED,
          flowId: g.id ?? null, from: g.from ?? null, to: g.to ?? null,
          amount: null, wanted: g.wanted ?? null, reason: g.reason ?? null,
          executor: null,
        });
      }
      // The firing, from the cube rather than the action stream — the ONLY record that covers
      // in-portfolio edges, which emit nothing per-edge (§12.4).
      if (Array.isArray(raw?.firedFlows)) {
        sawFiredField = true;
        for (const f of raw.firedFlows) {
          events.push({
            seq: entry.seq ?? events.length, at, year,
            kind:   POOL_EVENT_KIND.FIRED,
            flowId: f.id ?? null, from: f.from ?? null, to: f.to ?? null,
            amount: f.amount ?? null, wanted: null, reason: null,
            executor: f.executor ?? null,
          });
        }
      }
    }
    // Gated AND fired rows are both recorded on BOTH endpoints' cube entries
    // (`pool-flow-reducer` filters on `to === id || from === id`), so each arrives twice.
    _dedupeEndpoints(events, entry.seq);

    // The rebalance veto — executor 1's half of the same decision. Without it the log says
    // "the refill did not fire" and stays silent about the drift band being stopped from
    // selling the same sleeve for the same reason, which is the laundering §12.4 is about.
    for (const poolId of plan?.vetoed ?? []) {
      events.push({
        seq: entry.seq ?? events.length, at, year,
        kind: POOL_EVENT_KIND.VETOED,
        flowId: null, from: poolId, to: null, amount: null, wanted: null,
        reason: `rebalance sale of ${poolId} vetoed this period`,
      });
    }
    // §12.4c — the EDGE-scoped half of the same decision, and it must be here or the panel
    // reports an EDGE-scoped policy as a rebalancer running unconstrained. Same KIND, because
    // it is the same event seen from the other end: `from` names the pool that may not be
    // SOLD, `to` names the pool that may not be GROWN.
    for (const poolId of plan?.capped ?? []) {
      events.push({
        seq: entry.seq ?? events.length, at, year,
        kind: POOL_EVENT_KIND.VETOED,
        flowId: null, from: null, to: poolId, amount: null, wanted: null,
        reason: `rebalance fill of ${poolId} capped this period`,
      });
    }

    periods.push({ seq: entry.seq ?? periods.length, at, year, pools,
                   reserve: { ...reserve }, vetoed: [...(plan?.vetoed ?? [])],
                   capped: [...(plan?.capped ?? [])] });
  }

  // Pool order: the author's spend order when the graph is at hand, first-seen otherwise.
  const graphIds = (graph?.pools ?? []).map(p => p.id);
  const poolIds  = graphIds.length
    ? [...graphIds, ...[...seen].filter(id => !graphIds.includes(id))]
    : [...seen];

  const labels = {};
  for (const id of poolIds) labels[id] = (graph?.pools ?? []).find(p => p.id === id)?.label || id;

  const flowIds = [...new Set([
    ...(graph?.flows ?? []).map(f => f.id),
    ...events.map(e => e.flowId).filter(Boolean),
    ...fromActions.map(e => e.flowId).filter(Boolean),
  ])];

  // The cube is authoritative when it carries `firedFlows`, because it covers both executors.
  // The action stream is the fallback for a run recorded before the field existed, where the
  // cross-account edges are the only firings recoverable at all.
  if (!sawFiredField) events.push(...fromActions);

  events.sort((a, b) => a.seq - b.seq || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  // Distinguishes a run with no reserve figure (recorded before the field existed) from one
  // whose reserve is genuinely zero — the panel must not draw the first as a flat zero line.
  const hasReserve = periods.some(p => p.reserve?.accessible != null);
  return { periods, events, poolIds, labels, flowIds, firedFromCube: sawFiredField,
           hasCube: periods.length > 0, hasReserve };
}

/**
 * One row per pool per period — the fact table behind the panel and its CSV.
 *
 * Named columns rather than a spread of whatever the cube happened to carry: a column that
 * exists on the row and not here is a number nobody can trace back to the period it came
 * from, and that is invisible to any test that only looks at the chart.
 */
export function poolHistoryRows(history) {
  const rows = [];
  for (const p of history?.periods ?? []) {
    for (const id of history.poolIds) {
      const m = p.pools[id];
      if (!m) continue;
      rows.push({
        date: p.at.toISOString().slice(0, 10),
        year: p.year,
        pool: id,
        label: history.labels?.[id] ?? id,
        ...Object.fromEntries(POOL_CUBE_FIELDS.map(f => [f, m[f] ?? null])),
        headroom:  m.headroom,
        shortfall: m.shortfall,
        drawdown:  m.drawdown,
        gated:     (m.gatedFlows ?? []).map(g => g.id).join(' '),
        vetoed:    p.vetoed.includes(id) ? 1 : 0,
        // The two are NOT interchangeable and must not be merged into one column: `vetoed`
        // means this pool could not be sold, `capped` means it could not be grown (§12.4c).
        capped:    p.capped?.includes(id) ? 1 : 0,
        // Per-PERIOD, not per-pool, so they repeat down every pool's row. Repeating beats a
        // second table: the one question this CSV gets opened to answer is why a pool reads
        // zero cover, and the answer is on the same row.
        reserveAccessible: p.reserve?.accessible ?? null,
        reserveLocked:     p.reserve?.locked ?? null,
        reserveYears:      p.reserve?.yearsOfCover ?? null,
      });
    }
  }
  return rows;
}

/**
 * A field of the cube as one series per pool over the periods, plus the axis labels.
 *
 * The panel's ONLY pivot. Kept here rather than inline in the plugin for the reason design
 * 82 §6 gives about `buildAllocationSeries`: the moment a view grows its own pivot, the view
 * and any lab page over the same cube can disagree about a number with no way to tell which
 * is right.
 *
 * @param {object} history
 * @param {string} field  a `POOL_CUBE_FIELDS` name, or a derived one (`headroom`, …)
 * @param {string[]} [poolIds]  defaults to every pool, in the history's order
 */
export function poolSeries(history, field, poolIds = null) {
  const ids    = poolIds ?? history?.poolIds ?? [];
  const points = history?.periods ?? [];
  const series = {};
  for (const id of ids) {
    series[id] = points.map(p => {
      const v = p.pools[id]?.[field];
      return v == null ? null : v;
    });
  }
  return {
    // Two advances land in the same calendar year, so the axis is a DATE, not a year: an
    // axis of years would draw the July AU advance on top of the January US one.
    labels: points.map(p => p.at.toISOString().slice(0, 10)),
    years:  points.map(p => p.year),
    keys:   ids,
    series,
  };
}

/**
 * The household reserve as a series, on the same axis `poolSeries` returns.
 *
 * Separate from `poolSeries` because it is not a pool: it is measured across the whole book,
 * including accounts no pool claims, which is the entire reason it exists (§22.3 extended).
 * Folding it into the pool map would put it in every per-pool total the panel and CSV take.
 *
 * @returns {{labels: string[], years: number[], accessible: Array, locked: Array,
 *            yearsOfCover: Array}}
 */
export function reserveSeries(history) {
  const points = history?.periods ?? [];
  const pick = (f) => points.map(p => p.reserve?.[f] ?? null);
  return {
    labels:       points.map(p => p.at.toISOString().slice(0, 10)),
    years:        points.map(p => p.year),
    accessible:   pick('accessible'),
    locked:       pick('locked'),
    yearsOfCover: pick('yearsOfCover'),
  };
}

/**
 * Does the journal replay agree with the live state it was replayed from?
 *
 * The one check that makes anything on this panel quotable. The history is a RECONSTRUCTION
 * — a diff-application, not a reading — and a reconstruction that has drifted draws a
 * believable picture of a run that did not happen. The last period must equal
 * `state.liquidityPools` field for field; if it does not, the diffs are not total and the
 * whole series is suspect, not just the last point.
 *
 * `unchecked` when there is no live cube to compare against (a stub, a run with no graph),
 * which is not the same as a failure and must not be painted as one.
 *
 * @returns {{ok: boolean, unchecked: boolean, checked: number, mismatches: Array}}
 */
export function tiePoolHistory(history, state) {
  const live = state?.liquidityPools;
  const last = history?.periods?.[history.periods.length - 1]?.pools;
  if (!live || !last || Object.keys(live).length === 0) {
    return { ok: true, unchecked: true, checked: 0, mismatches: [] };
  }
  const mismatches = [];
  let checked = 0;
  // The reserve is replayed from the same diffs and is quotable on the same terms, so it is
  // tied on the same terms: a drifted reserve line is exactly as misleading as a drifted pool.
  const liveRes = state?.liquidityReserve;
  const lastRes = history?.periods?.[history.periods.length - 1]?.reserve;
  if (liveRes) {
    for (const f of ['accessible', 'locked', 'yearsOfCover']) {
      checked++;
      const a = liveRes[f] ?? null;
      const b = lastRes?.[f] ?? null;
      if (a !== b) mismatches.push({ pool: '(household reserve)', field: f, live: a, replayed: b });
    }
  }
  for (const id of Object.keys(live)) {
    for (const f of POOL_CUBE_FIELDS) {
      checked++;
      const a = live[id]?.[f] ?? null;
      const b = last[id]?.[f] ?? null;
      if (a !== b) mismatches.push({ pool: id, field: f, live: a, replayed: b });
    }
  }
  return { ok: mismatches.length === 0, unchecked: false, checked, mismatches };
}

/** Latest reading per pool — what the panel's summary strip reads. */
export function latestPools(history) {
  const last = history?.periods?.[history.periods.length - 1] ?? null;
  return last ? { at: last.at, pools: last.pools } : null;
}

// ─── internals ────────────────────────────────────────────────────────────────

/**
 * Derived-not-stored, on purpose (§12.1). `capacity` is the CEILING and `utilised` is what
 * of the pool is doing work — §20.4b separated the two after conflating them made `headroom`
 * identically zero and no refill could ever fire. Deriving headroom here rather than reading
 * a stored field is what keeps the panel from repeating that.
 */
function _derive(raw) {
  const balance  = raw?.balance ?? 0;
  const capacity = raw?.capacity ?? 0;
  const target   = raw?.target ?? null;
  const high     = raw?.high ?? 0;
  return {
    ...raw,
    headroom:  Math.max(0, capacity - balance),
    shortfall: target == null ? null : Math.max(0, target - balance),
    drawdown:  high > 0 ? Math.max(0, 1 - balance / high) : 0,
    gatedFlows: raw?.gatedFlows ?? [],
  };
}

/**
 * Drop the duplicate half of every event recorded on both of its endpoint pools.
 *
 * Scoped to the rows this period appended (`seq`), so an edge that legitimately fires in two
 * different periods keeps both rows — the repetition IS the reading (a gate still shut, a
 * cascade still refilling).
 */
function _dedupeEndpoints(events, seq) {
  const keys = new Set();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.seq !== seq || e.kind === POOL_EVENT_KIND.VETOED) break;
    const k = `${e.kind}|${e.flowId}|${e.from}|${e.to}|${e.reason}|${e.amount}`;
    if (keys.has(k)) events.splice(i, 1); else keys.add(k);
  }
}

function _setPath(target, path, value) {
  let node = target;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (node[k] == null || typeof node[k] !== 'object') node[k] = {};
    node = node[k];
  }
  node[path[path.length - 1]] = _clone(value);
}

function _clone(v) {
  if (v == null || typeof v !== 'object') return v;
  return Array.isArray(v) ? v.map(_clone)
       : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, _clone(x)]));
}
