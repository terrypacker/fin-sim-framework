/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Edge } from '../graph/edge.js';

export const EXECUTION_EDGE_TYPES = {
  INSTANCE_OF: 'instance-of',
  EXECUTES:    'executes',
  EMITS:       'emits',
  SCHEDULES:   'schedules',
};

/**
 * Wraps the singleton Graph to record causal relationships between runtime
 * execution nodes (layer:'execution') and their config-graph definitions
 * (layer:'config').
 *
 * Two layers share one Graph instance:
 *   config    — event/handler/action/reducer definitions (added by ServiceRegistry)
 *   execution — runtime instances (added here during stepTo)
 *
 * Edge types:
 *   INSTANCE_OF  runtime node → its config definition
 *   EXECUTES     parent execution node → child execution node (call chain)
 *   EMITS        reducer execution → action it caused via result.next
 *   SCHEDULES    execution node → event node it deferred via sim.schedule()
 */
export class ExecutionGraph {
  constructor(graph) {
    this._graph = graph;
  }

  get graph() { return this._graph; }

  addNode(node) {
    this._graph.addNode(node);
    return node;
  }

  addEdge(from, to, type) {
    if (!from || !to) return null;
    if (!this._graph.getNode(from) || !this._graph.getNode(to)) return null;
    return this._graph.addEdge(new Edge({ from, to, type }));
  }

  getNode(id) { return this._graph.getNode(id); }

  getExecutionNodes() {
    return this._graph.byLayer('execution');
  }

  getChildren(id) {
    return this._graph.getNeighbors(id, { type: EXECUTION_EDGE_TYPES.EXECUTES, direction: 'out' });
  }

  getParent(id) {
    const edges = this._graph.getIncoming(id, EXECUTION_EDGE_TYPES.EXECUTES);
    return edges.length ? this._graph.getNode(edges[0].from) : null;
  }

  getDefinition(runtimeId) {
    const edges = this._graph.getOutgoing(runtimeId, EXECUTION_EDGE_TYPES.INSTANCE_OF);
    return edges.length ? this._graph.getNode(edges[0].to) : null;
  }

  traceUp(id) {
    const chain = [];
    let current = this._graph.getNode(id);
    while (current) {
      chain.push(current);
      current = this.getParent(current.id);
    }
    return chain.reverse();
  }
}
