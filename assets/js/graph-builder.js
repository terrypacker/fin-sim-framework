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

export class ConfigGraphBuilder {
  constructor({ graphRoot, graphNodes, graphEdges}) {
    this.graphRoot = graphRoot;
    this.graphNodesEl = graphNodes;
    this.graphEdgesEl = graphEdges;

    this.nodes = [];
    this.edges = [];

    this.nodeClickListeners = [];
    this.selectedNodeId = null;
    this.dragState = null;
    this.xSpacing = NODE_WIDTH + PADDING;
    this.ySpacing = NODE_HEIGHT + PADDING;


    this._bindEvents();
  }

  /* ───────────────────────────── EVENTS ───────────────────────────── */

  _bindEvents() {
    this.graphNodesEl.addEventListener('mousedown', (e) => {
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
    });

    window.addEventListener('mousemove', (e) => {
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
    });

    window.addEventListener('mouseup', () => {
      if (!this.dragState) return;
      this.dragState.el.style.zIndex = '';
      this.dragState = null;
    });
  }

  _renderGraph() {
    this.graphNodesEl.innerHTML = '';

    for (const node of this.nodes) {
      const el = document.createElement('div');
      el.className = 'g-node';
      el.dataset.id = node.id;

      if (node.id === this.selectedNodeId) {
        el.classList.add('selected');
      }

      el.style.left = node.x + 'px';
      el.style.top  = node.y + 'px';

      el.innerHTML = `
        <div class="g-header">${node.kind.toUpperCase()}</div>
        <input class="g-title" value="${node.name || ''}">
        <div class="g-port in"></div>
        <div class="g-port out"></div>
      `;

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

  /* ────────────────── External Node Operations ────────────────────────*/
  /**
   * Register a listener to accept (event, node)
   * when a node is clicked.
   * @param listener
   */
  registerNodeClickListener(listener) {
    this.nodeClickListeners.push(listener);
  }

  addNode(node) {
    if(!node.id) {
      throw new Error(`Node requires id ${node}`);
    }
    const existing = this.getNode(node.id);
    if(existing) {
      throw new Error(`Node already added ${node}`);
    }
    //Need to ensure we have a good x,y
    this._computeNodePlacement(node);
    this.nodes.push(node);
    this.render();
  }

  /**
   * Find a good x,y for the new node
   * @param node
   * @private
   */
  _computeNodePlacement(node) {
    //Find a good spot to add this node
    const rootRect = this.graphRoot.getBoundingClientRect();
    const final = this._getNextPosition(rootRect, this.xSpacing, this.ySpacing);
    //const final = this._getRepelledPosition([...this.nodes, pos], rootRect);
    node.x = final.x;
    node.y = final.y;
  }

  _getNextPosition(rootRect, xSpacing = 10, ySpacing = 5) {
    const cols = Math.floor(rootRect.width / xSpacing);
    const rows = Math.floor(rootRect.height / ySpacing);

    const occupied = new Set(
        this.nodes.map(n => `${ Math.floor(n.x / xSpacing)}, ${Math.floor(n.y / ySpacing) }`)
    );

    // start from last node
    const last = this.nodes[this.nodes.length - 1];

    const cx = last
        ? Math.floor(last.x / xSpacing)
        : Math.floor(cols / 2);

    const cy = last
        ? Math.floor(last.y / ySpacing)
        : Math.floor(rows / 2);

    //TODO Find Parent if there is one
    //const cx = Math.floor(parent.x / xSpacing) + 1;
    //const cy = Math.floor(parent.y / ySpacing);

    // spiral out
    let x = 0, y = 0, dx = 0, dy = -1;
    const max = Math.max(cols, rows) ** 2;

    for (let i = 0; i < max; i++) {
      const gx = cx + x;
      const gy = cy + y;

      if (gx >= 0 && gy >= 0 && gx < cols && gy < rows) {
        const key = `${gx},${gy}`;
        if (!occupied.has(key)) {
          const px = gx * xSpacing;
          const py = gy * ySpacing;

          if (!this._isTooClose(px, py, this.nodes, xSpacing, ySpacing)) {
            return { x: px, y: py };
          }
        }
      }

      // spiral movement
      if (x === y || (x < 0 && x === -y) || (x > 0 && x === 1 - y)) {
        [dx, dy] = [-dy, dx];
      }
      x += dx;
      y += dy;
    }

    return { x: xSpacing, y: ySpacing }; // fallback
  }

  _isTooClose(x, y, nodes, minDistX, minDistY) {
    for (const n of nodes) {
      if (
          Math.abs(n.x - x) < minDistX &&
          Math.abs(n.y - y) < minDistY
      ) {
        return true;
      }
    }
    return false;
  }

  _getRepelledPosition(nodes, rootRect) {
    let x = rootRect.width / 2;
    let y = rootRect.height / 2;

    const minDist = 100;
    const iterations = 50;

    for (let i = 0; i < iterations; i++) {
      let fx = 0;
      let fy = 0;

      for (const n of nodes) {
        const dx = x - n.x;
        const dy = y - n.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;

        if (dist < minDist) {
          const force = (minDist - dist) / dist;
          fx += dx * force;
          fy += dy * force;
        }
      }

      x += fx * 0.1;
      y += fy * 0.1;

      // clamp to canvas
      x = Math.max(0, Math.min(rootRect.width, x));
      y = Math.max(0, Math.min(rootRect.height, y));
    }

    return { x, y };
  }

  _placeNear(parent, offset = { x: 150, y: 0 }) {
    return {
      x: parent.x + offset.x,
      y: parent.y + offset.y
    };
  }

  getNode(nodeId) {
    return this.nodes.find(n => n.id == nodeId);
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
      return n.kind === kind && n.from === node.id;
    });
  }

  getNodesToKindFromMe(node, kind) {
    const myEdges = Array.from(this.edges.values().filter(e => e.from === node.id));
    return Array.from(this.nodes.values()).filter(n => {
       return n.kind === kind && myEdges.some( e => e.to === n.id);
    });
  }

}
