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
import { activeDecisionsAt } from './run-schedule.js';
import { LEVER_SCHEDULE }    from './lever-schedule.js';

/**
 * DESIGN 81 §5 — the switch that plays a recorded MPC run.
 *
 * A controller run already IS a schedule: one decision per epoch per lever, each with a date.
 * This reducer asks, on every period advance, which decisions are in force, and stamps the
 * state the levers' consumers read. Press Play and the plan unfolds exactly as the controller
 * decided it — no bake, no collapse, no second execution path.
 *
 * ─── why a reducer on an existing advance, and NOT an event (D3) ─────────────────
 *
 * A `MPC_DECISION` event on the queue is the natural-looking design and is the one to refuse,
 * for the reason design 109 §8 records and the goldens have measured: this engine's event
 * queue is not a total order, so adding ANY event re-resolves the tie-breaks among events
 * already scheduled on the same instant. A feature whose job is to change a POLICY must not
 * perturb the ordering of the TRANSACTIONS, or every A/B between two plans is confounded by
 * an ordering change it did not ask for. Riding an advance that already exists adds nothing
 * to the queue.
 *
 * ─── why PRE_PROCESS + 0.25, which is narrower than it looks ─────────────────────
 *
 * It must be AFTER `PRIORITY.PRE_PROCESS` (10), where fifteen reducers already sit — among
 * them `UsPeriodAdvanceReducer` / `AuPeriodAdvanceReducer`, which write
 * `state.currentPeriods[cc] = action.period` so "the correct period and filing status are in
 * state before any tax or cash-flow reducers run on the same step". Below 10 this reducer
 * would resolve its "now" against the PREVIOUS period whenever it fell back off `action.date`
 * — a silent one-period error on exactly the date the controller chose.
 *
 * It must not JOIN the tie at 10 either: fifteen reducers on one priority are ordered only by
 * where their `push` lands in the toolset's list. Position by accident is not position.
 *
 * And it must be BEFORE every consumer — `MarketIndexReducer` (+0.5), `PoolShapeScheduleReducer`
 * (+1), `PoolFlowReducer` (+3), `ExplicitBandsSpendingReducer` (+4), `RebalanceToTargetReducer`
 * (+4), `BondLadderReducer` (+5) — because a period that applies a decision must evaluate its
 * flows and size its targets on the decision that has just taken over. Switching after them
 * makes the first period of every decision run on the previous one.
 *
 * ─── the cost of a period that decides nothing ───────────────────────────────────
 *
 * A map walk and a `newState` that adds no field. `diffStates` emits nothing for a patch that
 * changed nothing, so in every period of every run but the handful that decide something the
 * journal is untouched. Together with "registered only when a run is SELECTED" that is what
 * makes D4 — every existing golden byte-identical — a property of the code.
 */
export class MpcDecisionScheduleReducer extends Reducer {
  static type        = 'MpcDecisionScheduleReducer';
  static description = 'Design 81: applies the decisions a recorded MPC run committed, as the '
    + 'clock reaches each one.';

  /**
   * @param {object} opts
   * @param {object} opts.run         `resolveActiveMpcRun` output — { runId, source, decisions }
   * @param {object} [opts.baseParams] the scenario params the run was recorded against. A
   *   lever whose `applyAt` rebuilds a whole authored table (SPENDING's band table, §6.1)
   *   needs the table it is rebuilding, and a reducer cannot reach the param bag otherwise.
   * @param {object} [opts.levers]    hook map; defaults to `LEVER_SCHEDULE` (injectable for tests).
   */
  constructor({ run, baseParams = null, levers = LEVER_SCHEDULE } = {}) {
    super('MPC Decision Schedule', PRIORITY.PRE_PROCESS + 0.25);
    this.run        = run;
    this.baseParams = baseParams;
    this.levers     = levers;
    this.reducedActionTypes = ['US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE'];
    this._warnedLevers = new Set();
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
    // therefore emits no journal diff, which is what makes a non-deciding period free.
    const asOfMs = this._asOfMs(state, action, date);
    if (asOfMs == null) return this.newState(state);

    const active = activeDecisionsAt(this.run, asOfMs);
    if (!active) return this.newState(state);

    // The one scalar that decides whether anything changed. The active set can only change
    // when a new row's date is crossed, so comparing the greatest applied row date covers
    // every lever at once. Without it the first advance of every period would re-stamp an
    // identical table and put a diff in the journal on every row of every run.
    const stamped = state.mpcDecisionApplied?.throughMs ?? null;
    if (stamped === active.throughMs) return this.newState(state);

    let patch = null;
    const applied = [];
    for (const [lever, rows] of active.byLever) {
      const hook = this.levers?.[lever]?.applyAt;
      if (typeof hook !== 'function') {
        // Loud, once per lever. A recorded row for a lever that cannot be applied means the
        // run is playing back as something other than what it was, which is the one failure
        // this whole design exists to make impossible.
        if (!this._warnedLevers.has(lever)) {
          this._warnedLevers.add(lever);
          console.warn(`MpcDecisionScheduleReducer: lever '${lever}' has no \`applyAt\` hook, `
            + `so ${rows.length} recorded decision(s) for it are NOT being applied — the run is `
            + 'playing back incompletely (design 81 §4.5).');
        }
        continue;
      }
      const p = hook({ state, rows, asOfMs, baseParams: this.baseParams, lever });
      if (p) { patch = { ...(patch ?? {}), ...p }; applied.push(lever); }
    }
    if (!patch) return this.newState(state);

    return this.newState(state, {
      ...patch,
      // §5 — the one visible marker. Without it the whole feature is invisible in exactly the
      // surface a user watches while it plays: the journal diff and the timeline show THAT a
      // decision landed, and `date` is the date it BECAME LIVE, not the date recorded.
      mpcDecisionApplied: {
        runId:     this.run?.runId ?? null,
        date:      new Date(active.throughMs).toISOString(),
        throughMs: active.throughMs,
        levers:    applied,
      },
    });
  }

  toJSON() {
    // The decision table is config, not run state, and it is large (~400 rows on a real
    // 44-year plan). What a reader of a serialized reducer needs is WHICH run and HOW BIG.
    return { ...super.toJSON(), runId: this.run?.runId ?? null, rows: this.run?.decisions?.length ?? 0 };
  }
}
