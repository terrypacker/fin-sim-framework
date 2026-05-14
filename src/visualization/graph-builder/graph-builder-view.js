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
 * GraphBuilderView — pure DOM / template layer for the event-graph editor panel.
 *
 * Renders all node editors (Event, Handler, Action, Reducer) and the toolbar
 * "+" buttons.  Contains no ServiceRegistry calls.
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
 * `editNode(node)` is the primary entry point called by the Presenter to
 * (re-)render the editor panel for a node.
 */

import { BaseComponent } from '../components/base-component.js';

import { EventEditor } from '../components/event-editor.js';
import { HandlerEditor } from '../components/handler-editor.js';
import { ActionEditor } from '../components/action-editor.js';
import { ReducerEditor } from '../components/reducer-editor.js';

export class GraphBuilderView extends BaseComponent {

  constructor({
    builderCanvas,
    graphRenderer,
  }) {
    super();

    this._canvas = builderCanvas;
    this._graphRenderer = graphRenderer;

    /** @type {function(node, field: string, value)|null} */
    this.onFieldChange = null;
    /** @type {function(node)|null} */
    this.onDelete = null;
    /** @type {function(kind: string, subtype: string|null)|null} */
    this.onCreationRequested = null;
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

    this._buildControls();
  }

  editNode(node) {
    this._editor?.destroy();
    this._canvas.innerHTML = '';

    if (!node) {
      this._canvas.appendChild(
          this._getTemplate('tpl-empty')
      );
      return;
    }

    this._editor = this._createEditor(node);

    if (!this._editor) {
      this._canvas.innerHTML = `<div class="tl-empty">Unknown node type</div>`;
      return;
    }

    this._wireEditor(this._editor);

    this._editor.render();
  }

  _createEditor(node) {
    const common = {
      parent: this,
      container: this._canvas,
      node,
      graphRenderer: this._graphRenderer,
    };

    switch (node.kind) {
      case 'event':
        return new EventEditor(common);

      case 'handler':
        return new HandlerEditor(common);

      case 'action':
        return new ActionEditor(common);

      case 'reducer':
        return new ReducerEditor(common);

      default:
        return null;
    }
  }

  _wireEditor(editor) {
    editor.onFieldChange = (...args) => this.onFieldChange?.(...args);
    editor.onDelete = (...args) => this.onDelete?.(...args);
    editor.onLinkToggle = (...args) => this.onLinkToggle?.(...args);

    editor.onActionClassChange = (...args) => this.onActionClassChange?.(...args);
    editor.onReducerTypeChange = (...args) => this.onReducerTypeChange?.(...args);
    editor.onHandlerClassChange = (...args) => this.onHandlerClassChange?.(...args);
    editor.onEventTypeChange = (...args) => this.onEventTypeChange?.(...args);

    editor.onActionDefinitionAdd = (...args) => this.onActionDefinitionAdd?.(...args);
    editor.onActionDefinitionRemove = (...args) => this.onActionDefinitionRemove?.(...args);
    editor.onActionDefinitionUpdate = (...args) => this.onActionDefinitionUpdate?.(...args);
  }

  _buildControls() {
    const wrapper = this._graphRenderer.graphRoot.parentElement;

    if (!wrapper || this._controlsEl) return;

    wrapper.style.position = 'relative';

    this._controlsEl = document.createElement('div');

    this._controlsEl.style.cssText = `
      position:absolute;
      top:8px;
      right:8px;
      z-index:10;
      display:flex;
      gap:6px;
    `;

    [
      ['+ Series', 'event', 'Series'],
      ['+ One-Off', 'event', 'OneOff'],
      ['+ Handler', 'handler', null],
      ['+ Action', 'action', null],
      ['+ Reducer', 'reducer', null],
    ].forEach(([label, kind, subtype]) => {
      const btn = document.createElement('button');

      btn.className = 'btn btn-sm';
      btn.textContent = label;

      this.listen(btn, 'click', () => {
        if (this.onCreationRequested) {
          this.onCreationRequested(kind, subtype);
        }
      });

      this._controlsEl.appendChild(btn);
    });

    const fitBtn = document.createElement('button');
    fitBtn.className = 'btn btn-sm';
    fitBtn.textContent = 'Fit';

    this.listen(fitBtn, 'click', () => {
      this._graphRenderer.fitToView();
    });

    this._controlsEl.appendChild(fitBtn);

    wrapper.appendChild(this._controlsEl);
  }
}
