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
import { ActionDefinition } from '../../simulation-framework/actions.js';

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
  constructor({ graphRenderer, eventService, handlerService, actionService, reducerService}) {
    this._graphRenderer = graphRenderer;
    this.eventService = eventService;
    this.handlerService = handlerService;
    this.actionService = actionService;
    this.reducerService = reducerService;

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
    if      (node.kind === 'event')   this.eventService.deleteEvent(node.id);
    else if (node.kind === 'handler') this.handlerService.deleteHandler(node.id);
    else if (node.kind === 'action')  this.actionService.deleteAction(node.id);
    else if (node.kind === 'reducer') this.reducerService.deleteReducer(node.id);
    this._graphRenderer.render();
  }

  /**
   * Apply scalar field changes to a node via the appropriate service so the
   * bus fires and the simulation is re-wired.
   */
  updateNode(node, changes) {
    if      (node.kind === 'event')   this.eventService.updateEvent(node.id, changes);
    else if (node.kind === 'handler') this.handlerService.updateHandler(node.id, changes);
    else if (node.kind === 'action')  this.actionService.updateAction(node.id, changes);
    else if (node.kind === 'reducer') this.reducerService.updateReducer(node.id, changes);
    this._graphRenderer.render();
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
    return this.actionService.replaceAction(nodeId, actionClass);
  }

  /**
   * Replace a reducer with a new instance of the given type.
   * Returns the new node so callers can re-render.
   */
  replaceReducer(nodeId, reducerType) {
    return this.reducerService.replaceReducer(nodeId, reducerType);
  }

  /**
   * Replace a handler with a new instance of the given class.
   * Returns the new node so callers can re-render.
   */
  replaceHandler(nodeId, handlerClass) {
    return this.handlerService.replaceHandler(nodeId, handlerClass);
  }

  // ── ActionDefinition management ───────────────────────────────────────────

  /**
   * Add a new ActionDefinition to a handler or reducer.
   * Creates the definition from defData, pushes it into generatedActionDefinitions,
   * registers the type in generatedActionTypes, and wires the graph edge if the
   * corresponding action node already exists.
   *
   * @param {object} node     - Handler or reducer graph node
   * @param {object} defData  - { type, config: { actionClass, ...fields } }
   * @returns {ActionDefinition}
   */
  addActionDefinition(node, defData) {
    const def = new ActionDefinition({ type: defData.type, config: defData.config });
    node.generatedActionDefinitions.push(def);

    if (!node.generatedActionTypes.includes(def.type)) {
      node.generatedActionTypes.push(def.type);
      const actionNode = this._graphRenderer.getNodeByType('action', def.type);
      if (actionNode) this._graphRenderer.addEdge({ from: node.id, to: actionNode.id });
    }

    this.notifyChanged(node);
    return def;
  }

  /**
   * Remove an ActionDefinition from a handler or reducer by its id.
   * Cleans up generatedActionTypes and the graph edge when no other definition
   * in this node still uses that type.
   *
   * @param {object} node
   * @param {string} defId - ActionDefinition.id (UUID)
   */
  removeActionDefinition(node, defId) {
    const idx = node.generatedActionDefinitions.findIndex(d => d.id === defId);
    if (idx < 0) return;
    const [def] = node.generatedActionDefinitions.splice(idx, 1);

    const typeStillUsed = node.generatedActionDefinitions.some(d => d.type === def.type);
    if (!typeStillUsed) {
      const ti = node.generatedActionTypes.indexOf(def.type);
      if (ti >= 0) node.generatedActionTypes.splice(ti, 1);
      const actionNode = this._graphRenderer.getNodeByType('action', def.type);
      if (actionNode) this._graphRenderer.removeEdge({ from: node.id, to: actionNode.id });
    }

    this.notifyChanged(node);
  }

  /**
   * Update a single field on an ActionDefinition belonging to this node.
   *
   * When `field === 'type'`, the type discriminator is updated and
   * generatedActionTypes + graph edges are re-synced accordingly.
   * For all other fields, the value is written into def.config.
   *
   * @param {object} node
   * @param {string} defId
   * @param {string} field  - 'type' or a config key
   * @param {*}      value
   */
  updateActionDefinition(node, defId, field, value) {
    const def = node.generatedActionDefinitions.find(d => d.id === defId);
    if (!def) return;

    if (field === 'type') {
      const oldType = def.type;
      def.type = value;

      // Remove old type if no sibling def still uses it
      if (!node.generatedActionDefinitions.some(d => d !== def && d.type === oldType)) {
        const i = node.generatedActionTypes.indexOf(oldType);
        if (i >= 0) node.generatedActionTypes.splice(i, 1);
        const oldNode = this._graphRenderer.getNodeByType('action', oldType);
        if (oldNode) this._graphRenderer.removeEdge({ from: node.id, to: oldNode.id });
      }

      // Register new type if not already present
      if (!node.generatedActionTypes.includes(value)) {
        node.generatedActionTypes.push(value);
        const newNode = this._graphRenderer.getNodeByType('action', value);
        if (newNode) this._graphRenderer.addEdge({ from: node.id, to: newNode.id });
      }
    } else {
      def.config[field] = value;
    }

    this.notifyChanged(node);
  }

  // ── Graph edge mutations ───────────────────────────────────────────────────

  /** Add a graph edge and sync the canonical relationship array. */
  linkNodes(node, selectedNode, kind, linkTo) {
    switch(node.kind) {
      case 'event':
        if(selectedNode.kind === 'handler') {
          this.handlerService.linkEventToHandler(node.id, selectedNode.id);
        }
      break;
       case 'handler':
         if(selectedNode.kind === 'event'){
           this.handlerService.linkEventToHandler(selectedNode.id, node.id);
         }else if(selectedNode.kind === 'action') {
          this.handlerService.linkHandlerToAction(node.id, selectedNode.id);
        }
        break;
      case 'action':
        if(selectedNode.kind === 'handler'){
          this.handlerService.linkHandlerToAction(selectedNode.id, node.id);
        }else if(selectedNode.kind === 'reducer') {
          this.reducerService.linkReducesAction(node.id, selectedNode.id);
        }
        break;
      case 'reducer':
        if(selectedNode.kind === 'action') {
          this.reducerService.linkReducesAction(selectedNode.id, node.id);
        }
        break;
    }
  }

  /** Remove a graph edge and sync the canonical relationship array. */
  unlinkNodes(node, selectedNode, kind, linkTo) {
    switch(node.kind) {
      case 'event':
        if(selectedNode.kind === 'handler') {
          //Unlink event from handler
          this.handlerService.unlinkEventFromHandler(node.id, selectedNode.id);
        }
        break;
      case 'handler':
        if(selectedNode.kind === 'action') {
          //Unlink action from handler
          this.handlerService.unlinkHandlerFromAction(node.id, selectedNode.id);
        }else if(selectedNode.kind === 'event') {
          this.handlerService.unlinkEventFromHandler(selectedNode.id, node.id);
        }
        break;
      case 'action':
        if(selectedNode.kind === 'handler'){
          this.handlerService.unlinkHandlerFromAction(selectedNode.id, node.id);
        }else if(selectedNode.kind === 'reducer') {
          this.reducerService.unlinkReducesAction(node.id, selectedNode.id);
        }
        break;
      case 'reducer':
        if(selectedNode.kind === 'action') {
          this.reducerService.unlinkReducesAction(selectedNode.id, node.id);
        }
        break;
    }

    //TODO Doubt we nee this anymore
    //this._syncCanonicalArrays(node, selectedNode, kind, linkTo, 'remove');
  }

  // ── Graph read queries (proxied for view use) ─────────────────────────────
  //TODO Get rid of these..???
  getNode(id)                      { return this._graphRenderer.getNode(id); }
  getKind(kind)                    { return this._graphRenderer.getKind(kind); }
  getNodeByType(kind, type)        { return this._graphRenderer.getNodeByType(kind, type); }
  getNodesToKindFromMe(node, kind) { return this._graphRenderer.getNodesToKindFromMe(node, kind); }
  getNodesFromKindToMe(node, kind) { return this._graphRenderer.getNodesFromKindToMe(node, kind); }


  // ── Configuration Lifecycle ─────────────────────────────
  /**
   * Clear out any used meta and data from our nodes
   * - data.breakpointHit
   * - data.fired
   * - data.breakpoint
   */
  resetForReplay() {
    const data = {
      breakPointHit: false,
      fired: false,
      breakpoint: false
    };
    this.eventService.updateAllData(data);
    this.handlerService.updateAllData(data);
    this.actionService.updateAllData(data);
    this.reducerService.updateAllData(data);
  }
  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * Update the canonical relationship array on the domain object and notify
   * via notifyChanged() so the bus fires and SimulationSync re-wires the sim.
   *
   * handler ↔ event edges:   use object arrays (HandlerEntry.handledEvents holds event objects)
   * handler/reducer ↔ action: use type string arrays (generatedActionTypes / reducedActionTypes)
   */
  _syncCanonicalArrays(node, selectedNode, kind, linkTo, op) {
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

    if (node.kind === 'handler' && kind === 'event'   && !linkTo) { syncObjArr(node.handledEvents,          selectedNode);       this.notifyChanged(node);     return; }
    if (node.kind === 'handler' && kind === 'action'  &&  linkTo) { syncTypeArr(node.generatedActionTypes,  selectedNode.type);  this.notifyChanged(node);     return; }
    if (node.kind === 'reducer' && kind === 'action'  && !linkTo) { syncTypeArr(node.reducedActionTypes,    selectedNode.type);  this.notifyChanged(node);     return; }
    if (node.kind === 'reducer' && kind === 'action'  &&  linkTo) { syncTypeArr(node.generatedActionTypes,  selectedNode.type);  this.notifyChanged(node);     return; }
    if (node.kind === 'event'   && kind === 'handler' &&  linkTo) { syncObjArr(selectedNode.handledEvents,      node);           this.notifyChanged(chipNode); return; }
    if (node.kind === 'action'  && kind === 'handler' && !linkTo) { syncTypeArr(selectedNode.generatedActionTypes, node.type);   this.notifyChanged(chipNode); return; }
    if (node.kind === 'action'  && kind === 'reducer' &&  linkTo) { syncTypeArr(selectedNode.reducedActionTypes,   node.type);   this.notifyChanged(chipNode); return; }
  }
}
