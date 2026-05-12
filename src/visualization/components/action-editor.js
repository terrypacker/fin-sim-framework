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
import {
  ACTION_CLASSES,
  FieldValueAction,
  ScriptedAction,
} from '../../simulation-framework/actions.js';

import { EDGE_TYPES } from '../../graph/edge.js';
import { OneOffEvent } from '../../simulation-framework/events/one-off-event.js';

export class ActionEditor extends BaseNodeEditor {

  constructor(opts) {
    super(opts);

    this.ACTION_TYPES = Object.keys(ACTION_CLASSES);

    this.onActionClassChange = null;
  }

  render() {
    const node = this._node;

    const el = this._getTemplate('tpl-action-editor');

    const name = el.querySelector('[data-id="name"]');
    name.value = node.name || '';
    this.bindInput(node, name, 'name');

    const type = el.querySelector('[data-id="type"]');
    type.value = node.type || '';
    this.bindInput(node, type, 'type');

    const cls = el.querySelector('[data-id="actionClass"]');

    this.ACTION_TYPES.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      cls.appendChild(opt);
    });

    cls.value = node.actionClass || 'Action';

    this.listen(cls, 'change', () => {
      if (this.onActionClassChange) {
        this.onActionClassChange(node.id, cls.value);
      }
    });

    this.renderConfig(node, el.querySelector('[data-id="config"]'), el);

    this.renderLinkableMultiSelect({
      node,
      kind: 'handler',
      countSpan: el.querySelector('#action-handler-count'),
      container: el.querySelector('#action-handlers'),
      linkTo: true,
      edgeType: EDGE_TYPES.GENERATES_ACTION,
    });

    this.renderLinkableMultiSelect({
      node,
      kind: 'reducer',
      countSpan: el.querySelector('#action-reducer-count'),
      container: el.querySelector('#action-reducers'),
      linkTo: false,
      edgeType: EDGE_TYPES.REDUCES_ACTION,
    });

    this.mount(el);
  }

  renderConfig(node, container, parent) {
    container.innerHTML = '';

    let wrap = null;

    switch (node.actionClass) {
      case 'AmountAction':
        wrap = this._getTemplate('tpl-amount-action-editor');
        wrap.querySelector('[data-field="value"]').value = node.value ?? 0;
        break;

      case 'FieldAction':
        wrap = this._getTemplate('tpl-field-action-editor');
        wrap.querySelector('[data-field="fieldName"]').value = node.fieldName || '';
        break;

      case 'FieldValueAction':
        wrap = this._getTemplate('tpl-field-value-action-editor');
        wrap.querySelector('[data-field="fieldName"]').value = node.fieldName || '';
        wrap.querySelector('[data-field="value"]').value = node.value ?? '';
        break;

      case 'ScriptedAction':
        wrap = this._getTemplate('tpl-scripted-action-editor');

        wrap.querySelector('[data-field="fieldName"]').value = node.fieldName || '';
        wrap.querySelector('[data-field="script"]').value = node.script || '';

        const btn = wrap.querySelector('.script-validate-button');

        this.listen(btn, 'click', () => {
          const resultDiv = wrap.querySelector('.code-test-result');

          try {
            const scriptAction = new ScriptedAction(
                parent.querySelector('[data-id="type"]').value,
                parent.querySelector('[data-id="name"]').value,
                wrap.querySelector('[data-field="fieldName"]').value,
                wrap.querySelector('[data-field="script"]').value,
            );

            const state = {};
            const now = new Date();

            const sourceEvent = new OneOffEvent({
              id: 'id',
              name: 'event name',
              type: 'ONE_OFF_TYPE',
              enabled: true,
              date: now,
            });

            const handlerContext = {
              event: sourceEvent,
              handlerIdx: 'h1',
              stateBefore: {},
            };

            //First compile it, collect the error message
            const _fn = new Function('state', 'date', 'sourceEvent', 'handlerContext', 'me', scriptAction.script);

            const result = scriptAction.transform(state, {
              date: now,
              sourceEvent,
              handlerContext,
            });

            resultDiv.innerText = JSON.stringify(result, null, 2);
          } catch (e) {
            resultDiv.innerText = `Error: ${e.message}`;
          }

          resultDiv.style.display = 'block';
        });

        break;
    }

    if (!wrap) return;

    wrap.querySelectorAll('input, textarea, select').forEach(el => {
      this.listen(el, 'input', () => {
        const field = el.dataset.field;

        const value = field === 'value'
            ? (el.value === '' ? null : parseFloat(el.value))
            : el.value;

        if (this.onFieldChange) {
          this.onFieldChange(node, field, value);
        }
      });
    });

    container.appendChild(wrap);
  }
}
