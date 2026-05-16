/*
 * Copyright (c) 2026 Terry Packer.
 *
 * This file is part of Terry Packer's Work.
 * See www.terrypacker.com for further info.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { QueryApi } from "../query/query-api.js";
import { createEdgeId } from "./edge.js";
import { EXECUTION_EDGE_TYPES } from '../simulation-framework/execution-graph.js';


export class GraphQueryApi extends QueryApi {

  // Always rebuild — the graph mutates on every service operation and the
  // dataset is small (tens of nodes), so caching indexes is not worth the
  // complexity of invalidating them.
  get rebuildIndexes() { return true; }
  set rebuildIndexes(_) {}

  constructor(graph) {
    super(graph);
    this._graph = graph; //TODO This is also in the parent as _dataSource
    this._kindIndex = new Map();
    this._layerIndex = new Map();
  }

  /**
   * Optimization to filter by kind once for repeated queries
   * @param where
   * @return {*}
   * @private
   */
  _createDataSource(where) {
    const kind = this._extractKind(where);
    return kind
        ? this.getByKind(kind)
        : this.getAll();
  }

  // =========================================================
  // Public API
  // =========================================================

  getByKind(kind) {
    if(this.rebuildIndexes) this._buildIndexes();
    return this._kindIndex.get(kind) || [];
  }

  getByLayer(layer) {
    if(this.rebuildIndexes) this._buildIndexes();
    return this._layerIndex.get(layer) || [];
  }

  getOneByKind(kind, field, value) {
    const items = this.getByKind(kind);
    return items.find(n => n[field] === value) || null;
  }

  getOneBy(field, value) {
    if (this.rebuildIndexes) this._buildIndexes();

    // Fast path for indexed fields
    if (field === 'id') {
      return this._idIndex.get(String(value)) || null;
    }

    if (field === 'name') {
      const bucket = this._nameIndex.get(String(value).toLowerCase());
      return bucket ? bucket[0] : null;
    }

    // Fallback scan
    for (const item of this._dataSource.getAll()) {
      if (item[field] === value) return item;
    }

    return null;
  }

  getManyBy(field, value) {
    if (this.rebuildIndexes) this._buildIndexes();

    // Fast path for indexed fields
    if (field === 'id') {
      const item = this._idIndex.get(String(value));
      return item ? [item] : [];
    }

    if (field === 'name') {
      return this._nameIndex.get(String(value).toLowerCase()) || [];
    }

    // Fallback scan
    const results = [];
    for (const item of this._dataSource.getAll()) {
      if (item[field] === value) results.push(item);
    }

    return results;
  }

  getManyByKind(kind, field, value) {
    const items = this.getByKind(kind);
    if (!items || !items.length) return [];

    const results = [];
    for (const item of items) {
      if (item[field] === value) results.push(item);
    }

    return results;
  }

  getOutgoing(nodeId, type = null) {
    return this._graph.getOutgoing(nodeId, type);
  }
  getIncoming(nodeId, type = null) {
    return this._graph.getIncoming(nodeId, type);
  }

  // outgoing → nodes
  getTargets(nodeId, type = null) {
    return this._graph
      .getOutgoing(nodeId, type)
      .map(e => this._graph.getNode(e.to));
  }

  // incoming → node
  getSources(nodeId, type = null) {
    return this._graph
    .getIncoming(nodeId, type)
    .map(e => this._graph.getNode(e.from));
  }

  getRelated(nodeId, {
    edgeType = null,
    direction = 'out',
    where = null   // predicate function, NOT DSL
  }) {
    const nodes =
        direction === 'in'
            ? this.getSources(nodeId, edgeType)
            : this.getTargets(nodeId, edgeType);

    return where ? nodes.filter(where) : nodes;
  }

  existsBy(field, value) {
    if (this.rebuildIndexes) this._buildIndexes();

    // Fast path
    if (field === 'id') {
      return this._idIndex.has(String(value));
    }

    if (field === 'name') {
      return this._nameIndex.has(String(value).toLowerCase());
    }

    // Fallback
    for (const item of this._dataSource.getAll()) {
      if (item[field] === value) return true;
    }

    return false;
  }

  existsEdge(from, to, type) {
    // Use edge ID directly (fastest possible path)
    const edgeId = createEdgeId(from, type, to);
    return this._graph.getEdge(edgeId) != null;
  }

  getEdgesFrom(nodeId, type = null) {
    return this._graph.getEdges({from: nodeId, type: type})
  }

  getEdgesTo(nodeId, type = null) {
    return this._graph.getEdges({to: nodeId, type: type})
  }

  // =========================================================
  // Graph View
  // =========================================================

  getGraphView(layer) {
    const nodes = this.getByLayer(layer);

    const nodeIds = new Set(nodes.map(n => n.id));

    const edges = [];

    for (const node of nodes) {
      const outgoing = this.getOutgoing(node.id);

      for (const edge of outgoing) {
        if (!nodeIds.has(edge.to)) continue;
        edges.push(edge);
      }
    }

    return { nodes, edges };
  }

  // =========================================================
  // Traversals
  // =========================================================

  /**
   * DFS forward from startId along edges of the given type.
   * Returns all reachable nodes (including the start node) in visit order.
   * @param {string} startId
   * @param {string|null} edgeType
   * @returns {object[]}
   */
  traceForward(startId, edgeType = null) {
    const visited = new Set();
    const result  = [];

    const dfs = (id) => {
      if (visited.has(id)) return;
      visited.add(id);

      const node = this._graph.getNode(id);
      if (!node) return;

      result.push(node);

      for (const edge of this._graph.getOutgoing(id, edgeType)) {
        dfs(edge.to);
      }
    };

    dfs(startId);
    return result;
  }

  /**
   * Walk backward from startId following the first incoming edge of the
   * given type at each step. Returns the chain in root-first order.
   * @param {string} startId
   * @param {string|null} edgeType
   * @returns {object[]}
   */
  traceBackward(startId, edgeType = null) {
    const result  = [];
    const visited = new Set();
    let   current = this._graph.getNode(startId);

    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      result.push(current);

      const incoming = this._graph.getIncoming(current.id, edgeType);
      current = incoming.length ? this._graph.getNode(incoming[0].from) : null;
    }

    result.reverse();
    return result;
  }

  // ─── Cross-layer queries ──────────────────────────────────────────────────

  /**
   * Returns the config-layer definition node for a runtime execution instance.
   * Walks the INSTANCE_OF out-edge wired by GraphRecorder.
   * @param {string} nodeId — UUID of an execution-layer node.
   */
  getDefinition(nodeId) {
    const targets = this.getTargets(nodeId, EXECUTION_EDGE_TYPES.INSTANCE_OF);
    return targets[0] ?? null;
  }

  /**
   * Returns all runtime execution nodes that are instances of a config-layer
   * definition node.  Walks INSTANCE_OF in-edges.
   * @param {string} definitionId — id of a config-layer node.
   */
  getInstances(definitionId) {
    return this.getSources(definitionId, EXECUTION_EDGE_TYPES.INSTANCE_OF);
  }

  // ─── Domain-specific traversals ───────────────────────────────────────────

  /**
   * Forward execution chain from an execution node via EXECUTES edges.
   * Returns all descendants in visit order (DFS), including the start node.
   * @param {string} nodeId — UUID of an execution-layer node.
   */
  traceExecution(nodeId) {
    return this.traceForward(nodeId, EXECUTION_EDGE_TYPES.EXECUTES);
  }

  /**
   * Backward causality chain to an execution node via EXECUTES edges.
   * Returns [rootEvent, ..., node] — root-first order.
   * @param {string} nodeId — UUID of an execution-layer node.
   */
  traceCausality(nodeId) {
    return this.traceBackward(nodeId, EXECUTION_EDGE_TYPES.EXECUTES);
  }

  /**
   * Config path forward from a definition node via config-layer edges
   * (HANDLED_BY, GENERATES_ACTION, REDUCES_ACTION).  Uses null edge-type
   * filter which, starting from a config node, only reaches other config
   * nodes because execution edges are never outgoing from config nodes.
   * @param {string} definitionId — id of a config-layer node.
   */
  getConfigPath(definitionId) {
    return this.traceForward(definitionId, null);
  }

  /**
   * Compare the static config path of a definition against the actual causal
   * chain of a runtime instance.
   *
   * @param {string} definitionId — config-layer node id (e.g. an event node).
   * @param {string} instanceId   — execution-layer node UUID.
   * @returns {{ missing: string[], extra: string[] }}
   *   missing: config-node ids expected in the chain but absent from execution.
   *   extra:   definition ids that fired but are not in the config path.
   */
  diffExecution(definitionId, instanceId) {
    const configNodes = this.getConfigPath(definitionId);
    const configIds   = new Set(configNodes.map(n => n.id));

    const execChain  = this.traceCausality(instanceId);
    const execDefIds = new Set(
      execChain.map(n => n.definitionId).filter(Boolean)
    );

    return {
      missing: [...configIds].filter(id => !execDefIds.has(id)),
      extra:   [...execDefIds].filter(id => !configIds.has(id)),
    };
  }

  // =========================================================
  // Optimization
  // =========================================================

  _buildIndexes() {
    const all = this.getAll();

    // Clear BEFORE populating
    this._kindIndex.clear();
    this._layerIndex.clear();

    for (const item of all) {
      if (item.kind != null) {
        const key = String(item.kind);
        if (!this._kindIndex.has(key)) {
          this._kindIndex.set(key, []);
        }
        this._kindIndex.get(key).push(item);
      }

      if (item.layer != null) {
        const key = String(item.layer);
        if (!this._layerIndex.has(key)) {
          this._layerIndex.set(key, []);
        }
        this._layerIndex.get(key).push(item);
      }

    }
    super._buildIndexesFrom(all);
  }

  _extractKind(node) {
    if (!node) return null;

    if (node.op === 'eq' && node.field === 'kind') {
      return node.value;
    }

    if (node.conditions) {
      for (const c of node.conditions) {
        const k = this._extractKind(c);
        if (k) return k;
      }
    }

    if (node.condition) {
      return this._extractKind(node.condition);
    }

    return null;
  }

}
