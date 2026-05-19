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

import { nodeBounds, nodeAnchors } from '../../src/visualization/graph-builder/graph-geometry.js';
import { NODE_WIDTH, NODE_HEIGHT } from '../../src/visualization/graph-builder/graph-metrics.js';

const CENTER = { x: 200, y: 150 };

// ── nodeBounds ────────────────────────────────────────────────────────────────

describe('nodeBounds', () => {

  test('left = center.x - NODE_WIDTH/2', () => {
    assert.equal(nodeBounds(CENTER).left, CENTER.x - NODE_WIDTH / 2);
  });

  test('right = center.x + NODE_WIDTH/2', () => {
    assert.equal(nodeBounds(CENTER).right, CENTER.x + NODE_WIDTH / 2);
  });

  test('top = center.y - NODE_HEIGHT/2', () => {
    assert.equal(nodeBounds(CENTER).top, CENTER.y - NODE_HEIGHT / 2);
  });

  test('bottom = center.y + NODE_HEIGHT/2', () => {
    assert.equal(nodeBounds(CENTER).bottom, CENTER.y + NODE_HEIGHT / 2);
  });

  test('width = right - left = NODE_WIDTH', () => {
    const b = nodeBounds(CENTER);
    assert.equal(b.right - b.left, NODE_WIDTH);
  });

  test('height = bottom - top = NODE_HEIGHT', () => {
    const b = nodeBounds(CENTER);
    assert.equal(b.bottom - b.top, NODE_HEIGHT);
  });

  test('center.x = (left + right) / 2', () => {
    const b = nodeBounds(CENTER);
    assert.equal((b.left + b.right) / 2, CENTER.x);
  });

  test('center.y = (top + bottom) / 2', () => {
    const b = nodeBounds(CENTER);
    assert.equal((b.top + b.bottom) / 2, CENTER.y);
  });

});

// ── nodeAnchors ───────────────────────────────────────────────────────────────

describe('nodeAnchors', () => {

  test('left anchor x = center.x - NODE_WIDTH/2', () => {
    assert.equal(nodeAnchors(CENTER).left.x, CENTER.x - NODE_WIDTH / 2);
  });

  test('left anchor y = center.y', () => {
    assert.equal(nodeAnchors(CENTER).left.y, CENTER.y);
  });

  test('right anchor x = center.x + NODE_WIDTH/2', () => {
    assert.equal(nodeAnchors(CENTER).right.x, CENTER.x + NODE_WIDTH / 2);
  });

  test('right anchor y = center.y', () => {
    assert.equal(nodeAnchors(CENTER).right.y, CENTER.y);
  });

  test('top anchor x = center.x', () => {
    assert.equal(nodeAnchors(CENTER).top.x, CENTER.x);
  });

  test('top anchor y = center.y - NODE_HEIGHT/2', () => {
    assert.equal(nodeAnchors(CENTER).top.y, CENTER.y - NODE_HEIGHT / 2);
  });

  test('bottom anchor x = center.x', () => {
    assert.equal(nodeAnchors(CENTER).bottom.x, CENTER.x);
  });

  test('bottom anchor y = center.y + NODE_HEIGHT/2', () => {
    assert.equal(nodeAnchors(CENTER).bottom.y, CENTER.y + NODE_HEIGHT / 2);
  });

  test('left and right anchors share center y', () => {
    const a = nodeAnchors(CENTER);
    assert.equal(a.left.y, a.right.y);
  });

  test('top and bottom anchors share center x', () => {
    const a = nodeAnchors(CENTER);
    assert.equal(a.top.x, a.bottom.x);
  });

  test('right anchor x equals nodeBounds right', () => {
    assert.equal(nodeAnchors(CENTER).right.x, nodeBounds(CENTER).right);
  });

  test('left anchor x equals nodeBounds left', () => {
    assert.equal(nodeAnchors(CENTER).left.x, nodeBounds(CENTER).left);
  });

});
