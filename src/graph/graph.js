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
    this.nodes = new Map();        // id -> node
    this.edges = new Set();        // Edge objects
    this.out = new Map();          // id -> Set<Edge>
    this.in  = new Map();          // id -> Set<Edge>
  }

  addNode(node) {
    if (!node.id) throw new Error("Node must have id");
    this.nodes.set(node.id, node);
    this.out.set(node.id, new Set());
    this.in.set(node.id, new Set());
  }

  getNode(id) {
    return this.nodes.get(id);
  }

  updateNode(id, node) {
    this.nodes.set(id, node);
  }

  //TODO this is dangerous
  getNodes() {
    return this.nodes.values();
  }

  addEdge(edge) {
    if (!this.nodes.has(edge.from) || !this.nodes.has(edge.to)) {
      throw new Error("Edge references missing nodes");
    }

    this.edges.add(edge);
    this.out.get(edge.from).add(edge);
    this.in.get(edge.to).add(edge);
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
    for (const e of this.getOutgoing(id)) this.removeEdge(e);
    for (const e of this.getIncoming(id)) this.removeEdge(e);
    this.nodes.delete(id);
    this.out.delete(id);
    this.in.delete(id);
  }

  removeEdge(edge) {
    this.edges.delete(edge);
    this.out.get(edge.from)?.delete(edge);
    this.in.get(edge.to)?.delete(edge);
  }
}
