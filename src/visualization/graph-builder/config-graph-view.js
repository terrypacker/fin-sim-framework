/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseComponent }  from '../components/base-component.js';
import { GraphRenderer }  from '../components/graph-renderer.js';
import { BaseGraphView }  from './base-graph-view.js';

const KIND_OPTIONS = [
  ['',        'All Kinds'],
  ['event',   'Events'],
  ['handler', 'Handlers'],
  ['action',  'Actions'],
  ['reducer', 'Reducers'],
];

/**
 * ConfigGraphView — outer container for the config-graph panel.
 *
 * Creates GraphRenderer and BaseGraphView, builds the filter bar
 * (kind select + name input) above the graph canvas, and wires
 * filter changes through to BaseGraphView.setFilter().
 *
 * Exposes `this.graphRenderer` so GraphBuilderPresenter and
 * SimulationAnimator can receive it without knowing about the filter layer.
 */
export class ConfigGraphView extends BaseComponent {

  /**
   * Accepts the same args as GraphRenderer plus the usual parent.
   * @param {{
   *   parent?:                   BaseComponent,
   *   graph:                     import('../../graph/graph.js').Graph,
   *   graphQueryApi:             import('../../graph/graph-query-api.js').GraphQueryApi,
   *   graphRoot:                 HTMLElement,
   *   graphNodes:                HTMLElement,
   *   graphEdges:                SVGElement,
   *   nodeDetailsTemplate:       HTMLTemplateElement,
   *   displayNodeStateChanges?:  function,
   *   bus?:                      import('../../simulation-framework/event-bus.js').EventBus,
   *   layout?:                   object,
   * }}
   */
  constructor({
    parent,
    graph,
    graphQueryApi,
    graphRoot,
    graphNodes,
    graphEdges,
    nodeDetailsTemplate,
    displayNodeStateChanges,
    bus,
    layout,
  }) {
    super({ parent });

    this._graphQueryApi = graphQueryApi;
    this._selectedKind  = '';
    this._nameFilter    = '';

    this._buildFilterBar(graphRoot);

    this.graphRenderer = new GraphRenderer({
      parent: this,
      graph,
      graphQueryApi,
      graphRoot,
      graphNodes,
      graphEdges,
      nodeDetailsTemplate,
      displayNodeStateChanges,
      bus,
      layout,
    });

    this._baseGraphView = new BaseGraphView({
      graphRenderer: this.graphRenderer,
      graphQueryApi,
    });
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _buildFilterBar(graphRoot) {
    const panel = graphRoot.parentElement;

    // Make panel a flex column so the filter bar and graph stack vertically.
    panel.style.display       = 'flex';
    panel.style.flexDirection = 'column';

    // graphRoot must grow to fill remaining height instead of using 100%.
    graphRoot.style.height    = '';
    graphRoot.style.flex      = '1';
    graphRoot.style.minHeight = '0';

    const bar = document.createElement('div');
    bar.className = 'graph-filter-bar';

    // ── Kind select ────────────────────────────────────────────────────────
    const kindField = document.createElement('div');
    kindField.className = 'node-field';
    kindField.style.flex = '0 0 auto';

    const kindLabel = document.createElement('label');
    kindLabel.textContent = 'KIND';
    kindField.appendChild(kindLabel);

    this._kindSelect = document.createElement('select');
    for (const [value, label] of KIND_OPTIONS) {
      const opt       = document.createElement('option');
      opt.value       = value;
      opt.textContent = label;
      this._kindSelect.appendChild(opt);
    }
    this.listen(this._kindSelect, 'change', () => {
      this._selectedKind = this._kindSelect.value;
      this._applyFilter();
    });
    kindField.appendChild(this._kindSelect);

    // ── Name input ─────────────────────────────────────────────────────────
    const nameField = document.createElement('div');
    nameField.className = 'node-field';
    nameField.style.flex = '1';

    const nameLabel = document.createElement('label');
    nameLabel.textContent = 'NAME';
    nameField.appendChild(nameLabel);

    this._nameInput = document.createElement('input');
    this._nameInput.placeholder = 'Filter by name…';
    this.listen(this._nameInput, 'input', () => {
      this._nameFilter = this._nameInput.value.toLowerCase();
      this._applyFilter();
    });
    nameField.appendChild(this._nameInput);

    bar.append(kindField, nameField);
    panel.insertBefore(bar, graphRoot);
    this.onCleanup(() => bar.remove());
  }

  _applyFilter() {
    const kind = this._selectedKind;
    const name = this._nameFilter;

    if (!kind && !name) {
      this._baseGraphView.setFilter(null);
      return;
    }

    this._baseGraphView.setFilter(node => {
      if (kind && node.kind !== kind) return false;
      if (name && !(node.name ?? '').toLowerCase().includes(name)) return false;
      return true;
    });
  }
}
