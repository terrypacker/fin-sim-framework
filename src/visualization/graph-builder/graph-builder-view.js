/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * GraphBuilderView — pure DOM / template layer for the event-graph editor.
 *
 * Creates and wires node editors (Event, Handler, Action, Reducer) for display
 * in a NodeEditModal.  Also manages the overlay toolbar "+" buttons on the graph.
 *
 * Communicates mutations outward via callback properties set by
 * GraphBuilderPresenter:
 *
 *   onFieldChange(node, field, value)       — any input changed
 *   onDelete(node)                          — Delete Node button
 *   onCreationRequested(kind, subtype)      — toolbar "+" button
 *   onLinkToggle(node, selectedItem, kind, linkTo, isAdd) — node link toggled
 *   onActionClassChange(nodeId, newClass)   — action class dropdown changed
 *   onReducerTypeChange(nodeId, newType)    — reducer type dropdown changed
 *   onHandlerClassChange(nodeId, newClass)  — handler class dropdown changed
 *
 * `createAndRenderEditor(node, container)` is the primary entry point called
 * by NodeEditModal to (re-)render the editor for a node into a given container.
 */

import { BaseComponent } from '../components/base-component.js';

import { EventEditor }   from '../components/event-editor.js';
import { HandlerEditor } from '../components/handler-editor.js';
import { ActionEditor }  from '../components/action-editor.js';
import { ReducerEditor } from '../components/reducer-editor.js';

export class GraphBuilderView extends BaseComponent {

  constructor({ graphRenderer }) {
    super();

    this._graphRenderer = graphRenderer;

    /** @type {function(node, field: string, value)|null} */
    this.onFieldChange = null;
    /** @type {function(node)|null} */
    this.onDelete = null;
    /** @type {function(node, chipNode, kind, linkTo: boolean, isAdd: boolean)|null} */
    this.onLinkToggle = null;
    /** @type {function(nodeId: string, newClass: string)|null} */
    this.onActionClassChange = null;
    /** @type {function(nodeId: string, newType: string)|null} */
    this.onReducerTypeChange = null;
    /** @type {function(nodeId: string, newClass: string)|null} */
    this.onHandlerClassChange = null;
    /** @type {function(node, defData: {type, config})|null} */
    this.onActionDefinitionAdd = null;
    /** @type {function(node, defId: string)|null} */
    this.onActionDefinitionRemove = null;
    /** @type {function(node, defId: string, field: string, value)|null} */
    this.onActionDefinitionUpdate = null;
    this.onEventTypeChange = null;
  }

  /**
   * Create, wire, and render an editor for `node` into `container`.
   * Returns the editor instance (so the caller can destroy it when done).
   * Returns null for unknown node kinds.
   */
  createAndRenderEditor(node, container) {
    if (!node) return null;

    const editor = this._createEditor(node, container);
    if (!editor) return null;

    this._wireEditor(editor);
    editor.render();
    return editor;
  }

  _createEditor(node, container) {
    const common = {
      parent: this,
      container,
      node,
      graphRenderer: this._graphRenderer,
    };

    switch (node.kind) {
      case 'event':   return new EventEditor(common);
      case 'handler': return new HandlerEditor(common);
      case 'action':  return new ActionEditor(common);
      case 'reducer': return new ReducerEditor(common);
      default:        return null;
    }
  }

  _wireEditor(editor) {
    editor.onFieldChange = (...args) => this.onFieldChange?.(...args);
    editor.onDelete      = (...args) => this.onDelete?.(...args);
    editor.onLinkToggle  = (...args) => this.onLinkToggle?.(...args);

    editor.onActionClassChange  = (...args) => this.onActionClassChange?.(...args);
    editor.onReducerTypeChange  = (...args) => this.onReducerTypeChange?.(...args);
    editor.onHandlerClassChange = (...args) => this.onHandlerClassChange?.(...args);
    editor.onEventTypeChange    = (...args) => this.onEventTypeChange?.(...args);

    editor.onActionDefinitionAdd    = (...args) => this.onActionDefinitionAdd?.(...args);
    editor.onActionDefinitionRemove = (...args) => this.onActionDefinitionRemove?.(...args);
    editor.onActionDefinitionUpdate = (...args) => this.onActionDefinitionUpdate?.(...args);
  }
}
