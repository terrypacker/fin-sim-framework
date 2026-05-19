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

import { detectMidXObstacles, chooseClearMidX } from '../../src/visualization/graph-builder/collision-detector.js';

const OPTS = { nodeWidth: 180, nodeHeight: 56, margin: 8 };

// Standard 4-column layout (centerX values)
// col0: 170, col1: 450, col2: 730, col3: 1010  (PADDING_X=80, COLUMN_GAP=280, NODE_WIDTH/2=90)
const COL0 = { x: 170, y: 100 };
const COL1 = { x: 450, y: 200 };
const COL2 = { x: 730, y: 300 };

function posOf(...nodes) {
  const m = new Map();
  nodes.forEach((n, i) => m.set(`n${i}`, n));
  return m;
}

// ── detectMidXObstacles ────────────────────────────────────────────────────────

describe('detectMidXObstacles — empty / no match', () => {

  test('no positions → empty result', () => {
    assert.deepEqual(detectMidXObstacles(300, 0, 400, new Map(), OPTS), []);
  });

  test('node horizontally out of range (left) → not detected', () => {
    // midX=450, node at x=170: |450-170|=280 >= 90+8=98
    const result = detectMidXObstacles(450, 50, 350, posOf(COL0), OPTS);
    assert.equal(result.length, 0);
  });

  test('node horizontally out of range (right) → not detected', () => {
    // midX=450, node at x=730: |450-730|=280 >= 98
    const result = detectMidXObstacles(450, 50, 350, posOf(COL2), OPTS);
    assert.equal(result.length, 0);
  });

  test('node in horizontal range but Y segment entirely above node → not detected', () => {
    // COL1.y=200, halfH=28, node range [172,228]. Segment [0, 100] doesn't overlap.
    const result = detectMidXObstacles(450, 0, 100, posOf(COL1), OPTS);
    assert.equal(result.length, 0);
  });

  test('node in horizontal range but Y segment entirely below node → not detected', () => {
    const result = detectMidXObstacles(450, 300, 500, posOf(COL1), OPTS);
    assert.equal(result.length, 0);
  });

});

describe('detectMidXObstacles — blocking nodes', () => {

  test('single node in both ranges → detected', () => {
    // midX=450, COL1.x=450 → horizontal overlap; segment [100,350] overlaps [172,228]
    const result = detectMidXObstacles(450, 100, 350, posOf(COL1), OPTS);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'n0');
    assert.equal(result[0].x, COL1.x);
  });

  test('margin is respected — midX just within margin band is detected', () => {
    // nodeWidth/2 + margin = 98; midX = COL1.x + 97 = 547 → should be detected
    const result = detectMidXObstacles(547, 100, 350, posOf(COL1), OPTS);
    assert.equal(result.length, 1);
  });

  test('midX exactly at node body edge (no margin) → not detected when > halfW+margin', () => {
    // halfW = 90+8 = 98. midX = COL1.x + 98 = 548 → |548-450|=98, not < 98, not detected
    const result = detectMidXObstacles(548, 100, 350, posOf(COL1), OPTS);
    assert.equal(result.length, 0);
  });

  test('multiple nodes in range → all detected', () => {
    const n0 = { x: 450, y: 200 };
    const n1 = { x: 450, y: 400 };
    const positions = new Map([['a', n0], ['b', n1]]);
    const result = detectMidXObstacles(450, 100, 500, positions, OPTS);
    assert.equal(result.length, 2);
  });

  test('one blocking, one clear (different X) → only blocking detected', () => {
    const positions = new Map([['col1', COL1], ['col2', COL2]]);
    // midX=450 hits COL1 (x=450) but not COL2 (x=730)
    const result = detectMidXObstacles(450, 100, 500, positions, OPTS);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'col1');
  });

});

// ── chooseClearMidX ───────────────────────────────────────────────────────────

describe('chooseClearMidX — clear path', () => {

  test('candidate already clear → returned unchanged', () => {
    // midX=310 is between col0 right (260) and col1 left (360) — clear
    const sx = 260, tx = 360;
    const result = chooseClearMidX(310, sx, tx, 100, 200, posOf(COL0, COL1), OPTS);
    assert.equal(result, 310);
  });

  test('no positions → candidate returned unchanged', () => {
    const result = chooseClearMidX(450, 260, 640, 100, 300, new Map(), OPTS);
    assert.equal(result, 450);
  });

});

describe('chooseClearMidX — obstacle avoidance', () => {

  // col0→col2 edge: sx=260, tx=640, candidateMidX=(260+640)/2=450 → hits col1 (x=450)
  const SX = 260, TX = 640;
  const SY = 50,  TY = 400;

  test('midX blocked by intermediate column → shifts to a clear zone', () => {
    const positions = posOf(COL0, COL1, COL2);
    const result = chooseClearMidX(450, SX, TX, SY, TY, positions, OPTS);
    // Must no longer be blocked
    const obs = detectMidXObstacles(result, SY, TY, positions, OPTS);
    assert.equal(obs.length, 0, `result midX=${result} should be clear`);
  });

  test('prefers right gap when gaps are equal', () => {
    // blockLeft = 450-98=352, blockRight=450+98=548
    // leftGapW = 352-260=92, rightGapW = 640-548=92 — equal → right wins
    // rightMidX = (548+640)/2 = 594
    const positions = posOf(COL0, COL1, COL2);
    const result = chooseClearMidX(450, SX, TX, SY, TY, positions, OPTS);
    assert.equal(result, (548 + TX) / 2);
  });

  test('chooses left gap when it is larger', () => {
    // sx=100, blockLeft=352, leftGapW=252; blockRight=548, tx=560, rightGapW=12
    const result = chooseClearMidX(450, 100, 560, SY, TY, posOf(COL1), OPTS);
    assert.equal(result, (100 + 352) / 2);
  });

  test('result is always between sx and tx', () => {
    const positions = posOf(COL0, COL1, COL2);
    const result = chooseClearMidX(450, SX, TX, SY, TY, positions, OPTS);
    assert.ok(result >= SX && result <= TX,
      `result ${result} should be in [${SX}, ${TX}]`);
  });

});
