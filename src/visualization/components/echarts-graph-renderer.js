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
import { EXECUTION_KINDS, EXECUTION_PHASES } from '../../simulation-framework/bus-messages.js';

const NODE_WIDTH  = 180;
const NODE_HEIGHT = 44;

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
 * EChartsGraphRenderer — drop-in replacement for GraphRenderer using an
 * eCharts graph series instead of DOM nodes + SVG edges.
 *
 * Exposes the same public API as GraphRenderer so all callers (BaseGraphView,
 * GraphBuilderPresenter, SimulationAnimator) work without changes.
 *
 * Dropped from the original: port dots, node drag, selection-box.
 * eCharts provides pan/zoom via roam:true.
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

    this._chart = null;
    this._ro    = null;
    this._mount();
  }

  _mount() {
    this._container.innerHTML = '';
    this._chart = echarts.init(this._container, null, { renderer: 'canvas' });
    this._chart.setOption(this._buildBaseOption());

    // Prevent browser context menu over the canvas so right-click works.
    this._container.addEventListener('contextmenu', (e) => e.preventDefault());

    this._chart.on('contextmenu', (params) => {
      if (params.dataType !== 'node') return;
      // Look up node by id — avoids storing domain objects in eCharts data.
      const node = this._currentNodeMap.get(params.data.id);
      if (!node) return;
      this.breakpointChangeListeners.forEach(l => l(node));
      this.render();
    });

    this._chart.on('click', (params) => {
      if (params.dataType !== 'node') return;
      const node = this._currentNodeMap.get(params.data.id);
      if (!node) return;
      this.selectedNodeId = params.data.id;
      this.nodeClickListeners.forEach(l => l(params.event?.event, node));
      this.render();
    });

    this._chart.getZr().on('mouseup', () => this._syncDraggedPositions());

    this._ro = new ResizeObserver(() => this._chart?.resize());
    this._ro.observe(this._container);
  }

  _syncDraggedPositions() {
    try {
      const series = this._chart.getModel().getSeries()[0];
      const data   = series.getData();
      data.each((idx) => {
        const layout = data.getItemLayout(idx);
        const id     = data.getId(idx);
        if (layout && id) {
          this._positions.set(id, { x: layout[0] - NODE_WIDTH / 2, y: layout[1] - NODE_HEIGHT / 2 });
        }
      });
    } catch (_e) { /* internal eCharts API may differ across versions */ }
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

    this._chart?.setOption({
      series: [{
        data:  nodes.map(n => this._buildNodeData(n)),
        edges: edges.map(e => this._buildEdgeData(e)),
      }],
    });
  }

  _buildNodeData(node) {
    const pos  = this._positions.get(node.id) || { x: 0, y: 0 };
    const exec = this._execOverlay.get(node.id);

    const isSelected    = node.id === this.selectedNodeId;
    const isHighlighted = this._highlightNodeSet.has(node.id);
    const hasBreakpoint = !!node.data?.breakpoint;
    const hitBreakpoint = !!exec?.breakpointHit;

    let borderColor = C.border;
    let borderWidth = 1;
    let bgColor     = C.bg;

    if (isSelected) {
      borderColor = C.borderSelected;
      borderWidth = 2;
    } else if (isHighlighted) {
      borderColor = C.borderHighlight;
      borderWidth = 2;
    } else if (hasBreakpoint) {
      borderColor = C.borderBp;
      borderWidth = 2;
    }

    if (hitBreakpoint) bgColor = C.bgBreakpoint;

    // Only store primitives in eCharts data — domain objects cause clone$4 stack overflows.
    return {
      id:        node.id,
      name:      node.name,
      x:         pos.x + NODE_WIDTH  / 2,
      y:         pos.y + NODE_HEIGHT / 2,
      itemStyle: { color: bgColor, borderColor, borderWidth },
    };
  }

  _buildEdgeData(edge) {
    const key         = `${edge.from}->${edge.to}`;
    const highlighted = this._highlightEdgeSet.has(key);
    return {
      source:    edge.from,
      target:    edge.to,
      lineStyle: highlighted
        ? { color: C.edgeHighlight, width: 3, opacity: 1 }
        : {},
    };
  }

  _buildBaseOption() {
    const rich = {
      hdr: {
        fontSize:  9,
        color:     C.textMuted,
        padding:   [4, 6, 0, 6],
        align:     'left',
      },
      ttl: {
        fontSize:   10,
        color:      C.text,
        fontWeight: 'bold',
        padding:    [2, 6, 4, 6],
        align:      'left',
      },
      fired:  { fontSize: 9, color: '#fff', backgroundColor: C.badgeFired,   padding: [1, 4], borderRadius: 2 },
      idle:   { fontSize: 9, color: '#fff', backgroundColor: C.badgeIdle,    padding: [1, 4], borderRadius: 2 },
      change: { fontSize: 9, color: '#fff', backgroundColor: C.badgeChange,  padding: [1, 4], borderRadius: 2 },
      bp:     { fontSize: 9, color: '#fff', backgroundColor: C.badgeBp,      padding: [1, 4], borderRadius: 2 },
    };

    return {
      backgroundColor: 'transparent',
      animation:       false,
      series: [{
        type:           'graph',
        layout:         'none',
        roam:           true,
        draggable:      true,
        symbolSize:     [NODE_WIDTH, NODE_HEIGHT],
        symbol:         'rect',
        cursor:         'pointer',
        edgeSymbol:     ['none', 'arrow'],
        edgeSymbolSize: 8,
        label: {
          show:      true,
          position:  'inside',
          formatter: (params) => this._buildLabel(params.data),
          rich,
        },
        itemStyle: {
          color:        C.bg,
          borderColor:  C.border,
          borderWidth:  1,
          borderRadius: 3,
        },
        lineStyle: {
          color:     C.edge,
          width:     2,
          opacity:   0.7,
          curveness: 0.3,
        },
        emphasis: { disabled: true },
        select:   { disabled: true },
        data:     [],
        edges:    [],
      }],
    };
  }

  _buildLabel(data) {
    const node = this._currentNodeMap.get(data.id);
    if (!node) return '';

    const exec     = this._execOverlay.get(data.id);
    const showExec = this._layerMode !== 'config';

    let header = '';
    switch (node.kind) {
      case 'event':   header = node.eventType   ?? node.name; break;
      case 'handler': header = node.handlerClass ?? node.name; break;
      case 'action':  header = node.actionClass  ?? node.name; break;
      case 'reducer': header = node.reducerType  ?? node.name; break;
      default:        header = node.kind ?? '';
    }

    const name = node.name ?? '';

    let badges = '';
    if (showExec) {
      badges += exec?.fired ? ' {fired|Fired}' : ' {idle|Idle}';
      if (exec?.stateChanges?.length) badges += ' {change|Chg}';
    }
    if (node.data?.breakpoint) badges += ' {bp|⏸}';

    return `{hdr|${header}}\n{ttl|${name}}${badges}`;
  }

  destroy() {
    this._ro?.disconnect();
    this._chart?.dispose();
    this._chart = null;
    super.destroy();
  }
}
