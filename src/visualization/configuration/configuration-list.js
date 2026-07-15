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

const KIND_LABELS = {
  person:          'People',
  account:         'Accounts',
  'real-property': 'Real Property',
  collectible:     'Collectibles',
  company:         'Company Equity',
  bequest:         'Inheritance',
  event:           'Events',
  handler:         'Handlers',
  action:          'Actions',
  reducer:         'Reducers',
};

const KIND_SUBTITLES = {
  person:          (n) => n.citizen?.join('/') ?? '',
  account:         (n) => n.type ?? '',
  'real-property': (n) => [n.country, n.isPrimaryResidence ? 'Primary' : ''].filter(Boolean).join(' · '),
  collectible:     (n) => n.country ?? '',
  company:         (n) => n.country ?? '',
  bequest:         (n) => [n.decedentName, n.inheritanceYear ? `→ ${n.inheritanceYear}` : 'inert'].filter(Boolean).join(' '),
  event:           (n) => n.eventType ?? '',
  handler:         (n) => n.handlerClass ?? '',
  action:          (n) => n.actionClass  ?? '',
  reducer:         (n) => n.reducerType  ?? '',
};

/**
 * ConfigurationListComponent — left-panel Configuration group.
 *
 * Renders a kind dropdown, text filter, scrollable item list, and + Add button.
 * Queries all items via graphQueryApi.getByKind(selectedKind).
 *
 * Callbacks (set by WorkbenchApp):
 *   onItemClick(node)   — user clicked a list row
 *   onAddClick(kind)    — user clicked + Add
 */
export class ConfigurationListComponent extends BaseComponent {
  /**
   * @param {{
   *   parent?:       BaseComponent,
   *   container:     HTMLElement,
   *   graphQueryApi: import('../../graph/graph-query-api.js').GraphQueryApi,
   *   bus:           import('../../simulation-framework/event-bus.js').EventBus,
   * }}
   */
  constructor({ parent, container, graphQueryApi, bus }) {
    super({ parent });
    this._container     = container;
    this._graphQueryApi = graphQueryApi;
    this._selectedKind  = 'person';
    this._filter        = '';

    /** @type {function(node: object): void | null} */
    this.onItemClick = null;
    /** @type {function(kind: string): void | null} */
    this.onAddClick  = null;

    this._drainBus = this.busQueue(bus, 'SERVICE_ACTION', () => this.render());

    this._buildUI();
    this.render();
  }

  // ── Public ────────────────────────────────────────────────────────────────

  render() {
    this.scheduleRender(() => {
      this._drainBus();
      this._renderList();
    });
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _buildUI() {
    this._container.innerHTML = '';
    // Do NOT touch this._container.style.display — the group selector manages
    // visibility via inline display:none / '' and must not be overridden here.

    // Kind selector — node-field gives the right padding + select styling
    const kindField = document.createElement('div');
    kindField.className = 'node-field';
    kindField.style.padding = '4px';

    this._kindSelect = document.createElement('select');
    for (const [value, label] of Object.entries(KIND_LABELS)) {
      const opt       = document.createElement('option');
      opt.value       = value;
      opt.textContent = label;
      this._kindSelect.appendChild(opt);
    }
    this.listen(this._kindSelect, 'change', () => {
      this._selectedKind = this._kindSelect.value;
      this._addBtn.textContent = this._addLabel(this._selectedKind);
      this.render();
    });
    kindField.appendChild(this._kindSelect);
    this._container.appendChild(kindField);

    // Filter input — node-field applies input styling
    const filterField = document.createElement('div');
    filterField.className = 'node-field';
    filterField.style.padding = '0 4px 4px';

    this._filterInput = document.createElement('input');
    this._filterInput.placeholder = 'Filter by name…';
    this.listen(this._filterInput, 'input', () => {
      this._filter = this._filterInput.value.toLowerCase();
      this.render();
    });
    filterField.appendChild(this._filterInput);
    this._container.appendChild(filterField);

    // Scrollable list
    this._listEl = document.createElement('div');
    this._listEl.style.cssText = 'flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:2px;padding:4px;min-height:0;';
    this._container.appendChild(this._listEl);

    // Add button
    const addRow = document.createElement('div');
    addRow.style.padding = '4px';

    this._addBtn = document.createElement('button');
    this._addBtn.className   = 'btn btn-sm';
    this._addBtn.style.width = '100%';
    this._addBtn.textContent = this._addLabel('person');
    this.listen(this._addBtn, 'click', () => {
      if (this.onAddClick) this.onAddClick(this._selectedKind);
    });
    addRow.appendChild(this._addBtn);
    this._container.appendChild(addRow);
  }

  _addLabel(kind) {
    const label = KIND_LABELS[kind] ?? kind;
    // For multi-word labels (Real Property) keep as-is; for plural labels strip trailing 's'.
    if (label.includes(' ')) return `+ Add ${label}`;
    return `+ Add ${label.replace(/s$/, '')}`;
  }

  _renderList() {
    this._listEl.innerHTML = '';

    const items = this._graphQueryApi.getByKind(this._selectedKind)
      .filter(n => !this._filter || (n.name ?? '').toLowerCase().includes(this._filter));

    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className   = 'tl-empty';
      empty.textContent = 'No items';
      this._listEl.appendChild(empty);
      return;
    }

    for (const node of items) {
      const row = document.createElement('div');
      row.className = 'config-list-row';

      const nameEl = document.createElement('span');
      nameEl.className   = 'config-list-row__name';
      nameEl.textContent = node.name || node.id;

      const subtitle = KIND_SUBTITLES[this._selectedKind]?.(node);
      if (subtitle) {
        const sub = document.createElement('span');
        sub.className   = 'config-list-row__sub';
        sub.textContent = subtitle;
        row.append(nameEl, sub);
      } else {
        row.appendChild(nameEl);
      }

      this.listen(row, 'click', () => {
        if (this.onItemClick) this.onItemClick(node);
      });

      this._listEl.appendChild(row);
    }
  }
}
