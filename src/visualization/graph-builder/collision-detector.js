/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { NODE_WIDTH, NODE_HEIGHT, OBSTACLE_MARGIN } from './graph-metrics.js';

/**
 * Find node bodies whose horizontal extent overlaps `midX` and whose vertical
 * extent overlaps the range `[yFrom, yTo]`.  Used to detect when a forward
 * edge's vertical routing segment would clip through a node body.
 *
 * @param {number} midX   X coordinate of the candidate vertical segment.
 * @param {number} yFrom  One end of the vertical segment (order doesn't matter).
 * @param {number} yTo    Other end of the vertical segment.
 * @param {Map<string,{x:number,y:number}>} positions  Node centres (data space).
 * @param {{ nodeWidth?: number, nodeHeight?: number, margin?: number }} [opts]
 * @returns {Array<{id:string, x:number, y:number}>}
 */
export function detectMidXObstacles(midX, yFrom, yTo, positions, {
  nodeWidth  = NODE_WIDTH,
  nodeHeight = NODE_HEIGHT,
  margin     = OBSTACLE_MARGIN,
} = {}) {
  const halfW  = nodeWidth  / 2 + margin;
  const halfH  = nodeHeight / 2;
  const yMin   = Math.min(yFrom, yTo);
  const yMax   = Math.max(yFrom, yTo);

  const obstacles = [];
  for (const [id, { x, y }] of positions) {
    if (Math.abs(midX - x) >= halfW) continue;          // horizontal miss
    if (y + halfH <= yMin || y - halfH >= yMax) continue; // vertical miss
    obstacles.push({ id, x, y });
  }
  return obstacles;
}

/**
 * Return a midX for a forward orthogonal edge that avoids all node bodies.
 *
 * If `candidateMidX` is already clear, it is returned unchanged.  Otherwise
 * the blocking nodes' combined X extent is computed and the midpoint of the
 * larger of the two flanking gaps (left gap `[sx, blockLeft]` or right gap
 * `[blockRight, tx]`) is returned.  Ties prefer the right gap (more natural
 * forward routing direction).
 *
 * @param {number} candidateMidX  Proposed midX (may include a lane offset).
 * @param {number} sx  Right anchor X of the source node.
 * @param {number} tx  Left anchor X of the target node.
 * @param {number} sy  Y of the source exit anchor (after fan-out offset).
 * @param {number} ty  Y of the target entry anchor (after fan-out offset).
 * @param {Map<string,{x:number,y:number}>} positions  Node centres.
 * @param {{ nodeWidth?: number, nodeHeight?: number }} [opts]
 * @returns {number}
 */
export function chooseClearMidX(candidateMidX, sx, tx, sy, ty, positions, {
  nodeWidth  = NODE_WIDTH,
  nodeHeight = NODE_HEIGHT,
} = {}) {
  const obstacles = detectMidXObstacles(candidateMidX, sy, ty, positions, {
    nodeWidth, nodeHeight,
  });
  if (!obstacles.length) return candidateMidX;

  // Union the blocking nodes into a single X band
  const halfW = nodeWidth / 2 + OBSTACLE_MARGIN;
  let blockLeft  =  Infinity;
  let blockRight = -Infinity;
  for (const obs of obstacles) {
    blockLeft  = Math.min(blockLeft,  obs.x - halfW);
    blockRight = Math.max(blockRight, obs.x + halfW);
  }

  // Choose the larger of the two flanking gaps; ties go to the right
  const leftGapW  = blockLeft  - sx;
  const rightGapW = tx         - blockRight;

  if (rightGapW >= leftGapW && rightGapW > 0) return (blockRight + tx)    / 2;
  if (leftGapW  > 0)                           return (sx         + blockLeft) / 2;

  // Both gaps are zero-width (extremely dense layout) — leave unchanged
  return candidateMidX;
}
