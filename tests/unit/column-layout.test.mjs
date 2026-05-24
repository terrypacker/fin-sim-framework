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

import { ColumnLayout } from '../../src/visualization/graph-builder/column-layout.js';

// Constants mirrored from column-layout.js — tests break if the module drifts
const NODE_WIDTH  = 180;
const NODE_HEIGHT = 56;
const COLUMN_GAP  = 280;
const ROW_GAP     = 80;
const PADDING_X   = 80;
const PADDING_Y   = 60;

const layout = new ColumnLayout();

function node(id, kind) {
  return { id, kind };
}

describe('ColumnLayout — empty input', () => {

  test('returns empty map for no nodes', () => {
    const result = layout.apply([], { width: 800, height: 400 });
    assert.equal(result.size, 0);
  });

});

describe('ColumnLayout — single node', () => {

  test('center X equals PADDING_X + half node width', () => {
    const pos = layout.apply([node('e1', 'event')], { width: 800, height: 400 });
    assert.equal(pos.get('e1').x, PADDING_X + NODE_WIDTH / 2);
  });

  test('center Y is vertically centered in the container', () => {
    const height = 400;
    // totalColumnHeight = 56, startY = Math.max(60, (400-56)/2) = 172
    const startY   = Math.max(PADDING_Y, (height - NODE_HEIGHT) / 2);
    const centerY  = startY + NODE_HEIGHT / 2;
    const pos = layout.apply([node('e1', 'event')], { width: 800, height });
    assert.equal(pos.get('e1').y, centerY);
  });

  test('produces a map entry for the node id', () => {
    const pos = layout.apply([node('myNode', 'event')], { width: 800, height: 400 });
    assert.ok(pos.has('myNode'));
  });

});

describe('ColumnLayout — column X placement', () => {

  test('first column centerX uses colIdx 0', () => {
    const pos = layout.apply([node('e1', 'event'), node('h1', 'handler')], { width: 1200, height: 400 });
    const expectedCol0X = PADDING_X + 0 * COLUMN_GAP + NODE_WIDTH / 2;
    assert.equal(pos.get('e1').x, expectedCol0X);
  });

  test('second column centerX uses colIdx 1', () => {
    const pos = layout.apply([node('e1', 'event'), node('h1', 'handler')], { width: 1200, height: 400 });
    const expectedCol1X = PADDING_X + 1 * COLUMN_GAP + NODE_WIDTH / 2;
    assert.equal(pos.get('h1').x, expectedCol1X);
  });

  test('column X gap between centers equals COLUMN_GAP', () => {
    const pos = layout.apply([node('e1', 'event'), node('h1', 'handler')], { width: 1200, height: 400 });
    assert.equal(pos.get('h1').x - pos.get('e1').x, COLUMN_GAP);
  });

  test('four-column layout (event, handler, action, reducer)', () => {
    const nodes = [
      node('e1', 'event'),
      node('h1', 'handler'),
      node('a1', 'action'),
      node('r1', 'reducer'),
    ];
    const pos = layout.apply(nodes, { width: 2000, height: 400 });
    const xs = ['e1', 'h1', 'a1', 'r1'].map(id => pos.get(id).x);
    for (let i = 1; i < xs.length; i++) {
      assert.equal(xs[i] - xs[i - 1], COLUMN_GAP, `gap between column ${i - 1} and ${i}`);
    }
  });

});

describe('ColumnLayout — row Y placement (multi-node column)', () => {

  test('two nodes in same column have correct Y spacing', () => {
    const nodes = [node('e1', 'event'), node('e2', 'event')];
    const height = 400;
    const totalH = 2 * NODE_HEIGHT + 1 * ROW_GAP;
    const startY = Math.max(PADDING_Y, (height - totalH) / 2);
    const y0 = startY + 0 * (NODE_HEIGHT + ROW_GAP) + NODE_HEIGHT / 2;
    const y1 = startY + 1 * (NODE_HEIGHT + ROW_GAP) + NODE_HEIGHT / 2;

    const pos = layout.apply(nodes, { width: 800, height });
    assert.equal(pos.get('e1').y, y0);
    assert.equal(pos.get('e2').y, y1);
  });

  test('Y gap between adjacent node centers equals NODE_HEIGHT + ROW_GAP', () => {
    const nodes  = [node('e1', 'event'), node('e2', 'event'), node('e3', 'event')];
    const pos    = layout.apply(nodes, { width: 800, height: 800 });
    const [y1, y2, y3] = ['e1', 'e2', 'e3'].map(id => pos.get(id).y);
    assert.equal(y2 - y1, NODE_HEIGHT + ROW_GAP);
    assert.equal(y3 - y2, NODE_HEIGHT + ROW_GAP);
  });

});

describe('ColumnLayout — vertical centering', () => {

  test('column is vertically centered in tall container', () => {
    const nodes  = [node('e1', 'event')];
    const height = 800;
    const startY = Math.max(PADDING_Y, (height - NODE_HEIGHT) / 2);
    const pos    = layout.apply(nodes, { width: 800, height });
    assert.equal(pos.get('e1').y, startY + NODE_HEIGHT / 2);
  });

  test('startY clamps to PADDING_Y when column is taller than container', () => {
    // 10 nodes: totalColumnHeight = 10*56 + 9*80 = 1280, exceeds any reasonable height
    const nodes  = Array.from({ length: 10 }, (_, i) => node(`e${i}`, 'event'));
    const height = 400;
    const totalH = 10 * NODE_HEIGHT + 9 * ROW_GAP;
    const expectedStartY = Math.max(PADDING_Y, (height - totalH) / 2); // = PADDING_Y
    assert.equal(expectedStartY, PADDING_Y, 'precondition: column overflows container');

    const pos  = layout.apply(nodes, { width: 800, height });
    const topY = pos.get('e0').y - NODE_HEIGHT / 2; // recover startY
    assert.equal(topY, PADDING_Y);
  });

  test('two-node column is vertically symmetric around container center', () => {
    const nodes  = [node('e1', 'event'), node('e2', 'event')];
    const height = 800;
    const pos    = layout.apply(nodes, { width: 800, height });
    const midY   = (pos.get('e1').y + pos.get('e2').y) / 2;
    assert.equal(midY, height / 2);
  });

});

describe('ColumnLayout — kind ordering and filtering', () => {

  test('known kinds follow event → handler → action → reducer column order', () => {
    const nodes = [
      node('r1', 'reducer'),
      node('a1', 'action'),
      node('e1', 'event'),
      node('h1', 'handler'),
    ];
    const pos = layout.apply(nodes, { width: 2000, height: 400 });
    // event must be leftmost, reducer rightmost regardless of input order
    assert.ok(pos.get('e1').x < pos.get('h1').x, 'event left of handler');
    assert.ok(pos.get('h1').x < pos.get('a1').x, 'handler left of action');
    assert.ok(pos.get('a1').x < pos.get('r1').x, 'action left of reducer');
  });

  test('empty kind columns are skipped — no gap left by absent kind', () => {
    // Only event + action (no handler) → should occupy colIdx 0 and 1, not 0 and 2
    const nodes = [node('e1', 'event'), node('a1', 'action')];
    const pos   = layout.apply(nodes, { width: 1200, height: 400 });
    assert.equal(pos.get('a1').x - pos.get('e1').x, COLUMN_GAP);
  });

  test('unknown kind gets its own column after known kinds', () => {
    const nodes = [node('e1', 'event'), node('x1', 'custom')];
    const pos   = layout.apply(nodes, { width: 1200, height: 400 });
    assert.ok(pos.has('x1'), 'unknown kind node is present in output');
    assert.ok(pos.get('x1').x > pos.get('e1').x, 'unknown kind column is right of event');
  });

  test('node with no kind is placed in "other" column', () => {
    const pos = layout.apply([{ id: 'n1' }], { width: 800, height: 400 });
    assert.ok(pos.has('n1'));
  });

});
