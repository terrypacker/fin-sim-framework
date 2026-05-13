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
  PRIORITY,
  REDUCER_CLASSES,
  ScriptedReducer,
} from '../../simulation-framework/reducers.js';

import { FieldValueAction } from '../../simulation-framework/actions.js';
import { EDGE_TYPES } from '../../graph/edge.js';
import { ActionDefinitionList } from './action-definition-list.js';

export class ReducerEditor extends BaseNodeEditor {

  constructor(opts) {
    super(opts);

    this.REDUCER_TYPES = Object.keys(REDUCER_CLASSES);

    this.PRIORITY_OPTIONS = [
      { label: 'Pre-Process', value: PRIORITY.PRE_PROCESS },
      { label: 'Cash Flow', value: PRIORITY.CASH_FLOW },
      { label: 'Position Update', value: PRIORITY.POSITION_UPDATE },
      { label: 'Cost Basis', value: PRIORITY.COST_BASIS },
      { label: 'Tax Calc', value: PRIORITY.TAX_CALC },
      { label: 'Tax Apply', value: PRIORITY.TAX_APPLY },
      { label: 'Metrics', value: PRIORITY.METRICS },
      { label: 'Logging', value: PRIORITY.LOGGING },
    ];

    this.onReducerTypeChange = null;
  }

  render() {
    const node = this._node;

    const el = this._getTemplate('tpl-reducer-editor');

    el.querySelector('[data-id="description"]').innerText = node.getDescription();

    const name = el.querySelector('[data-id="name"]');
    name.value = node.name || '';
    this.bindInput(node, name, 'name');

    this.renderTypeSelect(
        el.querySelector('[data-id="type"]'),
        this.REDUCER_TYPES,
        node.reducerType || 'NoOpReducer',
        value => {
          if (this.onReducerTypeChange) {
            this.onReducerTypeChange(node.id, value);
          }
        }
    );

    const priority = el.querySelector('[data-id="priority"]');

    this.PRIORITY_OPTIONS.forEach(({ label, value }) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = `${label} (${value})`;
      priority.appendChild(opt);
    });

    priority.value = node.priority ?? PRIORITY.METRICS;

    this.bindSelect(node, priority, 'priority', v => parseInt(v, 10));

    this.renderConfig(node, el.querySelector('[data-id="config"]'), el);

    this.renderLinkableMultiSelect({
      node,
      kind: 'action',
      countSpan: el.querySelector('#reducer-reduced-actions-count'),
      container: el.querySelector('#reducer-reduced-actions'),
      linkTo: true,
      edgeType: EDGE_TYPES.REDUCES_ACTION,
    });

    const list = new ActionDefinitionList({
      parent: this,
      countSpan: el.querySelector('#reducer-generated-actions-count'),
      container: el.querySelector('#reducer-generated-actions'),
      node,
    });

    list.onAdd = (...args) => this.onActionDefinitionAdd?.(...args);
    list.onRemove = (...args) => this.onActionDefinitionRemove?.(...args);
    list.onUpdate = (...args) => this.onActionDefinitionUpdate?.(...args);

    list.render();

    this.mount(el);
  }

  renderConfig(node, container, parent) {
    container.innerHTML = '';

    let wrap;

    switch (node.reducerType) {
      case 'FieldReducer':
        wrap = this._getTemplate('tpl-field-reducer-editor');
        wrap.querySelector('[data-field="fieldName"]').value = node.fieldName || '';
        break;

      case 'FieldValueReducer':
      case 'NumericSumReducer':
      case 'ArrayReducer':
      case 'MultiplicativeReducer':
      case 'MetricReducer':
        wrap = this._getTemplate('tpl-field-value-reducer-editor');
        wrap.querySelector('[data-field="fieldName"]').value = node.fieldName || '';
        wrap.querySelector('[data-field="value"]').value = node.value ?? '';
        break;

      case 'AccountTransactionReducer':
        wrap = this._getTemplate('tpl-account-transaction-reducer-editor');
        wrap.querySelector('[data-field="accountKey"]').value = node.accountKey || '';
        break;

      case 'ScriptedReducer':
        wrap = this._getTemplate('tpl-scripted-reducer-editor');

        wrap.querySelector('[data-field="fieldName"]').value = node.fieldName || '';
        wrap.querySelector('[data-field="script"]').value = node.script || '';

        const btn = wrap.querySelector('.script-validate-button');

        this.listen(btn, 'click', () => {
          const resultDiv = wrap.querySelector('.code-test-result');

          try {
            const reducer = new ScriptedReducer(
                parent.querySelector('[data-id="name"]').value,
                parent.querySelector('[data-id="priority"]').value,
                wrap.querySelector('[data-field="fieldName"]').value,
                wrap.querySelector('[data-field="script"]').value,
            );

            const state = {};
            const action = new FieldValueAction('TEST', 'test action', 'field', 10);

            //Ensure the script compiles:
            new Function('state', 'action', 'date', reducer._script);

            const result = reducer.reduce(state, action, new Date());

            resultDiv.innerText = JSON.stringify(result, null, 2);
          } catch (e) {
            resultDiv.innerText = `Error: ${e.message}`;
          }

          resultDiv.style.display = 'block';
        });

        break;

      default:
        return;
    }

    wrap.querySelectorAll('input, textarea').forEach(el => {
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
