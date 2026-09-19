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
 * The gate-clause AXIS — design 110 leg C, phase 8 (§2.1, §6.3 option A).
 *
 * §14's first constraint is that ids are stable and authored, never positional. §20.15 turned a
 * gate into a table of clause rows keyed by flow id and a branch NUMBER, and that number is
 * explicitly a position — `renumberBranches` densely renumbers on every edit. So a threshold
 * had **no address**, and "search gate thresholds" was unreachable: an axis written as
 * (flow, branch, ordinal) addresses a different clause the moment the author inserts a clause
 * above it, which is `legacy-alias-levers-inert-on-loaded-plan` in a new costume.
 *
 * §6.3 option A, and the reason it beat the other two: **an optional authored `id` on a gate
 * clause.** Absent means positional, exactly as today, so every graph ever authored is
 * unchanged; present makes the clause addressable, and **only id'd clauses generate an axis**.
 * An axis that cannot be addressed therefore FAILS TO EXIST rather than addressing the wrong
 * clause — which is the property that makes this safe, and the one the alternatives could not
 * offer. (Option B, one threshold per flow, re-imposes the single-clause gate §20.15 spent a
 * section removing; option C, sweeping whole graphs, stays supported and is what
 * `scripts/lib/pool-graph.mjs` is for — it is the only route that can sweep a STRUCTURAL
 * change, which no scalar axis will ever reach.)
 *
 * ── what an id addresses, stated once ────────────────────────────────────────────────
 *
 * An id addresses **the node it is authored on**, and that node yields up to two axes:
 *
 *   · `gate.<id>.threshold` — the node's single numeric clause. A node with two numeric
 *     clauses has no unique threshold, so it generates none: same rule as a pool that claims
 *     two allocation classes, and the same reason (inventing a winner would make the axis mean
 *     something the author never wrote).
 *   · `gate.<id>.dwell` — the node's `sustainedYears`, default 1. §20.13 measured the three
 *     trailing-high thresholds landing within \$13k of each other on a \$5m plan while the same
 *     gate family differing only in HOW LONG it stays shut spread by \$460k, so the dwell is the
 *     knob the evidence points at. §2.1 says as much and calls it "the one knob with no
 *     address"; it gets one here, because the addressing work is the same work and leaving it
 *     out would have left the evidence-backed lever unreachable. §20.16's dwell sweep was a
 *     negative result on one plan, which is a reason to be able to re-run it, not to delete it.
 *
 * **One level through a `not`.** A negated row's dwell sits on the `not` (*"the source has NOT
 * been within 5% of its high for two years"*) while the threshold sits on the clause inside it.
 * The editor's row model is exactly this pair, so an id authored on the `not` resolves its
 * threshold from the single clause it wraps. Any deeper and the id is on a composition, which
 * has no threshold of its own.
 *
 * ── the seam, and why it is the same one the pool axis uses ──────────────────────────
 *
 * Applied where the graph is RESOLVED, in front of `normalizeLiquidityGraph`, on a copy — see
 * `pool-target-scale.js` for the full argument. Two consequences worth naming here:
 *
 *   · it works on the RAW authored tree, so an id'd clause inside a gate the editor cannot draw
 *     (a nested `not`, an OR inside an AND — the `rawGate` cases) is still addressable. The
 *     axis is not limited to the DNF subset the table can render.
 *   · the authored param is never written to, so a scenario saved mid-sweep reloads with the
 *     author's own thresholds.
 */

/** The generated namespace for a gate-clause axis. */
export const GATE_KEY_PREFIX = 'gate.';

/** The two fields an id'd clause exposes. */
export const GATE_AXIS_FIELD = Object.freeze({ THRESHOLD: 'threshold', DWELL: 'dwell' });

/** The default dwell — one year, i.e. "no dwell", which `normalizeGate` drops. */
export const GATE_DWELL_DEFAULT = 1;

/**
 * The numeric clause kinds a threshold axis can move, and the range it sweeps.
 *
 * ABSOLUTE ranges rather than a factor of the authored value, which is the opposite of the pool
 * target's choice and for a stated reason: a pool target is a level whose SHAPE across shapes
 * must be preserved (§10.3), while a gate threshold is one number on one clause and the
 * interesting span is wide — §20.13 swept 1 %, 5 % and 10 %, a factor of ten. A ±50 % band
 * around an authored 0.05 would not reach either end of the measurement that motivated the axis.
 *
 * `ageOver` / `ageUnder` are addressable — they take an id like any clause — but get no
 * threshold axis. They are a different kind of number (years, not a fraction) and no plan in
 * this repository gates on one; the range belongs here when one does, not invented in advance.
 */
export const GATE_THRESHOLD_RANGES = Object.freeze({
  // A fraction below a trailing high. §20.13's three measured points sit inside this.
  sourceDrawdownUnder: { min: 0.01, max: 0.25, step: 0.02 },
  targetDrawdownOver:  { min: 0.01, max: 0.25, step: 0.02 },
  // A RETURN threshold, legitimately negative: "harvest unless the market is down more than
  // 10%" is -0.10, and "only after an up year" is 0.
  sourceReturnOver:    { min: -0.15, max: 0.15, step: 0.05 },
  targetReturnUnder:   { min: -0.15, max: 0.15, step: 0.05 },
});

/** The dwell's range. Years, and a short span: a gate held shut for a decade never opens. */
export const GATE_DWELL_RANGE = Object.freeze({ min: 1, max: 5, step: 1 });

/**
 * A clause id is dot-free and word-like, so `gate.<id>.<field>` decodes without ambiguity.
 *
 * Deliberately stricter than a pool id (which `liquidity-graph` allows to be any non-empty
 * string, and which this cannot retroactively narrow): a clause id is NEW, it exists only to be
 * an address, and an address that needs quoting is not one.
 */
export const GATE_CLAUSE_ID_RE = /^[A-Za-z0-9_-]+$/;

/** The param key for one id'd clause's threshold or dwell. */
export function gateAxisKey(clauseId, field) {
  return `${GATE_KEY_PREFIX}${clauseId}.${field}`;
}

/** `{ clauseId, field }` for a gate axis key, or null for anything else. */
export function parseGateAxisKey(key) {
  if (typeof key !== 'string' || !key.startsWith(GATE_KEY_PREFIX)) return null;
  const rest = key.slice(GATE_KEY_PREFIX.length);
  const dot = rest.lastIndexOf('.');
  if (dot <= 0) return null;
  const clauseId = rest.slice(0, dot);
  const field = rest.slice(dot + 1);
  if (!GATE_CLAUSE_ID_RE.test(clauseId)) return null;
  if (field !== GATE_AXIS_FIELD.THRESHOLD && field !== GATE_AXIS_FIELD.DWELL) return null;
  return { clauseId, field };
}

/**
 * The overrides a params bag carries, as `clauseId → { threshold?, dwell? }`.
 *
 * A value equal to the authored one is NOT filtered out here, unlike the pool factor's
 * identity: there is no single default a threshold could be compared against without reading
 * the graph, and reading it here would make this function depend on the thing it overlays. The
 * overlay below returns the caller's own object when a write changes nothing, which gives the
 * same byte-identity property one layer down.
 */
export function gateOverridesFrom(params) {
  const out = new Map();
  if (!params || typeof params !== 'object') return out;
  for (const key of Object.keys(params)) {
    const hit = parseGateAxisKey(key);
    if (!hit) continue;
    const v = Number(params[key]);
    if (!Number.isFinite(v)) continue;
    if (hit.field === GATE_AXIS_FIELD.DWELL && (!Number.isInteger(v) || v < 1)) continue;
    const entry = out.get(hit.clauseId) ?? {};
    entry[hit.field] = v;
    out.set(hit.clauseId, entry);
  }
  return out;
}

/** The node a threshold lives on: this node, or the single clause a bare `not` wraps. */
function thresholdHost(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  if (thresholdKindOf(node) != null) return node;
  // One level through a negation — the editor's row model is exactly `{ not: clause }` plus a
  // dwell on the `not`, so an id authored there addresses the clause it wraps.
  if (node.not != null && thresholdKindOf(node.not) != null) return node.not;
  return null;
}

/** The single numeric clause kind on a node, or null when there is not exactly one. */
function thresholdKindOf(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  const kinds = Object.keys(GATE_THRESHOLD_RANGES).filter(k => Number.isFinite(Number(node[k])));
  return kinds.length === 1 ? kinds[0] : null;
}

/**
 * Walk every node of a raw gate tree, innermost last, calling `visit(node)`.
 * Arrays are `allOf` sugar (`normalizeGate`'s own rule), so they are walked as children.
 */
function walkGateNodes(node, visit) {
  if (node == null) return;
  if (Array.isArray(node)) { for (const k of node) walkGateNodes(k, visit); return; }
  if (typeof node !== 'object') return;
  visit(node);
  for (const key of ['allOf', 'anyOf']) {
    const child = node[key];
    if (child == null) continue;
    if (Array.isArray(child)) { for (const k of child) walkGateNodes(k, visit); }
    else walkGateNodes(child, visit);
  }
  if (node.not != null) walkGateNodes(node.not, visit);
}

/** One node, with `overrides` applied. Returns the SAME node when nothing changed. */
function overrideNode(node, override) {
  let out = node;
  const write = (target, key, value) => {
    if (target[key] === value) return;
    // The node the threshold lives on may be the `not`'s child, so the clone has to reach it:
    // shallow-copy the chain rather than the leaf alone, or the authored tree is mutated.
    out = (out === node) ? { ...node } : out;
    if (target === node) out[key] = value;
    else out.not = { ...out.not, [key]: value };
  };
  if (override.threshold !== undefined) {
    const host = thresholdHost(node);
    const kind = host ? thresholdKindOf(host) : null;
    if (kind) write(host, kind, override.threshold);
  }
  if (override.dwell !== undefined) {
    // The dwell rides on the node the id is authored on, never on the clause inside a `not`:
    // "its negation has held for n years" and "the clause has not held for n years" are two
    // different policies, and the id names the first (see the header).
    write(node, 'sustainedYears', override.dwell);
  }
  return out;
}

/**
 * A raw gate tree with every id'd node's override applied. Returns the SAME tree when nothing
 * changed, which is what keeps an unswept plan byte-identical rather than merely equal.
 */
export function applyGateOverridesToGate(gate, overrides) {
  if (gate == null || overrides.size === 0) return gate;
  const rebuild = (node) => {
    if (node == null) return node;
    if (Array.isArray(node)) {
      let touched = false;
      const kids = node.map((k) => { const n = rebuild(k); if (n !== k) touched = true; return n; });
      return touched ? kids : node;
    }
    if (typeof node !== 'object') return node;
    let out = node;
    const set = (key, value) => { out = (out === node) ? { ...node } : out; out[key] = value; };
    for (const key of ['allOf', 'anyOf', 'not']) {
      if (node[key] == null) continue;
      const next = rebuild(node[key]);
      if (next !== node[key]) set(key, next);
    }
    // The node's OWN override last, so a threshold written through a `not` is not then
    // overwritten by the rebuilt child above.
    const override = (typeof node.id === 'string') ? overrides.get(node.id) : undefined;
    if (override) {
      const withOwn = overrideNode(out, override);
      if (withOwn !== out) out = withOwn;
    }
    return out;
  };
  return rebuild(gate);
}

/** A raw `{ pools, flows }` graph with every flow's gate overridden. Same object when unchanged. */
export function applyGateOverridesToGraph(raw, overrides) {
  if (!raw || typeof raw !== 'object' || overrides.size === 0) return raw;
  if (!Array.isArray(raw.flows)) return raw;
  let touched = false;
  const flows = raw.flows.map((flow) => {
    if (!flow || typeof flow !== 'object' || flow.gate == null) return flow;
    const gate = applyGateOverridesToGate(flow.gate, overrides);
    if (gate === flow.gate) return flow;
    touched = true;
    return { ...flow, gate };
  });
  return touched ? { ...raw, flows } : raw;
}

/** The same, over a `{ <shapeId>: graph }` map — one id moves the clause in every shape. */
export function applyGateOverridesToShapes(rawShapes, overrides) {
  if (!rawShapes || typeof rawShapes !== 'object' || overrides.size === 0) return rawShapes;
  let touched = false;
  const out = {};
  for (const [id, shape] of Object.entries(rawShapes)) {
    const next = applyGateOverridesToGraph(shape, overrides);
    if (next !== shape) touched = true;
    out[id] = next;
  }
  return touched ? out : rawShapes;
}

/**
 * Every id'd gate clause in a plan, with what it is authored at.
 *
 * Reads the RAW graph, for the reason `scalablePoolTargets` does: this runs on an unloaded param
 * bag where a graph may not compile at all, and an axis list that throws would take the whole
 * Opt / grid panel with it. So the ids are not validated here — `normalizeLiquidityGraph` is the
 * authority on that, and a malformed id simply produces a row nothing can address, which is the
 * safe direction.
 *
 * @returns {Array<{ clauseId:string, kind:string|null, threshold:number|null, dwell:number,
 *                   negated:boolean, flows:string[], shapes:Array<string|null> }>}
 */
export function gateClauseAxes(params) {
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
  for (const [where, graph] of graphs) {
    for (const flow of (Array.isArray(graph.flows) ? graph.flows : [])) {
      if (!flow || typeof flow !== 'object' || flow.gate == null) continue;
      walkGateNodes(flow.gate, (node) => {
        const clauseId = node.id;
        if (typeof clauseId !== 'string' || !GATE_CLAUSE_ID_RE.test(clauseId)) return;
        const host = thresholdHost(node);
        const kind = host ? thresholdKindOf(host) : null;
        const row = byId.get(clauseId) ?? {
          clauseId, kind, negated: node.not != null && host !== node,
          threshold: kind ? Number(host[kind]) : null,
          dwell: Number.isFinite(Number(node.sustainedYears)) ? Number(node.sustainedYears) : GATE_DWELL_DEFAULT,
          flows: [], shapes: [],
        };
        if (typeof flow.id === 'string' && !row.flows.includes(flow.id)) row.flows.push(flow.id);
        if (!row.shapes.includes(where)) row.shapes.push(where);
        byId.set(clauseId, row);
      });
    }
  }
  return [...byId.values()];
}

const trim = (n) => Number(n.toPrecision(12));

/** Clause kind → the short phrase a label uses for it. */
const KIND_PHRASE = Object.freeze({
  sourceDrawdownUnder: 'source within',
  targetDrawdownOver:  'destination down over',
  sourceReturnOver:    'source return over',
  targetReturnUnder:   'destination return under',
});

/**
 * The label a gate axis carries.
 *
 * Names the FLOWS the clause gates and, when there is more than one shape, how many — the same
 * obligation §6.4 imposed on the pool axis, for the same reason: one id moves the clause in
 * every shape that contains it, which is probably what the author means and is certainly not
 * obvious from the key.
 */
export function gateAxisLabel(row, field) {
  const where = row.flows.length ? row.flows.join(', ') : 'no flow';
  const shapes = row.shapes.length > 1 ? ` — one key, ${row.shapes.length} shapes` : '';
  if (field === GATE_AXIS_FIELD.DWELL) {
    return `Gate '${row.clauseId}' (${where}) dwell — held ${row.dwell}y${shapes}`;
  }
  const phrase = KIND_PHRASE[row.kind] ?? row.kind ?? 'threshold';
  const sense = row.negated ? 'NOT ' : '';
  return `Gate '${row.clauseId}' (${where}) ${sense}${phrase} ${trim(row.threshold)}${shapes}`;
}

/**
 * The plan value of every gate axis, for the lever base.
 *
 * A hidden generated param is in neither `cfg.params` nor `paramSchemaDefaults`, so without
 * this a grid axis on a threshold has no plan value and no reference cell — the gap
 * `resolveBalanceCenters` and `resolvePoolTargetScaleCenters` fill for their own levers.
 * Unlike the pool factor, the centre is the AUTHORED number rather than a fixed identity: a
 * threshold has no natural 1.0, and the plan value is whatever the clause says.
 */
export function resolveGateAxisCenters(cfg, authoredGraphs) {
  const centers = {};
  for (const row of gateClauseAxes(authoredGraphs)) {
    if (row.kind) centers[gateAxisKey(row.clauseId, GATE_AXIS_FIELD.THRESHOLD)] = row.threshold;
    centers[gateAxisKey(row.clauseId, GATE_AXIS_FIELD.DWELL)] = row.dwell;
  }
  return centers;
}
