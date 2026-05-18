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

import { routeEdge, computeFanOutOffsets, computeLaneOffsets } from '../../src/visualization/graph-builder/orthogonal-edge-router.js';

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

describe('routeEdge — fan-out Y offsets', () => {

  test('sourceYOffset shifts the source anchor Y', () => {
    const pts = routeEdge(SRC, TGT, { ...OPTS, sourceYOffset: 10 });
    assert.equal(pts[0][1], SRC.y + 10);
  });

  test('targetYOffset shifts the target anchor Y', () => {
    const pts = routeEdge(SRC, TGT, { ...OPTS, targetYOffset: -5 });
    assert.equal(pts[pts.length - 1][1], TGT.y - 5);
  });

  test('midXOffset shifts the vertical lane X', () => {
    const sx = SRC.x + OPTS.nodeWidth / 2;
    const tx = TGT.x - OPTS.nodeWidth / 2;
    const baseMidX = (sx + tx) / 2;
    const pts = routeEdge(SRC, TGT, { ...OPTS, midXOffset: 6 });
    assert.equal(pts[1][0], baseMidX + 6);
    assert.equal(pts[2][0], baseMidX + 6);
  });

  test('zero offsets reproduce baseline routing', () => {
    const base = routeEdge(SRC, TGT, OPTS);
    const zero = routeEdge(SRC, TGT, { ...OPTS, sourceYOffset: 0, targetYOffset: 0, midXOffset: 0 });
    assert.deepEqual(base, zero);
  });

  test('negative sourceYOffset produces higher (smaller Y) exit', () => {
    const pts = routeEdge(SRC, TGT, { ...OPTS, sourceYOffset: -10 });
    assert.ok(pts[0][1] < SRC.y);
  });

});

// ── computeFanOutOffsets ──────────────────────────────────────────────────────

// Standard 3-column layout.  Positions map id → { x, y }.
// col0: x=80, col1: x=360, col2: x=640
function pos(id, x, y) { return [id, { x, y }]; }

const COL0_ROW0 = pos('a', 80,  60);
const COL0_ROW1 = pos('b', 80, 140);
const COL0_ROW2 = pos('c', 80, 220);
const COL1_ROW0 = pos('d', 360,  60);
const COL1_ROW1 = pos('e', 360, 140);
const COL1_ROW2 = pos('f', 360, 220);

describe('computeFanOutOffsets — single edge', () => {

  test('single edge produces zero source offset', () => {
    const positions = new Map([COL0_ROW0, COL1_ROW0]);
    const { sourceOffsets } = computeFanOutOffsets(
      [{ from: 'a', to: 'd' }], positions
    );
    assert.equal(sourceOffsets.get('a->d'), 0);
  });

  test('single edge produces zero target offset', () => {
    const positions = new Map([COL0_ROW0, COL1_ROW0]);
    const { targetOffsets } = computeFanOutOffsets(
      [{ from: 'a', to: 'd' }], positions
    );
    assert.equal(targetOffsets.get('a->d'), 0);
  });

});

describe('computeFanOutOffsets — two edges from same source', () => {

  // a → d (col1 row0), a → e (col1 row1)
  const positions = new Map([COL0_ROW0, COL1_ROW0, COL1_ROW1]);
  const edges = [{ from: 'a', to: 'd' }, { from: 'a', to: 'e' }];

  test('two edges produce symmetric ±EDGE_SPACING/2 source offsets', () => {
    const { sourceOffsets } = computeFanOutOffsets(edges, positions);
    const off0 = sourceOffsets.get('a->d');
    const off1 = sourceOffsets.get('a->e');
    assert.ok(off0 < 0, 'lower-Y target gets negative offset (exit higher)');
    assert.ok(off1 > 0, 'higher-Y target gets positive offset (exit lower)');
    assert.equal(off0, -off1, 'offsets are symmetric');
  });

  test('offsets sum to zero', () => {
    const { sourceOffsets } = computeFanOutOffsets(edges, positions);
    const total = [...sourceOffsets.values()].reduce((s, v) => s + v, 0);
    assert.equal(total, 0);
  });

});

describe('computeFanOutOffsets — three edges from same source', () => {

  // a → d, a → e, a → f  (three targets in col1, rows 0,1,2)
  const positions = new Map([COL0_ROW0, COL1_ROW0, COL1_ROW1, COL1_ROW2]);
  const edges = [
    { from: 'a', to: 'd' },
    { from: 'a', to: 'e' },
    { from: 'a', to: 'f' },
  ];

  test('three edges produce symmetric offsets: -EDGE_SPACING, 0, +EDGE_SPACING', () => {
    const { sourceOffsets } = computeFanOutOffsets(edges, positions);
    const offsets = ['a->d', 'a->e', 'a->f'].map(k => sourceOffsets.get(k));
    // Sorted by target Y (d=60, e=140, f=220):  d gets lowest, f gets highest
    assert.equal(offsets[0], -10, 'topmost target gets -10');
    assert.equal(offsets[1],   0, 'middle target gets 0');
    assert.equal(offsets[2],  10, 'bottommost target gets +10');
  });

  test('three-edge source offsets sum to zero', () => {
    const { sourceOffsets } = computeFanOutOffsets(edges, positions);
    const total = [...sourceOffsets.values()].reduce((s, v) => s + v, 0);
    assert.equal(total, 0);
  });

});

describe('computeFanOutOffsets — two edges into same target', () => {

  // a and b both → d (col1 row0)
  const positions = new Map([COL0_ROW0, COL0_ROW1, COL1_ROW0]);
  const edges = [{ from: 'a', to: 'd' }, { from: 'b', to: 'd' }];

  test('two fan-in edges produce symmetric ±EDGE_SPACING/2 target offsets', () => {
    const { targetOffsets } = computeFanOutOffsets(edges, positions);
    const off0 = targetOffsets.get('a->d');
    const off1 = targetOffsets.get('b->d');
    assert.equal(off0, -off1, 'target offsets are symmetric');
  });

  test('lower-source gets negative (higher) target entry', () => {
    const { targetOffsets } = computeFanOutOffsets(edges, positions);
    // Source a is at row0 (y=60), b at row1 (y=140); a is topmost source
    assert.ok(targetOffsets.get('a->d') < 0);
    assert.ok(targetOffsets.get('b->d') > 0);
  });

});

describe('computeFanOutOffsets — independent sources use custom spacing', () => {

  test('edgeSpacing option is respected', () => {
    const positions = new Map([COL0_ROW0, COL1_ROW0, COL1_ROW1]);
    const edges = [{ from: 'a', to: 'd' }, { from: 'a', to: 'e' }];
    const { sourceOffsets } = computeFanOutOffsets(edges, positions, { edgeSpacing: 20 });
    assert.equal(sourceOffsets.get('a->d'), -10);
    assert.equal(sourceOffsets.get('a->e'),  10);
  });

});

// ── computeLaneOffsets ────────────────────────────────────────────────────────

const LANE_OPTS = { nodeWidth: 180 };

describe('computeLaneOffsets — single edge in column pair', () => {

  test('single edge gets no offset (returns empty map)', () => {
    const positions = new Map([COL0_ROW0, COL1_ROW0]);
    const offsets = computeLaneOffsets([{ from: 'a', to: 'd' }], positions, LANE_OPTS);
    assert.equal(offsets.size, 0);
  });

});

describe('computeLaneOffsets — two edges in same column pair', () => {

  // a→d and b→d both go col0→col1
  const positions = new Map([COL0_ROW0, COL0_ROW1, COL1_ROW0]);
  const edges = [{ from: 'a', to: 'd' }, { from: 'b', to: 'd' }];

  test('two edges in same column pair get opposite offsets', () => {
    const offsets = computeLaneOffsets(edges, positions, LANE_OPTS);
    const off0 = offsets.get('a->d');
    const off1 = offsets.get('b->d');
    assert.notEqual(off0, undefined);
    assert.notEqual(off1, undefined);
    assert.equal(off0, -off1, 'lane offsets are symmetric');
  });

  test('lane offsets sum to zero', () => {
    const offsets = computeLaneOffsets(edges, positions, LANE_OPTS);
    const total = [...offsets.values()].reduce((s, v) => s + v, 0);
    assert.equal(total, 0);
  });

});

describe('computeLaneOffsets — three edges in same column pair', () => {

  // a→d, b→d, c→d all col0→col1, sorted by source Y: a(60), b(140), c(220)
  const positions = new Map([COL0_ROW0, COL0_ROW1, COL0_ROW2, COL1_ROW0]);
  const edges = [
    { from: 'a', to: 'd' },
    { from: 'b', to: 'd' },
    { from: 'c', to: 'd' },
  ];

  test('three edges produce -LANE_OFFSET, 0, +LANE_OFFSET', () => {
    const offsets = computeLaneOffsets(edges, positions, LANE_OPTS);
    assert.equal(offsets.get('a->d'), -12);
    assert.equal(offsets.get('b->d'),   0);
    assert.equal(offsets.get('c->d'),  12);
  });

});

describe('computeLaneOffsets — different column pairs are independent', () => {

  // a→d: col0→col1,  d→e: col1→col2 — different column pairs
  const positions = new Map([COL0_ROW0, COL1_ROW0, ...[ pos('g', 640, 60) ]]);
  const edges = [{ from: 'a', to: 'd' }, { from: 'd', to: 'g' }];

  test('edges in different column pairs do not get offsets', () => {
    const offsets = computeLaneOffsets(edges, positions, LANE_OPTS);
    assert.equal(offsets.size, 0, 'no overlapping lanes');
  });

});

describe('computeLaneOffsets — backward edges are excluded', () => {

  // d→a: col1→col0 — backward, should be skipped
  const positions = new Map([COL0_ROW0, COL1_ROW0, COL1_ROW1]);
  const edges = [{ from: 'd', to: 'a' }, { from: 'e', to: 'a' }];

  test('backward edges are not included in lane offset groups', () => {
    const offsets = computeLaneOffsets(edges, positions, LANE_OPTS);
    assert.equal(offsets.size, 0, 'backward edges excluded');
  });

});

describe('computeLaneOffsets — laneOffset option', () => {

  test('custom laneOffset is applied', () => {
    const positions = new Map([COL0_ROW0, COL0_ROW1, COL1_ROW0]);
    const edges = [{ from: 'a', to: 'd' }, { from: 'b', to: 'd' }];
    const offsets = computeLaneOffsets(edges, positions, { nodeWidth: 180, laneOffset: 20 });
    assert.equal(offsets.get('a->d'), -10);
    assert.equal(offsets.get('b->d'),  10);
  });

});
