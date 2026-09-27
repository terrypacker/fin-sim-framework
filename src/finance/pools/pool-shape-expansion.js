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
 * Design 114 Part I — pool shapes that inherit.
 *
 * A named shape (`liquidityShapes[id]`, design 109) is either STANDALONE — a whole graph, which
 * is every shape authored before this design — or a DELTA over a parent:
 *
 *   { extends: 'base' | '<shapeId>',
 *     pools:  [ … ],   // an id the parent has ⇒ REPLACES that pool whole; a new id ⇒ ADDED
 *     flows:  [ … ],   // the same, for flows
 *     remove: { pools: [ids], flows: [ids] } }
 *
 * Expansion turns every delta into the whole graph it means, BEFORE anything validates,
 * compiles, scales or searches it. The whole-graph rule of design 109 Q1 is therefore intact:
 * inheritance is authoring sugar, and every consumer sees complete graphs.
 *
 * ─── why every reader goes through here (design 114 §5.1) ──────────────────────────
 *
 * A reader that looks at `liquidityShapes` raw sees a delta — a shape with none of its
 * inherited pools — and fails QUIETLY: an axis finds no pool to scale, a gate override finds no
 * flow to move, a hygiene row says a pool is absent from a shape that inherits it. That is the
 * dead-lever shape the pool axes have been bitten by before, so `tests/unit/pool-shape-expansion-
 * hygiene.test.mjs` fails on any raw content read of the param outside an annotated line.
 *
 * ─── leaf module ──────────────────────────────────────────────────────────────────
 *
 * No imports. `lever-schedule.js` (MPC) may import leaf modules only (design 81), and it reads
 * shapes.
 */

/** The id a delta names to inherit from the base `liquidityGraph`. Reserved as a shape id. */
export const BASE_SHAPE_ID = 'base';

/** An expansion refusal, carrying the shape it is about so callers can localize it. */
export class ShapeExpansionError extends Error {
  constructor(shapeId, message) {
    super(`shape '${shapeId}': ${message}`);
    this.name = 'ShapeExpansionError';
    this.shapeId = shapeId;
  }
}

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/** True when `shape` is authored as a delta (it names a parent). */
export function isDeltaShape(shape) {
  return isPlainObject(shape) && Object.hasOwn(shape, 'extends');
}

/** The keys a delta uses for its own bookkeeping — never part of the graph it expands to. */
const DELTA_KEYS = new Set(['extends', 'remove']);

/**
 * Every shape as the whole graph it means.
 *
 * Returns the caller's own `shapes` object when no shape is a delta, so a plan authored before
 * this design takes no new path at all. Otherwise a new object in the same key order; a
 * standalone shape is carried by reference, a delta is expanded.
 *
 * Resolution (design 114 §5.1):
 *   1. the parent is resolved first, recursively (chains are allowed — D3);
 *   2. ORDER is preserved: the parent's items in the parent's order, an override in its parent's
 *      position, removed ids dropped, additions appended in delta order;
 *   3. the result carries no `extends` / `remove`, so expansion is idempotent.
 *
 * A container that is not an object is returned untouched: the loader owns that refusal and
 * words it for the container, not for a shape.
 *
 * @param {*} baseGraph  the `liquidityGraph` param
 * @param {*} shapes     the `liquidityShapes` param
 * @param {{lenient?: boolean}} [opts]  lenient ⇒ a shape that cannot be expanded is returned
 *        as authored instead of throwing. For readers that run on an UNLOADED bag (the axis
 *        lists, the hygiene report) and must never take a panel down with them; the loader
 *        runs strict and is the authority on the refusal.
 * @returns {*} the expanded shape map
 * @throws {ShapeExpansionError} (strict only)
 */
export function expandLiquidityShapes(baseGraph, shapes, { lenient = false } = {}) {
  if (!isPlainObject(shapes)) return shapes;
  const ids = Object.keys(shapes);
  if (!ids.some(id => isDeltaShape(shapes[id]))) return shapes;

  const done = new Map();          // id → expanded graph

  const resolve = (id, chain) => {
    if (done.has(id)) return done.get(id);
    const shape = shapes[id];
    if (!isDeltaShape(shape)) { done.set(id, shape); return shape; }
    if (chain.includes(id)) {
      throw new ShapeExpansionError(chain[0],
        `\`extends\` forms a cycle: ${[...chain, id].map(s => `'${s}'`).join(' → ')}`);
    }
    const parentId = shape.extends;
    if (typeof parentId !== 'string' || !parentId) {
      throw new ShapeExpansionError(id,
        `\`extends\` has to name '${BASE_SHAPE_ID}' or another shape, not ${JSON.stringify(parentId)}`);
    }
    let parent;
    if (parentId === BASE_SHAPE_ID) {
      if (!isPlainObject(baseGraph)) {
        throw new ShapeExpansionError(id,
          `extends '${BASE_SHAPE_ID}', but no base Liquidity Pools graph is authored`);
      }
      parent = baseGraph;
    } else {
      if (!Object.hasOwn(shapes, parentId)) {
        const known = ids.filter(s => s !== id);
        throw new ShapeExpansionError(id,
          `extends '${parentId}', which is not a shape (known: '${BASE_SHAPE_ID}'`
          + `${known.length ? `, ${known.map(s => `'${s}'`).join(', ')}` : ''})`);
      }
      parent = resolve(parentId, [...chain, id]);
      if (!isPlainObject(parent)) {
        throw new ShapeExpansionError(id, `extends '${parentId}', which is not a graph`);
      }
    }
    const graph = applyShapeDelta(parent, shape, id);
    done.set(id, graph);
    return graph;
  };

  const out = {};
  for (const id of ids) {
    try {
      out[id] = resolve(id, []);
    } catch (e) {
      if (!lenient || !(e instanceof ShapeExpansionError)) throw e;
      out[id] = shapes[id];
    }
  }
  return out;
}

/**
 * One delta over one (already whole) parent graph. Exported for the editor's readouts and the
 * conversion proof; `expandLiquidityShapes` is the entry point for everything else.
 *
 * @throws {ShapeExpansionError}
 */
export function applyShapeDelta(parent, delta, shapeId) {
  const out = {};
  for (const [k, v] of Object.entries(parent)) if (!DELTA_KEYS.has(k)) out[k] = v;
  for (const [k, v] of Object.entries(delta)) {
    if (!DELTA_KEYS.has(k) && k !== 'pools' && k !== 'flows') out[k] = v;
  }
  const remove = _removeLists(delta.remove, shapeId);
  for (const kind of ['pools', 'flows']) {
    const merged = _mergeItems(parent[kind], delta[kind], remove[kind], kind, shapeId);
    if (merged != null) out[kind] = merged;
  }
  return out;
}

/** `remove` validated to `{ pools: Set, flows: Set }`. */
function _removeLists(raw, shapeId) {
  const out = { pools: new Set(), flows: new Set() };
  if (raw == null) return out;
  if (!isPlainObject(raw)) {
    throw new ShapeExpansionError(shapeId, '`remove` has to be { pools: [ids], flows: [ids] }');
  }
  for (const [kind, list] of Object.entries(raw)) {
    if (kind !== 'pools' && kind !== 'flows') {
      throw new ShapeExpansionError(shapeId, `\`remove.${kind}\` is unknown — only pools and flows can be removed`);
    }
    if (!Array.isArray(list) || list.some(x => typeof x !== 'string' || !x)) {
      throw new ShapeExpansionError(shapeId, `\`remove.${kind}\` has to be a list of ids`);
    }
    for (const x of list) out[kind].add(x);
  }
  return out;
}

/**
 * The parent's list with the delta's items applied: overrides in place, removals dropped,
 * additions appended. Null when neither side has the list (so an absent `flows` stays absent).
 */
function _mergeItems(parentList, deltaList, removed, kind, shapeId) {
  const noun = kind === 'pools' ? 'pool' : 'flow';
  if (deltaList != null && !Array.isArray(deltaList)) {
    throw new ShapeExpansionError(shapeId, `\`${kind}\` has to be a list`);
  }
  const base = Array.isArray(parentList) ? parentList : [];
  const own = Array.isArray(deltaList) ? deltaList : [];
  if (parentList == null && deltaList == null) {
    if (removed.size) {
      throw new ShapeExpansionError(shapeId,
        `removes ${noun} ${[...removed].map(s => `'${s}'`).join(', ')}, which the parent does not have`);
    }
    return null;
  }

  const parentIds = new Set(base.map(x => x?.id).filter(id => typeof id === 'string'));
  const overrides = new Map();
  const added = [];
  for (const item of own) {
    if (!isPlainObject(item) || typeof item.id !== 'string' || !item.id) {
      throw new ShapeExpansionError(shapeId, `every ${noun} a shape overrides or adds needs an id`);
    }
    if (overrides.has(item.id) || added.some(a => a.id === item.id)) {
      throw new ShapeExpansionError(shapeId, `${noun} '${item.id}' appears twice`);
    }
    if (removed.has(item.id)) {
      throw new ShapeExpansionError(shapeId, `${noun} '${item.id}' is both removed and overridden`);
    }
    if (parentIds.has(item.id)) overrides.set(item.id, item);
    else added.push(item);
  }
  // A `remove` of an id the parent does not have is a typo, or a parent that changed underneath
  // the shape. Both should be seen (design 114 §4).
  const missing = [...removed].filter(id => !parentIds.has(id));
  if (missing.length) {
    throw new ShapeExpansionError(shapeId,
      `removes ${noun} ${missing.map(s => `'${s}'`).join(', ')}, which the parent does not have`);
  }

  const merged = [];
  for (const item of base) {
    const id = item?.id;
    if (typeof id === 'string' && removed.has(id)) continue;
    merged.push(typeof id === 'string' && overrides.has(id) ? overrides.get(id) : item);
  }
  merged.push(...added);
  return merged;
}

/**
 * The ancestors of a shape, nearest first, ending in `BASE_SHAPE_ID` when the chain reaches the
 * base graph. Empty for a standalone shape. Never throws: a broken chain stops where it breaks.
 */
export function shapeLineage(shapes, id) {
  const out = [];
  if (!isPlainObject(shapes)) return out;
  let cur = shapes[id];
  const seen = new Set([id]);
  while (isDeltaShape(cur)) {
    const parent = cur.extends;
    if (typeof parent !== 'string' || !parent || seen.has(parent)) break;
    out.push(parent);
    if (parent === BASE_SHAPE_ID) break;
    seen.add(parent);
    cur = shapes[parent];
  }
  return out;
}

/** The named shapes' ids, in authored order. Ids do not change under expansion. */
export function liquidityShapeIds(params) {
  const shapes = params?.liquidityShapes;
  return isPlainObject(shapes) ? Object.keys(shapes) : [];
}

/** `expandLiquidityShapes` over a flat param bag. */
export function expandedShapesOf(params, opts) {
  return expandLiquidityShapes(params?.liquidityGraph, params?.liquidityShapes, opts);
}

/**
 * Every graph a plan authors as `[where, graph]` — `[null, base]` first, then each shape
 * EXPANDED — skipping anything that is not an object. Lenient: this is what the axis lists and
 * the hygiene report walk, and they run on unloaded bags.
 *
 * @returns {Array<[string|null, object]>}
 */
export function poolGraphEntries(params) {
  const out = [];
  const base = params?.liquidityGraph;
  if (isPlainObject(base)) out.push([null, base]);
  const shapes = expandedShapesOf(params, { lenient: true });
  if (isPlainObject(shapes)) {
    for (const [id, g] of Object.entries(shapes)) if (isPlainObject(g)) out.push([id, g]);
  }
  return out;
}

/**
 * The graph a schedule entry selects, expanded: `null` is the base graph.
 * Lenient, for the MPC readers that run on a base-params bag.
 */
export function poolGraphFor(params, shapeId) {
  if (shapeId === null) return params?.liquidityGraph;
  const shapes = expandedShapesOf(params, { lenient: true });
  return isPlainObject(shapes) ? shapes[shapeId] : undefined;
}

// ─── conversion (design 114 §5.3) ──────────────────────────────────────────────────

/** Structural equality: arrays by position, objects by key SET (key order is not meaning). */
export function sameGraphValue(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => sameGraphValue(x, b[i]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return Number.isNaN(a) && Number.isNaN(b);
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every(k => Object.hasOwn(b, k) && sameGraphValue(a[k], b[k]));
}

/**
 * The delta that makes `shape` (a whole graph) inherit from `parent` (a whole graph), PROVEN:
 * the delta expanded over the parent must equal the shape, order included. When it cannot be —
 * the shape orders its items differently from the parent, or carries a top-level key the parent
 * has and it lacks — conversion is refused rather than changing what the run sees.
 *
 * @param {object} parent    the parent's WHOLE graph (expand it first if it is itself a delta)
 * @param {object} shape     the standalone shape to convert
 * @param {string} parentId  what `extends` will say
 * @returns {{ok: true, delta: object} | {ok: false, reason: string}}
 */
export function shapeDeltaAgainst(parent, shape, parentId) {
  if (!isPlainObject(parent) || !isPlainObject(shape)) {
    return { ok: false, reason: 'both the shape and its parent have to be graphs' };
  }
  if (isDeltaShape(shape)) return { ok: false, reason: 'the shape already inherits' };
  const delta = { extends: parentId };
  const remove = {};
  for (const kind of ['pools', 'flows']) {
    const mine = Array.isArray(shape[kind]) ? shape[kind] : [];
    const theirs = new Map((Array.isArray(parent[kind]) ? parent[kind] : [])
      .filter(x => typeof x?.id === 'string').map(x => [x.id, x]));
    const own = mine.filter(x => !(typeof x?.id === 'string' && theirs.has(x.id)
                                   && sameGraphValue(x, theirs.get(x.id))));
    if (own.length) delta[kind] = own;
    const kept = new Set(mine.map(x => x?.id));
    const gone = [...theirs.keys()].filter(id => !kept.has(id));
    if (gone.length) remove[kind] = gone;
  }
  for (const [k, v] of Object.entries(shape)) {
    if (k !== 'pools' && k !== 'flows' && !sameGraphValue(v, parent[k])) delta[k] = v;
  }
  if (Object.keys(remove).length) delta.remove = remove;

  let expanded;
  try {
    expanded = applyShapeDelta(parent, delta, '(conversion)');
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  // An absent `pools` / `flows` list and an empty one mean the same graph (the normalizer reads
  // both as []), and a delta that removes every flow expands to `flows: []`. Everything else is
  // compared strictly.
  const withLists = (g) => ({ ...g, pools: g.pools ?? [], flows: g.flows ?? [] });
  if (!sameGraphValue(withLists(expanded), withLists(shape))) {
    return { ok: false, reason: 'the shape lists its pools or flows in a different order from '
      + 'the parent (or lacks a setting the parent has), so inheriting would change what the run '
      + 'sees. Keep it as a copy, or reorder it to match first.' };
  }
  return { ok: true, delta };
}
