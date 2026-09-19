/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY } from '../../simulation-framework/reducers.js';
import { activeGraphAt, compileToDrawdownSequence } from './liquidity-graph.js';

/**
 * DESIGN 109 §8 — the shape switch.
 *
 * Resolves which named shape governs this period and, when that is not the one already
 * stamped, re-stamps the two compiled artefacts the rest of the engine reads.
 *
 * ─── why a reducer on an existing advance, and NOT an event ──────────────────────
 *
 * A `POOL_SHAPE_CHANGED` event on the queue is the natural-looking design and is the one to
 * refuse. This engine's event queue is not a total order: adding any event re-resolves the
 * tie-breaks among events already scheduled on the same instant, which is a measured,
 * whole-portfolio effect rather than a local one. A feature whose job is to change a POLICY
 * must not perturb the ordering of the TRANSACTIONS, or every A/B between two schedules is
 * confounded by an ordering change nobody asked for. Riding an advance that already exists
 * adds nothing to the queue.
 *
 * ─── why `drawdownSequence` is the load-bearing half ─────────────────────────────
 *
 * Design 109 §2 measured it: `state.liquidityGraph` is written by the toolset's projection and
 * read by NOTHING in `src/` — it is a liveness witness for tooling. The only compiled artefact
 * the engine consults each period is `state.drawdownSequence`, which `AccountService` reads
 * live. Re-stamping the graph alone would change nothing and look like it changed everything:
 * the `config-field-in-state-is-not-read` shape exactly. Both are therefore written HERE, in
 * ONE patch — two writers on the two halves of one compiled artefact is how the witness comes
 * to describe a shape the engine is not running.
 *
 * ─── the cost of a period that does not switch ───────────────────────────────────
 *
 * One map lookup, and a `newState` that adds no field. `diffStates` emits nothing for a patch
 * that changed nothing, so the journal is untouched and a run whose schedule never fires is
 * indistinguishable from one without a schedule. That is what makes §13 case 2 — "a schedule
 * whose rows all name the base graph is byte-identical" — a property of the code rather than a
 * coincidence.
 */
export class PoolShapeScheduleReducer extends Reducer {
  static type        = 'PoolShapeScheduleReducer';
  static description = 'Design 109: selects the liquidity pool shape that governs this period, '
    + 're-stamping the compiled drawdown sequence when it changes.';

  /**
   * @param {object} opts
   * @param {Array}  opts.schedule - `resolveLiquidityGraphSchedule` output
   */
  constructor({ schedule } = {}) {
    // Ahead of PoolFlowReducer (PRE_PROCESS + 3) and the rebalancer (+4), so a period that
    // switches evaluates its flows and sizes its targets on the shape that has just taken
    // over. Switching after them would make the first period of every new shape run on the
    // old one — a one-period error on a date the author chose deliberately, which is the
    // worst place to have one.
    super('Pool Shape Schedule', PRIORITY.PRE_PROCESS + 1);
    this.schedule = schedule;
    this.reducedActionTypes = ['US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE'];
  }

  /**
   * The instant this period is deciding at.
   *
   * The action's own date is the authority; `state.currentPeriods` is the fallback for a
   * hand-built action, and `date` last. Deliberately NOT `Date.now()` — on a projection
   * decades out that is not a small error, it is a different run.
   */
  _asOfMs(state, action, date) {
    if (action?.date != null) return new Date(action.date).getTime();
    const cc = action?.type === 'AU_PERIOD_ADVANCE' ? 'AU' : 'US';
    const startMs = state?.currentPeriods?.[cc]?.startMs;
    if (Number.isFinite(startMs)) return startMs;
    return date ? new Date(date).getTime() : null;
  }

  reduce(state, action, date) {
    // `newState(state)` and not a bare `return state`: the house convention for a no-op is to
    // go through it so the reducer still picks up the `next` array. It adds no field and
    // therefore emits no journal diff, which is what makes a non-switching period free.
    if (!Array.isArray(this.schedule) || this.schedule.length === 0) return this.newState(state);
    const asOfMs = this._asOfMs(state, action, date);
    if (asOfMs == null) return this.newState(state);

    const active = activeGraphAt(this.schedule, asOfMs);
    if (!active) return this.newState(state);

    // `?? null` on both sides: the opening entry's id IS null (it is the base graph, not a
    // named shape), and an unstamped state has no field at all. Without the coalesce the
    // first period of every run would read `undefined !== null` and emit a patch that changes
    // nothing — a diff on every scenario with a schedule, for no reason.
    const stamped = state.liquidityShapeId ?? null;
    if ((active.shapeId ?? null) === stamped) return this.newState(state);

    const seq = active.graph ? compileToDrawdownSequence(active.graph) : null;

    return this.newState(state, {
      // §9 — the retired pools' cube entries go with the shape that held them. Carried
      // forward they would keep their last value for the rest of the run, and the panel would
      // go on plotting a pool that no longer exists, flat, forever.
      ...(state.liquidityPools ? { liquidityPools: _keepLivePools(state.liquidityPools, active.graph) } : {}),
      liquidityShapeId: active.shapeId ?? null,
      // Both halves, one patch. See the header.
      liquidityGraph:   active.graph ?? null,
      drawdownSequence: seq,
    });
  }

  toJSON() {
    // The schedule itself is config, not run state, and it is large. The SHAPE IDS are what a
    // reader of a serialized reducer needs to see.
    return { ...super.toJSON(), shapeIds: (this.schedule ?? []).map(e => e.shapeId) };
  }
}

/**
 * The cube, narrowed to the pools the incoming shape actually has.
 *
 * Design 109 §9's third rule. A pool id present in both shapes CONTINUES — it keeps its
 * trailing `high`, its `spendHistory` and its gate streaks, which is what an author means by
 * "the bond pool gets bigger in 2040". An id only in the new shape is absent here and is
 * seeded cold by `PoolFlowReducer` on the same advance. An id only in the old one is dropped.
 * @private
 */
function _keepLivePools(cube, graph) {
  const live = new Set((graph?.pools ?? []).map(p => p.id));
  const out  = {};
  for (const [id, entry] of Object.entries(cube)) {
    if (live.has(id)) out[id] = entry;
  }
  return out;
}
