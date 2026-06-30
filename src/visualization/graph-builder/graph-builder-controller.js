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

    // Materialize a graph action node for this type (creating one if it doesn't
    // exist yet) so the generated action is visible in the graph and selectable
    // as a reducer input.
    const actionNode = this.actionService.ensureActionForType(def.type);

    // Link the definition to that node via _actionId so the runtime action it
    // emits carries the config-graph node id. Execution telemetry publishes that
    // id as nodeId (the #134 workaround in simulation.js), which is what lights
    // the action node up as "fired" — without it the action runs but the node
    // reports nodeId:null and never shows as fired. Mirrors ActionDefinition.fromAction.
    def.config = { ...def.config, _actionId: actionNode.id };

    const generatedActionDefinitions = [...node.generatedActionDefinitions, def];

    // Declare the type so updateNode's edge rebuild wires the handler/reducer →
    // action edge.
    const generatedActionTypes = [...node.generatedActionTypes];
    if (!generatedActionTypes.includes(def.type)) {
      generatedActionTypes.push(def.type);
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

  /** Add a link between two config nodes (direction-agnostic). */
  linkNodes(node, selectedNode, kind, linkTo) {
    this._syncLink(node, selectedNode, true);
  }

  /** Remove a link between two config nodes (direction-agnostic). */
  unlinkNodes(node, selectedNode, kind, linkTo) {
    this._syncLink(node, selectedNode, false);
  }

  /**
   * Add or remove a link by syncing the CANONICAL relationship array on the
   * owning node, then routing through the service update path. That update
   * rebuilds the graph edge (_rewireEdges) AND re-wires the running sim
   * (UPDATE → SimulationSync._applyHandlerChange / _applyReducerChange).
   *
   * The canonical arrays — not the raw graph edges — are what gets serialized
   * by toJSON and what drives runtime wiring (_wireHandler reads handledEvents;
   * _wireReducer reads reducedActionTypes). The previous implementation only
   * added/removed the graph edge, so hand-built links neither survived a reload
   * (toJSON saw empty arrays) nor executed (the sim never wired them) — the
   * event fired but nothing downstream ran.
   *
   * @param {object}  node          - the node being edited
   * @param {object}  selectedNode  - the node it is being linked to/from
   * @param {boolean} add           - true to link, false to unlink
   * @private
   */
  _syncLink(node, selectedNode, add) {
    // Resolve the pair by kind regardless of which end the drag started from.
    const byKind = { [node.kind]: node, [selectedNode.kind]: selectedNode };
    const { event, handler, action, reducer } = byKind;

    if (handler && event) {
      this._syncHandlerEvents(handler, event, add);
    } else if (handler && action) {
      this._syncHandlerActionTypes(handler, action, add);
    } else if (reducer && action) {
      this._syncReducerActionTypes(reducer, action, add);
    }
  }

  /** Sync an event into/out of a handler's handledEvents (event→handler edge). */
  _syncHandlerEvents(handler, event, add) {
    const events = [...(handler.handledEvents ?? [])];
    const idx = events.findIndex(e => e.id === event.id);
    if (add) { if (idx !== -1) return; events.push(event); }
    else     { if (idx === -1) return; events.splice(idx, 1); }
    this.handlerService.updateHandler(handler.id, { handledEvents: events });
  }

  /** Sync an action type into/out of a handler's generatedActionTypes (handler→action edge). */
  _syncHandlerActionTypes(handler, action, add) {
    const types = [...(handler.generatedActionTypes ?? [])];
    const idx = types.indexOf(action.type);
    if (add) { if (idx !== -1) return; types.push(action.type); }
    else     { if (idx === -1) return; types.splice(idx, 1); }
    this.handlerService.updateHandler(handler.id, { generatedActionTypes: types });
  }

  /** Sync an action type into/out of a reducer's reducedActionTypes (action→reducer edge). */
  _syncReducerActionTypes(reducer, action, add) {
    const types = [...(reducer.reducedActionTypes ?? [])];
    const idx = types.indexOf(action.type);
    if (add) { if (idx !== -1) return; types.push(action.type); }
    else     { if (idx === -1) return; types.splice(idx, 1); }
    this.reducerService.updateReducer(reducer.id, { reducedActionTypes: types });
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
