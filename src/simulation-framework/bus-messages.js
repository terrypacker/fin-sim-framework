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

// ─── Execution message constants ─────────────────────────────────────────────

export const EXECUTION_KINDS = {
  EVENT:   'EVENT',
  HANDLER: 'HANDLER',
  ACTION:  'ACTION',
  REDUCER: 'REDUCER',
};

export const EXECUTION_PHASES = {
  BEGIN: 'BEGIN',
  END:   'END',
};

// ─── Legacy simulation bus message type constants ─────────────────────────────
// Removed in Phase 4 when simulation.js publish sites are rewritten.

export const SIMULATION_BUS_MESSAGES = {
  SCENARIO_READY:        'SCENARIO_READY',
  EVENT_OCCURRENCE_START: 'EVENT_OCCURRENCE_START',
  EVENT_OCCURRENCE_END:   'EVENT_OCCURRENCE_END',
  HANDLED_EVENT:          'HANDLED_EVENT',
  ACTION_INSTANCE:        'ACTION_INSTANCE',
  ACTION_RESULT:          'ACTION_RESULT',
  REDUCER_RESULT:         'REDUCER_RESULT',
  NODE_DATA_CHANGED:      'NODE_DATA_CHANGED',
  BREAKPOINT_HIT:         'BREAKPOINT_HIT',
};

// ─── Base ─────────────────────────────────────────────────────────────────────

/**
 * Base class for all messages published to the EventBus.
 *
 * type    — primary discriminator   (e.g. 'EXECUTION_BEGIN', 'SERVICE_ACTION')
 * subtype — secondary discriminator (e.g. 'BEGIN'|'END', 'CREATE'|'UPDATE'|'DELETE')
 * kind    — tertiary discriminator  (e.g. 'EVENT'|'HANDLER'|'ACTION'|'REDUCER')
 */
export class BusMessage {
  constructor({ type, subtype = null, kind = null, date }) {
    this.type    = type;
    this.subtype = subtype;
    this.kind    = kind;
    this.date    = date;
  }
}

/**
 * Base for messages that carry simulation context and optional state data.
 *
 * stateSnapshot — full structuredClone of state; attached only at EXECUTION_END (EVENT).
 * stateDiff     — array of {field, before, after, delta}; attached at EXECUTION_END (REDUCER)
 *                 and EXECUTION_END (EVENT). Populated in Phase 4+.
 */
export class SimulationBusMessage extends BusMessage {
  constructor({ type, subtype = null, kind = null, date, sim, payload, stateSnapshot = null, stateDiff = null }) {
    super({ type, subtype, kind, date });
    this.sim           = sim;
    this.payload       = payload;
    this.stateSnapshot = stateSnapshot;
    this.stateDiff     = stateDiff;
  }
}

// ─── New execution messages (Phase 4 will wire these into simulation.js) ──────

/**
 * Published at the start and end of every execution unit (event / handler / action / reducer).
 *
 * type        — 'EXECUTION_BEGIN' | 'EXECUTION_END'
 * kind        — EXECUTION_KINDS value
 * executionId — hierarchical path id, e.g. 'e1.1:h1.1:a1.1'
 * parentId    — parent segment of executionId, or null for root events
 * nodeId      — config-graph node id (e.g. 'e1', 'h2') — kept separate for perf
 * meta        — arbitrary metadata (reason, flags, etc.)
 * data        — payload-specific data for this execution unit
 * stateDiff   — populated at EXECUTION_END (REDUCER) and EXECUTION_END (EVENT)
 * stateSnapshot — full state clone, populated at EXECUTION_END (EVENT) only
 */
export class ExecutionBusMessage extends SimulationBusMessage {
  constructor({ phase, kind, executionId, parentId = null, nodeId, meta = null, data = null,
                date, sim, stateDiff = null, stateSnapshot = null }) {
    super({
      type:          `EXECUTION_${phase}`,
      subtype:       phase,
      kind,
      date,
      sim,
      payload:       { phase, kind, executionId, parentId, nodeId, meta, data },
      stateSnapshot,
      stateDiff,
    });
    this.executionId = executionId;
    this.parentId    = parentId;
    this.nodeId      = nodeId;
  }
}

// ─── Breakpoint control message ───────────────────────────────────────────────

/**
 * Published when execution pauses at a breakpoint.
 * Not routed through services — UI subscribes directly.
 * Not tracked in the execution graph.
 *
 * nodeId — config-graph node id of the paused node
 * kind   — 'event' | 'handler' | 'action' | 'reducer'
 * stage  — 'event:start' | 'handler:before' | 'action' | 'reducer:before'
 */
export class BreakpointHitMessage extends BusMessage {
  constructor({ date, nodeId, kind, stage }) {
    super({ type: 'BREAKPOINT_HIT', date });
    this.nodeId = nodeId;
    this.kind   = kind;
    this.stage  = stage;
  }
}

// ─── Service messages ─────────────────────────────────────────────────────────

/**
 * Published by service-layer CRUD operations.
 *
 * subtype      — 'CREATE' | 'UPDATE' | 'DELETE'  (authoritative field)
 * actionType   — alias for subtype; kept for backward compat, removed in Phase 8
 * item         — the item after the operation; use instanceof to identify type
 * originalItem — the item before the operation (null for CREATE)
 */
export class ServiceActionEvent extends BusMessage {
  constructor({ subtype, actionType, item, originalItem = null }) {
    const resolvedSubtype = subtype ?? actionType;
    super({ type: 'SERVICE_ACTION', subtype: resolvedSubtype });
    this.subtype      = resolvedSubtype;
    this.actionType   = resolvedSubtype;  // backward compat — removed in Phase 8
    this.item         = item;
    this.originalItem = originalItem;
  }
}

export class ServiceBulkActionEvent extends BusMessage {
  constructor({ actionType, changes }) {
    super({ type: 'SERVICE_BULK_ACTION', subtype: actionType });
    this.actionType = actionType;
    this.changes    = changes;
  }
}

/**
 * Published by base-service when a graph edge is added or removed.
 * Replaces the Graph edgeModificationWatcher pattern (Phase 8).
 *
 * subtype  — 'ADD' | 'REMOVE'
 * edge     — Edge instance (populated on ADD)
 * from     — source node id (populated on REMOVE)
 * to       — target node id (populated on REMOVE)
 * edgeType — EDGE_TYPES value (populated on REMOVE)
 */
export class ServiceEdgeActionEvent extends BusMessage {
  constructor({ subtype, edge = null, from = null, to = null, edgeType = null }) {
    super({ type: 'SERVICE_EDGE_ACTION', subtype });
    this.edge     = edge;
    this.from     = from;
    this.to       = to;
    this.edgeType = edgeType;
  }
}

// ─── Legacy execution messages ────────────────────────────────────────────────
// These remain until Phase 4 rewrites the publish sites in simulation.js.

export class NodeDataBusMessage extends SimulationBusMessage {
  constructor({ date, sim, payload, stateSnapshot, nodeId, kind, meta, data }) {
    super({ type: SIMULATION_BUS_MESSAGES.NODE_DATA_CHANGED, date, sim, payload, stateSnapshot });
    this.nodeId = nodeId;
    this.kind   = kind;
    this.meta   = meta;
    this.data   = data;
  }
}

export class BreakpointHitBusMessage extends SimulationBusMessage {
  constructor({ date, sim, payload, stateSnapshot }) {
    super({ type: SIMULATION_BUS_MESSAGES.BREAKPOINT_HIT, date, sim, payload, stateSnapshot });
  }
}

export class EventStartBusMessage extends SimulationBusMessage {
  constructor({ date, sim, payload, stateSnapshot }) {
    super({ type: SIMULATION_BUS_MESSAGES.EVENT_OCCURRENCE_START, date, sim, payload, stateSnapshot });
  }
}

export class EventEndBusMessage extends SimulationBusMessage {
  constructor({ date, sim, payload, stateSnapshot }) {
    super({ type: SIMULATION_BUS_MESSAGES.EVENT_OCCURRENCE_END, date, sim, payload, stateSnapshot });
  }
}

export class EventHandledMessage extends SimulationBusMessage {
  constructor({ date, sim, payload, stateSnapshot }) {
    super({ type: SIMULATION_BUS_MESSAGES.HANDLED_EVENT, date, sim, payload, stateSnapshot });
  }
}

export class ActionInstanceMessage extends BusMessage {
  constructor({ date, action }) {
    super({ type: SIMULATION_BUS_MESSAGES.ACTION_INSTANCE, date });
    this.action = action;
  }
}

export class ActionResultMessage extends SimulationBusMessage {
  constructor({ date, sim, payload, stateSnapshot }) {
    super({ type: SIMULATION_BUS_MESSAGES.ACTION_RESULT, date, sim, payload, stateSnapshot });
  }
}

export class ReducerResultMessage extends SimulationBusMessage {
  constructor({ date, sim, payload, stateSnapshot }) {
    super({ type: SIMULATION_BUS_MESSAGES.REDUCER_RESULT, date, sim, payload, stateSnapshot });
  }
}
