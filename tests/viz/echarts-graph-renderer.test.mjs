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
 * Tests for EChartsGraphRenderer — pure logic methods that don't require a
 * live canvas or real eCharts rendering.
 *
 * Run with: npm run test:viz
 */

import { EChartsGraphRenderer } from '../../src/visualization/components/echarts-graph-renderer.js';
import {mockGraphRoot} from "../helpers/viz-utils.js";

// jsdom doesn't ship ResizeObserver.
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stubGraphQueryApi() {
  return { getGraphView: () => ({ nodes: [], edges: [] }) };
}

function makeRenderer() {
  const graphRoot = mockGraphRoot();
  document.body.appendChild(graphRoot);
  return new EChartsGraphRenderer({
    graphRoot,
    graphQueryApi: stubGraphQueryApi(),
  });
}

// Identity api stub: api.coord([x,y]) → [x,y], api.value(i) → values[i].
function makeApi(values) {
  return {
    value: (i) => values[i],
    coord: (pt) => [...pt],
    style: (s) => s,
  };
}

// Two nodes in adjacent columns — typical layout positions (centre coords).
const SRC = { x: 170, y: 100 };  // col 0 centre
const TGT = { x: 450, y: 200 };  // col 1 centre

function twoNodePositions() {
  return new Map([['src', SRC], ['tgt', TGT]]);
}

function oneEdge() {
  return new Map([['src->tgt', { from: 'src', to: 'tgt' }]]);
}

afterEach(() => { document.body.innerHTML = ''; });

// ─── Construction ─────────────────────────────────────────────────────────────

test('EChartsGraphRenderer: constructs without error', () => {
  expect(() => makeRenderer()).not.toThrow();
});

// ─── _buildNodeRenderContext — position passthrough ───────────────────────────

describe('_buildNodeRenderContext: centre coordinates', () => {

  test('cx is the centre x (from api.coord)', () => {
    const r    = makeRenderer();
    const node = { id: 'n1', name: 'Test', kind: 'event' };
    r._currentNodes = [node];
    const ctx = r._buildNodeRenderContext({ dataIndex: 0 }, makeApi([170, 100]));
    expect(ctx.cx).toBe(170);
  });

  test('cy is the centre y (from api.coord)', () => {
    const r    = makeRenderer();
    const node = { id: 'n1', name: 'Test', kind: 'event' };
    r._currentNodes = [node];
    const ctx = r._buildNodeRenderContext({ dataIndex: 0 }, makeApi([170, 100]));
    expect(ctx.cy).toBe(100);
  });

  test('x = cx - NODE_WIDTH/2', () => {
    const r    = makeRenderer();
    r._currentNodes = [{ id: 'n1', name: 'T', kind: 'event' }];
    const ctx = r._buildNodeRenderContext({ dataIndex: 0 }, makeApi([170, 100]));
    expect(ctx.x).toBe(170 - 180 / 2);
  });

  test('y = cy - NODE_HEIGHT/2', () => {
    const r    = makeRenderer();
    r._currentNodes = [{ id: 'n1', name: 'T', kind: 'event' }];
    const ctx = r._buildNodeRenderContext({ dataIndex: 0 }, makeApi([170, 100]));
    expect(ctx.y).toBe(100 - 56 / 2);
  });

  test('returns null for unknown dataIndex', () => {
    const r = makeRenderer();
    r._currentNodes = [];
    expect(r._buildNodeRenderContext({ dataIndex: 0 }, makeApi([0, 0]))).toBeNull();
  });

});

// ─── _renderEdgeItem ─────────────────────────────────────────────────────────

describe('_renderEdgeItem: return shape', () => {

  function renderEdge(hl = 0) {
    const r   = makeRenderer();
    const api = makeApi([SRC.x, SRC.y, TGT.x, TGT.y, hl]);
    return r._renderEdgeItem({}, api);
  }

  test('returns a group', () => {
    expect(renderEdge().type).toBe('group');
  });

  test('group has 2 children — polyline + arrowhead polygon', () => {
    expect(renderEdge().children).toHaveLength(2);
  });

  test('first child is a polyline', () => {
    expect(renderEdge().children[0].type).toBe('polyline');
  });

  test('second child is a polygon (arrowhead)', () => {
    expect(renderEdge().children[1].type).toBe('polygon');
  });

});

describe('_renderEdgeItem: anchor accuracy', () => {

  function edgePts() {
    const r   = makeRenderer();
    const api = makeApi([SRC.x, SRC.y, TGT.x, TGT.y, 0]);
    return r._renderEdgeItem({}, api).children[0].shape.points;
  }

  test('first point exits from right edge of source node', () => {
    const pts = edgePts();
    expect(pts[0][0]).toBe(SRC.x + 180 / 2);  // NODE_WIDTH = 180
    expect(pts[0][1]).toBe(SRC.y);
  });

  test('last point enters left edge of target node', () => {
    const pts = edgePts();
    expect(pts.at(-1)[0]).toBe(TGT.x - 180 / 2);
    expect(pts.at(-1)[1]).toBe(TGT.y);
  });

  test('polyline has at least 2 points', () => {
    expect(edgePts().length).toBeGreaterThanOrEqual(2);
  });

  test('all segments are axis-aligned', () => {
    const pts = edgePts();
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i][0] === pts[i - 1][0] || pts[i][1] === pts[i - 1][1]).toBe(true);
    }
  });

});

describe('_renderEdgeItem: normal style', () => {

  function normalChildren() {
    const r   = makeRenderer();
    const api = makeApi([SRC.x, SRC.y, TGT.x, TGT.y, 0]);
    return r._renderEdgeItem({}, api).children;
  }

  test('polyline stroke is the normal edge colour', () => {
    expect(normalChildren()[0].style.stroke).toBe('#374151');
  });

  test('polyline lineWidth is 2', () => {
    expect(normalChildren()[0].style.lineWidth).toBe(2);
  });

  test('polyline opacity is 0.7', () => {
    expect(normalChildren()[0].style.opacity).toBe(0.7);
  });

  test('polyline fill is none', () => {
    expect(normalChildren()[0].style.fill).toBe('none');
  });

  test('arrowhead fill matches polyline stroke', () => {
    const ch = normalChildren();
    expect(ch[1].style.fill).toBe(ch[0].style.stroke);
  });

});

describe('_renderEdgeItem: highlighted style', () => {

  function hlChildren() {
    const r   = makeRenderer();
    const api = makeApi([SRC.x, SRC.y, TGT.x, TGT.y, 1]);
    return r._renderEdgeItem({}, api).children;
  }

  test('polyline stroke is the highlight colour', () => {
    expect(hlChildren()[0].style.stroke).toBe('#f97316');
  });

  test('polyline lineWidth is 3', () => {
    expect(hlChildren()[0].style.lineWidth).toBe(3);
  });

  test('polyline opacity is 1', () => {
    expect(hlChildren()[0].style.opacity).toBe(1);
  });

  test('arrowhead fill is the highlight colour', () => {
    expect(hlChildren()[1].style.fill).toBe('#f97316');
  });

});

describe('_renderEdgeItem: arrowhead placement', () => {

  test('arrowhead tip is at the last polyline point', () => {
    const r   = makeRenderer();
    const api = makeApi([SRC.x, SRC.y, TGT.x, TGT.y, 0]);
    const { children } = r._renderEdgeItem({}, api);
    const last = children[0].shape.points.at(-1);
    const tip  = children[1].shape.points[0];
    expect(tip[0]).toBe(last[0]);
    expect(tip[1]).toBe(last[1]);
  });

  test('arrowhead polygon has 3 vertices', () => {
    const r   = makeRenderer();
    const api = makeApi([SRC.x, SRC.y, TGT.x, TGT.y, 0]);
    expect(r._renderEdgeItem({}, api).children[1].shape.points).toHaveLength(3);
  });

});

// ─── _renderNodeItem ─────────────────────────────────────────────────────────

describe('_renderNodeItem: structure', () => {

  function renderNode(nodeOverride = {}) {
    const r    = makeRenderer();
    const node = { id: 'n1', name: 'Pay Salary', kind: 'action', actionClass: 'PaySalaryAction', ...nodeOverride };
    r._currentNodes = [node];
    r._currentNodeMap.set('n1', node);
    return r._renderNodeItem({ dataIndex: 0 }, makeApi([SRC.x, SRC.y]));
  }

  test('returns a group', () => {
    expect(renderNode().type).toBe('group');
  });

  test('group has at least 2 children', () => {
    expect(renderNode().children.length).toBeGreaterThanOrEqual(2);
  });

  test('unknown dataIndex returns empty group', () => {
    const r = makeRenderer();
    r._currentNodes = [];
    expect(r._renderNodeItem({ dataIndex: 0 }, makeApi([0, 0])).children).toHaveLength(0);
  });

});

// ─── _buildNodeRenderContext — colour states ──────────────────────────────────
// Colour decisions live in the context object; node renderers consume them.

describe('_buildNodeRenderContext: colour states', () => {

  function ctx(r, node) {
    r._currentNodes = [node];
    return r._buildNodeRenderContext({ dataIndex: 0 }, makeApi([SRC.x, SRC.y]));
  }

  test('default bgColor is #111827', () => {
    const r    = makeRenderer();
    const node = { id: 'n1', name: 'T', kind: 'event' };
    expect(ctx(r, node).bgColor).toBe('#111827');
  });

  test('selected node sets borderColor to #f59e0b and borderWidth 2', () => {
    const r    = makeRenderer();
    const node = { id: 'n1', name: 'T', kind: 'event' };
    r.selectedNodeId = 'n1';
    const c = ctx(r, node);
    expect(c.borderColor).toBe('#f59e0b');
    expect(c.borderWidth).toBe(2);
  });

  test('highlighted node sets borderColor to #f97316', () => {
    const r    = makeRenderer();
    const node = { id: 'n1', name: 'T', kind: 'event' };
    r._highlightNodeSet.add('n1');
    expect(ctx(r, node).borderColor).toBe('#f97316');
  });

  test('breakpoint node sets borderColor to #ef4444', () => {
    const r    = makeRenderer();
    const node = { id: 'n1', name: 'T', kind: 'event', data: { breakpoint: true } };
    expect(ctx(r, node).borderColor).toBe('#ef4444');
  });

  test('breakpoint-hit node sets bgColor to #2d1515', () => {
    const r    = makeRenderer();
    const node = { id: 'n1', name: 'T', kind: 'event' };
    r._execOverlay.set('n1', { breakpointHit: true });
    expect(ctx(r, node).bgColor).toBe('#2d1515');
  });

  test('context includes node dimensions from NODE_WIDTH/HEIGHT', () => {
    const r    = makeRenderer();
    const node = { id: 'n1', name: 'T', kind: 'event' };
    const c    = ctx(r, node);
    expect(c.width).toBe(180);
    expect(c.height).toBe(56);
  });

});

// ─── _pixelToData ─────────────────────────────────────────────────────────────

describe('_pixelToData: identity mapping at initial view', () => {

  test('top-left pixel (0,0) maps to data (0,0)', () => {
    const r = makeRenderer();
    r._viewRange = { xMin: 0, xMax: 800, yMin: 0, yMax: 600 };
    expect(r._pixelToData(0, 0)).toEqual([0, 0]);
  });

  test('bottom-right pixel (800,600) maps to data (800,600)', () => {
    const r = makeRenderer();
    r._viewRange = { xMin: 0, xMax: 800, yMin: 0, yMax: 600 };
    const [dx, dy] = r._pixelToData(800, 600);
    expect(dx).toBeCloseTo(800);
    expect(dy).toBeCloseTo(600);
  });

  test('centre pixel (400,300) maps to data (400,300)', () => {
    const r = makeRenderer();
    r._viewRange = { xMin: 0, xMax: 800, yMin: 0, yMax: 600 };
    const [dx, dy] = r._pixelToData(400, 300);
    expect(dx).toBeCloseTo(400);
    expect(dy).toBeCloseTo(300);
  });

  test('zoomed-in view maps pixel 400,300 to the zoomed data centre', () => {
    const r = makeRenderer();
    // Zoomed in 2× centred on (400,300) in data space
    r._viewRange = { xMin: 200, xMax: 600, yMin: 150, yMax: 450 };
    const [dx, dy] = r._pixelToData(400, 300);
    expect(dx).toBeCloseTo(400);
    expect(dy).toBeCloseTo(300);
  });

});

// ─── _fitToView ───────────────────────────────────────────────────────────────

describe('_fitToView: viewport encloses all nodes', () => {

  // Container is 800×600 (set in makeRenderer via getBoundingClientRect stub).
  // NODE_WIDTH=180, NODE_HEIGHT=56, FIT_PAD=40 (private constant, but observable via viewRange).

  test('no positions → falls back to 0..W × 0..H', () => {
    const r = makeRenderer();
    r._positions = new Map();
    r._fitToView();
    expect(r._viewRange.xMin).toBe(0);
    expect(r._viewRange.xMax).toBe(800);
    expect(r._viewRange.yMin).toBe(0);
    expect(r._viewRange.yMax).toBe(600);
  });

  test('single node → graph centre is viewport centre', () => {
    const r = makeRenderer();
    r._positions = new Map([['n0', { x: 400, y: 300 }]]);
    r._fitToView();
    const { xMin, xMax, yMin, yMax } = r._viewRange;
    const midX = (xMin + xMax) / 2;
    const midY = (yMin + yMax) / 2;
    expect(midX).toBeCloseTo(400);
    expect(midY).toBeCloseTo(300);
  });

  test('viewRange is wider than graph (with padding)', () => {
    const r = makeRenderer();
    // Two nodes: col0 (x=170) and col1 (x=450)
    r._positions = new Map([['a', { x: 170, y: 100 }], ['b', { x: 450, y: 200 }]]);
    r._fitToView();
    // Graph X extents: 170-90=80 to 450+90=540, with 40 pad → 40..580
    // Graph Y extents: 100-28=72 to 200+28=228, with 40 pad → 32..268
    expect(r._viewRange.xMin).toBeLessThanOrEqual(80);
    expect(r._viewRange.xMax).toBeGreaterThanOrEqual(540);
    expect(r._viewRange.yMin).toBeLessThanOrEqual(72);
    expect(r._viewRange.yMax).toBeGreaterThanOrEqual(228);
  });

  test('each axis fitted independently — X tight around nodes, Y independent', () => {
    // Nodes render at a fixed pixel size regardless of zoom, so there is no
    // visual distortion from having different data-per-pixel ratios per axis.
    // X and Y should each be fitted tightly to their own content.
    const r = makeRenderer();
    r._positions = new Map([['a', { x: 170, y: 100 }], ['b', { x: 450, y: 200 }]]);
    r._fitToView();
    const { xMin, xMax, yMin, yMax } = r._viewRange;
    // X: node extents 80..540, FIT_PAD=40 → 40..580 (range = 540)
    expect(xMin).toBeCloseTo(40);
    expect(xMax).toBeCloseTo(580);
    // Y: node extents 72..228, FIT_PAD=40 → 32..268 (range = 236)
    expect(yMin).toBeCloseTo(32);
    expect(yMax).toBeCloseTo(268);
  });

  test('4-column graph (rightmost at x=1010) is fully visible', () => {
    const r = makeRenderer();
    // 4-column layout centrex: 170, 450, 730, 1010
    r._positions = new Map([
      ['e', { x: 170,  y: 100 }],
      ['h', { x: 450,  y: 100 }],
      ['a', { x: 730,  y: 100 }],
      ['re', { x: 1010, y: 100 }],
    ]);
    r._fitToView();
    expect(r._viewRange.xMin).toBeLessThanOrEqual(170 - 90);   // left of first node
    expect(r._viewRange.xMax).toBeGreaterThanOrEqual(1010 + 90); // right of last node
  });

  test('backward edge loopY extends yMax beyond node bounds', () => {
    // A backward edge routes below all nodes in its X corridor.  _fitToView
    // must include that path so it is not clipped out of the viewport.
    const r = makeRenderer();
    // Two same-column nodes — the edge from b→a is backward (src.x >= tgt.x).
    r._positions  = new Map([
      ['a', { x: 170, y: 100 }],
      ['b', { x: 170, y: 236 }],   // 136 below = NODE_HEIGHT(56) + ROW_GAP(80)
    ]);
    r._prevEdges  = new Map([['b->a', { from: 'b', to: 'a' }]]);
    r._fitToView();
    // Node bottom: max(100+28, 236+28) = 264.  loopY ≥ 264+30 = 294.
    // yMax must be at least loopY + FIT_PAD(40) = 334.
    expect(r._viewRange.yMax).toBeGreaterThanOrEqual(294);
    // But node-only yMax would be 264+40 = 304, so the backward edge ADDS room.
    expect(r._viewRange.yMax).toBeGreaterThan(304);
  });

});

// ─── _onDown pixel-space hit detection ───────────────────────────────────────

describe('_onDown: pixel-space node hit detection', () => {

  test('click at node visual centre grabs node at any zoom level', () => {
    const r = makeRenderer();
    // Place a node at data (400, 300), which at the 1:1 default view maps to
    // pixel (400, 300) — centre of the 800×600 container.
    r._positions    = new Map([['n', { x: 400, y: 300 }]]);
    r._currentNodes = [{ id: 'n' }];
    r._viewRange    = { xMin: 0, xMax: 800, yMin: 0, yMax: 600 };
    r._onDown({ offsetX: 400, offsetY: 300 });
    expect(r._dragNodeId).toBe('n');
    expect(r._panStart).toBeNull();
  });

  test('click at visual node edge still grabs (pixel tolerance, not data tolerance)', () => {
    const r = makeRenderer();
    // Zoom out 4×: viewRange covers 0..3200 × 0..2400 but container is 800×600.
    // Node at data (400, 300) maps to pixel (400*800/3200, 300*600/2400) = (100, 75).
    // Visual half-width = NODE_WIDTH/2 = 90 CSS px; right visual edge at pixel 190.
    // Data-space hit at px=190 would be data x = 190/800*3200 = 760 → 360 away from 400.
    // The old data-space check (±90 data units) would MISS. The pixel check HITS.
    r._positions    = new Map([['n', { x: 400, y: 300 }]]);
    r._currentNodes = [{ id: 'n' }];
    r._viewRange    = { xMin: 0, xMax: 3200, yMin: 0, yMax: 2400 };
    // Click at the right visual edge of the node.
    r._onDown({ offsetX: 100 + 89, offsetY: 75 });
    expect(r._dragNodeId).toBe('n');
  });

  test('click in empty space starts pan', () => {
    const r = makeRenderer();
    r._positions    = new Map([['n', { x: 400, y: 300 }]]);
    r._currentNodes = [{ id: 'n' }];
    r._viewRange    = { xMin: 0, xMax: 800, yMin: 0, yMax: 600 };
    r._onDown({ offsetX: 10, offsetY: 10 });
    expect(r._dragNodeId).toBeNull();
    expect(r._panStart).not.toBeNull();
  });

});
