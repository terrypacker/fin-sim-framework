/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { GraphBuilderController } from './graph-builder-controller.js';
import { GraphBuilderView }       from './graph-builder-view.js';

/**
 * GraphBuilderPresenter — the composition root for the event-graph editor.
 *
 * Creates GraphBuilderController and GraphBuilderView, wires view mutation
 * callbacks to controller operations, and exposes the public API that
 * BaseScenario expects:
 *
 *   registerEventCreatedListener(fn)
 *   registerHandlerCreatedListener(fn)
 *   registerActionCreatedListener(fn)
 *   registerReducerCreatedListener(fn)
 *   editNode(node)       — open the edit modal for a node
 *   createNode(kind, subtype) — create a new node and open the edit modal
 *
 * Graph node clicks are routed through `editNode`, which fires `onEditNode(node)`
 * so that the host (workbench-app.js) can open the appropriate modal.
 */
export class GraphBuilderPresenter {

  /**
   * @param {{
   *   graphRenderer:  import('../components/graph-renderer.js').GraphRenderer,
   *   eventService:   object,
   *   handlerService: object,
   *   actionService:  object,
   *   reducerService: object,
   *   onEditNode?:    function(node: object): void,
   * }}
   */
  constructor({ graphRenderer, eventService, handlerService, actionService, reducerService, onEditNode }) {
    this._controller    = new GraphBuilderController({ eventService, handlerService, actionService, reducerService });
    this._view          = new GraphBuilderView({ graphRenderer });
    this._graphRenderer = graphRenderer;

    /** Called whenever a node should be opened for editing (graph click or creation). */
    this.onEditNode = onEditNode ?? null;

    // Register the graph node-click listener so clicking a node opens its editor.
    this._graphRenderer.registerNodeClickListener((event, node) => this.editNode(node));

    // ── Wire view mutation callbacks → controller ─────────────────────────

    this._view.onDelete = (node) => {
      this._controller.deleteNode(node);
    };

    this._view.onFieldChange = (node, field, value) => {
      this._controller.updateNode(node, { [field]: value });
    };

    this._view.onLinkToggle = (node, selectedNode, kind, linkTo, isAdd) => {
      if (isAdd) this._controller.linkNodes(node, selectedNode, kind, linkTo);
      else       this._controller.unlinkNodes(node, selectedNode, kind, linkTo);
    };

    // For replace* operations the node instance changes, so re-open the modal
    // with the returned replacement node.
    this._view.onEventTypeChange = (nodeId, newClass) => {
      const updated = this._controller.replaceEvent(nodeId, newClass);
      this.editNode(updated);
    };

    this._view.onActionClassChange = (nodeId, newClass) => {
      const updated = this._controller.replaceAction(nodeId, newClass);
      this.editNode(updated);
    };

    this._view.onReducerTypeChange = (nodeId, newType) => {
      const updated = this._controller.replaceReducer(nodeId, newType);
      this.editNode(updated);
    };

    this._view.onHandlerClassChange = (nodeId, newClass) => {
      const updated = this._controller.replaceHandler(nodeId, newClass);
      this.editNode(updated);
    };

    this._view.onActionDefinitionAdd = (node, defData) => {
      this._controller.addActionDefinition(node, defData);
      this.editNode(node);
    };

    this._view.onActionDefinitionRemove = (node, defId) => {
      this._controller.removeActionDefinition(node, defId);
      this.editNode(node);
    };

    this._view.onActionDefinitionUpdate = (node, defId, field, value) => {
      if (this._controller.updateActionDefinition(node, defId, field, value)) {
        this.editNode(node);
      }
    };
  }

  // ── Public API ────────────────────────────────────────────────────────────

  registerEventCreatedListener(l)   { this._controller.registerEventCreatedListener(l); }
  registerHandlerCreatedListener(l) { this._controller.registerHandlerCreatedListener(l); }
  registerActionCreatedListener(l)  { this._controller.registerActionCreatedListener(l); }
  registerReducerCreatedListener(l) { this._controller.registerReducerCreatedListener(l); }

  /** Open the edit modal for a node. */
  editNode(node) {
    if (this.onEditNode) this.onEditNode(node);
  }

  /** Create a new node and return it (does NOT open modal — caller decides). */
  createNode(kind, subtype) {
    this._controller.notifyCreationRequested(kind, subtype);
    return this._controller.createNewNode(kind, subtype);
  }

  resetForReplay() {
    this._controller.resetForReplay();
  }

  // ── Delegating accessors (preserve backwards-compatibility for tests) ──────

  get eventNodeCreatedListeners()   { return this._controller.eventNodeCreatedListeners; }
  get handlerNodeCreatedListeners() { return this._controller.handlerNodeCreatedListeners; }
  get actionNodeCreatedListeners()  { return this._controller.actionNodeCreatedListeners; }
  get reducerNodeCreatedListeners() { return this._controller.reducerNodeCreatedListeners; }

  _notifyNodeCreationRequested(kind, subtype) {
    this._controller.notifyCreationRequested(kind, subtype);
  }

  deleteNode(node) {
    this._controller.deleteNode(node);
  }

  destroy() {
    this._view.destroy();
    this._graphRenderer.destroy();
  }
}
