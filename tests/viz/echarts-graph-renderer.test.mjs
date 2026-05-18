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

// jsdom doesn't ship ResizeObserver.
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stubGraphQueryApi() {
  return { getGraphView: () => ({ nodes: [], edges: [] }) };
}

function makeRenderer() {
  const graphRoot = document.createElement('div');
  // Give it pixel dimensions so _pixelToData and _resetView work.
  Object.defineProperty(graphRoot, 'getBoundingClientRect', {
    value: () => ({ width: 800, height: 600, left: 0, top: 0 }),
  });
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

// ─── _buildNodeData — position passthrough ────────────────────────────────────

describe('_buildNodeData: position coordinates', () => {

  test('x is the centre x from _positions', () => {
    const r = makeRenderer();
    r._positions.set('n1', { x: 170, y: 100 });
    r._currentNodeMap.set('n1', { id: 'n1', name: 'Test', kind: 'event' });
    expect(r._buildNodeData({ id: 'n1', name: 'Test', kind: 'event' }).x).toBe(170);
  });

  test('y is the centre y from _positions', () => {
    const r = makeRenderer();
    r._positions.set('n1', { x: 170, y: 100 });
    r._currentNodeMap.set('n1', { id: 'n1', name: 'Test', kind: 'event' });
    expect(r._buildNodeData({ id: 'n1', name: 'Test', kind: 'event' }).y).toBe(100);
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
    const api  = makeApi([SRC.x, SRC.y]);
    return r._renderNodeItem({ dataIndex: 0 }, api);
  }

  test('returns a group', () => {
    expect(renderNode().type).toBe('group');
  });

  test('group has at least 2 children (rect + text)', () => {
    expect(renderNode().children.length).toBeGreaterThanOrEqual(2);
  });

  test('first child is a rect', () => {
    expect(renderNode().children[0].type).toBe('rect');
  });

});

describe('_renderNodeItem: rect position and size', () => {

  function nodeRect(nodeOverride = {}) {
    const r    = makeRenderer();
    const node = { id: 'n1', name: 'Test', kind: 'event', ...nodeOverride };
    r._currentNodes = [node];
    const api  = makeApi([SRC.x, SRC.y]);
    return r._renderNodeItem({ dataIndex: 0 }, api).children[0].shape;
  }

  test('rect x = cx - NODE_WIDTH/2', () => {
    expect(nodeRect().x).toBe(SRC.x - 180 / 2);
  });

  test('rect y = cy - NODE_HEIGHT/2', () => {
    expect(nodeRect().y).toBe(SRC.y - 56 / 2);
  });

  test('rect width = NODE_WIDTH', () => {
    expect(nodeRect().width).toBe(180);
  });

  test('rect height = NODE_HEIGHT', () => {
    expect(nodeRect().height).toBe(56);
  });

});

describe('_renderNodeItem: colour states', () => {

  function nodeRect(r, node, api) {
    return r._renderNodeItem({ dataIndex: 0 }, api).children[0].style;
  }

  test('default fill is the background colour', () => {
    const r    = makeRenderer();
    const node = { id: 'n1', name: 'T', kind: 'event' };
    r._currentNodes = [node];
    const style = nodeRect(r, node, makeApi([SRC.x, SRC.y]));
    expect(style.fill).toBe('#111827');
  });

  test('selected node gets a highlighted border colour', () => {
    const r    = makeRenderer();
    const node = { id: 'n1', name: 'T', kind: 'event' };
    r._currentNodes = [node];
    r.selectedNodeId = 'n1';
    const style = nodeRect(r, node, makeApi([SRC.x, SRC.y]));
    expect(style.stroke).toBe('#f59e0b');
    expect(style.lineWidth).toBe(2);
  });

  test('highlighted node gets an orange border', () => {
    const r    = makeRenderer();
    const node = { id: 'n1', name: 'T', kind: 'event' };
    r._currentNodes = [node];
    r._highlightNodeSet.add('n1');
    const style = nodeRect(r, node, makeApi([SRC.x, SRC.y]));
    expect(style.stroke).toBe('#f97316');
  });

  test('breakpoint node gets a red border', () => {
    const r    = makeRenderer();
    const node = { id: 'n1', name: 'T', kind: 'event', data: { breakpoint: true } };
    r._currentNodes = [node];
    const style = nodeRect(r, node, makeApi([SRC.x, SRC.y]));
    expect(style.stroke).toBe('#ef4444');
  });

  test('breakpoint-hit node gets a dark red background', () => {
    const r    = makeRenderer();
    const node = { id: 'n1', name: 'T', kind: 'event' };
    r._currentNodes = [node];
    r._execOverlay.set('n1', { breakpointHit: true });
    const style = nodeRect(r, node, makeApi([SRC.x, SRC.y]));
    expect(style.fill).toBe('#2d1515');
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
