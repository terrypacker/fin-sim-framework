/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BACKWARD_MARGIN } from './graph-metrics.js';

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
 * @param {{ nodeWidth: number, nodeHeight: number }} opts
 * @returns {Array<[number, number]>}
 */
export function routeEdge(source, target, { nodeWidth, nodeHeight }) {
  const sx = source.x + nodeWidth / 2;    // right anchor of source
  const sy = source.y;
  const tx = target.x - nodeWidth / 2;    // left anchor of target
  const ty = target.y;

  // Straight horizontal — same row, forward direction
  if (sy === ty && sx < tx) {
    return [[sx, sy], [tx, ty]];
  }

  // Standard 3-segment orthogonal: right → vertical drop/rise → left
  if (sx < tx) {
    const midX = (sx + tx) / 2;
    return [[sx, sy], [midX, sy], [midX, ty], [tx, ty]];
  }

  // Backwards or same-column: route below both nodes then back left (5-segment)
  const bottomY =
    Math.max(source.y + nodeHeight / 2, target.y + nodeHeight / 2) +
    BACKWARD_MARGIN;

  return [
    [sx,                   sy],
    [sx + BACKWARD_MARGIN, sy],
    [sx + BACKWARD_MARGIN, bottomY],
    [tx - BACKWARD_MARGIN, bottomY],
    [tx - BACKWARD_MARGIN, ty],
    [tx,                   ty],
  ];
}
