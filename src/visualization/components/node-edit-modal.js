/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseComponent } from './base-component.js';

/**
 * NodeEditModal — generic modal overlay for editing any config-graph node.
 *
 * Usage:
 *   modal.setEditorFactory((node, container) => editor);
 *   modal.open(node);   // creates editor, shows overlay
 *   modal.close();      // destroys editor, removes overlay
 *
 * The editor factory creates, populates, and renders the appropriate editor
 * into `container`, then returns the editor instance so it can be destroyed
 * when the modal closes.
 */
export class NodeEditModal extends BaseComponent {
  constructor() {
    super();
    this._overlay = null;
    this._editor  = null;
    /** @type {function(node, container: HTMLElement): BaseComponent|null} */
    this._editorFactory = null;
  }

  setEditorFactory(factory) {
    this._editorFactory = factory;
  }

  open(node) {
    this.close();

    const overlay = document.createElement('div');
    overlay.className = 'sim-modal-overlay';
    this.listen(overlay, 'click', (e) => {
      if (e.target === overlay) this.close();
    });

    const modal = document.createElement('div');
    modal.className = 'sim-modal sim-modal--editor';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;flex-shrink:0';

    const title = document.createElement('span');
    title.style.cssText = 'font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;';
    title.textContent = node?.name || node?.id || 'Edit';

    const closeBtn = document.createElement('button');
    closeBtn.className   = 'btn btn-sm';
    closeBtn.textContent = '✕ Close';
    this.listen(closeBtn, 'click', () => this.close());

    header.append(title, closeBtn);

    const body = document.createElement('div');
    body.style.cssText = 'overflow-y:auto;flex:1;min-height:0;';

    modal.append(header, body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    this._overlay = overlay;

    if (this._editorFactory) {
      this._editor = this._editorFactory(node, body);
    }
  }

  close() {
    this._editor?.destroy();
    this._editor = null;
    this._overlay?.remove();
    this._overlay = null;
  }

  destroy() {
    this.close();
    super.destroy();
  }
}
