/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseComponent } from "./base-component.js";
import { EXECUTION_KINDS, EXECUTION_PHASES } from '../../simulation-framework/bus-messages.js';
import { ColumnLayout } from '../graph-builder/column-layout.js';

//defined by .g-node css
const NODE_WIDTH = 180;
const NODE_HEIGHT = 40;
const PADDING = 20;

const createEdgeId = (edge) => {
  return `${edge.from}->${edge.to}`;
};

export class GraphRenderer extends BaseComponent {

  constructor({ parent, graph, graphQueryApi, graphRoot, graphNodes,
    graphEdges, nodeDetailsTemplate, displayNodeStateChanges, bus, layout}) {
    super({ parent });
    this._graph = graph;
    this._graphQueryApi = graphQueryApi;
    this._layout = layout ?? new ColumnLayout();
    this._graphDataProvider = null;
    this.graphRoot = graphRoot;
    this.graphNodesEl = graphNodes;
    this.graphEdgesEl = graphEdges;
    this.nodeTemplate = nodeDetailsTemplate;
    this.displayNodeStateChanges = displayNodeStateChanges ? displayNodeStateChanges : (c) => {};

    // Per-node execution-time display state (fired, stateChanges, breakpointHit).
    // Populated from simBus EXECUTION_* messages; cleared on each new event cycle.
    this._execOverlay = new Map();

    const noop = () => [];
    if (bus) {
      this._drainServiceMsgs     = this.busQueue(bus, 'SERVICE_ACTION',      () => this.render());
      this._drainServiceBulkMsgs = this.busQueue(bus, 'SERVICE_BULK_ACTION', () => this.render());
    } else {
      this._drainServiceMsgs     = noop;
      this._drainServiceBulkMsgs = noop;
    }
    // Execution drains are wired later via wireSimBus()
    this._drainExecBeginMsgs  = noop;
    this._drainExecEndMsgs    = noop;
    this._drainBreakpointMsgs = noop;

    //Current view tracking
    this._currentNodes = [];
    this._currentNodeMap = new Map();
    this._positions = new Map();

    //Diff rendering
    this._prevNodes = new Map(); // id -> node
    this._prevEdges = new Map(); // key -> edge
    this._nodeEls = new Map(); // id -> element
    this._edgeEls = new Map(); // id -> element
    this._nodeRenderState = new Map(); // id -> { fired, ... }

    //DOM Batching — scheduling delegated to BaseComponent.scheduleRender

    //Pan/Zoom
    this.viewport = this.graphRoot.querySelector('#graphViewport');
    this.view = {
      x: 0,
      y: 0,
      scale: 1
    };

    //Selection for re-layout and zoom
    this.selection = {
      active: false,
      start: null,
      end: null,
      boxEl: null
    };
    this.selection.boxEl = this.graphRoot.querySelector('.selection-box');

    this.nodeClickListeners = [];
    this.breakpointChangeListeners = [];
    this.selectedNodeId = null;
    this.dragState = null;

    // 'config' | 'execution' | 'both'
    // Controls whether execution badges (Fired/Changed) are rendered.
    this._layerMode = 'both';

    // When true, only fired nodes (per _execOverlay) are shown.
    this._firedOnly = false;

    // Node/edge IDs to render with an orange highlight ring (lineage trace).
    this._highlightNodeSet = new Set();
    this._highlightEdgeSet = new Set();
    this._bindEvents();
    // mount immediately
    this._mount();
  }

  _mount() {
    this.graphNodesEl.innerHTML = '';
    this.graphEdgesEl.innerHTML = '';
    this._bindEvents();
  }

  _bindEvents() {

    //TODO Refactor these to use parent methods to register
    //Setup Node Select and Move
    this._setupNodeSelectAndMove();
    //Setup Pan
    this._setupPan();
    //Setup Zoom
    this._setupZoom();
    //Setup Select box
    this._setupSelection();
  }

  /* ───────────────────────── External Action Listeners ───────────────────────────── */

  /**
   * Register a listener to accept (event, node)
   * when a node is clicked.
   * @param listener
   */
  registerNodeClickListener(listener) {
    this.nodeClickListeners.push(listener);
  }

  /**
   * Register a listener called with (node) whenever a node's breakpoint
   * flag is toggled via right-click.
   * @param {function} listener
   */
  registerBreakpointChangeListener(listener) {
    this.breakpointChangeListeners.push(listener);
  }

  /**
   * Set the active layer display mode.
   * 'config'    — execution badges (Fired/Changed) hidden
   * 'execution' — show execution overlay only
   * 'both'      — show everything (default)
   * @param {'config'|'execution'|'both'} mode
   */
  setLayerMode(mode) {
    this._layerMode = mode;
    this.render();
  }

  /**
   * Return the current execution overlay entry for a node, or null if none.
   * Used by GraphNodeExecHistory to display per-node execution state.
   * @param {string} nodeId
   * @returns {{ fired?: boolean, stateChanges?: object[], breakpointHit?: boolean } | null}
   */
  getExecState(nodeId) {
    return this._execOverlay.get(nodeId) ?? null;
  }

  /**
   * Highlight a set of config-layer node IDs and the edges between them
   * in orange (lineage trace).  Cleared automatically on the next event
   * cycle (EXECUTION_BEGIN).
   * @param {string[]} nodeIds
   */
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

  /**
   * When true, only nodes that have fired this event cycle are included in
   * the graph view.  Triggers a relayout + render immediately.
   * @param {boolean} bool
   */
  setFiredOnly(bool) {
    this._firedOnly = bool;
    this._relayoutAll();
    this.render();
  }

  /* ───────────────────────── PUBLIC API ───────────────────────────── */

  /**
   * Override the default data source (getGraphView('config')) with a custom
   * provider. Called by BaseGraphView to inject filtered node/edge sets.
   * @param {function(): { nodes: object[], edges: object[] }} fn
   */
  setGraphDataProvider(fn) {
    this._graphDataProvider = fn;
  }

  /* ───────────────────────── CORE RENDERING ───────────────────────────── */

  render() {
    this.scheduleRender(() => this._renderGraph());
  }

  resizeCanvas(h,w) {
    this.graphRoot.height = h;
    this.graphRoot.width = w;
    this._relayoutAll();
    this.render();
  }

  /**
   * Subscribe to the simulation bus for execution-layer display state.
   * Call once per scenario after the sim bus is available.
   * EXECUTION_BEGIN(EVENT) clears the overlay; EXECUTION_END populates fired/stateChanges;
   * BREAKPOINT_HIT marks the node for visual flash.
   */
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

  _refreshGraphState() {
    const { nodes, edges } = this._graphDataProvider
      ? this._graphDataProvider()
      : this._graphQueryApi.getGraphView('config');

    this._currentNodes = nodes;
    this._currentNodeMap = new Map(nodes.map(n => [n.id, n]));

    return { nodes, edges };
  }

  _renderGraph() {
    // Drain queued config-bus messages; relayout if the graph structure changed.
    const serviceChanged =
      this._drainServiceMsgs().length > 0 ||
      this._drainServiceBulkMsgs().length > 0;
    if (serviceChanged) this._relayoutAll();

    // Drain execution messages; update the per-node display overlay.
    const beginMsgs = this._drainExecBeginMsgs();
    for (const _msg of beginMsgs) {
      // New event cycle — reset execution display state and lineage highlight.
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
    // Relayout when fired-only mode is active and the visible set may have changed.
    if (this._firedOnly && (beginMsgs.length || endMsgs.length)) this._relayoutAll();

    for (const msg of this._drainBreakpointMsgs()) {
      if (!msg.nodeId) continue;
      const entry = this._execOverlay.get(msg.nodeId) ?? {};
      entry.breakpointHit = true;
      this._execOverlay.set(msg.nodeId, entry);
    }

    const { nodes, edges } = this._refreshGraphState();

    const nextNodes = new Map(nodes.map(n => [n.id, n]));
    const nodeFrag = document.createDocumentFragment();
    // REMOVE old nodes
    for (const [id, prevNode] of this._prevNodes) {
      if (!nextNodes.has(id)) {
        this._removeNode(id);
      }
    }

    // ADD or UPDATE nodes
    for (const node of nodes) {
      if (!this._prevNodes.has(node.id)) {
        this._addNode(node, nodeFrag);
      } else {
        this._updateNode(node, this._prevNodes.get(node.id));
      }
    }
    this.graphNodesEl.appendChild(nodeFrag);
    this._prevNodes = nextNodes;

    const nextEdges = new Map();
    const edgeFrag = document.createDocumentFragment();
    for (const edge of edges) {
      const key = createEdgeId(edge);
      nextEdges.set(key, edge);

      if (!this._prevEdges.has(key)) {
        this._addEdge(edge, edgeFrag);
      } else {
        this._updateEdge(edge, this._prevEdges.get(key));
      }
    }

    // REMOVE old edges
    for (const [key, edge] of this._prevEdges) {
      if (!nextEdges.has(key)) {
        this._removeEdge(key);
      }
    }

    this._prevEdges = nextEdges;
    this.graphEdgesEl.appendChild(edgeFrag);

    for (const edge of edges) {
      this._updateEdge(edge);
    }
  }

  /* ───────────────────────── LOCAL NODE OPERATIONS ───────────────────────────── */

  _addNode(node, frag) {
    const el = this.nodeTemplate.content.firstElementChild.cloneNode(true);
    el.dataset.id = node.id;

    // ── right click breakpoint ─────────────────────────
    // will be cleaned up when we remove the node el
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();

      this.breakpointChangeListeners.forEach(l => l(node));
      this.render();
    });

    // ── click ─────────────────────────
    // will be cleaned up when we remove the node el
    el.addEventListener('click', (e) => {
      e.stopPropagation();

      this._selectNode(node.id);
      this.nodeClickListeners.forEach((l) =>
          l(e, this._prevNodes.get(node.id))
      );
    });

    // ── state change indicator (bind once) ─────────────────────────
    const stateChangedIndicator = el.querySelector('[data-id="stateChangeIndicator"]');

    if (stateChangedIndicator) {
      stateChangedIndicator.addEventListener('click', () => {
        const exec = this._execOverlay.get(node.id);
        const current = this._currentNodeMap.get(node.id);
        const stateChanges = exec?.stateChanges ?? current?.data?.stateChanges;
        if (stateChanges) this.displayNodeStateChanges(stateChanges);
      });
    }

    this._nodeEls.set(node.id, el);
    frag.appendChild(el);

    this._updateNode(node);
  }

  _removeNode(id) {
    const el = this._nodeEls.get(id);
    if (el) el.remove();
    this._nodeEls.delete(id);
  }

  /**
   * Because we mutate our changes, node is prevNode always unless a new
   * node is being added.
   *
   * @param node
   * @param prevNode (Not used since we mutate in place)
   * @private
   */
  _updateNode(node, prevNode) {
    const el = this._nodeEls.get(node.id);

    //Track the previously rendered state
    const prev = this._nodeRenderState.get(node.id);
    const renderedState = {};

    // Merge execution-time overlay (fired, stateChanges, breakpointHit) into
    // display data.  Config-level data (breakpoint flag) stays on node.data.
    const exec = this._execOverlay.get(node.id);
    const data = exec ? { ...node.data, ...exec } : (node.data ?? {});

    // ── base classes ─────────────────────────
    el.classList.add('g-node');

    // selected
    el.classList.toggle('selected', node.id === this.selectedNodeId);

    // lineage highlight
    el.classList.toggle('node-highlighted', this._highlightNodeSet.has(node.id));

    // flashing
    el.classList.toggle('node-flash', !!data.breakpointHit);

    // ── position ─────────────────────────
    const { x, y } = this._getPos(node.id);
    el.style.left = x + 'px';
    el.style.top = y + 'px';

    // ── header text ─────────────────────────
    const header = el.querySelector('span.g-header-text');

    if (node.kind !== prev?.kind) {
      switch(node.kind) {
        case 'event':   header.innerText = node.eventType; break;
        case 'handler': header.innerText = node.handlerClass; break;
        case 'action':  header.innerText = node.actionClass; break;
        case 'reducer': header.innerText = node.reducerType; break;
      }
      renderedState.kind = node.kind;
    }

    // ── title ─────────────────────────
    const title = el.querySelector('span.g-title-text');
    if (node.name !== prev?.name) {
      title.innerText = node.name;
      renderedState.name = node.name;
    }

    // ── fired indicator — hidden in config-only mode ──────────────────
    const firedIndicator = el.querySelector('[data-id="firedIndicator"]');
    const showExec = this._layerMode !== 'config';

    firedIndicator.style.display = showExec ? '' : 'none';
    if (showExec) {
      const fired = !!data.fired;
      firedIndicator.classList.toggle('badge-green', fired);
      firedIndicator.classList.toggle('badge-cyan', !fired);
      firedIndicator.innerText = fired ? 'Fired' : 'Idle';
      renderedState.fired = fired;
    }

    // ── state change indicator — hidden in config-only mode ───────────
    const stateChangedIndicator = el.querySelector('[data-id="stateChangeIndicator"]');
    if (stateChangedIndicator) {
      stateChangedIndicator.style.display = showExec && data.stateChanges?.length > 0 ? '' : 'none';
    }

    // ── breakpoint indicator ─────────────────────────
    const bpIndicator = el.querySelector('[data-id="breakpointIndicator"]');
    const hasBreakpoint = !!node.data?.breakpoint;

    bpIndicator.style.display = hasBreakpoint ? '' : 'none';
    el.classList.toggle('has-breakpoint', hasBreakpoint);

    this._nodeRenderState.set(node.id, renderedState);
  }

  _selectNode(id) {
    this.selectedNodeId = id;
    // Bring selected node element to top of the node layer.
    const el = this._nodeEls.get(id);
    if (el) this.graphNodesEl.appendChild(el);
    // Bring connected edges to top of the edge layer.
    for (const [key, path] of this._edgeEls) {
      const sep = key.indexOf('->');
      if (key.slice(0, sep) === id || key.slice(sep + 2) === id) {
        this.graphEdgesEl.appendChild(path);
      }
    }
    this.render();
  }

  _getNodesByIds(ids) {
    return ids.map(id => this._currentNodeMap.get(id)).filter(Boolean);
  }

  /* ───────────────────────── LOCAL EDGE OPERATIONS ───────────────────────────── */

  _addEdge(edge, frag) {
    const id = createEdgeId(edge);

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.classList.add('g-edge');

    this._edgeEls.set(id, path);
    frag.appendChild(path);

    this._updateEdge(edge);
  }

  _removeEdge(id) {
    const el = this._edgeEls.get(id);
    if (el) el.remove();
    this._edgeEls.delete(id);
  }

  _updateEdge(edge) {
    const id = createEdgeId(edge);
    const path = this._edgeEls.get(id);

    const from = this._getPos(edge.from);
    const to = this._getPos(edge.to);

    if (!from || !to) return;

    const x1 = from.x + NODE_WIDTH;
    const y1 = from.y + NODE_HEIGHT / 2;
    const x2 = to.x;
    const y2 = to.y + NODE_HEIGHT / 2;

    const d = `M ${x1} ${y1} C ${x1 + 60} ${y1}, ${x2 - 60} ${y2}, ${x2} ${y2}`;
    path.setAttribute('d', d);
    path.classList.toggle('highlighted', this._highlightEdgeSet.has(id));
  }

  /* ───────────────────────── Layout Helpers ───────────────────────────── */
  _getPos(id) {
    return this._positions.get(id) || { x: 0, y: 0 };
  }

  _setPos(id, x, y) {
    this._positions.set(id, { x, y });
  }

  /**
   * Re-position all nodes using a hierarchical column layout.
   * Nodes are grouped by kind into columns (event → handler → action → reducer),
   * with each column centered horizontally and rows distributed evenly vertically.
   * Called every time a node is added so the layout stays balanced.
   * @private
   */
  _relayoutAll() {
    this._refreshGraphState();

    const rect = this.graphRoot.getBoundingClientRect();
    const W = rect.width  || 800;
    const H = rect.height || 400;

    const positions = this._layout.apply(this._currentNodes, { width: W, height: H });
    for (const [id, { x, y }] of positions) {
      this._setPos(id, x, y);
    }
  }

  /* ───────────────────────── PAN / ZOOM ───────────────────────────── */
  _applyTransform() {
    const { x, y, scale } = this.view;
    this.viewport.style.transform =
        `translate(${x}px, ${y}px) scale(${scale})`;
    this.viewport.style.transformOrigin = '0 0';
  }

  fitToView(padding = 40) {
    if (!this._currentNodes.length) return;

    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    for (const n of this._currentNodes) {
      const { x, y } = this._getPos(n.id);

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + NODE_WIDTH);
      maxY = Math.max(maxY, y + NODE_HEIGHT);
    }

    const rect = this.graphRoot.getBoundingClientRect();
    const viewW = rect.width;
    const viewH = rect.height;

    const scale = Math.min(
        (viewW - padding * 2) / (maxX - minX),
        (viewH - padding * 2) / (maxY - minY)
    );

    this.view.scale = Math.min(Math.max(scale, 0.2), 3);

    this.view.x = -minX * this.view.scale +
        (viewW - (maxX - minX) * this.view.scale) / 2;

    this.view.y = -minY * this.view.scale +
        (viewH - (maxY - minY) * this.view.scale) / 2;

    this._applyTransform();
  }

  _updateSelectionBox() {
    const { start, end, boxEl } = this.selection;

    // convert to graph space
    const p1 = this._screenToGraph(start.x, start.y);
    const p2 = this._screenToGraph(end.x, end.y);

    const x = Math.min(p1.x, p2.x);
    const y = Math.min(p1.y, p2.y);
    const w = Math.abs(p1.x - p2.x);
    const h = Math.abs(p1.y - p2.y);

    Object.assign(boxEl.style, {
      left: x + 'px',
      top: y + 'px',
      width: w + 'px',
      height: h + 'px'
    });
  }

  _screenToGraph(x, y) {
    const rect = this.graphRoot.getBoundingClientRect();

    return {
      x: (x - rect.left - this.view.x) / this.view.scale,
      y: (y - rect.top  - this.view.y) / this.view.scale
    };
  }

  _getNodesInSelection() {
    const { start, end } = this.selection;

    const p1 = this._screenToGraph(start.x, start.y);
    const p2 = this._screenToGraph(end.x, end.y);

    const minX = Math.min(p1.x, p2.x);
    const maxX = Math.max(p1.x, p2.x);
    const minY = Math.min(p1.y, p2.y);
    const maxY = Math.max(p1.y, p2.y);

    return this._currentNodes.filter(n => {
      const { x, y } = this._getPos(n.id);

      return (
          x < maxX &&
          x + NODE_WIDTH > minX &&
          y < maxY &&
          y + NODE_HEIGHT > minY
      );
    });
  }

  layoutSubset(nodeIds, { spacingX = 1.5, spacingY = 1.5 } = {}) {

    const subset = this._getNodesByIds(nodeIds);

    if (!subset.length) return;

    let cx = 0, cy = 0;

    subset.forEach(n => {
      const { x, y } = this._getPos(n.id);
      cx += x;
      cy += y;
    });

    cx /= subset.length;
    cy /= subset.length;

    subset.forEach(n => {
      const { x, y } = this._getPos(n.id);

      this._setPos(
          n.id,
          cx + (x - cx) * spacingX,
          cy + (y - cy) * spacingY
      );
    });
  }

  _focusNodes(nodes) {
    if (!nodes.length) return;

    const ids = nodes.map(n => n.id);

    // 1. Expand layout
    this.layoutSubset(ids, {
      spacingX: 2.0,
      spacingY: 2.0
    });

    this.render();

    // 2. Animate camera
    const target = this.computeFitView(ids);
    this.animateView(target, 400); // slightly longer feels nicer
  }

  computeFitView(nodeIds, padding = 40) {
    const nodes = nodeIds
    .map(id => this._currentNodeMap.get(id))
    .filter(Boolean);

    if (!nodes.length) return null;

    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    for (const n of nodes) {
      const { x, y } = this._getPos(n.id);

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + NODE_WIDTH);
      maxY = Math.max(maxY, y + NODE_HEIGHT);
    }

    const rect = this.graphRoot.getBoundingClientRect();
    const viewW = rect.width;
    const viewH = rect.height;

    const scale = Math.min(
        (viewW - padding * 2) / (maxX - minX),
        (viewH - padding * 2) / (maxY - minY)
    );

    const clampedScale = Math.min(Math.max(scale, 0.3), 3);

    const x = -minX * clampedScale +
        (viewW - (maxX - minX) * clampedScale) / 2;

    const y = -minY * clampedScale +
        (viewH - (maxY - minY) * clampedScale) / 2;

    return { x, y, scale: clampedScale };
  }

  animateView(target, duration = 300) {
    if (!target) return;

    const start = { ...this.view };
    const startTime = performance.now();

    const easeInOut = (t) => {
      return t < 0.5
          ? 2 * t * t
          : 1 - Math.pow(-2 * t + 2, 2) / 2;
    };

    const tick = (now) => {
      const elapsed = now - startTime;
      const t = Math.min(elapsed / duration, 1);
      const e = easeInOut(t);

      this.view.x = start.x + (target.x - start.x) * e;
      this.view.y = start.y + (target.y - start.y) * e;
      this.view.scale = start.scale + (target.scale - start.scale) * e;

      this._applyTransform();

      if (t < 1) {
        requestAnimationFrame(tick);
      }
    };

    requestAnimationFrame(tick);
  }

  _getLocalPoint(e) {
    const rect = this.graphRoot.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  }

  /* ───────────────────────────── PAN / ZOOM / SELECTION  ──────────────── */

  _setupPan() {
    //Panning
    this.isPanning = false;
    this.panStart = null;

    this._onPanStart = (e) => {
      if (e.shiftKey) return; // don't pan when selecting
      // only pan if NOT clicking a node
      if (e.target.closest('.g-node')) return;

      this.isPanning = true;
      this.panStart = {
        x: e.clientX - this.view.x,
        y: e.clientY - this.view.y
      };
    };

    this._onPanMove = (e) => {
      if (!this.isPanning) return;

      this.view.x = e.clientX - this.panStart.x;
      this.view.y = e.clientY - this.panStart.y;

      this._applyTransform();
    };

    this._onPanEnd = () => {
      this.isPanning = false;
    };

    this.listen(this.graphRoot, 'mousedown', (e) => this._onPanStart(e))
    this.listen(window, 'mousemove', (e) => this._onPanMove(e))
    this.listen(window, 'mouseup', (e) => this._onPanEnd(e))
  }

  _onWheel(e) {
    e.preventDefault();

    const scaleFactor = 1.1;
    const oldScale = this.view.scale;

    const direction = e.deltaY > 0 ? -1 : 1;
    const newScale = direction > 0
        ? oldScale * scaleFactor
        : oldScale / scaleFactor;

    // clamp
    this.view.scale = Math.min(Math.max(newScale, 0.2), 3);

    // zoom toward mouse position
    const rect = this.graphRoot.getBoundingClientRect();

    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const dx = mx - this.view.x;
    const dy = my - this.view.y;

    this.view.x -= dx * (this.view.scale / oldScale - 1);
    this.view.y -= dy * (this.view.scale / oldScale - 1);

    this._applyTransform();
  }

  //Zooming
  _setupZoom() {
    this.listen(this.graphRoot, 'wheel', (e) => this._onWheel(e), { passive: false })
  }

  _onSelectStart(e) {
    if (!e.shiftKey) return;

    this.selection.active = true;
    this.selection.start = { x: e.clientX, y: e.clientY };
    this.selection.end = { x: e.clientX, y: e.clientY };

    const box = this.selection.boxEl;
    box.style.display = 'block';

    this._updateSelectionBox();
  };

  _onSelectMove(e) {
    if (!this.selection.active) return;

    this.selection.end = this._getLocalPoint(e);

    this._updateSelectionBox();
  };

  _onSelectEnd() {
    if (!this.selection.active) return;

    this.selection.active = false;
    this.selection.boxEl.style.display = 'none';

    const nodes = this._getNodesInSelection();
    this._focusNodes(nodes);
  };

  //Selection
  _setupSelection() {
    this.listen(this.graphRoot, 'mousedown', (e) => this._onSelectStart(e))
    this.listen(window, 'mousemove', (e) => this._onSelectMove(e))
    this.listen(window, 'mouseup', (e) => this._onSelectEnd(e))
  }

  _onMouseDown(e) {
    const el = e.target.closest('.g-node');
    if (!el) return;

    const rect = el.getBoundingClientRect();

    const scale = this.view.scale;

    this.dragState = {
      el,
      id: el.dataset.id,
      offsetX: (e.clientX - rect.left) / scale,
      offsetY: (e.clientY - rect.top) / scale
    };

    el.style.zIndex = 10;
  };

  //Move node
  _onMouseMove(e) {
    if (!this.dragState) return;

    const rect = this.graphRoot.getBoundingClientRect();
    const scale = this.view.scale;

    const x = (e.clientX - rect.left - this.view.x) / scale - this.dragState.offsetX;
    const y = (e.clientY - rect.top  - this.view.y) / scale - this.dragState.offsetY;

    this._setPos(this.dragState.id, x, y);

    const el = this.dragState.el;
    el.style.left = x + 'px';
    el.style.top  = y + 'px';

    this.render();
  };

  _onMouseUp() {
    if (!this.dragState) return;
    this.dragState.el.style.zIndex = '';
    this.dragState = null;
  };

  //Select node
  _setupNodeSelectAndMove() {
    this.listen(this.graphNodesEl, 'mousedown', (e) => this._onMouseDown(e))
    this.listen(window, 'mousemove', (e) => this._onMouseMove(e))
    this.listen(window, 'mouseup', (e) => this._onMouseUp(e))
  }

  destroy() {
    super.destroy();
  }
}
