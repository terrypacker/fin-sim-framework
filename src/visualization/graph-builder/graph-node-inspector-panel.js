/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseComponent } from '../components/base-component.js';

/**
 * GraphNodeInspectorPanel — renders a node editor into the left-column EDIT
 * sub-tab instead of the modal overlay.
 *
 * Usage:
 *   panel.setEditorFactory((node, container) => editor);
 *   panel.open(node);   // creates editor, calls onShowTab, renders into container
 *   panel.clear();      // destroys editor, shows placeholder
 */
export class GraphNodeInspectorPanel extends BaseComponent {
  /**
   * @param {{
   *   container: HTMLElement,
   *   onShowTab?: function(): void,
   * }}
   */
  constructor({ container, onShowTab }) {
    super();
    this._container    = container;
    this._onShowTab    = onShowTab ?? null;
    this._editor       = null;
    this._editorFactory = null;
    this._renderPlaceholder();
  }

  setEditorFactory(factory) {
    this._editorFactory = factory;
  }

  open(node) {
    this._destroyEditor();
    if (!node || !this._editorFactory) {
      this._renderPlaceholder();
      return;
    }
    this._container.innerHTML = '';
    this._editor = this._editorFactory(node, this._container) ?? null;
    this._onShowTab?.();
  }

  clear() {
    this._destroyEditor();
    this._renderPlaceholder();
  }

  _destroyEditor() {
    this._editor?.destroy?.();
    this._editor = null;
    this._container.innerHTML = '';
  }

  _renderPlaceholder() {
    this._container.innerHTML =
      '<div style="padding:12px;color:var(--text-dim);font-size:12px">Select a node to edit</div>';
  }

  destroy() {
    this._destroyEditor();
  }
}
