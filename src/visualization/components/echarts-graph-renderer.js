/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import * as echarts from 'echarts';
import { BaseComponent } from './base-component.js';
import { ColumnLayout } from '../graph-builder/column-layout.js';
import { routeEdge, computeFanOutOffsets, computeLaneOffsets } from '../graph-builder/orthogonal-edge-router.js';
import { EXECUTION_KINDS, EXECUTION_PHASES } from '../../simulation-framework/bus-messages.js';
import {NodeRendererRegistry} from "../graph-builder/rendering/node-renderer-registry.js";

const NODE_WIDTH  = 180;
const NODE_HEIGHT = 56;

const C = {
  bg:              '#111827',
  bgBreakpoint:    '#2d1515',
  border:          '#374151',
  borderSelected:  '#f59e0b',
  borderHighlight: '#f97316',
  borderBp:        '#ef4444',
  text:            '#e2e8f0',
  textMuted:       '#6b7280',
  edge:            '#374151',
  edgeHighlight:   '#f97316',
  badgeFired:      '#16a34a',
  badgeIdle:       '#0891b2',
  badgeChange:     '#d97706',
  badgeBp:         '#dc2626',
};

/**
 * EChartsGraphRenderer — two custom series sharing a single cartesian2d
 * coordinate system so that renderItem fires for both nodes and edges.
 *
 * Architecture:
 *   series[0] 'edge-series' — custom, z:1, draws orthogonal polylines + arrowheads
 *   series[1] 'node-series' — custom, z:2, draws rounded-rect nodes + text labels
 *
 * Both series use the same hidden xAxis/yAxis whose range equals the container
 * pixel dimensions, so api.coord([layoutX, layoutY]) returns [layoutX, layoutY]
 * (identity mapping). Node positions from ColumnLayout are therefore usable
 * directly as data coordinates without any further conversion.
 *
 * Exposes the same public API as GraphRenderer so all callers work unchanged.
 */
export class EChartsGraphRenderer extends BaseComponent {

  constructor({ parent, graph, graphQueryApi, graphRoot,
    graphNodes, graphEdges, nodeDetailsTemplate,
    displayNodeStateChanges, bus, layout }) {
    super({ parent });

    this._graphQueryApi     = graphQueryApi;
    this._layout            = layout ?? new ColumnLayout();
    this._graphDataProvider = null;
    this._container         = graphRoot;

    this._execOverlay       = new Map();
    this._positions         = new Map();
    this._currentNodes      = [];
    this._currentNodeMap    = new Map();
    this._prevEdges         = new Map();

    this._layerMode         = 'both';
    this._firedOnly         = false;
    this._highlightNodeSet  = new Set();
    this._highlightEdgeSet  = new Set();
    this.selectedNodeId     = null;

    //TODO Move this to a central location for UI so the plugins and domain specific classes
    // can register renderers, first up we will want Person and Account
    this._nodeRendererRegistry = new NodeRendererRegistry();
    this._nodeRendererRegistry.registerDefaults();

    this.nodeClickListeners        = [];
    this.breakpointChangeListeners = [];

    const noop = () => [];
    if (bus) {
      this._drainServiceMsgs     = this.busQueue(bus, 'SERVICE_ACTION',      () => this.render());
      this._drainServiceBulkMsgs = this.busQueue(bus, 'SERVICE_BULK_ACTION', () => this.render());
    } else {
      this._drainServiceMsgs     = noop;
      this._drainServiceBulkMsgs = noop;
    }
    this._drainExecBeginMsgs  = noop;
    this._drainExecEndMsgs    = noop;
    this._drainBreakpointMsgs = noop;

    this._chart       = null;
    this._ro          = null;
    this._viewRange   = null;   // { xMin, xMax, yMin, yMax } — current axis window
    this._panStart    = null;   // { px, py, xMin, xMax, yMin, yMax } set on mousedown
    this._dragNodeId  = null;   // id of node currently being dragged
    this._mount();
  }

  _mount() {
    this._container.innerHTML = '';
    this._chart = echarts.init(this._container, null, { renderer: 'canvas' });
    this._chart.setOption(this._buildBaseOption());

    this._container.addEventListener('contextmenu', (e) => e.preventDefault());

    this._chart.on('contextmenu', (params) => {
      if (params.seriesId !== 'node-series') return;
      const node = this._currentNodes[params.dataIndex];
      if (!node) return;
      this.breakpointChangeListeners.forEach(l => l(node));
      this.render();
    });

    this._chart.on('click', (params) => {
      if (params.seriesId !== 'node-series') return;
      const node = this._currentNodes[params.dataIndex];
      if (!node) return;
      this.selectedNodeId = node.id;
      this.nodeClickListeners.forEach(l => l(params.event?.event, node));
      this.render();
    });

    // Pan, zoom, and node-drag via ZRender — gives full control so pan,
    // zoom, and node-drag can share the same mousedown event correctly.
    const zr = this._chart.getZr();
    zr.on('mousewheel', (e) => this._onWheel(e));
    zr.on('mousedown',  (e) => this._onDown(e));
    zr.on('mousemove',  (e) => this._onMove(e));
    zr.on('mouseup',    (e) => this._onUp(e));

    this._ro = new ResizeObserver(() => this._chart?.resize());
    this._ro.observe(this._container);
  }

  /* ───────────────────────── External Action Listeners ───────────────────── */

  registerNodeClickListener(l)        { this.nodeClickListeners.push(l); }
  registerBreakpointChangeListener(l) { this.breakpointChangeListeners.push(l); }

  /* ───────────────────────── Public API ──────────────────────────────────── */

  setLayerMode(mode) {
    this._layerMode = mode;
    this.render();
  }

  getExecState(nodeId) {
    return this._execOverlay.get(nodeId) ?? null;
  }

  setHighlight(nodeIds) {
    this._highlightNodeSet = new Set(nodeIds);
    this._highlightEdgeSet = new Set();
    for (const [key, edge] of this._prevEdges) {
      if (this._highlightNodeSet.has(edge.from) && this._highlightNodeSet.has(edge.to)) {
        this._highlightEdgeSet.add(key);
      }
    }
    this.render();
  }

  clearHighlight() {
    if (!this._highlightNodeSet.size && !this._highlightEdgeSet.size) return;
    this._highlightNodeSet.clear();
    this._highlightEdgeSet.clear();
    this.render();
  }

  setFiredOnly(bool) {
    this._firedOnly = bool;
    this._relayoutAll();
    this.render();
  }

  setGraphDataProvider(fn) {
    this._graphDataProvider = fn;
  }

  /* ───────────────────────── Render ──────────────────────────────────────── */

  render() {
    this.scheduleRender(() => this._renderGraph());
  }

  resizeCanvas() {
    this._chart?.resize();
    this._relayoutAll();
    this._resetView();
    this.render();
  }

  wireSimBus(simBus) {
    this._drainExecBeginMsgs = this.busQueue(
      simBus,
      `EXECUTION_${EXECUTION_PHASES.BEGIN}`,
      () => this.render(),
      { kind: EXECUTION_KINDS.EVENT }
    );
    this._drainExecEndMsgs = this.busQueue(
      simBus,
      `EXECUTION_${EXECUTION_PHASES.END}`,
      () => this.render()
    );
    this._drainBreakpointMsgs = this.busQueue(
      simBus,
      'BREAKPOINT_HIT',
      () => this.render()
    );
  }

  fitToView() {
    this._relayoutAll();
    this._resetView();
    this.render();
  }

  /* ───────────────────────── Internal ────────────────────────────────────── */

  _refreshGraphState() {
    const { nodes, edges } = this._graphDataProvider
      ? this._graphDataProvider()
      : this._graphQueryApi.getGraphView('config');

    this._currentNodes   = nodes;
    this._currentNodeMap = new Map(nodes.map(n => [n.id, n]));
    return { nodes, edges };
  }

  _relayoutAll() {
    this._refreshGraphState();
    const rect    = this._container.getBoundingClientRect();
    const H       = rect.height || 400;
    const numCols = Math.max(new Set(this._currentNodes.map(n => n.kind).filter(Boolean)).size, 1);
    const minW    = numCols * (NODE_WIDTH + 60) + 60;
    const W       = Math.max(rect.width || 800, minW);
    const positions = this._layout.apply(this._currentNodes, { width: W, height: H });
    for (const [id, pos] of positions) {
      this._positions.set(id, pos);
    }
  }

  _renderGraph() {
    const serviceChanged =
      this._drainServiceMsgs().length > 0 ||
      this._drainServiceBulkMsgs().length > 0;
    if (serviceChanged) this._relayoutAll();

    const beginMsgs = this._drainExecBeginMsgs();
    for (const _msg of beginMsgs) {
      this._execOverlay.clear();
      this._highlightNodeSet.clear();
      this._highlightEdgeSet.clear();
    }

    const endMsgs = this._drainExecEndMsgs();
    for (const msg of endMsgs) {
      if (!msg.nodeId) continue;
      const entry = this._execOverlay.get(msg.nodeId) ?? {};
      entry.fired = true;
      if (msg.stateDiff?.length) entry.stateChanges = msg.stateDiff;
      this._execOverlay.set(msg.nodeId, entry);
    }

    if (this._firedOnly && (beginMsgs.length || endMsgs.length)) this._relayoutAll();

    for (const msg of this._drainBreakpointMsgs()) {
      if (!msg.nodeId) continue;
      const entry = this._execOverlay.get(msg.nodeId) ?? {};
      entry.breakpointHit = true;
      this._execOverlay.set(msg.nodeId, entry);
    }

    const { nodes, edges } = this._refreshGraphState();
    if (!this._positions.size && nodes.length) this._relayoutAll();

    this._prevEdges = new Map(edges.map(e => [`${e.from}->${e.to}`, e]));

    // Node data: each item is [centerX, centerY]. renderItem looks up the node
    // by params.dataIndex into this._currentNodes (same order).
    const nodeData = nodes.map(n => {
      const pos = this._positions.get(n.id) || { x: 0, y: 0 };
      return { value: [pos.x, pos.y] };
    });

    // Compute fan-out Y offsets (spread anchors when multiple edges share a node)
    // and lane X offsets (shift midX when multiple edges share the same column pair).
    const edgesArray = [...this._prevEdges.values()];
    const { sourceOffsets, targetOffsets } = computeFanOutOffsets(edgesArray, this._positions);
    const midXOffsets = computeLaneOffsets(edgesArray, this._positions, { nodeWidth: NODE_WIDTH });

    // Edge data: [srcX, srcY, tgtX, tgtY, highlighted, srcYOffset, tgtYOffset, midXOffset].
    const edgeData = [];
    for (const [key, edge] of this._prevEdges) {
      const src = this._positions.get(edge.from);
      const tgt = this._positions.get(edge.to);
      if (!src || !tgt) continue;
      edgeData.push({
        value: [
          src.x, src.y,
          tgt.x, tgt.y,
          this._highlightEdgeSet.has(key) ? 1 : 0,
          sourceOffsets.get(key) ?? 0,
          targetOffsets.get(key) ?? 0,
          midXOffsets.get(key)   ?? 0,
        ],
      });
    }

    if (!this._viewRange) this._resetView();

    // Always include axis ranges so that a series-only setOption call cannot
    // cause eCharts to re-evaluate and override the current pan/zoom state.
    const { xMin, xMax, yMin, yMax } = this._viewRange;
    this._chart?.setOption({
      xAxis: { min: xMin, max: xMax },
      yAxis: { min: yMin, max: yMax, inverse: true },
      series: [
        { id: 'edge-series', data: edgeData },
        { id: 'node-series', data: nodeData },
      ],
    });
  }

  /* ─────────────────── View (pan / zoom) ─────────────────────────────────── */

  /** Reset the axis window to the full container dimensions (1:1 pixel mapping). */
  _resetView() {
    const rect = this._container.getBoundingClientRect();
    const W    = rect.width  || 800;
    const H    = rect.height || 600;
    this._viewRange = { xMin: 0, xMax: W, yMin: 0, yMax: H };
    this._applyView();
  }

  _applyView() {
    const { xMin, xMax, yMin, yMax } = this._viewRange;
    this._chart?.setOption({
      xAxis: { min: xMin, max: xMax },
      yAxis: { min: yMin, max: yMax, inverse: true },
    });
  }

  /**
   * Convert a canvas pixel position to data-space coordinates.
   * Works correctly across any zoom/pan level because it uses the live
   * _viewRange rather than the fixed initial dimensions.
   */
  _pixelToData(px, py) {
    const { xMin, xMax, yMin, yMax } = this._viewRange;
    const rect = this._container.getBoundingClientRect();
    const W = rect.width  || 800;
    const H = rect.height || 600;
    return [
      xMin + (px / W) * (xMax - xMin),
      yMin + (py / H) * (yMax - yMin),
    ];
  }

  /** Scroll-wheel zoom — equal factor on both axes, centred on cursor. */
  _onWheel(e) {
    if (!this._viewRange) return;
    e.event?.preventDefault?.();
    const factor = e.wheelDelta > 0 ? 0.85 : 1 / 0.85;
    const { xMin, xMax, yMin, yMax } = this._viewRange;
    // ZRender fires the event *packet* which has offsetX/offsetY (= the original zrX/zrY).
    const [cx, cy] = this._pixelToData(e.offsetX, e.offsetY);
    this._viewRange = {
      xMin: cx - (cx - xMin) * factor,
      xMax: cx + (xMax - cx) * factor,
      yMin: cy - (cy - yMin) * factor,
      yMax: cy + (yMax - cy) * factor,
    };
    this._applyView();
  }

  /** Mousedown — start a node drag if cursor is over a node, else start pan. */
  _onDown(e) {
    if (!this._viewRange) return;
    const px = e.offsetX;
    const py = e.offsetY;
    const [dataX, dataY] = this._pixelToData(px, py);
    for (const [nodeId, pos] of this._positions) {
      if (Math.abs(pos.x - dataX) <= NODE_WIDTH  / 2 &&
          Math.abs(pos.y - dataY) <= NODE_HEIGHT / 2) {
        this._dragNodeId = nodeId;
        return;
      }
    }
    const { xMin, xMax, yMin, yMax } = this._viewRange;
    this._panStart = { px, py, xMin, xMax, yMin, yMax };
  }

  /** Mousemove — continue node drag or pan. */
  _onMove(e) {
    const ex = e.offsetX;
    const ey = e.offsetY;
    if (this._dragNodeId) {
      const [dataX, dataY] = this._pixelToData(ex, ey);
      this._positions.set(this._dragNodeId, { x: dataX, y: dataY });
      this.render();
    } else if (this._panStart) {
      const { px, py, xMin, xMax, yMin, yMax } = this._panStart;
      const rect = this._container.getBoundingClientRect();
      const W    = rect.width  || 800;
      const H    = rect.height || 600;
      const dx   = -(ex - px) / W * (xMax - xMin);
      const dy   = -(ey - py) / H * (yMax - yMin);
      this._viewRange = { xMin: xMin + dx, xMax: xMax + dx, yMin: yMin + dy, yMax: yMax + dy };
      this._applyView();
    }
  }

  /** Mouseup — end any drag or pan. */
  _onUp() {
    this._dragNodeId = null;
    this._panStart   = null;
  }

  /* ─────────────────── Custom series renderItem callbacks ─────────────────── */

  /**
   * Render one node as a rounded-rect group with two text lines.
   * params.dataIndex indexes into this._currentNodes.
   */
  _renderNodeItem(params, api) {
    const ctx = this._buildNodeRenderContext(params, api);

    if (!ctx) {
      return { type: 'group', children: [] };
    }

    const renderer = this._nodeRendererRegistry.get(ctx.node.kind);

    return renderer.render(ctx);
  }

  _buildNodeRenderContext(params, api) {
    const [cx, cy] = api.coord([api.value(0), api.value(1)]);
    const node = this._currentNodes[params.dataIndex];

    if (!node) return null;

    const exec       = this._execOverlay.get(node.id);
    const isSelected = node.id === this.selectedNodeId;
    const isHL       = this._highlightNodeSet.has(node.id);
    const hasBp      = !!node.data?.breakpoint;
    const hitBp      = !!exec?.breakpointHit;

    let borderColor = C.border;
    let borderWidth = 1;
    let bgColor     = hitBp ? C.bgBreakpoint : C.bg;

    if (isSelected) {
      borderColor = C.borderSelected;
      borderWidth = 2;
    }
    else if (isHL) {
      borderColor = C.borderHighlight;
      borderWidth = 2;
    }
    else if (hasBp) {
      borderColor = C.borderBp;
      borderWidth = 2;
    }

    const clip = params.coordSys ? {
      shape: {
        x: params.coordSys.x,
        y: params.coordSys.y,
        width: params.coordSys.width,
        height: params.coordSys.height,
      }
    } : null;

    return {
      node,
      exec,
      api,
      textStyle: this._chart.getOption().textStyle,

      cx, //center of node x
      cy, //center of node y

      x: cx - NODE_WIDTH / 2, //bottom left corner x
      y: cy - NODE_HEIGHT / 2, //bottom left corner y

      width: NODE_WIDTH,
      height: NODE_HEIGHT,

      borderColor,
      borderWidth,
      bgColor,

      isSelected,
      isHL,
      hasBp,
      hitBp,
      clip: clip,

      padding: 10
    };
  }

  /**
   * Render one edge as an orthogonal polyline + arrowhead polygon.
   * Value dimensions: [srcX, srcY, tgtX, tgtY, highlighted(0|1)].
   */
  _renderEdgeItem(params, api) {
    const [sx, sy] = api.coord([api.value(0), api.value(1)]);
    const [tx, ty] = api.coord([api.value(2), api.value(3)]);
    const hl       = api.value(4) === 1;
    const srcYOff  = api.value(5) ?? 0;
    const tgtYOff  = api.value(6) ?? 0;
    const midXOff  = api.value(7) ?? 0;

    const pts = routeEdge(
      { x: sx, y: sy },
      { x: tx, y: ty },
      { nodeWidth: NODE_WIDTH, nodeHeight: NODE_HEIGHT, sourceYOffset: srcYOff, targetYOffset: tgtYOff, midXOffset: midXOff }
    );

    const stroke  = hl ? C.edgeHighlight : C.edge;
    const lw      = hl ? 3 : 2;
    const opacity = hl ? 1 : 0.7;
    const [ex, ey] = pts[pts.length - 1];

    return {
      type: 'group',
      children: [
        {
          type:  'polyline',
          shape: { points: pts },
          style: { stroke, lineWidth: lw, opacity, fill: 'none', lineCap: 'round', lineJoin: 'round' },
        },
        {
          type:  'polygon',
          shape: { points: [[ex, ey], [ex - 8, ey - 5], [ex - 8, ey + 5]] },
          style: { fill: stroke, opacity },
        },
      ],
    };
  }

  _buildBaseOption() {
    const W = this._container.clientWidth  || 800;
    const H = this._container.clientHeight || 600;

    return {
      backgroundColor: 'transparent',
      animation:       false,
      // Plot area fills the full container so coordinate [0,0] → canvas pixel (0,0).
      grid: { left: 0, right: 0, top: 0, bottom: 0, containLabel: false },
      xAxis: { show: false, type: 'value' },
      // inverse: true makes canvas y=0 map to data y=0 (top of layout),
      // giving api.coord an identity mapping and making _pixelToData correct.
      yAxis: { show: false, type: 'value', inverse: true },
      series: [
        {
          id:         'edge-series',
          type:       'custom',
          z:          1,
          silent:     true,
          clip:       false,
          renderItem: (params, api) => this._renderEdgeItem(params, api),
          data:       [],
        },
        {
          id:         'node-series',
          type:       'custom',
          z:          2,
          clip:       false,
          renderItem: (params, api) => this._renderNodeItem(params, api),
          data:       [],
        },
      ],
    };
  }

  destroy() {
    this._ro?.disconnect();
    this._chart?.dispose();
    this._chart = null;
    super.destroy();
  }
}
