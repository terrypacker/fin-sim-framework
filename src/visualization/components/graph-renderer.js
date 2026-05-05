/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import {BaseComponent} from "./base-component.js";

//defined by .g-node css
const NODE_WIDTH = 180;
const NODE_HEIGHT = 40;
const PADDING = 20;

const createEdgeId = (edge) => {
  return `${edge.from}->${edge.to}`;
};

export class GraphRenderer extends BaseComponent {

  constructor({ parent, graph, graphQueryApi, graphRoot, graphNodes, graphEdges, nodeDetailsTemplate, displayNodeStateChanges}) {
    super({ parent });
    this._graph = graph;
    this._graphQueryApi = graphQueryApi;
    this.graphRoot = graphRoot;
    this.graphNodesEl = graphNodes;
    this.graphEdgesEl = graphEdges;
    this.nodeTemplate = nodeDetailsTemplate;
    this.displayNodeStateChanges = displayNodeStateChanges ? displayNodeStateChanges : (c) => {};

    //TODO ??? Graph has been modified
    //TODO Remove on Destroy
    //TODO This should live outside the component I think
    this._graph.addNodeModifcationWatcher(() => {
      this.render();
    });

    //Current view tracking
    this._currentNodes = [];
    this._currentNodeMap = new Map();
    this._layout = new Map();

    //Diff rendering
    this._prevNodes = new Map(); // id -> node
    this._prevEdges = new Map(); // key -> edge
    this._nodeEls = new Map(); // id -> element
    this._edgeEls = new Map(); // id -> element
    this._nodeRenderState = new Map(); // id -> { fired, ... }

    //DOM Batching
    this._dirty = false;
    this._frameScheduled = false;

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
    this._bindEvents();
    // mount immediately
    this._mount();
  }

  _mount() {
    //TODO Build out the component parts dynamically
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

  /* ───────────────────────── PUBLIC API ───────────────────────────── */
  //TODO Consider need for these
  selectNode(id) {
    this.selectedNodeId = id;
    this.render();
  }

  /* ───────────────────────── CORE RENDERING ───────────────────────────── */

  render() {
    if (this._dirty) return; // already scheduled
    this._dirty = true;
    this._scheduleFrame();
  }

  _scheduleFrame() {
    if (this._frameScheduled) return;

    this._frameScheduled = true;

    requestAnimationFrame(() => {
      this._frameScheduled = false;

      if (!this._dirty) return;

      this._dirty = false;
      this._renderGraph();
    });
  }

  resizeCanvas(h,w) {
    this.graphRoot.height = h;
    this.graphRoot.width = w;
    this._relayoutAll();
    this.render();
  }

  _renderGraph() {

    const { nodes, edges } = this._graphQueryApi.getGraphView('config');
    this._currentNodes = nodes;
    this._currentNodeMap = new Map(nodes.map(n => [n.id, n]));

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

      this.selectNode(node.id);
      this.nodeClickListeners.forEach((l) =>
          l(e, this._prevNodes.get(node.id))
      );
    });

    // ── state change indicator (bind once) ─────────────────────────
    const stateChangedIndicator = el.querySelector('[data-id="stateChangeIndicator"]');

    if (stateChangedIndicator) {
      stateChangedIndicator.addEventListener('click', () => {
        const current = this._currentNodeMap.get(node.id);
        if (current?.stateChanges) {
          this.displayNodeStateChanges(current.stateChanges);
        }
      });
    }

    this._nodeEls.set(node.id, el);

    this._updateNode(node);
    frag.appendChild(el);
  }

  _removeNode(id) {
    const el = this._nodeEls.get(id);
    if (el) el.remove();
    this._nodeEls.delete(id);
  }
  _updateNode(node, prevNode) {
    const el = this._nodeEls.get(node.id);
    const prev = this._nodeRenderState.get(node.id);
    const renderedState = {};

    // ── base classes ─────────────────────────
    el.classList.add('g-node');

    // selected
    el.classList.toggle('selected', node.id === this.selectedNodeId);

    // flashing
    el.classList.toggle('node-flash', !!node.flashing);

    // ── position ─────────────────────────
    const { x, y } = this._getPos(prevNode ? prevNode.id : null);
    el.style.left = x + 'px';
    el.style.top = y + 'px';

    // ── header text ─────────────────────────
    const header = el.querySelector('span.g-header-text');

    if (!prevNode || node.kind !== prevNode.kind) {
      switch(node.kind) {
        case 'event':   header.innerText = node.eventType; break;
        case 'handler': header.innerText = node.handlerClass; break;
        case 'action':  header.innerText = node.actionClass; break;
        case 'reducer': header.innerText = node.reducerType; break;
      }
    }

    // ── title ─────────────────────────
    const title = el.querySelector('span.g-title-text');
    if (!prevNode || node.name !== prevNode.name) {
      title.innerText = node.name;
    }

    // ── fired indicator ─────────────────────────
    const firedIndicator = el.querySelector('[data-id="firedIndicator"]');

    const fired = !!node.data?.fired;
    firedIndicator.classList.toggle('badge-green', fired);
    firedIndicator.classList.toggle('badge-cyan', !fired);
    firedIndicator.innerText = fired ? 'Fired' : 'Idle';
    renderedState.fired = fired;

  // ── state change indicator (update only) ─────────────────────────
    const stateChangedIndicator = el.querySelector('[data-id="stateChangeIndicator"]');

    if (stateChangedIndicator) {
      stateChangedIndicator.style.display = node.stateChanged ? '' : 'none';
    }

    // ── breakpoint indicator ─────────────────────────
    const bpIndicator = el.querySelector('[data-id="breakpointIndicator"]');
    const hasBreakpoint = !!node.breakpoint;

    bpIndicator.style.display = hasBreakpoint ? '' : 'none';
    el.classList.toggle('has-breakpoint', hasBreakpoint);

    this._nodeRenderState.set(node.id, renderedState);
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
  }

  /* ───────────────────────── Layout Helpers ───────────────────────────── */
  _getPos(id) {
    return this._layout.get(id) || { x: 0, y: 0 };
  }

  _setPos(id, x, y) {
    this._layout.set(id, { x, y });
  }

  /**
   * Re-position all nodes using a hierarchical column layout.
   * Nodes are grouped by kind into columns (event → handler → action → reducer),
   * with each column centered horizontally and rows distributed evenly vertically.
   * Called every time a node is added so the layout stays balanced.
   * @private
   */
  _relayoutAll() {
    const rect = this.graphRoot.getBoundingClientRect();
    const W = rect.width  || 800;
    const H = rect.height || 400;

    const KIND_ORDER = ['event', 'handler', 'action', 'reducer'];

    const groups = new Map();
    for (const kind of KIND_ORDER) groups.set(kind, []);

    for (const node of this._currentNodes) {
      const kind = node.kind ?? 'other';
      if (!groups.has(kind)) groups.set(kind, []);
      groups.get(kind).push(node);
    }

    const activeGroups = [...groups.entries()]
    .filter(([, nodes]) => nodes.length > 0);

    const numCols = activeGroups.length;

    activeGroups.forEach(([, nodes], colIdx) => {
      const x = W * (colIdx + 1) / (numCols + 1) - NODE_WIDTH / 2;

      nodes.forEach((node, rowIdx) => {
        const y = H * (rowIdx + 1) / (nodes.length + 1) - NODE_HEIGHT / 2;
        this._setPos(node.id, x, y);
      });
    });
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
}
