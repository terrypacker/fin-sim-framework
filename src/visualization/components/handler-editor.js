/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */
import { BaseNodeEditor } from './base-node-editor.js';
import { HANDLER_CLASSES } from '../../simulation-framework/handlers.js';
import { EDGE_TYPES } from '../../graph/edge.js';
import { ActionDefinitionList } from './action-definition-list.js';

export class HandlerEditor extends BaseNodeEditor {

  constructor(opts) {
    super(opts);

    this.HANDLER_TYPES = Object.keys(HANDLER_CLASSES);

    this.onHandlerClassChange = null;
  }

  render() {
    const node = this._node;

    const el = this._getTemplate('tpl-handler-editor');

    el.querySelector('[data-id="description"]').innerText = node.getDescription();

    this.renderTypeSelect(
        el.querySelector('[data-id="handlerClass"]'),
        this.HANDLER_TYPES,
        node.handlerClass || 'HandlerEntry',
        value => {
          if (this.onHandlerClassChange) {
            this.onHandlerClassChange(node.id, value);
          }
        }
    );

    const name = el.querySelector('[data-id="name"]');
    name.value = node.name || '';

    this.bindInput(node, name, 'name');

    this.renderLinkableMultiSelect({
      node,
      kind: 'event',
      countSpan: el.querySelector('#handler-event-count'),
      container: el.querySelector('#handler-events'),
      linkTo: true,
      edgeType: EDGE_TYPES.HANDLED_BY,
    });

    const list = new ActionDefinitionList({
      parent: this,
      countSpan: el.querySelector('#handler-action-count'),
      container: el.querySelector('#handler-actions'),
      node,
    });

    list.onAdd = (...args) => this.onActionDefinitionAdd?.(...args);
    list.onRemove = (...args) => this.onActionDefinitionRemove?.(...args);
    list.onUpdate = (...args) => this.onActionDefinitionUpdate?.(...args);

    list.render();

    this.mount(el);
  }
}
