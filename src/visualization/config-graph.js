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

    this.nodes = [];
    this.edges = [];

    this.nodeClickListeners = [];
    this.breakpointChangeListeners = [];
    this.selectedNodeId = null;
    this.dragState = null;
    this.nodeTemplate = nodeDetailsTemplate;
    this._bindEvents();
  }

  /* ───────────────────────────── EVENTS ───────────────────────────── */

  _bindEvents() {
    this._onMouseDown = (e) => {
      const el = e.target.closest('.g-node');
      if (!el) return;

      const rect = el.getBoundingClientRect();

      this.dragState = {
        el,
        id: el.dataset.id,
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top
      };

      el.style.zIndex = 10;
    };

    this._onMouseMove = (e) => {
      if (!this.dragState) return;

      const rootRect = this.graphRoot.getBoundingClientRect();

      const x = e.clientX - rootRect.left - this.dragState.offsetX;
      const y = e.clientY - rootRect.top  - this.dragState.offsetY;

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

  applyToAllNodes(changer, value) {
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
