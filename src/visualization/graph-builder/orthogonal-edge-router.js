/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BACKWARD_MARGIN, EDGE_SPACING, LANE_OFFSET } from './graph-metrics.js';

/**
 * Identify groups of forward edges that share the same target node.
 * Only forward edges (source right anchor strictly left of target left anchor)
 * are eligible; backward and same-column edges are excluded.
 *
 * Returns a Map from targetId → array of edge keys ("from->to") for targets
 * that have 2 or more incoming forward edges.  Targets with fewer than 2 such
 * edges are omitted — they render normally.
 *
 * @param {Array<{from:string, to:string}>} edges
 * @param {Map<string,{x:number,y:number}>} positions  Node centre positions.
 * @param {{ nodeWidth: number }} opts
 * @returns {Map<string, string[]>}
 */
export function groupMergeTargets(edges, positions, { nodeWidth }) {
  const byTarget = new Map();

  for (const edge of edges) {
    const src = positions.get(edge.from);
    const tgt = positions.get(edge.to);
    if (!src || !tgt) continue;

    const sx = src.x + nodeWidth / 2;
    const tx = tgt.x - nodeWidth / 2;
    if (sx >= tx) continue;  // skip backward / same-column edges

    const key = `${edge.from}->${edge.to}`;
    if (!byTarget.has(edge.to)) byTarget.set(edge.to, []);
    byTarget.get(edge.to).push(key);
  }

  // Keep only targets with 2+ incoming forward edges
  for (const [to, keys] of byTarget) {
    if (keys.length < 2) byTarget.delete(to);
  }

  return byTarget;
}

/**
 * Compute an orthogonal polyline connecting the right side of `source` to the
 * left side of `target`, using center-based node coordinates.
 *
 * Returns an array of [x, y] pairs defining the polyline vertices:
 *
 *   Normal left-to-right, different Y (3-segment):
 *     source ───┐
 *               └──▶ target
 *
 *   Normal left-to-right, same Y (1-segment):
 *     source ──────────▶ target
 *
 *   Backwards / same-column (5-segment, routes below both nodes):
 *     source ──┐
 *              └──────┐
 *                     ↓
 *            ▶ target ┘
 *
 * @param {{ x: number, y: number }} source  Center of source node.
 * @param {{ x: number, y: number }} target  Center of target node.
 * @param {{ nodeWidth: number, nodeHeight: number, sourceYOffset?: number, targetYOffset?: number, midXOffset?: number, loopY?: number|null }} opts
 *   `loopY` — when provided, overrides the internal bottom-clearance calculation for
 *   backwards edges.  Pass a pre-computed floor (pixel or data space, matching the
 *   other coordinates) to ensure backward routes clear intermediate nodes.
 * @returns {Array<[number, number]>}
 */
export function routeEdge(source, target, { nodeWidth, nodeHeight, sourceYOffset = 0, targetYOffset = 0, midXOffset = 0, loopY = null }) {
  const sx = source.x + nodeWidth / 2;         // right anchor of source
  const sy = source.y + sourceYOffset;          // fan-out Y offset
  const tx = target.x - nodeWidth / 2;         // left anchor of target
  const ty = target.y + targetYOffset;          // fan-in Y offset

  // Straight horizontal — same anchor Y, forward direction
  if (sy === ty && sx < tx) {
    return [[sx, sy], [tx, ty]];
  }

  // Standard 3-segment orthogonal: right → vertical drop/rise → left
  if (sx < tx) {
    const midX = (sx + tx) / 2 + midXOffset;   // lane de-overlap X shift
    return [[sx, sy], [midX, sy], [midX, ty], [tx, ty]];
  }

  // Backwards or same-column: route below both nodes then back left (5-segment).
  // loopY may be pre-computed by the caller to clear intermediate nodes; otherwise
  // fall back to clearing just the two endpoint node bodies.
  const bottomY = loopY !== null
    ? loopY
    : Math.max(source.y + nodeHeight / 2, target.y + nodeHeight / 2) + BACKWARD_MARGIN;

  return [
    [sx,                   sy],
    [sx + BACKWARD_MARGIN, sy],
    [sx + BACKWARD_MARGIN, bottomY],
    [tx - BACKWARD_MARGIN, bottomY],
    [tx - BACKWARD_MARGIN, ty],
    [tx,                   ty],
  ];
}

/**
 * Compute per-edge Y offsets for source exits and target entries when multiple
 * edges share the same node anchor.  Offsets are symmetric around centre:
 *   offset = (i - (N-1)/2) * edgeSpacing
 *
 * Edges are sorted by opposite-end Y so the layout is visually ordered —
 * topmost target gets the topmost source exit, reducing crossing.
 *
 * @param {Array<{from:string, to:string}>} edges
 * @param {Map<string,{x:number,y:number}>} positions  Node centre positions.
 * @param {{ edgeSpacing?: number }} [opts]
 * @returns {{ sourceOffsets: Map<string,number>, targetOffsets: Map<string,number> }}
 *   Maps from edge key (`"from->to"`) to Y offset in layout units.
 */
export function computeFanOutOffsets(edges, positions, { edgeSpacing = EDGE_SPACING } = {}) {
  const bySource = new Map();
  const byTarget = new Map();

  for (const edge of edges) {
    const key = `${edge.from}->${edge.to}`;
    if (!bySource.has(edge.from)) bySource.set(edge.from, []);
    bySource.get(edge.from).push({ key, edge });
    if (!byTarget.has(edge.to)) byTarget.set(edge.to, []);
    byTarget.get(edge.to).push({ key, edge });
  }

  const sourceOffsets = new Map();
  const targetOffsets = new Map();

  for (const items of bySource.values()) {
    items.sort((a, b) => (positions.get(a.edge.to)?.y ?? 0) - (positions.get(b.edge.to)?.y ?? 0));
    const N = items.length;
    items.forEach(({ key }, i) => sourceOffsets.set(key, (i - (N - 1) / 2) * edgeSpacing));
  }

  for (const items of byTarget.values()) {
    items.sort((a, b) => (positions.get(a.edge.from)?.y ?? 0) - (positions.get(b.edge.from)?.y ?? 0));
    const N = items.length;
    items.forEach(({ key }, i) => targetOffsets.set(key, (i - (N - 1) / 2) * edgeSpacing));
  }

  return { sourceOffsets, targetOffsets };
}

/**
 * Detect forward edges that share the same vertical lane (same source/target
 * column pair) and assign alternating X offsets so their vertical routing
 * segments don't overlap.
 *
 * Backward and same-column edges are excluded (they route below the nodes).
 *
 * @param {Array<{from:string, to:string}>} edges
 * @param {Map<string,{x:number,y:number}>} positions
 * @param {{ nodeWidth: number, laneOffset?: number }} [opts]
 * @returns {Map<string, number>}  edge key → midX offset in layout units.
 */
export function computeLaneOffsets(edges, positions, { nodeWidth, laneOffset = LANE_OFFSET } = {}) {
  const byLane = new Map();

  for (const edge of edges) {
    const src = positions.get(edge.from);
    const tgt = positions.get(edge.to);
    if (!src || !tgt) continue;

    if (src.x + nodeWidth / 2 >= tgt.x - nodeWidth / 2) continue;  // skip backward/same-column

    // Group by column-pair: use sum of node Xs as a stable key
    const laneKey  = src.x + tgt.x;
    const edgeKey  = `${edge.from}->${edge.to}`;
    if (!byLane.has(laneKey)) byLane.set(laneKey, []);
    byLane.get(laneKey).push({ edgeKey, srcY: src.y });
  }

  const offsets = new Map();
  for (const items of byLane.values()) {
    if (items.length < 2) continue;
    items.sort((a, b) => a.srcY - b.srcY);
    const N = items.length;
    items.forEach(({ edgeKey }, i) => offsets.set(edgeKey, (i - (N - 1) / 2) * laneOffset));
  }

  return offsets;
}
