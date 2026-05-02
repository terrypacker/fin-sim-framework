/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ServiceRegistry } from '../../services/service-registry.js';

/**
 * GraphBuilderController — pure domain + graph-mutation layer.
 *
 * Owns:
 *  - ServiceRegistry calls (CRUD, replaceAction, replaceReducer)
 *  - Graph edge mutations (addEdge / removeEdge)
 *  - Canonical array sync (handledEvents, generatedActionTypes, reducedActionTypes)
 *  - Creation-listener arrays registered by BaseScenario
 *
 * No DOM.  Receives the graph for queries and mutations.
 * Services are resolved lazily via ServiceRegistry.getInstance() to match the
 * original pattern — the registry is always valid at time of call.
 */
export class GraphBuilderController {

  /** @param {{ graph: import('../config-graph.js').ConfigGraph }} */
  constructor({ graph }) {
    this._graph = graph;

    // Creation listener arrays — BaseScenario registers here so it can react
    // to the "+" toolbar buttons.
    this.eventNodeCreatedListeners   = [];
    this.handlerNodeCreatedListeners = [];
    this.actionNodeCreatedListeners  = [];
    this.reducerNodeCreatedListeners = [];
  }

  // ── Creation listener registration ────────────────────────────────────────

  registerEventCreatedListener(l)   { this.eventNodeCreatedListeners.push(l); }
  registerHandlerCreatedListener(l) { this.handlerNodeCreatedListeners.push(l); }
  registerActionCreatedListener(l)  { this.actionNodeCreatedListeners.push(l); }
  registerReducerCreatedListener(l) { this.reducerNodeCreatedListeners.push(l); }

  /** Dispatch a toolbar "+" click to the relevant listener array. */
  notifyCreationRequested(kind, subtype) {
    if      (kind === 'event')   this.eventNodeCreatedListeners.forEach(l => l(subtype));
    else if (kind === 'handler') this.handlerNodeCreatedListeners.forEach(l => l());
    else if (kind === 'action')  this.actionNodeCreatedListeners.forEach(l => l());
    else if (kind === 'reducer') this.reducerNodeCreatedListeners.forEach(l => l());
  }

  // ── Domain mutations ───────────────────────────────────────────────────────

  /**
   * Delete a node — calls the appropriate service so the bus fires and
   * SimulationSync + GraphSync clean up automatically.
   */
  deleteNode(node) {
    const { eventService, handlerService, actionService, reducerService } = ServiceRegistry.getInstance();
    if      (node.kind === 'event')   eventService.deleteEvent(node.id);
    else if (node.kind === 'handler') handlerService.deleteHandler(node.id);
    else if (node.kind === 'action')  actionService.deleteAction(node.id);
    else if (node.kind === 'reducer') reducerService.deleteReducer(node.id);
  }

  /**
   * Apply scalar field changes to a node via the appropriate service so the
   * bus fires and the simulation is re-wired.
   */
  updateNode(node, changes) {
    const { eventService, handlerService, actionService, reducerService } = ServiceRegistry.getInstance();
    if      (node.kind === 'event')   eventService.updateEvent(node.id, changes);
    else if (node.kind === 'handler') handlerService.updateHandler(node.id, changes);
    else if (node.kind === 'action')  actionService.updateAction(node.id, changes);
    else if (node.kind === 'reducer') reducerService.updateReducer(node.id, changes);
  }

  /**
   * Fire a no-op service update to notify the bus after a canonical array has
   * already been mutated in-place (chip toggle path).
   *
   * NOTE: The arrays are mutated before this call, so originalItem in the
   * ServiceActionEvent captures the post-mutation state.  This is preserved
   * behaviour from the original ConfigBuilder.
   */
  notifyChanged(node) {
    this.updateNode(node, {});
  }

  /**
   * Replace an action with a new instance of the given class.
   * Returns the new node so callers can re-render.
   */
  replaceAction(nodeId, actionClass) {
    return ServiceRegistry.getInstance().actionService.replaceAction(nodeId, actionClass);
  }

  /**
   * Replace a reducer with a new instance of the given type.
   * Returns the new node so callers can re-render.
   */
  replaceReducer(nodeId, reducerType) {
    return ServiceRegistry.getInstance().reducerService.replaceReducer(nodeId, reducerType);
  }

  // ── Graph edge mutations ───────────────────────────────────────────────────

  /** Add a graph edge and sync the canonical relationship array. */
  linkNodes(node, chipNode, kind, linkTo) {
    if (linkTo) this._graph.addEdge({ from: node.id, to: chipNode.id });
    else        this._graph.addEdge({ from: chipNode.id, to: node.id });
    this._syncCanonicalArrays(node, chipNode, kind, linkTo, 'add');
  }

  /** Remove a graph edge and sync the canonical relationship array. */
  unlinkNodes(node, chipNode, kind, linkTo) {
    if (linkTo) this._graph.removeEdge({ from: node.id, to: chipNode.id });
    else        this._graph.removeEdge({ from: chipNode.id, to: node.id });
    this._syncCanonicalArrays(node, chipNode, kind, linkTo, 'remove');
  }

  // ── Graph read queries (proxied for view use) ─────────────────────────────

  getNode(id)                      { return this._graph.getNode(id); }
  getKind(kind)                    { return this._graph.getKind(kind); }
  getNodeByType(kind, type)        { return this._graph.getNodeByType(kind, type); }
  getNodesToKindFromMe(node, kind) { return this._graph.getNodesToKindFromMe(node, kind); }
  getNodesFromKindToMe(node, kind) { return this._graph.getNodesFromKindToMe(node, kind); }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * Update the canonical relationship array on the domain object and notify
   * via notifyChanged() so the bus fires and SimulationSync re-wires the sim.
   *
   * handler ↔ event edges:   use object arrays (HandlerEntry.handledEvents holds event objects)
   * handler/reducer ↔ action: use type string arrays (generatedActionTypes / reducedActionTypes)
   */
  _syncCanonicalArrays(node, chipNode, kind, linkTo, op) {
    const add = op === 'add';

    // Object arrays (hold domain objects, keyed by .id)
    const syncObjArr = (arr, item) => {
      if (add) {
        if (!arr.some(n => n.id === item.id)) arr.push(item);
      } else {
        const i = arr.findIndex(n => n.id === item.id);
        if (i !== -1) arr.splice(i, 1);
      }
    };

    // Type string arrays (hold action type discriminators)
    const syncTypeArr = (arr, type) => {
      if (add) {
        if (!arr.includes(type)) arr.push(type);
      } else {
        const i = arr.indexOf(type);
        if (i !== -1) arr.splice(i, 1);
      }
    };

    if (node.kind === 'handler' && kind === 'event'   && !linkTo) { syncObjArr(node.handledEvents,          chipNode);       this.notifyChanged(node);     return; }
    if (node.kind === 'handler' && kind === 'action'  &&  linkTo) { syncTypeArr(node.generatedActionTypes,  chipNode.type);  this.notifyChanged(node);     return; }
    if (node.kind === 'reducer' && kind === 'action'  && !linkTo) { syncTypeArr(node.reducedActionTypes,    chipNode.type);  this.notifyChanged(node);     return; }
    if (node.kind === 'reducer' && kind === 'action'  &&  linkTo) { syncTypeArr(node.generatedActionTypes,  chipNode.type);  this.notifyChanged(node);     return; }
    if (node.kind === 'event'   && kind === 'handler' &&  linkTo) { syncObjArr(chipNode.handledEvents,      node);           this.notifyChanged(chipNode); return; }
    if (node.kind === 'action'  && kind === 'handler' && !linkTo) { syncTypeArr(chipNode.generatedActionTypes, node.type);   this.notifyChanged(chipNode); return; }
    if (node.kind === 'action'  && kind === 'reducer' &&  linkTo) { syncTypeArr(chipNode.reducedActionTypes,   node.type);   this.notifyChanged(chipNode); return; }
  }
}
