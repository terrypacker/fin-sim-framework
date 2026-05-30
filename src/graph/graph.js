/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */
export class Graph {
  constructor() {
    this.nodes = new Map();
    this.edges = new Map();
    this.out   = new Map(); // nodeId -> Set<edgeId>
    this.in    = new Map(); // nodeId -> Set<edgeId>
  }

  addNode(node) {
    if (!node.id) throw new Error("Node must have id");

    if (!this.nodes.has(node.id)) {
      this.out.set(node.id, new Set());
      this.in.set(node.id, new Set());
    }

    this.nodes.set(node.id, node);
  }

  getNode(id) {
    return this.nodes.get(id);
  }

  updateNode(id, node) {
    if (id !== node.id) {
      throw new Error("Cannot change node id");
    }
    this.nodes.set(id, node);
  }

  getNodes() {
    return [...this.nodes.values()];
  }

  //TODO Remove once we get Rid of ConfigGraph as a data source
  getAll() {
    return this.getNodes();
  }

  getOutgoing(id, type = null) {
    const edges = this.out.get(id) || [];
    return type ? [...edges].filter(e => e.type === type) : [...edges];
  }

  getIncoming(id, type = null) {
    const edges = this.in.get(id) || [];
    return type ? [...edges].filter(e => e.type === type) : [...edges];
  }

  removeNode(id) {
    for (const edge of this.getOutgoing(id)) this.removeEdge(edge.id);
    for (const edge of this.getIncoming(id)) this.removeEdge(edge.id);

    this.nodes.delete(id);
    this.out.delete(id);
    this.in.delete(id);
  }

  clearLayer(layer) {
    for (const node of [...this.nodes.values()]) {
      if (node.layer === layer) this.removeNode(node.id);
    }
  }

  // ─── Edges ───────────────────────────────────────────────────────────────

  addEdge(edge) {
    if (!edge?.id) throw new Error("Edge must have id");
    if (!this.nodes.has(edge.from) || !this.nodes.has(edge.to)) {
      throw new Error("Edge references missing nodes");
    }

    if (this.edges.has(edge.id)) return this.edges.get(edge.id);

    this.edges.set(edge.id, edge);
    this.out.get(edge.from).add(edge.id);
    this.in.get(edge.to).add(edge.id);

    return edge;
  }

  getEdge(id) {
    return this.edges.get(id) ?? null;
  }

  removeEdge(edgeId) {
    const edge = this.edges.get(edgeId);
    if (!edge) return;

    this.out.get(edge.from)?.delete(edgeId);
    this.in.get(edge.to)?.delete(edgeId);
    this.edges.delete(edgeId);
  }

  // ─── Edge Queries ─────────────────────────────────────────────────────────

  getOutgoing(nodeId, type = null) {
    const ids = this.out.get(nodeId);
    if (!ids) return [];

    const edges = [...ids].map(id => this.edges.get(id));
    return type ? edges.filter(e => e.type === type) : edges;
  }

  getIncoming(nodeId, type = null) {
    const ids = this.in.get(nodeId);
    if (!ids) return [];

    const edges = [...ids].map(id => this.edges.get(id));
    return type ? edges.filter(e => e.type === type) : edges;
  }

  // This is the one your UI will use constantly
  getNeighbors(nodeId, { type = null, direction = 'out' } = {}) {
    const edges =
        direction === 'in'
            ? this.getIncoming(nodeId, type)
            : this.getOutgoing(nodeId, type);

    return edges.map(e =>
        direction === 'in' ? this.getNode(e.from) : this.getNode(e.to)
    );
  }

  // Very useful for debugging + UI overlays
  getEdges({ from = null, to = null, type = null } = {}) {
    let edges = [...this.edges.values()];

    if (from !== null) edges = edges.filter(e => e.from === from);
    if (to !== null)   edges = edges.filter(e => e.to === to);
    if (type !== null) edges = edges.filter(e => e.type === type);

    return edges;
  }

  // Bulk removal
  removeEdges({ from = null, to = null, type = null } = {}) {
    const edges = this.getEdges({ from, to, type });
    for (const e of edges) {
      this.removeEdge(e.id);
    }
  }
}
