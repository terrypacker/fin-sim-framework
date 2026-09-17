/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HandlerEntry } from '../../simulation-framework/handlers.js';
import { getResidency, primaryPersonKey } from '../residency-utils.js';

/**
 * Design 107 §5 — THE PAYCHECK.
 *
 * Turns the scheduled `PAYCHECK` event into the `SPENDING_REFILL` action, which
 * `PoolFlowReducer` answers by evaluating exactly the `cadence: PAYCHECK` edges of the
 * liquidity graph (§5.1). That is the whole handler: it carries no amount and moves no
 * money.
 *
 * The event and the action are deliberately named differently. They are two things — a date
 * on the calendar and a decision to fund the year — and the repo already separates them
 * everywhere it matters (`PERIOD_ADVANCE_US` → `US_PERIOD_ADVANCE`). Sharing one name also
 * breaks the design-71 payload scan, which reads any `{ type: 'X', ... }` literal as an
 * emission of action X and would report an EventSeries' `interval`/`month`/`order` as
 * undeclared fields of the action.
 *
 * ─── why it carries no amount ────────────────────────────────────────────────
 *
 * The obvious shape is an event that computes "a year of spending" and hands it to a
 * transfer. It is the wrong shape, and the reason is the one §5.2 gives: the destination
 * pool already owns a `target`, and `amount.toTarget` already resolves the demand to
 * `shortfall` — the (s, S) band's upper edge, recomputed from the LIVE spend line every time
 * it is asked. An amount computed here would be a second answer to a question the pool
 * already answers, and the two would diverge the first time the spend line moved: the age
 * bands, the regime cut and inflation all move it, and none of them are visible from here.
 *
 * It also means the paycheck is net of whatever already arrived. Dividend cash lands in the
 * country's transaction account, which IS the spending pool's only claim, so a year of yield
 * reduces `shortfall` directly and the paycheck sells only the remainder (§5.3 leg 1). An
 * authored amount would sell the full year and leave the yield sitting idle.
 *
 * ─── what decides the date, and the one thing this handler DOES decide ───────
 *
 * The cadence and the calendar live on the SCHEDULE, which is what makes `ANNUAL` on the AU
 * income year expressible at all — `FLOW_CADENCE.ANNUAL` cannot say it (it is keyed on the
 * calendar year, so it fires on the 1 January US advance and is then dead; see
 * `FLOW_CADENCE`).
 *
 * What the handler decides is WHICH calendar is live (design 107 §15.3). Both are scheduled —
 * `PAYCHECK_US` on 1 January and `PAYCHECK_AU` on 1 July — and each firing is answered only
 * while the household is resident in that country. The residency is read from live state on
 * every firing, never captured at build time: it is a fact about year 5 of the run, and a
 * value read at construction would be the STARTING residency forever, which is a defect shape
 * this repo has already paid for once.
 *
 * ─── the move year falls out, rather than being special-cased ────────────────
 *
 * §15.3 asks for a sweep-and-top-up triggered by the residency change itself. It needs no
 * separate trigger. The household moves on 1 July; the schedule puts `PAYCHECK_AU` on that
 * date at `order: 1`, so it runs AFTER the order-0 `CHANGE_RESIDENCY`, sees AU, and fires —
 * and the first thing it fires is the sweep edge out of the float being left behind. The
 * off-cycle top-up and the first ordinary AU paycheck are the same event.
 *
 * A move onto a date that is NOT an income-year start would leave the new float waiting until
 * the next one. That is a real gap and it is left open deliberately: it cannot happen on a
 * 1 July move, and closing it speculatively would mean a second trigger whose only test would
 * be a scenario nobody runs.
 *
 * ─── the deliberate non-guard ────────────────────────────────────────────────
 *
 * It does not check whether the household has anything to refill, or whether any
 * `PAYCHECK` edge exists. An empty evaluation is cheap and, more to the point, it is
 * RECORDED: the reducer stamps `gatedFlows` for an edge that wanted money and was refused,
 * and a handler that suppressed the action would delete that record — the non-event is the
 * interesting one, which is the whole argument behind `gatedFlows` existing.
 */
export class SpendingRefillHandler extends HandlerEntry {
  static description = 'Design 107 §5/§15.3: dispatches SPENDING_REFILL on the income-year start of the country the household currently lives in, so PoolFlowReducer evaluates the graph\'s PAYCHECK edges — the retirement paycheck, following residency across a move.';
  static type        = 'SpendingRefillHandler';
  // A FALLBACK only. `SimulationAdapter._wireHandler` prefers `handledEvents`, which the
  // strategy always populates with this instance's own calendar, so the static value is what
  // a direct-wired handler with no event node would get. Named for the US calendar because
  // that is the default `paycheckCalendar` the param schema used to carry.
  static eventType   = 'PAYCHECK_US';

  /**
   * @param {object} opts
   * @param {string} opts.country - the residency this instance's calendar belongs to ('US'|'AU')
   */
  constructor({ country = 'US' } = {}) {
    super(null, `Spending Refill (${country})`);
    this.country = country;
    this.generatedActionTypes = ['SPENDING_REFILL'];
  }

  toJSON() {
    return { ...super.toJSON(), country: this.country };
  }

  static fromJSON(d) {
    const h = new this({ country: d.country ?? 'US' });
    h.id = d.id;
    return h;
  }

  call({ date, state }) {
    // The residency gate. Returning [] rather than emitting a no-op action keeps the journal
    // honest: a paycheck that was never due is not a paycheck that moved nothing.
    //
    // An UNSTATED residency does not suppress. A single-country plan may configure no
    // `residency` at all, and reading that absence as "not resident here" would silently turn
    // the paycheck off for every scenario that never needed to say where it lives — the
    // feature would look wired and do nothing, which is the failure this repo keeps paying
    // for. Absent ⇒ the scheduled calendar is the only one, so honour it.
    const residency = getResidency(state ?? {}, primaryPersonKey(state ?? {}));
    if (residency != null && residency !== this.country) return [];
    // `date` is forwarded so the reducer dates its evaluation by the paycheck rather than by
    // the tax period it happens to fall in. A quarterly paycheck fires three times inside one
    // period, and `state.currentPeriods[cc].startMs` would date all three to the period's
    // start — putting three evaluations on one timestamp in the cube and the journal.
    return [{ type: 'SPENDING_REFILL', date: date instanceof Date ? date.toISOString() : date }];
  }
}
