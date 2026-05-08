/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseComponent } from "./base-component.js";

/**
 * Base filter component for Graph Nodes with id, and name
 */
export class GraphNodeFilterMultiSelect extends BaseComponent {
  constructor({
    parent,
    container,
    countEl,
    selectedItems = [],
    onToggle,
    graphQueryApi,
    defaultCondition
  }) {
    super({ parent });
    this._container = container;
    this._countEl = countEl;
    this._selectedMap = new Map(selectedItems.map(i => [i.id, i]));
    this._onToggle = onToggle;
    this._graphQueryApi = graphQueryApi;
    this._defaultCondition = defaultCondition;

    //init fields
    this._input = null;
    this._list = null;
    this._dropdown = null;

    // internal state
    this._query = {
      query: this._defaultCondition,
      sort: [{ field: 'name', dir: 'asc' }],
      offset: 0,
      limit: 50
    }

    this._items = [];
    this._total = 0;
    this._loading = false;
    this._requestId = 0;

    // mount immediately
    this._mount();
  }

  _mount() {
    this._container.innerHTML = '';

    this._input = document.createElement('input');
    this._input.className = 'multi-select-input';
    this._input.placeholder = 'Select...';

    this._dropdown = document.createElement('div');
    this._dropdown.className = 'multi-select-dropdown';
    this._dropdown.style.position = 'fixed';
    this._dropdown.style.zIndex = 1000;
    this._dropdown.style.display = 'none';

    this._list = document.createElement('div');
    this._list.style.position = 'relative';

    this._dropdown.appendChild(this._list);
    document.body.appendChild(this._dropdown);
    this._container.appendChild(this._input);

    this._countEl.innerText = `${this._selectedMap.size} selected`;
    this._bindEvents();
  }

  _bindEvents() {
    this.listen(document, 'click', (e) => {
      const isInside =
          this._container.contains(e.target) ||
          this._dropdown.contains(e.target);

      if (!isInside) {
        this._dropdown.style.display = 'none';
      }
    });

    this.listen(window, 'resize', () => this._position());

    this.listen(this._dropdown, 'scroll', () => this._renderVisible());
    this.listen(this._dropdown, 'click', (e) => this._onClick(e));

    this._debouncedSearch = this.debounce(() => this._searchChanged(), 200);
    this.listen(this._input, 'input', this._debouncedSearch);

    this.listen(this._input, 'focus', () => this._open());

    this.append(document.body, this._dropdown);
  }

  _onClick(e) {
    const item = e.target.closest('.multi-select-item');
    if (!item) return;

    e.stopPropagation(); // Don't propagate this up to the document so our drop down stays open

    const id = item.dataset.id;
    const selectedItem = this._items.find(i => i.id === id);

    if (this._selectedMap.has(id)) {
      this._selectedMap.delete(id);
      this._onToggle(selectedItem, false);
    } else {
      this._selectedMap.set(id, selectedItem);
      this._onToggle(selectedItem, true);
    }

    this._renderVisible();
  }

  _open() {
    this._dropdown.style.display = 'block';

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this._position();
        this._fetchPage(true).then(r => this._renderVisible());
      });
    });
  }

  _position() {
    const rect = this._input.getBoundingClientRect();

    this._dropdown.style.left = `${rect.left}px`;
    this._dropdown.style.top = `${rect.bottom}px`;
    this._dropdown.style.width = `${rect.width}px`;
  }

  destroy() {
    document.removeEventListener('click', this._onDocClick);
    window.removeEventListener('scroll', this._onResize, true);
    window.removeEventListener('resize', this._onResize);

    this._input.removeEventListener('input', this._debouncedSearch);
    this._dropdown.removeEventListener('scroll', this._onScroll);
    this._dropdown.removeEventListener('click', this._onDropdownClick);

    this._dropdown.remove();
  }

  async _searchChanged() {
    if(this._defaultCondition) {
      if(this._input.value) {
        this._query.query = `${this._defaultCondition} & contains(name,${this._input.value})`;
      }else {
        this._query.query = `${this._defaultCondition}`;
      }
    }else {
      if(this._input.value) {
        this._query.query = `contains(name,${this._input.value})`;
      }else {
        this.query.query = '';
      }
    }
    this._fetchPage(true).then(r => this._renderVisible());
  }

  async _fetchPage(reset = false) {
    if (this._loading) return;

    this._loading = true;
    const reqId = ++this._requestId;
    const offset = reset ? 0 : this._items.length;

    const { items, total } = await this._graphQueryApi.search(this._query);
    if(reqId !== this._requestId) return;

    if (reset) {
      this._items = items;
    } else {
      this._items.push(...items);
    }

    this._total = total;
    this._loading = false;

    this._renderVisible();
  }

  _renderVisible() {
    const fragment = document.createDocumentFragment();

    this._items.forEach(opt => {
      const item = document.createElement('div');
      item.className = 'multi-select-item';
      item.dataset.id = opt.id;

      const isSelected = this._selectedMap.has(opt.id);
      if (isSelected) item.classList.add('selected');

      item.innerHTML = `
      <span>${opt.name}</span>
      <span>${isSelected ? '✓' : ''}</span>`;

      fragment.appendChild(item);
    });

    this._list.innerHTML = '';
    this._list.appendChild(fragment);

    this._countEl.innerText = `${this._selectedMap.size} selected`;
  }
}
