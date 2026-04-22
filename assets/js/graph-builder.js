export class GraphBuilder {
  constructor({ graphRoot, graphNodes, graphEdges}) {
    this.graphRoot = graphRoot;
    this.graphNodesEl = graphNodes;
    this.graphEdgesEl = graphEdges;

    this.nodes = [];
    this.edges = [];

    this.nodeClickListeners = [];
    this.selectedNodeId = null;
    this.dragState = null;

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

      const x1 = from.x + 180;
      const y1 = from.y + 30;
      const x2 = to.x;
      const y2 = to.y + 30;

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
    this.nodes.push(node);
    this.render();
  }

  getNode(nodeId) {
    return this.nodes.find(n => n.id === nodeId);
  }

  addEdge(edge) {
    this.edges.push(edge);
    this.render();
  }
  getHandlers() {
    return Array.from(this.nodes.values()).filter(n => n.kind === 'handler');
  }
  getReducers() {
    return Array.from(this.nodes.values()).filter(n => n.kind === 'reducer');
    return Array.from(this.nodes.values()).filter(n => n.kind === 'reducer');
  }
}
