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
import { GraphNodeFilterMultiSelect } from './graph-node-filter-multi-select.js';

export class BaseNodeEditor extends BaseComponent {

  constructor({
    parent,
    container,
    node,
    graphRenderer,
  }) {
    super({ parent });

    this._container = container;
    this._node = node;
    this._graphRenderer = graphRenderer;

    // shared callbacks
    this.onFieldChange = null;
    this.onDelete = null;
    this.onLinkToggle = null;
    this.onActionDefinitionAdd = null;
    this.onActionDefinitionRemove = null;
    this.onActionDefinitionUpdate = null;
  }

  render() {
    throw new Error('render() must be implemented');
  }

  mount(el) {
    this.destroy();

    this._rootEl = el;

    this.renderRoot(el);
    this.decorate(el);
  }

  destroy() {
    if (this._rootEl) {
      super.destroy();
      this._rootEl = null;
    }
  }


  renderRoot(el) {
    this._container.replaceChildren(el);
  }

  decorate(el) {
    this._container.appendChild(this._createDeleteButton());
  }

  bindInput(node, el, field, parser = v => v) {
    this.listen(el, 'input', () => {
      if (this.onFieldChange) {
        this.onFieldChange(node, field, parser(el.value));
      }
    });
  }

  bindCheckbox(node, el, field) {
    this.listen(el, 'input', () => {
      if (this.onFieldChange) {
        this.onFieldChange(node, field, el.checked);
      }
    });
  }

  bindSelect(node, el, field, parser = v => v) {
    this.listen(el, 'change', () => {
      if (this.onFieldChange) {
        this.onFieldChange(node, field, parser(el.value));
      }
    });
  }

  _createDeleteButton() {
    const wrap = document.createElement('div');
    wrap.className = 'node-field';

    const btn = document.createElement('button');
    btn.className = 'btn btn-warn btn-sm';
    btn.textContent = '✕ Delete Node';
    btn.style.width = '100%';

    this.listen(btn, 'click', () => {
      if (this.onDelete) this.onDelete(this._node);
    });

    wrap.appendChild(btn);
    return wrap;
  }

  renderTypeSelect(selectEl, knownTypes, currentValue, onChange) {
    if (!knownTypes.includes(currentValue)) {
      const span = document.createElement('span');
      span.className = 'type-badge type-badge--domain';
      span.title = 'Domain type — not editable via the graph builder';
      span.textContent = currentValue || '(unknown)';
      selectEl.replaceWith(span);
      return;
    }

    knownTypes.forEach(type => {
      const opt = document.createElement('option');
      opt.value = type;
      opt.textContent = type;
      selectEl.appendChild(opt);
    });

    selectEl.value = currentValue;

    this.listen(selectEl, 'change', () => {
      onChange(selectEl.value);
    });
  }

  renderLinkableMultiSelect({
    node,
    kind,
    countSpan,
    container,
    linkTo,
    edgeType,
  }) {
    const related = linkTo
        ? this._graphRenderer._graphQueryApi.getRelated(node.id, {
          edgeType,
          direction: 'in',
          where: n => n.kind === kind,
        })
        : this._graphRenderer._graphQueryApi.getRelated(node.id, {
          edgeType,
          direction: 'out',
          where: n => n.kind === kind,
        });

    const multi = new GraphNodeFilterMultiSelect({
      parent: this,
      container,
      countEl: countSpan,
      selectedItems: related,
      graphQueryApi: this._graphRenderer._graphQueryApi,
      // Restrict to config-layer nodes. Without the layer filter the picker also
      // lists every execution-layer runtime instance the recorder creates as the
      // sim steps (one per node per cycle), flooding the dropdown with repeated
      // entries. Linking only ever targets config nodes.
      defaultCondition: `kind=${kind} & layer=config`,
      onToggle: (selectedItem, toggleOn) => {
        if (this.onLinkToggle) {
          this.onLinkToggle(node, selectedItem, kind, linkTo, toggleOn);
        }
      }
    });

    return multi;
  }
}
