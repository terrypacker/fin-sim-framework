/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { routeEdge } from '../../src/visualization/graph-builder/orthogonal-edge-router.js';

const OPTS = { nodeWidth: 180, nodeHeight: 56 };

// Convenience: source/target centers for a standard two-column layout
// Column 0 centerX = 170, Column 1 centerX = 450 (gap 280)
const SRC  = { x: 170, y: 100 };   // event in col 0
const TGT  = { x: 450, y: 200 };   // handler in col 1
const TGT_SAME_Y = { x: 450, y: 100 };

describe('routeEdge — anchors', () => {

  test('first point is right edge of source', () => {
    const pts = routeEdge(SRC, TGT, OPTS);
    assert.equal(pts[0][0], SRC.x + OPTS.nodeWidth / 2,  'x: right edge of source');
    assert.equal(pts[0][1], SRC.y,                        'y: center of source');
  });

  test('last point is left edge of target', () => {
    const pts = routeEdge(SRC, TGT, OPTS);
    const last = pts[pts.length - 1];
    assert.equal(last[0], TGT.x - OPTS.nodeWidth / 2, 'x: left edge of target');
    assert.equal(last[1], TGT.y,                       'y: center of target');
  });

});

describe('routeEdge — standard left-to-right, different Y', () => {

  test('returns 4 points', () => {
    const pts = routeEdge(SRC, TGT, OPTS);
    assert.equal(pts.length, 4);
  });

  test('exact coordinates', () => {
    // sx = 170 + 90 = 260, tx = 450 - 90 = 360, midX = (260+360)/2 = 310
    const pts = routeEdge(SRC, TGT, OPTS);
    assert.deepEqual(pts, [
      [260, 100],
      [310, 100],
      [310, 200],
      [360, 200],
    ]);
  });

  test('segment 1-2 is horizontal at source Y', () => {
    const pts = routeEdge(SRC, TGT, OPTS);
    assert.equal(pts[0][1], pts[1][1], 'first horizontal segment stays at source Y');
  });

  test('segment 2-3 is vertical at midX', () => {
    const pts = routeEdge(SRC, TGT, OPTS);
    assert.equal(pts[1][0], pts[2][0], 'vertical segment stays at midX');
  });

  test('segment 3-4 is horizontal at target Y', () => {
    const pts = routeEdge(SRC, TGT, OPTS);
    assert.equal(pts[2][1], pts[3][1], 'second horizontal segment stays at target Y');
  });

  test('midX bisects the gap between anchors', () => {
    const pts  = routeEdge(SRC, TGT, OPTS);
    const sx   = SRC.x + OPTS.nodeWidth / 2;
    const tx   = TGT.x - OPTS.nodeWidth / 2;
    const midX = (sx + tx) / 2;
    assert.equal(pts[1][0], midX);
    assert.equal(pts[2][0], midX);
  });

});

describe('routeEdge — same Y (straight horizontal)', () => {

  test('returns 2 points when source and target share center Y', () => {
    const pts = routeEdge(SRC, TGT_SAME_Y, OPTS);
    assert.equal(pts.length, 2);
  });

  test('exact coordinates', () => {
    // sx = 260, tx = 360
    const pts = routeEdge(SRC, TGT_SAME_Y, OPTS);
    assert.deepEqual(pts, [[260, 100], [360, 100]]);
  });

  test('both points share the same Y', () => {
    const pts = routeEdge(SRC, TGT_SAME_Y, OPTS);
    assert.equal(pts[0][1], pts[1][1]);
  });

});

describe('routeEdge — backwards edge (source right of target)', () => {

  // Reverse: source in col 1, target in col 0
  const BWD_SRC = { x: 450, y: 100 };
  const BWD_TGT = { x: 170, y: 200 };

  test('returns 6 points', () => {
    const pts = routeEdge(BWD_SRC, BWD_TGT, OPTS);
    assert.equal(pts.length, 6);
  });

  test('first point is right edge of source', () => {
    const pts = routeEdge(BWD_SRC, BWD_TGT, OPTS);
    assert.equal(pts[0][0], BWD_SRC.x + OPTS.nodeWidth / 2);
    assert.equal(pts[0][1], BWD_SRC.y);
  });

  test('last point is left edge of target', () => {
    const pts  = routeEdge(BWD_SRC, BWD_TGT, OPTS);
    const last = pts[pts.length - 1];
    assert.equal(last[0], BWD_TGT.x - OPTS.nodeWidth / 2);
    assert.equal(last[1], BWD_TGT.y);
  });

  test('routing leg goes below both nodes', () => {
    const pts    = routeEdge(BWD_SRC, BWD_TGT, OPTS);
    const nodeBottomSrc = BWD_SRC.y + OPTS.nodeHeight / 2;
    const nodeBottomTgt = BWD_TGT.y + OPTS.nodeHeight / 2;
    const lowestBottom  = Math.max(nodeBottomSrc, nodeBottomTgt);
    // The horizontal bottom leg (points 2 and 3) must be below both nodes
    assert.ok(pts[2][1] > lowestBottom, 'bottom leg Y is below both node bottoms');
    assert.equal(pts[2][1], pts[3][1], 'bottom leg is horizontal');
  });

  test('all segments are axis-aligned', () => {
    const pts = routeEdge(BWD_SRC, BWD_TGT, OPTS);
    for (let i = 1; i < pts.length; i++) {
      const sameX = pts[i][0] === pts[i - 1][0];
      const sameY = pts[i][1] === pts[i - 1][1];
      assert.ok(sameX || sameY, `segment ${i - 1}→${i} is not axis-aligned`);
    }
  });

});

describe('routeEdge — same-column edge (sx >= tx)', () => {

  // Two nodes stacked in the same column — source.x === target.x
  const COL_SRC = { x: 170, y: 100 };
  const COL_TGT = { x: 170, y: 300 };

  test('returns 6 points (uses backwards routing)', () => {
    const pts = routeEdge(COL_SRC, COL_TGT, OPTS);
    assert.equal(pts.length, 6);
  });

  test('all segments are axis-aligned', () => {
    const pts = routeEdge(COL_SRC, COL_TGT, OPTS);
    for (let i = 1; i < pts.length; i++) {
      const sameX = pts[i][0] === pts[i - 1][0];
      const sameY = pts[i][1] === pts[i - 1][1];
      assert.ok(sameX || sameY, `segment ${i - 1}→${i} is not axis-aligned`);
    }
  });

});
