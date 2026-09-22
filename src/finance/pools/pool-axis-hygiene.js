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
  // Design 112 R7 — a dated row multiplies the axis, so the ceiling is a property of the
  // PRODUCT. The largest row factor for each pool widens the top of the span it is checked at.
  const rowMax = new Map();
  for (const r of (Array.isArray(val('liquidityTargetSchedule')) ? val('liquidityTargetSchedule') : [])) {
    if (typeof r?.pool === 'string' && Number.isFinite(r?.scale)) {
      rowMax.set(r.pool, Math.max(rowMax.get(r.pool) ?? 1, r.scale));
    }
  }
  for (const row of scalablePoolTargets(authored)) {
    const worst = row.authored
      .filter(a => a.mode === 'PERCENT')
      .reduce((m, a) => Math.max(m, a.value), 0);
    const rowK = rowMax.get(row.poolId) ?? 1;
    if (worst > 0 && rowK > 1 && worst * rowK > 1) {
      row_(out, 'liquidityTargetSchedule', POOL_AXIS_PROBLEM_KIND.REFUSES,
        `Pool '${row.label}' is sized as a PERCENT of the book (${trimTo(worst * 100)}%), and a target `
        + `schedule row scales it by ${trimTo(rowK)}, past 1.0 of the book. The plan will not load until `
        + 'that row is lowered.');
    } else if (worst > 0 && worst * rowK * POOL_TARGET_SCALE_RANGE.max > 1) {
      const limit = trimTo(1 / (worst * rowK));
      row_(out, 'liquidityGraph', POOL_AXIS_PROBLEM_KIND.REFUSES,
        `Pool '${row.label}' is sized as a PERCENT of the book (${trimTo(worst * 100)}%), and a `
        + `PERCENT target is a FRACTION — above 1.0 the graph refuses to compile. Factors over `
        + `${limit} will fail rather than run, so the top of the default ${POOL_TARGET_SCALE_RANGE.min}–`
        + `${POOL_TARGET_SCALE_RANGE.max} range is out of reach for this pool. Narrow the axis, or `
        + 'size the pool in years of spending, which has no ceiling.');
    }
  }
  // Design 112 §2.5 — what a factor does to the rest of the pool vocabulary. Applies to the
  // hidden axis and to dated target rows alike, so the span checked is the axis range widened
  // by the most extreme row factor the plan authors.
  if (hasPoolTarget) out.push(...targetVocabularyProblems(authored, val('liquidityTargetSchedule')));
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

/**
 * Design 112 §2.5 — four ways a pool's other settings change what a size factor MEANS.
 *
 * A factor touches only `target.value`. Two target modes and three capacity modes then make it
 * do less than its label claims, and neither design 110 nor the first draft of design 112 said
 * so. Each row names the pool (and the shape, when it is not the base graph):
 *
 *   · CONFOUNDED — a REMAINDER pool: the factor multiplies the aggregate, so the residual moves
 *     by more than the factor.
 *   · CONFOUNDED — a pool a REMAINDER pool sits behind (with a target and no real ceiling): it
 *     contributes its TARGET, so scaling it shrinks the remainder one for one and total cover
 *     does not move. A mix lever, not a size lever.
 *   · INERT — a static ceiling (`AMOUNT` / `YEARS_OF_SPEND` capacity, in the target's own unit)
 *     below the top of the span: the pool is capped, and the search sees a plateau. `OFFSET_CAP`
 *     gets its own sentence, because that ceiling falls with the loan.
 *   · CONFOUNDED — a floor in the target's unit above the bottom of the span: the refills stop
 *     short of what the pool refuses to release.
 *
 * @param {{liquidityGraph:*, liquidityShapes:*}} authored  the raw graphs
 * @param {*} targetRows  the raw `liquidityTargetSchedule`
 */
export function targetVocabularyProblems(authored, targetRows) {
  const factors = (Array.isArray(targetRows) ? targetRows : [])
    .map(r => r?.scale).filter(k => Number.isFinite(k) && k >= 0);
  const lo = POOL_TARGET_SCALE_RANGE.min * Math.min(1, ...factors);
  const hi = POOL_TARGET_SCALE_RANGE.max * Math.max(1, ...factors);
  const scalable = new Set(scalablePoolTargets(authored).map(r => r.poolId));
  const graphs = [[null, authored.liquidityGraph]];
  const shapes = authored.liquidityShapes;
  if (shapes && typeof shapes === 'object' && !Array.isArray(shapes)) {
    for (const [id, g] of Object.entries(shapes)) graphs.push([id, g]);
  }
  // One row per (kind, pool, sentence), naming every graph it holds in. A pool carried unchanged
  // into three shapes would otherwise say the same thing three times — measured on the author's
  // plan, eight rows for four facts.
  const grouped = new Map();
  const push = (kind, pool, shape, message) => {
    const key = `${kind}\u0000${pool}\u0000${message}`;
    const g = grouped.get(key) ?? { kind, pool, message, shapes: [] };
    g.shapes.push(shape);
    grouped.set(key, g);
  };
  const valueOf = (spec) => (typeof spec === 'number' ? spec
    : (spec && typeof spec === 'object' && Number.isFinite(spec.value)) ? spec.value : null);
  const modeOf  = (spec, dflt) => (spec && typeof spec === 'object' && typeof spec.mode === 'string')
    ? spec.mode : dflt;
  const fmt = (n) => trimTo(n);

  for (const [where, graph] of graphs) {
    const pools = Array.isArray(graph?.pools) ? graph.pools : [];
    for (const pool of pools) {
      if (!pool || typeof pool.id !== 'string' || !scalable.has(pool.id)) continue;
      const tValue = valueOf(pool.target);
      if (tValue == null || tValue === 0) continue;
      const tMode = modeOf(pool.target, 'YEARS_OF_SPEND');

      if (tMode === 'YEARS_OF_SPEND_REMAINDER') {
        push(POOL_AXIS_PROBLEM_KIND.CONFOUNDED, pool.id, where,
          `Pool '${pool.id}' is a REMAINDER of ${fmt(tValue)} years across other pools. A factor `
          + 'multiplies that AGGREGATE, not the pool\'s own share, so its residual moves by more than '
          + 'the factor says (6y behind 4y is 2y; ×1.5 makes it 5y). Read its results as sizes, not '
          + 'as the factor.');
      }

      const behind = pools.filter(q => q && q !== pool
        && modeOf(q.target, null) === 'YEARS_OF_SPEND_REMAINDER'
        && Array.isArray(q.target?.after) && q.target.after.includes(pool.id));
      const capMode = modeOf(pool.capacity, 'BALANCE');
      const realCeiling = capMode !== 'BALANCE';
      for (const q of behind) {
        if (realCeiling) continue;         // a capped pool contributes what it HOLDS, not its target
        push(POOL_AXIS_PROBLEM_KIND.CONFOUNDED, pool.id, where,
          `Pool '${pool.id}' sits in front of REMAINDER pool '${q.id}', which counts '${pool.id}' `
          + `at its target. Scaling '${pool.id}' shrinks '${q.id}' by the same amount, so total cover does `
          + `not move until '${q.id}' reaches zero: this factor trades one pool against the other rather `
          + 'than sizing the reserve.');
      }

      const capValue = valueOf(pool.capacity);
      if (capMode === 'OFFSET_CAP') {
        push(POOL_AXIS_PROBLEM_KIND.INERT, pool.id, where,
          `Pool '${pool.id}' is capped at its offset ceiling, min(cash, loan owed), which falls as `
          + 'the loan amortises. A factor that fits today can sit above that ceiling in a few years, '
          + 'where every larger value runs the same capped pool.');
      } else if (capValue != null && capMode === tMode && tValue * hi > capValue) {
        push(POOL_AXIS_PROBLEM_KIND.INERT, pool.id, where,
          `Pool '${pool.id}' has a ${capMode} capacity of ${fmt(capValue)}, and factors above `
          + `${fmt(capValue / tValue)} take its target (${fmt(tValue)}) past it. The pool is capped there, `
          + 'so the top of the range is a plateau: those factors all run the same plan.');
      }

      const floorValue = valueOf(pool.floor);
      const floorMode  = modeOf(pool.floor, 'AMOUNT');
      if (floorValue != null && floorValue > 0 && floorMode === tMode && tValue * lo < floorValue) {
        push(POOL_AXIS_PROBLEM_KIND.CONFOUNDED, pool.id, where,
          `Pool '${pool.id}' has a floor of ${fmt(floorValue)}, and factors below `
          + `${fmt(floorValue / tValue)} take its target (${fmt(tValue)}) under it. The floor is not scaled, `
          + 'so the pool then refills to less than it refuses to release.');
      }
    }
  }
  const whereOf = (shapes) => {
    const named = shapes.map(s => (s == null ? 'the base graph' : `shape '${s}'`));
    return named.length === 1 && shapes[0] == null ? '' : ` (in ${named.join(', ')})`;
  };
  return [...grouped.values()].map(g => ({
    param: 'liquidityGraph', index: null, field: null, pool: g.pool,
    // The first graph that carries it, for a renderer that localizes by shape.
    shape: g.shapes[0] ?? null,
    severity: PROBLEM_SEVERITY.WARN, kind: g.kind,
    message: g.message.replace(/^(Pool '[^']+')/, `$1${whereOf(g.shapes)}`),
  }));
}

/** Push a row — the same shape `row()` builds, for the checks that run after it is out of scope. */
function row_(out, param, kind, message) {
  out.push({ param, index: null, field: null, pool: null, shape: null,
             severity: PROBLEM_SEVERITY.WARN, kind, message });
}
