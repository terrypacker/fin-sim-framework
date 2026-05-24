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
import { EDGE_TYPES } from '../../graph/edge.js';

export class EventEditor extends BaseNodeEditor {

  constructor(opts) {
    super(opts);

    this.EVENT_TYPES = ['EventSeries', 'OneOffEvent'];
    this.EVENT_SERIES_TYPES = [
      'monthly',
      'quarterly',
      'annually',
      'month-end',
      'year-end'
    ];

    this.onEventTypeChange = null;
  }

  render() {
    const node = this._node;

    const el = this._getTemplate('tpl-event-editor');

    const name = el.querySelector('[data-id="name"]');
    name.value = node.name || '';
    this.bindInput(node, name, 'name');

    const typeSelect = el.querySelector('[data-id="type"]');

    this.EVENT_TYPES.forEach(type => {
      const opt = document.createElement('option');
      opt.value = type;
      opt.textContent = type;
      typeSelect.appendChild(opt);
    });

    typeSelect.value = node.eventType || 'EventSeries';

    this.listen(typeSelect, 'change', () => {
      if (this.onEventTypeChange) {
        this.onEventTypeChange(node.id, typeSelect.value);
      }
    });

    const color = el.querySelector('[data-field="color"]');
    color.value = node.color || '#888888';
    this.bindInput(node, color, 'color');

    const enabled = el.querySelector('[data-field="enabled"]');
    enabled.checked = node.enabled || false;
    this.bindCheckbox(node, enabled, 'enabled');

    this.renderConfig(node, el.querySelector('[data-id="config"]'));

    this.renderLinkableMultiSelect({
      node,
      kind: 'handler',
      countSpan: el.querySelector('#event-handler-count'),
      container: el.querySelector('#event-handlers'),
      linkTo: false,
      edgeType: EDGE_TYPES.HANDLED_BY,
    });

    this.mount(el);
  }

  renderConfig(node, container) {
    container.innerHTML = '';

    let wrap;

    switch (node.eventType) {
      case 'EventSeries':
        wrap = this._getTemplate('tpl-event-series-editor');

        const interval = wrap.querySelector('[data-field="interval"]');

        this.EVENT_SERIES_TYPES.forEach(type => {
          const opt = document.createElement('option');
          opt.value = type;
          opt.textContent = type;
          interval.appendChild(opt);
        });

        interval.value = node.interval || '';

        wrap.querySelector('[data-field="startOffset"]').value = node.startOffset ?? 0;
        break;

      case 'OneOffEvent':
        wrap = this._getTemplate('tpl-event-one-off-editor');
        wrap.querySelector('[data-field="date"]').valueAsDate = node.date || new Date();
        break;

      default:
        return;
    }

    wrap.querySelectorAll('input, select').forEach(input => {
      this.listen(input, 'input', () => {
        let value;

        if (input.type === 'checkbox') value = input.checked;
        else if (input.type === 'date') value = input.valueAsDate;
        else if (input.type === 'number') value = parseInt(input.value, 10);
        else value = input.value;

        if (this.onFieldChange) {
          this.onFieldChange(node, input.dataset.field, value);
        }
      });
    });

    container.appendChild(wrap);
  }
}
