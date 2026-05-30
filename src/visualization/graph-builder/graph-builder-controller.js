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
import { readThemeColor } from '../theme.js';

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

  constructor({ eventService, handlerService, actionService, reducerService}) {
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
    if (kind === 'event') this.eventNodeCreatedListeners.forEach(l => l(subtype));
    else if (kind === 'handler') this.handlerNodeCreatedListeners.forEach(l => l());
    else if (kind === 'action')  this.actionNodeCreatedListeners.forEach(l => l());
    else if (kind === 'reducer') this.reducerNodeCreatedListeners.forEach(l => l());
  }

  // ─── Creation handlers (called via ConfigBuilder "+" buttons) ───────────
  //
  // Each service create* call publishes CREATE on the bus.
  // SimulationSync's subscriber wires it into the sim.
  // ConfigBuilder's subscriber adds the node to the graph.
  // The only thing these handlers do explicitly is open the editor panel.

  createNewNode(kind, subtype) {
    if (kind === 'event') return this.eventCreationRequested(subtype);
    else if (kind === 'handler') return this.handlerCreationRequested(subtype)
    else if (kind === 'action')  return this.actionCreationRequested(subtype)
    else if (kind === 'reducer') return this.reducerCreationRequested(subtype);
  }

  eventCreationRequested(subtype) {
    const id = this.eventService.nextId();
    let event;
    if (subtype === 'OneOff') {
      event = this.eventService.createOneOffEvent({
        id: id,
        name: 'New One-Off Event',
        type: 'NEW_ONEOFF_' + id,
        date: new Date(), enabled: false,
        color: readThemeColor('--red'),
      });
    } else {
      event = this.eventService.createEventSeries({
        id: id,
        name: 'New Event Series',
        type: 'NEW_SERIES_' + id,
        interval: 'month-end', enabled: false,
        color: readThemeColor('--blue-muted'),
      });
    }
    return event;
  }

  handlerCreationRequested() {
    // null fn → uses HandlerEntry.defaultFunction which instantiates from generatedActionDefinitions
    return this.handlerService.createHandler(null, 'New Handler');
  }

  actionCreationRequested() {
    return this.actionService.createAmountAction('NEW_ACTION', 'New Action', 0);
  }

  reducerCreationRequested() {
    return this.reducerService.createFieldReducer('', 'New Reducer');
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
  }

  /**
   * Replace an event with a new instance of the given class.
   * Returns the new node so callers can re-render.
   */
  replaceEvent(nodeId, eventClass) {
    return this.eventService.replaceEvent(nodeId, eventClass);
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
    const generatedActionDefinitions = [...node.generatedActionDefinitions];
    generatedActionDefinitions.push(def);

    const generatedActionTypes = [...node.generatedActionTypes];
    if (!generatedActionTypes.includes(def.type)) {
      const actionNode = this.actionService.getByType(def.type);
      if (actionNode) {
        generatedActionTypes.push(def.type);
      }
    }
    this.updateNode(node, {
      generatedActionDefinitions: generatedActionDefinitions,
      generatedActionTypes: generatedActionTypes
    });
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
      const actionNode = this.actionService.getByType(def.type);
      if (actionNode) {
        //Update the item
        const generatedActionTypes = [...node.generatedActionTypes];
        const ti = generatedActionTypes.indexOf(def.type);
        if (ti >= 0) generatedActionTypes.splice(ti, 1);
        this.updateNode(node, {generatedActionTypes: generatedActionTypes});
      }
    }
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
   * @return {boolean} true to reload edit window
   */
  updateActionDefinition(node, defId, field, value) {
    const def = node.generatedActionDefinitions.find(d => d.id === defId);
    if (!def) return false;

    if (field === 'type') {
      const oldType = def.type;
      // Remove old type if no sibling def still uses it
      if (!node.generatedActionDefinitions.some(d => d !== def && d.type === oldType)) {
        this.removeActionDefinition(node, oldType);
      }

      // Register new type if not already present
      if (!node.generatedActionTypes.includes(value)) {
        this.addActionDefinition(node, value);
      }
      return false;
    } else {
      //We have no choice but to modify the definition in place, we
      // can't structured clone the def... but we want to notify everyone
      // that it was modified so we pass it through the service layer
      def.config[field] = value;
      const changes = {
        generatedActionDefinitions: node.generatedActionDefinitions
      };
      this.updateNode(node, changes);
      return false;
    }
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
  }

  // ── Configuration Lifecycle ─────────────────────────────
  /**
   * TODO Need to have a central location to reset the sim  See #348
   * Clear out any used meta and data from our nodes
   * - data.breakpointHit
   * - data.fired
   * - data.breakpoint
   */
  resetForReplay() {
    const data = {
      breakPointHit: false,
      fired: false,
      breakpoint: false,
      breakpointContext: null,
      stateChanges: []
    };
    this.eventService.updateAllData(data);
    this.handlerService.updateAllData(data);
    this.actionService.updateAllData(data);
    this.reducerService.updateAllData(data);
  }
}
