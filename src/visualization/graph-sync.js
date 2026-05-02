/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HandlerEntry } from "../simulation-framework/handlers.js";
import {BaseEvent} from "../simulation-framework/events/base-event.js";
import {Action} from "../simulation-framework/actions.js";
import {Reducer} from "../simulation-framework/reducers.js";

/**
 * GraphSync subscribes to SERVICE_ACTION events on the shared bus and
 * keeps the ConfigGraph in sync with the service maps:
 *
 *   CREATE  — adds the new node to the graph with the correct kind/eventType
 *             decoration, then adds edges for handler.handledEvents,
 *             handler.generatedActions, reducer.reducedActions, and
 *             reducer.generatedActions.
 *   UPDATE  — merges position and visualization state from the existing node
 *             into the updated item, then replaces the node.  This preserves
 *             x/y, fired indicators, breakpoint flags, and state-change badges
 *             when replaceReducer / replaceAction creates a brand-new object.
 *   DELETE  — removes the node (and its incident edges) from the graph.
 *
 * One instance is created by BaseApp.buildScenario() after ConfigGraph
 * and ConfigBuilder are ready.  The bus is replaced on every
 * ServiceRegistry.reset(), so stale subscriptions are discarded automatically.
 */
export class GraphSync {
  /**
   * @param {{ graph: import('./config-graph.js').ConfigGraph,
   *           registry: { bus: import('../simulation-framework/event-bus.js').EventBus } }} opts
   */
  constructor({ graph, registry }) {
    this._graph = graph;
    registry.bus.subscribe('SERVICE_ACTION', (msg) => this._handleServiceAction(msg));
  }

  // ─── Bus dispatch ─────────────────────────────────────────────────────────

  /** @private */
  _handleServiceAction({ actionType, classType, item }) {
    if (actionType === 'CREATE') {
      this._handleCreate(classType, item);
    } else if (actionType === 'UPDATE') {
      this._handleUpdate(item);
    } else if (actionType === 'DELETE') {
      this._graph.removeNode(item.id);
    }
    this._graph.render();
  }

  // ─── CREATE ───────────────────────────────────────────────────────────────

  /** @private */
  _handleCreate(classType, item) {
    if (item instanceof BaseEvent) {
      // Events have no `get kind()` — set it as an own property
      if (!item.kind) item.kind = 'event';
      item.eventType = classType === 'EventSeries' ? 'Series' : 'OneOff';
      if (!this._graph.getNode(item.id)) {
        this._graph.addNode(item);
      }

    } else if (item instanceof HandlerEntry) {
      // HandlerEntry has get kind() { return 'handler'; }
      if (!this._graph.getNode(item.id)) {
        this._graph.addNode(item);
      }
      item.handledEvents.forEach(e => {
        if (this._graph.getNode(e.id)) {
          this._graph.addEdge({ from: e.id, to: item.id });
        }
      });
      item.generatedActions.forEach(a => {
        this._ensureActionNode(a);
        this._graph.addEdge({ from: item.id, to: a.id });
      });

    } else if (item instanceof Action) {
      this._ensureActionNode(item);

    } else if (item instanceof Reducer) {
      // Reducer has get kind() { return 'reducer'; }
      if (!this._graph.getNode(item.id)) {
        this._graph.addNode(item);
      }
      item.reducedActions.forEach(a => {
        this._ensureActionNode(a);
        this._graph.addEdge({ from: a.id, to: item.id });
      });
      if (item.generatedActions) {
        item.generatedActions.forEach(a => {
          this._ensureActionNode(a);
          this._graph.addEdge({ from: item.id, to: a.id });
        });
      }
    }
  }

  /**
   * Add an action node to the graph if it is not already present.
   * Action has get kind() { return 'action'; } so no kind decoration needed.
   * @private
   */
  _ensureActionNode(action) {
    if (!this._graph.getNode(action.id)) {
      this._graph.addNode(action);
    }
  }

  // ─── UPDATE ───────────────────────────────────────────────────────────────

  /**
   * Merge position and visualization state from the currently-displayed node
   * into the updated item before replacing it in the graph.
   *
   * When item === existing (normal service.updateX mutation) all assignments
   * are no-ops.  When item is a freshly-allocated replacement object (from
   * replaceReducer / replaceAction) this preserves the node's visual state.
   * @private
   */
  _handleUpdate(item) {
    const existing = this._graph.getNode(item.id);
    if (!existing) return; // not in graph yet — nothing to merge

    item.x            = existing.x;
    item.y            = existing.y;
    item.fired        = existing.fired;
    item.breakpoint   = existing.breakpoint ?? false;
    item.stateChanged = existing.stateChanged;
    item.stateChanges = existing.stateChanges;

    // Events have no `get kind()` — preserve own-property kind / eventType
    if (Object.prototype.hasOwnProperty.call(existing, 'kind') &&
        !Object.prototype.hasOwnProperty.call(item, 'kind')) {
      item.kind = existing.kind;
    }
    if (Object.prototype.hasOwnProperty.call(existing, 'eventType')) {
      item.eventType = existing.eventType;
    }

    this._graph.replaceNode(item.id, item);
  }
}
