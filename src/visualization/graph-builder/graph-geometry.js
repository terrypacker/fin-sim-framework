/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { NODE_WIDTH, NODE_HEIGHT } from './graph-metrics.js';

/**
 * Axis-aligned bounding box for a node given its center point.
 *
 * @param {{ x: number, y: number }} center
 * @returns {{ left: number, right: number, top: number, bottom: number }}
 */
export function nodeBounds(center) {
  return {
    left:   center.x - NODE_WIDTH  / 2,
    right:  center.x + NODE_WIDTH  / 2,
    top:    center.y - NODE_HEIGHT / 2,
    bottom: center.y + NODE_HEIGHT / 2,
  };
}

/**
 * Mid-point anchors on each side of a node.
 * Execution graphs use right (output) and left (input) anchors.
 *
 * @param {{ x: number, y: number }} center
 * @returns {{ left: {x,y}, right: {x,y}, top: {x,y}, bottom: {x,y} }}
 */
export function nodeAnchors(center) {
  return {
    left:   { x: center.x - NODE_WIDTH  / 2, y: center.y },
    right:  { x: center.x + NODE_WIDTH  / 2, y: center.y },
    top:    { x: center.x,                   y: center.y - NODE_HEIGHT / 2 },
    bottom: { x: center.x,                   y: center.y + NODE_HEIGHT / 2 },
  };
}
