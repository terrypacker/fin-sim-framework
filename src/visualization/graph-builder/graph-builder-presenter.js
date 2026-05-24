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
 *   editNode(node)
 *
 * Constructor signature matches the original ConfigBuilder so base-app.js and
 * any custom scenarios do not need to change.
 */
export class GraphBuilderPresenter {

  /**
   * @param {{
   *   graph:         import('../config-graph.js').ConfigGraph,
   *   builderCanvas: HTMLElement
   * }}
   */
  constructor({ graph, builderCanvas }) {
    this._controller = new GraphBuilderController({ graph });
    this._view       = new GraphBuilderView({ builderCanvas, graph });

    // Register the graph node-click listener so clicking a node opens its editor.
    graph.registerNodeClickListener((event, node) => this._view.editNode(node));

    // ── Wire view mutation callbacks → controller ─────────────────────────

    this._view.onCreationRequested = (kind, subtype) => {
      this._controller.notifyCreationRequested(kind, subtype);
    };

    this._view.onDelete = (node) => {
      this._controller.deleteNode(node);
      this._view.editNode(null);
    };

    this._view.onFieldChange = (node, field, value) => {
      this._controller.updateNode(node, { [field]: value });
    };

    this._view.onLinkToggle = (node, chipNode, kind, linkTo, isAdd) => {
      if (isAdd) this._controller.linkNodes(node, chipNode, kind, linkTo);
      else       this._controller.unlinkNodes(node, chipNode, kind, linkTo);
    };

    // For replaceAction/replaceReducer the node instance changes, so re-render
    // the full editor with the returned replacement node.
    this._view.onActionClassChange = (nodeId, newClass) => {
      const updated = this._controller.replaceAction(nodeId, newClass);
      this._view.editNode(updated);
    };

    this._view.onReducerTypeChange = (nodeId, newType) => {
      const updated = this._controller.replaceReducer(nodeId, newType);
      this._view.editNode(updated);
    };
  }

  // ── Public API (BaseScenario contract) ────────────────────────────────────

  registerEventCreatedListener(l)   { this._controller.registerEventCreatedListener(l); }
  registerHandlerCreatedListener(l) { this._controller.registerHandlerCreatedListener(l); }
  registerActionCreatedListener(l)  { this._controller.registerActionCreatedListener(l); }
  registerReducerCreatedListener(l) { this._controller.registerReducerCreatedListener(l); }

  /** Open the editor panel for a node.  Called by BaseScenario after creation. */
  editNode(node) { this._view.editNode(node); }

  // ── Delegating accessors (preserve backwards-compatibility for tests) ──────

  /** Direct access to the listener arrays for test assertions. */
  get eventNodeCreatedListeners()   { return this._controller.eventNodeCreatedListeners; }
  get handlerNodeCreatedListeners() { return this._controller.handlerNodeCreatedListeners; }
  get actionNodeCreatedListeners()  { return this._controller.actionNodeCreatedListeners; }
  get reducerNodeCreatedListeners() { return this._controller.reducerNodeCreatedListeners; }

  /** Used by tests that call the old private method name directly. */
  _notifyNodeCreationRequested(kind, subtype) {
    this._controller.notifyCreationRequested(kind, subtype);
  }

  /** Used by tests and custom scenarios that call deleteNode directly. */
  deleteNode(node) {
    this._controller.deleteNode(node);
    this._view.editNode(null);
  }
}
