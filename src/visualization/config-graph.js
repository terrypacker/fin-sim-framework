/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */
//defined by .g-node css
const NODE_WIDTH = 180;
const NODE_HEIGHT = 40;
const PADDING = 20;

export class ConfigGraph {
  constructor({ graphRoot, graphNodes, graphEdges, nodeDetailsTemplate, displayNodeStateChanges}) {
    this.graphRoot = graphRoot;
    this.graphNodesEl = graphNodes;
    this.graphEdgesEl = graphEdges;
    this.displayNodeStateChanges = displayNodeStateChanges ? displayNodeStateChanges : (c) => {};

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

    this.nodes = [];
    this.edges = [];

    this.nodeClickListeners = [];
    this.breakpointChangeListeners = [];
    this.selectedNodeId = null;
    this.dragState = null;
    this.nodeTemplate = nodeDetailsTemplate;
    this._bindEvents();
  }

  /* ───────────────────────── PAN / ZOOM ───────────────────────────── */
  _applyTransform() {
    const { x, y, scale } = this.view;
    this.viewport.style.transform =
        `translate(${x}px, ${y}px) scale(${scale})`;
    this.viewport.style.transformOrigin = '0 0';
    this._drawEdges();
  }

  fitToView(padding = 40) {
    if (this.nodes.length === 0) return;

    // 1. Compute bounds in graph space
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    for (const n of this.nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + NODE_WIDTH);
      maxY = Math.max(maxY, n.y + NODE_HEIGHT);
    }

    const graphWidth  = maxX - minX;
    const graphHeight = maxY - minY;

    // 2. View size
    const rect = this.graphRoot.getBoundingClientRect();
    const viewWidth  = rect.width;
    const viewHeight = rect.height;

    // 3. Compute scale
    const scaleX = (viewWidth  - padding * 2) / graphWidth;
    const scaleY = (viewHeight - padding * 2) / graphHeight;

    const scale = Math.min(scaleX, scaleY);

    // 4. Center it
    this.view.scale = Math.min(Math.max(scale, 0.2), 3);

    this.view.x = -minX * this.view.scale +
        (viewWidth - graphWidth * this.view.scale) / 2;

    this.view.y = -minY * this.view.scale +
        (viewHeight - graphHeight * this.view.scale) / 2;

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

    return this.nodes.filter(n => {
      return (
          n.x < maxX &&
          n.x + NODE_WIDTH > minX &&
          n.y < maxY &&
          n.y + NODE_HEIGHT > minY
      );
    });
  }

  layoutSubset(nodeIds, { spacingX = 1.5, spacingY = 1.5 } = {}) {
    const subset = this.nodes.filter(n => nodeIds.includes(n.id));
    if (!subset.length) return;

    // 1. Compute center of current selection
    let cx = 0, cy = 0;
    subset.forEach(n => {
      cx += n.x;
      cy += n.y;
    });

    cx /= subset.length;
    cy /= subset.length;

    // 2. Expand positions outward from center
    subset.forEach(n => {
      n.x = cx + (n.x - cx) * spacingX;
      n.y = cy + (n.y - cy) * spacingY;
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
    const nodes = this.nodes.filter(n => nodeIds.includes(n.id));
    if (!nodes.length) return null;

    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    for (const n of nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + NODE_WIDTH);
      maxY = Math.max(maxY, n.y + NODE_HEIGHT);
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

    this.graphRoot.addEventListener('mousedown', this._onPanStart);
    window.addEventListener('mousemove', this._onPanMove);
    window.addEventListener('mouseup', this._onPanEnd);
  }

  _setupZoom() {
    //Zooming
    this._onWheel = (e) => {
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
    };

    this.graphRoot.addEventListener('wheel', this._onWheel, { passive: false });
  }

  _setupSelection() {
    //Selection
    this._onSelectStart = (e) => {
      if (!e.shiftKey) return;

      this.selection.active = true;
      this.selection.start = { x: e.clientX, y: e.clientY };
      this.selection.end = { x: e.clientX, y: e.clientY };

      const box = this.selection.boxEl;
      box.style.display = 'block';

      this._updateSelectionBox();
    };

    this._onSelectMove = (e) => {
      if (!this.selection.active) return;

      this.selection.end = this._getLocalPoint(e);

      this._updateSelectionBox();
    };

    this._onSelectEnd = () => {
      if (!this.selection.active) return;

      this.selection.active = false;
      this.selection.boxEl.style.display = 'none';

      const nodes = this._getNodesInSelection();
      this._focusNodes(nodes);
    };

    this.graphRoot.addEventListener('mousedown', this._onSelectStart);
    window.addEventListener('mousemove', this._onSelectMove);
    window.addEventListener('mouseup', this._onSelectEnd);
  }

  /* ───────────────────────────── EVENTS ───────────────────────────── */

  _setupNodeSelectAndMove() {
    //Select node
    this._onMouseDown = (e) => {
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
    this._onMouseMove = (e) => {
      if (!this.dragState) return;

      const rootRect = this.graphRoot.getBoundingClientRect();

      const scale = this.view.scale;

      const x = (e.clientX - rootRect.left - this.view.x) / scale - this.dragState.offsetX;
      const y = (e.clientY - rootRect.top  - this.view.y) / scale - this.dragState.offsetY;

      const node = this.getNode(this.dragState.id);
      node.x = x;
      node.y = y;

      this.dragState.el.style.left = x + 'px';
      this.dragState.el.style.top  = y + 'px';

      this._drawEdges();
    };

    this._onMouseUp = () => {
      if (!this.dragState) return;
      this.dragState.el.style.zIndex = '';
      this.dragState = null;
    };

    this.graphNodesEl.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mouseup', this._onMouseUp);
  }

  _bindEvents() {
    //Setup Node Select and Move
    this._setupNodeSelectAndMove();
    //Setup Pan
    this._setupPan();
    //Setup Zoom
    this._setupZoom();
    //Setup Select box
    this._setupSelection();
  }

  destroy() {
    this.graphNodesEl.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mouseup', this._onMouseUp);
  }

  _renderGraph() {
    this.graphNodesEl.innerHTML = '';

    for (const node of this.nodes) {
      const el = this.nodeTemplate.content.firstElementChild.cloneNode(true);
      el.classList.add('g-node');
      el.dataset.id = node.id;

      if (node.id === this.selectedNodeId) {
        el.classList.add('selected');
      }

      el.style.left = node.x + 'px';
      el.style.top  = node.y + 'px';

      if(node.flashing) {
        el.classList.add('node-flash');
      }else {
        el.classList.remove('node-flash');
      }

      const header = el.querySelector('span.g-header-text');
      switch(node.kind) {
        case 'event':
          header.innerText = node.eventType;
          break;
        case 'handler':
          header.innerText = node.handlerClass;
          break;
        case 'action':
          header.innerText = node.actionClass;
          break;
        case 'reducer':
          header.innerText = node.reducerType;
          break;
      }
      const title = el.querySelector('span.g-title-text');
      title.innerText = node.name;
      const type = el.querySelector('span.g-type-text');

      //Update the fired status
      const firedIndicator = el.querySelector('[data-id="firedIndicator"]');
      firedIndicator.classList.toggle('badge-green', node.fired);
      firedIndicator.classList.toggle('badge-cyan', !node.fired);

      const stateChangedIndicator = el.querySelector('[data-id="stateChangeIndicator"]');
      if(node.stateChanged) {
        stateChangedIndicator.style = '';
        stateChangedIndicator.addEventListener('click', (evt) => {
          this.displayNodeStateChanges(node.stateChanges);
        });
      }else {
        stateChangedIndicator.style = 'display:none';
      }
      if(node.fired) {
        firedIndicator.innerText = 'Fired';
      }else {
        firedIndicator.innerText = 'Idle';
      }

      // ── Breakpoint indicator ─────────────────────────────────────────
      const bpIndicator = el.querySelector('[data-id="breakpointIndicator"]');
      if (bpIndicator) {
        if (node.breakpoint) {
          bpIndicator.style.display = '';
          el.classList.add('has-breakpoint');
        } else {
          bpIndicator.style.display = 'none';
          el.classList.remove('has-breakpoint');
        }
      }

      // Right-click toggles the breakpoint on this node
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        node.breakpoint = !node.breakpoint;
        this.breakpointChangeListeners.forEach(l => l(node));
        this.render();
      });

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.selectNode(node.id);
        this.nodeClickListeners.forEach((l) => l(e, this.getNode(node.id)))
      });

      this.graphNodesEl.appendChild(el);
    }

    this._drawEdges();
  }

  _drawEdges() {
    this.graphEdgesEl.innerHTML = '';

    // compute bounds of all nodes
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    for (const n of this.nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + NODE_WIDTH);
      maxY = Math.max(maxY, n.y + NODE_HEIGHT);
    }

    const padding = 200;

    const width = maxX - minX + padding * 2;
    const height = maxY - minY + padding * 2;
    for (const edge of this.edges) {
      const from = this.nodes.find(n => n.id === edge.from);
      const to   = this.nodes.find(n => n.id === edge.to);
      if (!from || !to) continue;

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');

      const x1 = from.x + NODE_WIDTH;
      const y1 = from.y + NODE_HEIGHT / 2;
      const x2 = to.x;
      const y2 = to.y + NODE_HEIGHT / 2;

      const d = `M ${x1} ${y1} C ${x1 + 60} ${y1}, ${x2 - 60} ${y2}, ${x2} ${y2}`;
      path.setAttribute('d', d);

      this.graphEdgesEl.appendChild(path);
    }
  }

  /* ───────────────────────────── SELECTION ───────────────────────────── */
  selectNode(id) {
    this.selectedNodeId = id;
    this.render();
  }
  /* ───────────────────────────── RENDER ───────────────────────────── */
  render() {
    this._renderGraph();
  }

  resizeCanvas(h,w) {
    this.graphRoot.height = h;
    this.graphRoot.width = w;
    this._relayoutAll();
    this.render();
  }

  /* ────────────────── External Node Operations ────────────────────────*/
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

  addNode(node) {
    if(!node.id) {
      throw new Error(`Node requires id ${node}`);
    }

    const existing = this.getNode(node.id);
    if(existing) {
      throw new Error(`Node already added ${node.id} kind: ${node.kind}`);
    }

    //Decorate for viz
    node.fired = false;
    node.breakpoint = node.breakpoint ?? false;

    this.nodes.push(node);
    this._relayoutAll();
    this.render();
  }

  flashNode(nodeId) {
    const node = this.getNode(nodeId);
    if(node) {
      node.flashing = true;
      this.render();
    }
  }

  /**
   * Re-position all nodes using a hierarchical column layout.
   * Nodes are grouped by kind into columns (event → handler → action → reducer),
   * with each column centered horizontally and rows distributed evenly vertically.
   * Called every time a node is added so the layout stays balanced.
   * @private
   */
  _relayoutAll() {
    const rootRect = this.graphRoot.getBoundingClientRect();
    const W = rootRect.width  || 800;
    const H = rootRect.height || 400;

    const KIND_ORDER = ['event', 'handler', 'action', 'reducer'];

    // Group nodes by kind, preserving insertion order within each group
    const groups = new Map();
    for (const kind of KIND_ORDER) groups.set(kind, []);
    for (const node of this.nodes) {
      const kind = node.kind ?? 'other';
      if (!groups.has(kind)) groups.set(kind, []);
      groups.get(kind).push(node);
    }

    const activeGroups = [...groups.entries()].filter(([, nodes]) => nodes.length > 0);
    const numCols = activeGroups.length;

    activeGroups.forEach(([, nodes], colIdx) => {
      const x = W * (colIdx + 1) / (numCols + 1) - NODE_WIDTH / 2;
      nodes.forEach((node, rowIdx) => {
        node.x = x;
        node.y = H * (rowIdx + 1) / (nodes.length + 1) - NODE_HEIGHT / 2;
      });
    });
  }

  getNode(nodeId) {
    return this.nodes.find(n => n.id == nodeId);
  }

  applyToAllNodes(changer) {
    this.nodes.forEach(n => changer(n));
  }

  replaceNode(nodeId, node) {
    this.nodes = this.nodes.filter(n => n.id !== nodeId);
    this.nodes.push(node);
    this.render();
  }

  removeNode(nodeId) {
    this.edges = this.edges.filter(e => e.from !== nodeId && e.to !== nodeId);
    this.nodes = this.nodes.filter(n => n.id !== nodeId);
    this._relayoutAll();
    this.render();
  }

  addEdge(edge) {
    this.edges.push(edge);
    this.render();
  }

  removeEdge(edge) {
    const index = this.edges.findIndex(e => e.from === edge.from && e.to === edge.to);
    this.edges.splice(index, 1);
    this.render();
  }

  getKind(kind) {
    return Array.from(this.nodes.values()).filter(n => n.kind === kind);
  }

  /** Find the first node of the given kind whose type string matches. */
  getNodeByType(kind, type) {
    return this.nodes.find(n => n.kind === kind && n.type === type);
  }

  getNodesFromKindToMe(node, kind) {
    const myEdges = Array.from(this.edges.values().filter(e => e.to === node.id));
    return Array.from(this.nodes.values()).filter(n => {
      return n.kind === kind && myEdges.some( e => e.from === n.id);
    });
  }

  getNodesToKindFromMe(node, kind) {
    const myEdges = Array.from(this.edges.values().filter(e => e.from === node.id));
    return Array.from(this.nodes.values()).filter(n => {
       return n.kind === kind && myEdges.some( e => e.to === n.id);
    });
  }

}
