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
 * The pool-size AXIS — design 110 leg C, phase 6 (§6.2, §10.3).
 *
 * `pool.<poolId>.targetScale` is a hidden, compile-only MC/Opt/grid lever that MULTIPLIES
 * that pool's authored `target` in every shape that contains it. Default `1.0`, which is
 * identity, so a plan nobody sweeps is byte-identical.
 *
 * ── why a multiplier and not an absolute value (§10.3, decided 19 Sep 2026) ────────────
 *
 * A pool id spans shapes (design 109 §9): the base graph can hold 2 years of spending in
 * `bonds` and the bridge shape 4, and that difference is the entire reason shapes exist.
 * An absolute `pool.<id>.target` swept to 3 would set BOTH to 3 — it would delete a policy
 * the author wrote and then report a single number as if it were the policy. A factor
 * sweeps the LEVEL of the profile and preserves its shape, which is one rule with no
 * special case, including for a pool that only some shapes contain (the factor applies to
 * the shapes that have it and there is nothing to apply it to in the ones that do not).
 *
 * `pool.<id>.target` as an absolute key must NOT be added beside this one: two keys writing
 * one field is design 97 §12.2's one-authority rule broken, and a sweep that set both would
 * have no defined answer. An author who wants an absolute value writes it in the graph.
 *
 * ── why the seam is the RESOLVER and not the loader cascade ────────────────────────────
 *
 * Every other generated param (design 55) cascades onto a cfg RECORD, so `ScenarioLoader`
 * is its seam. A pool graph is not a record — it is the `liquidityGraph` / `liquidityShapes`
 * param value, read from the params bag at `buildSim()` time, before the loader runs
 * (`config-field-in-state-is-not-read`). So the scale is applied where the graph is
 * RESOLVED (`resolveLiquidityGraph` / `resolveLiquidityGraphSchedule`), in front of the
 * normalizer, on a copy.
 *
 * That placement is what makes §6.2's "an overlay, not a rewrite" true by construction
 * rather than by discipline: the authored param object is never written to, so a scenario
 * saved mid-sweep reloads with the author's own targets (CTRL-9), and applying the overlay
 * twice cannot compound (CTRL-9's sibling property — a multiplier, unlike
 * `BALANCE_TARGET`'s absolute rescale, is not idempotent, so nothing may apply it to its
 * own output).
 *
 * No second validator (§17.2): the scaled value goes through `normalizeLiquidityGraph`
 * exactly as an authored one does. A factor that pushes a PERCENT target past 1.0 is
 * therefore REFUSED with the normalizer's own sentence rather than silently clamped — the
 * cell fails loudly instead of running a target nobody chose.
 */
// Leg C's other axis family, imported for `resolveLiquidityAxisCenters` only — one function for
// the three lever bases to merge, so a family added later cannot reach two of the three.
import { resolveGateAxisCenters } from './pool-gate-axis.js';
import { resolveShapeYearShiftCenters } from './pool-shape-year-axis.js';

/** The generated namespace this axis lives in (see `GENERATED_KEY_PREFIXES`). */
export const POOL_KEY_PREFIX = 'pool.';

/** The one field the namespace carries. */
export const POOL_TARGET_SCALE_FIELD = 'targetScale';

/** Identity — the value a plan nobody sweeps runs at. */
export const POOL_TARGET_SCALE_DEFAULT = 1;

/**
 * How far a grid or a solver may scale a target: half it to double it, in quarter steps.
 *
 * Exported rather than written in the Opt contributor, because `poolAxisProblems` has to know
 * the same span to say whether a sweep will push a PERCENT target past 1.0. Two transcriptions
 * of one range is how a warning comes to disagree with the thing it warns about.
 */
export const POOL_TARGET_SCALE_RANGE = Object.freeze({ min: 0.5, max: 2, step: 0.25 });

/** The param key for one pool's target factor. */
export function poolTargetScaleKey(poolId) {
  return `${POOL_KEY_PREFIX}${poolId}.${POOL_TARGET_SCALE_FIELD}`;
}

/**
 * The pool id in a `pool.<poolId>.targetScale` key, or null for anything else.
 * A pool id is any non-empty string (`liquidity-graph.js` only requires that), so the id
 * is everything between the prefix and the trailing field rather than one dot-free token.
 */
export function parsePoolTargetScaleKey(key) {
  if (typeof key !== 'string' || !key.startsWith(POOL_KEY_PREFIX)) return null;
  const suffix = `.${POOL_TARGET_SCALE_FIELD}`;
  if (!key.endsWith(suffix)) return null;
  const id = key.slice(POOL_KEY_PREFIX.length, key.length - suffix.length);
  return id.length > 0 ? id : null;
}

/**
 * The factors a params bag carries, as `poolId → factor`.
 *
 * Identity and nonsense are both dropped, so the common case returns an empty map and the
 * scaling functions below can short-circuit to the caller's own object — that is what keeps
 * an unswept plan byte-identical rather than merely numerically equal.
 *
 * @param {object} params  a flat param bag
 * @returns {Map<string, number>}
 */
export function poolTargetScalesFrom(params) {
  const out = new Map();
  if (!params || typeof params !== 'object') return out;
  for (const key of Object.keys(params)) {
    const poolId = parsePoolTargetScaleKey(key);
    if (poolId == null) continue;
    const k = Number(params[key]);
    if (!Number.isFinite(k) || k < 0 || k === POOL_TARGET_SCALE_DEFAULT) continue;
    out.set(poolId, k);
  }
  return out;
}

/** Float noise off a product, so `5 × 1.2` is 6 and not 6.000000000000001. */
const trim = (n) => Number(n.toPrecision(12));

/**
 * One raw size spec, scaled. Both authored forms are handled: the `{ mode, value }` object
 * and the bare number that is sugar for the default mode (see `sizeSpec`). Anything else —
 * a spec whose `value` is missing or non-numeric — is returned unchanged and left for the
 * normalizer to refuse or accept on its own terms.
 */
function scaleRawTarget(raw, k) {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const next = trim(raw * k);
    return next === raw ? raw : next;
  }
  if (raw && typeof raw === 'object' && Number.isFinite(raw.value)) {
    const next = trim(raw.value * k);
    // A product equal to the authored value is not a change. Returning the spec itself keeps
    // the "same object back" property honest for the case that actually occurs: a target of 0,
    // which no factor can move (see `scalablePoolTargets`).
    return next === raw.value ? raw : { ...raw, value: next };
  }
  return raw;
}

/**
 * A raw graph with its pools' targets scaled. Returns the SAME object when nothing changed.
 *
 * @param {object} raw     a raw `{ pools, flows }` graph as authored
 * @param {Map<string, number>} scales  from {@link poolTargetScalesFrom}
 */
export function scaleRawPoolGraph(raw, scales) {
  if (!raw || typeof raw !== 'object' || scales.size === 0) return raw;
  if (!Array.isArray(raw.pools)) return raw;
  let touched = false;
  const pools = raw.pools.map((pool) => {
    if (!pool || typeof pool !== 'object' || pool.target == null) return pool;
    const k = scales.get(pool.id);
    if (k === undefined) return pool;
    const target = scaleRawTarget(pool.target, k);
    if (target === pool.target) return pool;
    touched = true;
    return { ...pool, target };
  });
  return touched ? { ...raw, pools } : raw;
}

/**
 * The `{ <shapeId>: graph }` map with every shape's pools scaled by the same factors.
 *
 * §6.4 — the key is the POOL id, so one factor moves that pool in every shape that
 * contains it. That is the whole content of §10.3's decision and the thing CTRL-14 pins.
 */
export function scaleRawPoolShapes(rawShapes, scales) {
  if (!rawShapes || typeof rawShapes !== 'object' || scales.size === 0) return rawShapes;
  let touched = false;
  const out = {};
  for (const [id, shape] of Object.entries(rawShapes)) {
    const scaled = scaleRawPoolGraph(shape, scales);
    if (scaled !== shape) touched = true;
    out[id] = scaled;
  }
  return touched ? out : rawShapes;
}

/**
 * Every pool in a plan that HAS a numeric target, and therefore a level to scale.
 *
 * One row per pool id across the base graph and every shape, carrying the authored values
 * the id resolves to — which is what §10.3 says the axis row has to show, so that a factor
 * of 0.5 reads as "1y / 2y" rather than as a bare 0.5 the reader has to translate.
 *
 * Reads the RAW graph rather than a normalized one deliberately: this runs on an unloaded
 * param bag, where a graph may not compile at all, and an axis list that throws would take
 * the whole Opt / grid panel with it.
 *
 * @param {object} params  a flat param bag (`liquidityGraph`, `liquidityShapes`)
 * @returns {Array<{ poolId: string, label: string,
 *                   authored: Array<{ where: string|null, mode: string|null, value: number }> }>}
 */
export function scalablePoolTargets(params) {
  const graphs = [];
  const base = params?.liquidityGraph;
  if (base && typeof base === 'object') graphs.push([null, base]);
  const shapes = params?.liquidityShapes;
  if (shapes && typeof shapes === 'object' && !Array.isArray(shapes)) {
    for (const [id, shape] of Object.entries(shapes)) {
      if (shape && typeof shape === 'object') graphs.push([id, shape]);
    }
  }
  const byId = new Map();
  // Pools whose target is non-zero in at least ONE shape. A FACTOR cannot lift a target off
  // zero, so a pool authored at 0 everywhere has no level to scale: the axis would read as a
  // lever, sweep as a lever and return byte-identical rollouts. That is the failure
  // `appliesTo` exists for on the record templates ("a param that changes nothing is worse
  // than no param") and it is not hypothetical — the author's own plan carries an
  // `AMOUNT 0` offset pool, which is how this was found.
  //
  // Scoped to "no shape authors a non-zero value", not "the base graph is zero": a pool the
  // base holds nothing in and a bridge shape holds four years in is genuinely searchable, and
  // it is the most interesting kind of pool there is (§10.3's bridge case).
  const nonZero = new Set();
  for (const [where, graph] of graphs) {
    for (const pool of (Array.isArray(graph.pools) ? graph.pools : [])) {
      if (!pool || typeof pool !== 'object' || typeof pool.id !== 'string' || !pool.id) continue;
      const target = pool.target;
      const value = (typeof target === 'number') ? target
                  : (target && typeof target === 'object') ? target.value : undefined;
      if (!Number.isFinite(value)) continue;
      const mode = (target && typeof target === 'object' && typeof target.mode === 'string')
        ? target.mode : null;
      if (value !== 0) nonZero.add(pool.id);
      const row = byId.get(pool.id)
        ?? { poolId: pool.id, label: pool.id, authored: [] };
      // The first LABEL wins, and the base graph is read first: a pool relabelled in a
      // later shape is still the same pool, and the row names it once.
      if (typeof pool.label === 'string' && pool.label && row.label === row.poolId) {
        row.label = pool.label;
      }
      row.authored.push({ where, mode, value });
      byId.set(pool.id, row);
    }
  }
  return [...byId.values()].filter(r => nonZero.has(r.poolId));
}

/**
 * One param's AUTHORED value on a cfg: the typed `cfg.params` entry first, the flat
 * `cfg.parameters` bag second.
 *
 * The order is the point, not a convenience. `cfg.params` is what the author wrote and what
 * `ScenarioSerializer` saves; `cfg.parameters` is the flat bag an MC/Opt runner injects
 * sampled values into (`two-param-stores-trap`). Reading the typed entry first is what makes
 * the axis list — and the hygiene report built from the same graph — stable across a sweep
 * rather than describing whatever the last cell happened to run at.
 */
export function authoredParamValue(cfg, key) {
  const typed = Array.isArray(cfg?.params) ? cfg.params.find(p => p?.name === key) : undefined;
  return typed ? typed.value : cfg?.parameters?.[key];
}

/** The base graph and the shape map as AUTHORED, for the axis list and the hygiene report. */
export function authoredPoolGraphs(cfg) {
  return {
    liquidityGraph:  authoredParamValue(cfg, 'liquidityGraph'),
    liquidityShapes: authoredParamValue(cfg, 'liquidityShapes'),
  };
}

/**
 * The plan value of every pool axis: `1.0`, for each pool the plan gives a target.
 *
 * A hidden generated param is deliberately absent from `cfg.params` and from
 * `paramSchemaDefaults` (both exclude `hidden`), so the lever base has no value for it and
 * a grid axis would have no plan value or reference cell. Merged into the base alongside
 * `resolveBalanceCenters` / `resolveAliasCenters` for exactly the same reason those exist.
 *
 * @param {object} cfg  a scenario config (loaded or serialized)
 * @returns {Object<string, number>}
 */
export function resolvePoolTargetScaleCenters(cfg) {
  if (!cfg) return {};
  const centers = {};
  for (const { poolId } of scalablePoolTargets(authoredPoolGraphs(cfg))) {
    centers[poolTargetScaleKey(poolId)] = POOL_TARGET_SCALE_DEFAULT;
  }
  return centers;
}

/**
 * Every leg-C axis's plan value for this cfg — the pool factors AND the gate thresholds/dwells.
 *
 * One function so the three lever bases that need it (`IntlRetirementMcRunner._prepare`,
 * `OptimizationProblem._resolveBase`, `MonteCarloPresenter._resolveBaseParams`) merge ONE thing.
 * A second axis family added to leg C later and merged at two of the three sites would be
 * live on the panel and centreless in the runner, which is the shape of defect this design
 * keeps re-finding.
 */
export function resolveLiquidityAxisCenters(cfg) {
  if (!cfg) return {};
  const authored = authoredPoolGraphs(cfg);
  const schedule = {
    liquidityShapes:        authored.liquidityShapes,
    liquidityGraphSchedule: authoredParamValue(cfg, 'liquidityGraphSchedule'),
  };
  return { ...resolvePoolTargetScaleCenters(cfg), ...resolveGateAxisCenters(cfg, authored),
           ...resolveShapeYearShiftCenters(schedule) };
}

/** Mode → the unit an authored target reads in, for a label. */
const TARGET_UNIT = { YEARS_OF_SPEND: 'y', YEARS_OF_SPEND_REMAINDER: 'y', PERCENT: '%', AMOUNT: '$' };

/** One authored target as the reader wrote it: `4y`, `60%`, `$50,000`. */
function describeAuthored({ mode, value }) {
  const unit = TARGET_UNIT[mode] ?? 'y';                 // absent mode ⇒ YEARS_OF_SPEND (the sugar default)
  if (unit === '%') return `${trim(value * 100)}%`;
  if (unit === '$') return `$${Math.round(value).toLocaleString('en-US')}`;
  return `${trim(value)}y`;
}

/**
 * The label a pool axis carries — §6.4 and §10.3, both of which are label obligations.
 *
 * §6.4: the key is the pool id, so the axis moves the pool in EVERY shape that contains it.
 * "That is probably what an author means and it is certainly not obvious, so it is a thing
 * the row's label has to say, not a thing the reader should infer."
 *
 * §10.3: a factor is less legible than a number of years, and the agreed price of the
 * multiplier is that the row shows the values the factor is multiplying. So the authored
 * target of every shape the pool appears in is named here, which is also the only place a
 * reader can see that one factor is about to move two different numbers.
 */
export function poolTargetScaleLabel(row) {
  const shapes = row.authored.length;
  const parts = row.authored.map(a =>
    `${a.where == null ? 'base' : a.where} ${describeAuthored(a)}`);
  const scope = shapes > 1 ? ` — one factor, ${shapes} shapes` : '';
  return `Pool '${row.label}' target × (${parts.join(', ')})${scope}`;
}

/**
 * DESIGN 112 §2.3 "Legibility" — a factor as the SIZE it resolves to, then the factor:
 * `cash 3y (×1.5)`, or `bonds base 4.5y / bridge 7.5y (×1.5)` for a pool in several graphs.
 *
 * One formatter for every place a factor is shown — the target-schedule row editor, the MPC
 * control's search list and `describe`, and the Pools panel — so the four cannot disagree. It is
 * the axis label's (`poolTargetScaleLabel`) obligation carried one step further: that label
 * names the authored values a factor multiplies; this one does the multiplication.
 *
 * A `YEARS_OF_SPEND_REMAINDER` pool is shown as its RESIDUAL, because the factor multiplies the
 * aggregate and the residual moves by more than the factor (§2.5): 6y behind 4y is 2y, and ×1.5
 * makes it 5y, not 3y. The residual is computed when every pool it sits behind has a years
 * target in that graph (a static figure); otherwise the aggregate is shown and labelled so.
 *
 * Reads the RAW graphs, like `scalablePoolTargets`, so it never throws on a plan that does not
 * compile. A pool no graph contains reads as `pool (not in any graph)`.
 *
 * @param {object} params  a flat bag carrying `liquidityGraph` / `liquidityShapes`
 * @param {string} poolId
 * @param {number} factor
 * @returns {string}
 */
export function describeScaledTarget(params, poolId, factor) {
  return describeScaledDescriptor(scaledTargetDescriptor(params, poolId), factor);
}

/**
 * What {@link describeScaledTarget} needs about one pool, as small plain JSON: its label and,
 * per graph containing it, the raw target and (for a REMAINDER) the years the pools it sits
 * behind state. An MPC variable carries this instead of the graphs, so `describe` can label any
 * candidate factor without the variable dragging the whole plan into every record.
 *
 * @returns {{label:string, parts:Array<{where:string|null, target:*, covered:number|null}>}}
 */
export function scaledTargetDescriptor(params, poolId) {
  const graphs = [];
  const base = params?.liquidityGraph;
  if (base && typeof base === 'object') graphs.push([null, base]);
  const shapes = params?.liquidityShapes;
  if (shapes && typeof shapes === 'object' && !Array.isArray(shapes)) {
    for (const [id, shape] of Object.entries(shapes)) {
      if (shape && typeof shape === 'object') graphs.push([id, shape]);
    }
  }
  const parts = [];
  let label = poolId;
  for (const [where, graph] of graphs) {
    const pools = Array.isArray(graph.pools) ? graph.pools : [];
    const pool = pools.find(p => p?.id === poolId);
    if (!pool) continue;
    if (typeof pool.label === 'string' && pool.label && label === poolId) label = pool.label;
    parts.push({ where, target: pool.target ?? null, covered: _coveredYears(pool.target, pools) });
  }
  return { label, parts };
}

/** A descriptor at factor `k` — the string {@link describeScaledTarget} returns. */
export function describeScaledDescriptor(desc, factor) {
  const k = Number(factor);
  // Two decimals: a solver's factor is continuous, and "×1.25493289449" is noise to a reader.
  const f = Number.isFinite(k) ? `×${round2(k)}` : '×?';
  const parts = desc?.parts ?? [];
  const label = desc?.label ?? '?';
  if (!parts.length) return `${label} (not in any graph) (${f})`;
  const at = Number.isFinite(k) ? k : 1;
  const each = parts.map(p => [p.where ?? 'base', _scaledSize(p.target, p.covered, at)]);
  // One size when every graph resolves to the same one: "base 2y / wrapLast 2y" says the same
  // thing twice and hides the case where the shapes genuinely differ.
  const sizes = new Set(each.map(([, sz]) => sz)).size === 1
    ? each[0][1]
    : each.map(([where, sz]) => `${where} ${sz}`).join(' / ');
  return `${label} ${sizes} (${f})`;
}

/** Two decimals, without trailing zeros: 1.25493 → 1.25, 2 → 2. */
const round2 = (n) => Number(n.toFixed(2));

/**
 * For a REMAINDER target, the years the pools it sits behind state — or null when one of them
 * has no static years figure (then only the aggregate can be shown). A referenced pool with a
 * real ceiling contributes what it HOLDS at run time, which no static label can know, so its
 * target is used as the best available statement of it. @private
 */
function _coveredYears(target, pools) {
  if (!target || typeof target !== 'object' || target.mode !== 'YEARS_OF_SPEND_REMAINDER') return null;
  let covered = 0;
  for (const ref of (Array.isArray(target.after) ? target.after : [])) {
    const y = _yearsOf(pools.find(p => p?.id === ref)?.target);
    if (y == null) return null;
    covered += y;
  }
  return covered;
}

/** Years a raw target states, when it is a plain years figure; otherwise null. @private */
function _yearsOf(target) {
  if (typeof target === 'number') return target;
  if (target && typeof target === 'object' && Number.isFinite(target.value)
      && (target.mode == null || target.mode === 'YEARS_OF_SPEND')) return target.value;
  return null;
}

/** One raw target at factor `k`, in its own unit. @private */
function _scaledSize(target, covered, k) {
  if (target == null) return 'no target';
  if (typeof target === 'number') return describeAuthored({ mode: null, value: round2(target * k) });
  if (typeof target !== 'object' || !Number.isFinite(target.value)) return 'no target';
  const raw = target.value * k;
  // A PERCENT value is a fraction, so it keeps two more places (37.04%, not 37%).
  const value = target.mode === 'PERCENT' ? Number(raw.toFixed(4)) : round2(raw);
  if (target.mode !== 'YEARS_OF_SPEND_REMAINDER') return describeAuthored({ mode: target.mode, value });
  if (covered == null) return `${value}y aggregate`;
  return `${round2(Math.max(0, value - covered))}y left of ${value}y`;
}
