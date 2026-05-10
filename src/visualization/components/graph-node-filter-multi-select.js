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
import {MapFilterMultiSelect} from "./map-filter-multi-select.js";

/**
 * Base filter component for Graph Nodes with id, and name
 */
export class GraphNodeFilterMultiSelect extends MapFilterMultiSelect {
  constructor({
    parent,
    container,
    countEl,
    selectedItems = [],
    onToggle,
    graphQueryApi,
    defaultCondition
  }) {
    super({ parent, container, selectedItems, onToggle, queryApi: graphQueryApi, defaultCondition});
    this._countEl = countEl;
    this._mountLocal();
  }

  _mountLocal() {
    this._countEl.innerText = `${this._selectedMap.size} selected`;
  }

  onRenderVisible() {
    this._countEl.innerText = `${this._selectedMap.size} selected`;
  }
}
