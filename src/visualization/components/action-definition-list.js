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
    countSpan,
    container,
    node,
  }) {
    super({ parent });

    this._countSpan = countSpan;
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

    const declaredOnly = this._declaredOnlyActionTypes(this._node);
    if (declaredOnly.length > 0) {
      this._container.appendChild(this._renderDeclaredTypeBadges(declaredOnly));
    }

    const defCount  = (this._node.generatedActionDefinitions ?? []).length;
    const typeCount = this._undefinedActionTypeCount(this._node);
    this._countSpan.innerText = defCount + typeCount > 0
        ? `${defCount} defined, ${typeCount} declared`
        : '0 defined';

    this._container.appendChild(this._renderAddForm());
  }

  _renderItem(def) {
    const row = document.createElement('div');

    row.classList.add('action-definition-row')

    const typeInput = document.createElement('input');
    typeInput.className = 'form-control form-control-sm';
    typeInput.value = def.type || '';
    typeInput.placeholder = 'action type';
    typeInput.style.cssText = 'flex: .9; width: auto;'

    this.listen(typeInput, 'input', () => {
      if (this.onUpdate) {
        this.onUpdate(this._node, def.id, 'type', typeInput.value);
      }
    });

    row.appendChild(typeInput);

    // Editable config fields (value, name, key, fieldName, script, …) so the
    // emitted action can actually be configured here — not just its type.
    // actionClass is fixed by the template and internal (_-prefixed) keys are
    // not user-editable, so both are skipped.
    const config = def.config ?? {};
    for (const key of Object.keys(config)) {
      if (key === 'actionClass' || key.startsWith('_')) continue;
      row.appendChild(this._renderConfigField(def, key, config[key]));
    }

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-warn btn-sm';
    removeBtn.style.cssText = 'flex: .1';
    removeBtn.textContent = '✕';

    this.listen(removeBtn, 'click', () => {
      if (this.onRemove) {
        this.onRemove(this._node, def.id);
      }
    });

    row.appendChild(removeBtn);

    return row;
  }

  /**
   * Render a labelled input for one ActionDefinition config field.
   *
   * Numeric fields (those whose current value is a number, e.g. AmountAction's
   * `value`) are coerced back to a number on edit so the reducer reads a numeric
   * amount — unless the user types a `$`-expression, which is passed through as a
   * string for ActionDefinition.instantiate() to evaluate at runtime.
   *
   * @param {ActionDefinition} def
   * @param {string} key
   * @param {*} currentValue
   * @private
   */
  _renderConfigField(def, key, currentValue) {
    const wrap = document.createElement('label');
    wrap.className = 'action-definition-config';
    wrap.style.cssText = 'flex:.7;display:flex;flex-direction:column;font-size:10px;color:var(--muted,#888);';
    wrap.append(key);

    const input = document.createElement('input');
    input.className = 'form-control form-control-sm';
    input.value = currentValue ?? '';
    input.placeholder = key;

    const wasNumber = typeof currentValue === 'number';
    this.listen(input, 'input', () => {
      if (!this.onUpdate) return;
      const raw = input.value;
      const trimmed = raw.trim();
      const num = Number(trimmed);
      const coerced = (wasNumber && trimmed !== '' && !trimmed.startsWith('$') && Number.isFinite(num))
        ? num
        : raw;
      this.onUpdate(this._node, def.id, key, coerced);
    });

    wrap.appendChild(input);
    return wrap;
  }

  _renderAddForm() {
    const form = document.createElement('div');
    form.classList.add('action-definition-row')

    const select = document.createElement('select');
    select.className = 'form-select form-select-sm';

    ACTION_TEMPLATES.forEach(tpl => {
      const opt = document.createElement('option');
      opt.value = tpl.id;
      opt.textContent = tpl.label;
      select.appendChild(opt);
    });

    const typeInput = document.createElement('input');
    typeInput.className = 'form-control form-control-med';
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

  /**
   * Render a row of read-only type badges for action types that are declared in
   * handler/reducer code but have no ActionDefinition (not configurable via UI).
   */
  _renderDeclaredTypeBadges(types) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-bottom:6px;padding:6px;border:1px dashed var(--border,#ccc);border-radius:4px;';

    const label = document.createElement('span');
    label.textContent = 'Declared in code:';
    label.title = 'These action types are generated by handler/reducer logic and are not configurable here.';
    label.style.cssText = 'font-size:10px;color:var(--muted,#888);flex:0 0 auto;';
    wrap.appendChild(label);

    types.forEach(type => {
      const badge = document.createElement('span');
      badge.textContent = type;
      badge.title = 'Declared in handler/reducer code — not configurable via ActionDefinition';
      badge.classList.add('badge-green')
      wrap.appendChild(badge);
    });

    return wrap;
  }

  /**
   * Returns the set of action types in generatedActionTypes that have no
   * corresponding entry in generatedActionDefinitions (i.e. declared in code
   * but not configurable via the UI).
   */
  _declaredOnlyActionTypes(node) {
    const defs = node.generatedActionDefinitions ?? [];
    const defTypes = new Set(defs.map(d => d.type));
    return (node.generatedActionTypes ?? []).filter(t => !defTypes.has(t));
  }

  _undefinedActionTypeCount(node) {
    return this._declaredOnlyActionTypes(node).length;
  }
}
