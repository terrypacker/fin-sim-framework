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
import { ACTION_TEMPLATES } from '../../simulation-framework/action-templates.js';

export class ActionDefinitionList extends BaseComponent {

  constructor({
    parent,
    container,
    node,
  }) {
    super({ parent });

    this._container = container;
    this._node = node;

    this.onAdd = null;
    this.onRemove = null;
    this.onUpdate = null;
  }

  render() {
    this._container.innerHTML = '';

    (this._node.generatedActionDefinitions ?? []).forEach(def => {
      this._container.appendChild(this._renderItem(def));
    });

    this._container.appendChild(this._renderAddForm());
  }

  _renderItem(def) {
    const row = document.createElement('div');

    row.style.cssText = `
      display:flex;
      flex-wrap:wrap;
      gap:4px;
      align-items:flex-start;
      margin-bottom:6px;
      padding:6px;
      border:1px solid var(--border,#ccc);
      border-radius:4px;
    `;

    const typeInput = document.createElement('input');
    typeInput.className = 'form-control form-control-sm';
    typeInput.value = def.type || '';
    typeInput.placeholder = 'action type';

    this.listen(typeInput, 'input', () => {
      if (this.onUpdate) {
        this.onUpdate(this._node, def.id, 'type', typeInput.value);
      }
    });

    row.appendChild(typeInput);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-warn btn-sm';
    removeBtn.textContent = '✕';

    this.listen(removeBtn, 'click', () => {
      if (this.onRemove) {
        this.onRemove(this._node, def.id);
      }
    });

    row.appendChild(removeBtn);

    return row;
  }

  _renderAddForm() {
    const form = document.createElement('div');
    form.style.cssText = 'display:flex;gap:4px;margin-top:4px';

    const select = document.createElement('select');
    select.className = 'form-select form-select-sm';

    ACTION_TEMPLATES.forEach(tpl => {
      const opt = document.createElement('option');
      opt.value = tpl.id;
      opt.textContent = tpl.label;
      select.appendChild(opt);
    });

    const typeInput = document.createElement('input');
    typeInput.className = 'form-control form-control-sm';
    typeInput.placeholder = 'action type';

    const btn = document.createElement('button');
    btn.className = 'btn btn-sm';
    btn.textContent = '+ Add';

    this.listen(btn, 'click', () => {
      const tpl = ACTION_TEMPLATES.find(t => t.id === select.value);

      if (!tpl || !typeInput.value.trim()) return;

      const defData = {
        type: typeInput.value.trim().toUpperCase().replace(/\s+/g, '_'),
        config: {
          actionClass: tpl.actionClass,
          ...tpl.defaultConfig,
        }
      };

      if (this.onAdd) {
        this.onAdd(this._node, defData);
      }

      typeInput.value = '';
    });

    form.appendChild(select);
    form.appendChild(typeInput);
    form.appendChild(btn);

    return form;
  }
}
