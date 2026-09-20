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
 * Study hygiene for a pool axis — design 110 leg C, phase 7 (§6.5).
 *
 * `scripts/lib/pool-arms.mjs` carries six pieces of hygiene that make pooled arms comparable,
 * and every one of them applies to the **control** as well as the arms — *"an arm and a control
 * that differ in two ways measure neither of them."* The app's grid applies none of it. A pool
 * axis in the app would therefore produce a grid that looks comparable and is not, which is
 * worse than not having one.
 *
 * So this **reports and never repairs**. Repairing silently would be the same class of mistake
 * as a lever rewriting another lever (§12.2's one-authority rule), and a grid launched from a
 * config the app quietly edited is a grid nobody can reproduce.
 *
 * ── the six, and where each one actually lives ────────────────────────────────────────
 *
 * Three of `pool-arms`' six are ALREADY REFUSALS in `normalizeLiquidityGraph`, so restating
 * them here would be two derivations of one sentence — §23.6's failure shape, and the thing
 * §17.2 forbids. They are named rather than duplicated:
 *
 *   · **the legacy `poolCashYears` / `poolBondYears`** — §12.2 throws when either is finite
 *     beside a pool `target`, and a pool axis exists only for a pool that HAS a target. The one
 *     gap is `hasRebalancer: false`, and there the axis has no reader at all, which is a
 *     stronger statement and is reported below in its own right.
 *   · **a hand-authored `drawdownSequence`** — throws: the graph COMPILES to that field.
 *   · **`drawdownMode: PROPORTIONAL`** — throws: a graph compiles to an ordering.
 *
 * Two are real, in-app, and silent, which is why this module exists:
 *
 *   · **the glidepath** (`allocationSchedule` other than `STATIC`). Legal, and the pool target
 *     governs only the classes it claims, so the schedule governs the residual: the plan runs a
 *     mix that is neither the pool's claim nor the author's anchors, and it MOVES as the axis is
 *     swept. `pool-arms` sets `STATIC` for every arm *and the control* for exactly this reason.
 *   · **manufactured shocks**. §18.4 — a dated crash is foreseen, which biases precisely this
 *     class of timing lever, and with paths it double-counts the downside.
 *
 * The last, *"the strategy list identical across arms"*, has no in-app equivalent as written —
 * a grid sweeps one config, so the list is identical by construction. Its SUBSTANCE translates
 * to something sharper, and the in-app form is the one that bites: whether the axis has a
 * reader at all. A pool `target` is realised by the TARGET_ALLOCATION rebalancer and the refill
 * edges by LIQUIDITY_POOLS' reducers, so with either deselected — or with the master switch off
 * — the factor is swept and nothing reads it. Every cell returns the plan, and a flat grid reads
 * as a null result rather than as a misconfiguration.
 *
 * Deliberately NOT here: **wealth-matching**. §6.5 — it is not a config problem. Nothing a pool
 * axis does moves money, so `assertArmsWealthMatched` stays where it is, on a built state.
 */
import { PROBLEM_SEVERITY } from './liquidity-graph.js';
import { authoredParamValue, scalablePoolTargets, authoredPoolGraphs, POOL_TARGET_SCALE_RANGE }
  from './pool-target-scale.js';
import { gateClauseAxes } from './pool-gate-axis.js';
import { scheduledShapeAxes, SHAPE_YEAR_SHIFT_RANGE } from './pool-shape-year-axis.js';

/**
 * What a hygiene row says about the grid it is warning about. Two different sentences, and
 * conflating them would cost a session: an INERT axis produces identical cells and reads as
 * "the pool size does not matter"; a CONFOUNDED one produces cells that differ for two reasons
 * and reads as a larger effect than the lever has.
 */
export const POOL_AXIS_PROBLEM_KIND = Object.freeze({
  /** The axis is swept and nothing reads it. Every cell runs the plan. */
  INERT:      'inert',
  /** The axis moves, and so does something else. The cells differ for two reasons. */
  CONFOUNDED: 'confounded',
  /**
   * Some values in the axis's range produce a plan the compiler REFUSES, so those cells are
   * holes rather than results.
   *
   * A third kind and not a shade of the other two, because it is a third sentence: the grid
   * neither reports a flat response nor an inflated one, it comes back with gaps. §17.2 is why
   * it can happen at all — the overlay never clamps, so a value out of range is refused with the
   * normalizer's own sentence rather than quietly corrected into a policy nobody chose.
   */
  REFUSES:    'refuses',
});

/**
 * Study-hygiene problems for a pool axis on this config, or `[]` when the plan authors no
 * scalable pool (then there is no axis and nothing to say).
 *
 * Rows are shaped like `collectAuthoredGraphProblems`' so one renderer can draw both, and are
 * always `severity: 'warn'`: none of these makes the plan illegal, so none may stop a Rebuild.
 * `param` names the param the author has to change, which is the only actionable field here —
 * a hygiene problem is a statement about the PLAN, not about a cell in the pool tables, so
 * `index` / `field` / `pool` stay null rather than pointing somewhere plausible and wrong.
 *
 * @param {object} cfg  a scenario config (loaded or serialized)
 * @returns {Array<{param:string, index:null, field:null, pool:null, shape:null,
 *                  severity:'warn', kind:string, message:string}>}
 */
export function poolAxisProblems(cfg) {
  if (!cfg) return [];
  const authored = authoredPoolGraphs(cfg);
  // Both of leg C's axis families, because the hygiene is a property of the PLAN and a grid on a
  // gate threshold is as confoundable as one on a pool size. Two of the rows below are narrower
  // than that and say so: their argument is specifically about what a pool `target` claims.
  const hasPoolTarget = scalablePoolTargets(authored).length > 0;
  const hasGateAxis   = gateClauseAxes(authored).length > 0;
  const shapeAxes = scheduledShapeAxes({
    liquidityShapes:        authored.liquidityShapes,
    liquidityGraphSchedule: authoredParamValue(cfg, 'liquidityGraphSchedule'),
  });
  if (!hasPoolTarget && !hasGateAxis && shapeAxes.length === 0) return [];

  const val = (key) => authoredParamValue(cfg, key);
  const out = [];
  const row = (param, kind, message) => out.push({
    param, index: null, field: null, pool: null, shape: null,
    severity: PROBLEM_SEVERITY.WARN, kind, message,
  });

  // ── does the axis have a reader? ───────────────────────────────────────────────────────
  //
  // Reported first and in this order because an inert axis makes every other row moot: there
  // is no point telling an author their glidepath confounds a comparison that is not happening.
  if (val('liquidityGraphEnabled') === false) {
    row('liquidityGraphEnabled', POOL_AXIS_PROBLEM_KIND.INERT,
      'Liquidity Pools are switched OFF (liquidityGraphEnabled: false), so no pool target is '
      + 'read at all. Every cell of this axis will run the plan and the grid will report a flat '
      + 'response — which reads as "the reserve size does not matter".');
  }

  // Absent is NOT "none selected": a partial config or a test bag that never mentions the field
  // takes the permissive reading, exactly as `hasTargetAllocation` does, so a missing list is
  // not reported as five problems.
  const strategies = val('behavioralStrategies');
  if (Array.isArray(strategies)) {
    // Scoped to a pool TARGET: the rebalancer is what realises one. A gate axis governs whether
    // a flow fires, which is LIQUIDITY_POOLS' reducers' job, so reporting this against a
    // gate-only plan would be advice that does not apply.
    if (hasPoolTarget && !strategies.includes('TARGET_ALLOCATION')) {
      row('behavioralStrategies', POOL_AXIS_PROBLEM_KIND.INERT,
        'TARGET_ALLOCATION is not selected, and a pool `target` is realised by the rebalancer '
        + '(design 97 §12.2). The factor will be swept and nothing will read it: every cell runs '
        + 'the plan. Select TARGET_ALLOCATION, or sweep something the plan actually acts on.');
    }
    if (!strategies.includes('LIQUIDITY_POOLS')) {
      row('behavioralStrategies', POOL_AXIS_PROBLEM_KIND.INERT,
        'LIQUIDITY_POOLS is not selected, so the refill flows contribute no reducers: the pools '
        + 'are sized and the spend order is compiled, but no edge fires to keep a pool at the '
        + 'target the axis is moving. `pool-arms.mjs` keeps this strategy selected in every arm '
        + 'INCLUDING the control, where it is inert by construction, so that the only thing that '
        + 'differs across arms is the graph.');
    }
  }

  // ── is the comparison clean? ───────────────────────────────────────────────────────────
  // Also scoped to a pool target, and for the same reason: the argument below is about what a
  // pool `target` claims and what is left over for a second author to govern.
  const schedule = val('allocationSchedule');
  if (hasPoolTarget && schedule != null && schedule !== 'STATIC') {
    // YEARS_OF_SPEND is the pool target's own PREDECESSOR (design 97 §9), so it is worth its
    // own sentence: it is not merely a second authority on the mix, it is the same claim made
    // twice in two vocabularies.
    const why = schedule === 'YEARS_OF_SPEND'
      ? 'allocationSchedule YEARS_OF_SPEND is the pool target\'s predecessor — it sizes cash and '
        + 'bonds as years of spending from the legacy params, which is the same claim the pool '
        + '`target` makes, in the vocabulary it replaced.'
      : `allocationSchedule is ${schedule}, so the target mix has a second author.`;
    row('allocationSchedule', POOL_AXIS_PROBLEM_KIND.CONFOUNDED,
      `${why} Under §12.2's one-authority rule a pool target governs only the classes it claims, `
      + 'so the schedule governs the residual: the plan runs a mix that is neither the pool\'s '
      + 'claim nor the anchors you wrote, and it MOVES as this axis is swept. `pool-arms.mjs` '
      + 'sets STATIC for every arm and for the control. Set it to STATIC — the anchors stay in '
      + 'the scenario, they simply stop being the target source.');
  }

  const shocks = val('shocks');
  if (Array.isArray(shocks) && shocks.length > 0) {
    row('shocks', POOL_AXIS_PROBLEM_KIND.CONFOUNDED,
      `${shocks.length} manufactured shock${shocks.length === 1 ? '' : 's'} are authored. A DATED `
      + 'crash is FORESEEN, which biases exactly this class of timing lever (design 97 §18.4): a '
      + 'reserve sized to cover a downturn the plan knows the date of is not the reserve the '
      + 'household would need. With paths per cell it also double-counts the downside. Clear '
      + '`shocks` for the grid and let the paths supply the bad years.');
  }

  // ── will some cells simply refuse? ───────────────────────────────────────────────────
  //
  // Both of these are consequences of §17.2, which is the rule and not a defect: the overlay
  // never clamps, so a swept value outside what the normalizer accepts is refused with its own
  // sentence. Saying so before a grid is launched is the difference between a hole the author
  // expected and one they spend an afternoon explaining.
  for (const row of scalablePoolTargets(authored)) {
    const worst = row.authored
      .filter(a => a.mode === 'PERCENT')
      .reduce((m, a) => Math.max(m, a.value), 0);
    if (worst > 0 && worst * POOL_TARGET_SCALE_RANGE.max > 1) {
      const limit = trimTo(1 / worst);
      row_(out, 'liquidityGraph', POOL_AXIS_PROBLEM_KIND.REFUSES,
        `Pool '${row.label}' is sized as a PERCENT of the book (${trimTo(worst * 100)}%), and a `
        + `PERCENT target is a FRACTION — above 1.0 the graph refuses to compile. Factors over `
        + `${limit} will fail rather than run, so the top of the default ${POOL_TARGET_SCALE_RANGE.min}–`
        + `${POOL_TARGET_SCALE_RANGE.max} range is out of reach for this pool. Narrow the axis, or `
        + 'size the pool in years of spending, which has no ceiling.');
    }
  }
  if (shapeAxes.length) {
    const years = shapeAxes.flatMap(r => r.years).sort((a, b) => a - b);
    let closest = Infinity;
    for (let i = 1; i < years.length; i++) closest = Math.min(closest, years[i] - years[i - 1]);
    if (closest <= SHAPE_YEAR_SHIFT_RANGE.max) {
      row_(out, 'liquidityGraphSchedule', POOL_AXIS_PROBLEM_KIND.REFUSES,
        `Two shape switches are ${closest} year${closest === 1 ? '' : 's'} apart, and the switch-`
        + `year axis shifts by up to ±${SHAPE_YEAR_SHIFT_RANGE.max}. A shift that lands one switch on `
        + 'another\'s year is refused outright — only one shape can take over in a given year — so '
        + 'those cells will be holes in the grid rather than results. Keep the shift inside '
        + `±${closest - 1 >= 0 ? closest - 1 : 0}, or move the switches further apart.`);
    }
  }

  return out;
}

/** Round a display number without trailing float noise. */
const trimTo = (n) => Number(n.toPrecision(12));

/** Push a row — the same shape `row()` builds, for the checks that run after it is out of scope. */
function row_(out, param, kind, message) {
  out.push({ param, index: null, field: null, pool: null, shape: null,
             severity: PROBLEM_SEVERITY.WARN, kind, message });
}
