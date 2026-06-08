/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { SimGraphNode } from '../graph/sim-graph-node.js';
import { EXECUTION_EDGE_TYPES } from './execution-graph.js';

/**
 * Records execution nodes and edges into the ExecutionGraph as the simulation
 * runs.  Called directly from simulation.js (not via bus) because SCHEDULES
 * and EMITS edges require internal execution context unavailable on the bus.
 *
 * Node IDs are UUIDs generated here (or provided by the caller for actions,
 * which already carry action.instanceId).  Execution nodes accumulate across
 * rewinds — they are never cleared.
 *
 * Silent mode: callers guard with `if (!this.silent)` before calling; the
 * recorder itself has no silent flag.
 */
export class GraphRecorder {
  constructor(executionGraph) {
    this._eg = executionGraph;
    this._nodeStack = [];        // UUIDs of currently-open execution nodes
    this._pendingSchedules = []; // { fromNodeId, targetDefinitionId, scheduledFor }
  }

  /**
   * Open a new execution node.
   *
   * @param {string|null} uuid          Use action.instanceId for action nodes;
   *                                    omit (null) for event/handler/reducer nodes
   *                                    (a fresh UUID is generated).
   * @param {string}      kind          'event'|'handler'|'action'|'reducer'
   * @param {string}      name          Human-readable label (event type, action type, …)
   * @param {string|null} definitionId  Config-graph node id (event.id, entry.id, …)
   * @param {string|null} parentNodeId  UUID of the enclosing execution node
   * @param {Date}        date          Current simulation date
   * @returns {string} UUID of the created node
   */
  beginNode({ uuid = null, kind, name, definitionId, parentNodeId, date }) {
    const id = uuid ?? crypto.randomUUID();

    const node = new SimGraphNode({
      id,
      kind,
      layer: 'execution',
      name: name ?? kind,
      definitionId: definitionId ?? null,
      timestamp: date,
    });

    this._eg.addNode(node);

    if (parentNodeId) {
      this._eg.addEdge(parentNodeId, id, EXECUTION_EDGE_TYPES.EXECUTES);
    }

    if (definitionId) {
      this._eg.addEdge(id, definitionId, EXECUTION_EDGE_TYPES.INSTANCE_OF);
    }

    this._nodeStack.push(id);
    return id;
  }

  /**
   * Close an execution node, optionally attaching state diff data.
   * Removes the node from the open-node stack.
   */
  endNode(uuid, { stateDiff = null } = {}) {
    const node = this._eg.getNode(uuid);
    if (node) {
      if (stateDiff !== null) node.meta = { ...node.meta, stateDiff };
    }
    const idx = this._nodeStack.lastIndexOf(uuid);
    if (idx !== -1) this._nodeStack.splice(idx, 1);
  }

  /**
   * Returns the UUID of the innermost currently-open execution node.
   * Used by recordPendingSchedule() to capture the SCHEDULES source.
   */
  getCurrentNodeId() {
    return this._nodeStack.at(-1) ?? null;
  }

  /**
   * Add an EMITS edge: reducerNode → actionNode.
   * Both nodes must already exist (action node was just created in _processActionQueue).
   */
  addEmitsEdge(reducerNodeId, actionNodeId) {
    this._eg.addEdge(reducerNodeId, actionNodeId, EXECUTION_EDGE_TYPES.EMITS);
  }

  /**
   * Store a pending SCHEDULES relationship.  Called from sim.schedule() while
   * inside a handler or reducer.  The target event's UUID doesn't exist yet;
   * it is resolved in resolvePendingSchedules() when the event fires.
   */
  recordPendingSchedule({ targetDefinitionId, scheduledFor }) {
    const fromNodeId = this.getCurrentNodeId();
    if (!fromNodeId) return;
    this._pendingSchedules.push({ fromNodeId, targetDefinitionId, scheduledFor });
  }

  /**
   * Resolve pending SCHEDULES entries whose target definition matches
   * `definitionId`.  Called from execute() when an event's node is created.
   */
  resolvePendingSchedules(definitionId, eventNodeId) {
    const remaining = [];
    for (const pending of this._pendingSchedules) {
      if (pending.targetDefinitionId === definitionId) {
        this._eg.addEdge(pending.fromNodeId, eventNodeId, EXECUTION_EDGE_TYPES.SCHEDULES);
      } else {
        remaining.push(pending);
      }
    }
    this._pendingSchedules = remaining;
  }
}
