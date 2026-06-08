/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseComponent }         from '../components/base-component.js';
import { EChartsGraphRenderer as GraphRenderer } from '../components/echarts-graph-renderer.js';
import { BaseGraphView }          from './base-graph-view.js';

const KIND_OPTIONS = [
  ['',        'All Kinds'],
  ['event',   'Events'],
  ['handler', 'Handlers'],
  ['action',  'Actions'],
  ['reducer', 'Reducers'],
];

const LAYER_OPTIONS = [
  ['both',      'Config + Execution'],
  ['config',    'Config Only'],
  ['execution', 'Execution Only'],
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
   * @param {{
   *   parent?:                   BaseComponent,
   *   graph:                     import('../../graph/graph.js').Graph,
   *   graphQueryApi:             import('../../graph/graph-query-api.js').GraphQueryApi,
   *   graphRoot:                 HTMLElement,
   *   displayNodeStateChanges?:  function,
   *   bus?:                      import('../../simulation-framework/event-bus.js').EventBus,
   *   layout?:                   object,
   *   displaySettings?:          import('../app-display-settings.js').AppDisplaySettings,
   * }}
   */
  constructor({
    parent,
    graph,
    graphQueryApi,
    graphRoot,
    displayNodeStateChanges,
    bus,
    layout,
    displaySettings,
  }) {
    super({ parent });

    this._graphQueryApi = graphQueryApi;
    this._selectedKind  = '';
    this._nameFilter    = '';
    this._layerMode     = 'both';
    this._firedOnly     = false;

    this._buildFilterBar(graphRoot);

    this.graphRenderer = new GraphRenderer({
      parent: this,
      graph,
      graphQueryApi,
      graphRoot,
      displayNodeStateChanges,
      bus,
      layout,
      displaySettings,
    });

    this._baseGraphView = new BaseGraphView({
      graphRenderer: this.graphRenderer,
      graphQueryApi,
    });
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _buildFilterBar(graphRoot) {
    const panel = graphRoot.parentElement;

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

    // ── Layer select ───────────────────────────────────────────────────────
    const layerField = document.createElement('div');
    layerField.className = 'node-field';
    layerField.style.flex = '0 0 auto';

    const layerLabel = document.createElement('label');
    layerLabel.textContent = 'LAYER';
    layerField.appendChild(layerLabel);

    this._layerSelect = document.createElement('select');
    for (const [value, label] of LAYER_OPTIONS) {
      const opt       = document.createElement('option');
      opt.value       = value;
      opt.textContent = label;
      this._layerSelect.appendChild(opt);
    }
    this.listen(this._layerSelect, 'change', () => {
      this._layerMode = this._layerSelect.value;
      this.graphRenderer.setLayerMode(this._layerMode);
    });
    layerField.appendChild(this._layerSelect);

    // ── Fired Only toggle ──────────────────────────────────────────────────────
    const firedField = document.createElement('div');
    firedField.className = 'node-field';
    firedField.style.flex = '0 0 auto';
    firedField.style.gap  = '4px';

    const firedLabel = document.createElement('label');
    firedLabel.textContent = 'FIRED ONLY';
    firedField.appendChild(firedLabel);

    this._firedCheck = document.createElement('input');
    this._firedCheck.type = 'checkbox';
    this.listen(this._firedCheck, 'change', () => {
      this._firedOnly = this._firedCheck.checked;
      this.graphRenderer.setFiredOnly(this._firedOnly);
      this._applyFilter();
    });
    firedField.appendChild(this._firedCheck);

    bar.append(kindField, nameField, layerField, firedField);
    panel.insertBefore(bar, graphRoot);
    this.onCleanup(() => bar.remove());
  }

  _applyFilter() {
    const kind      = this._selectedKind;
    const name      = this._nameFilter;
    const firedOnly = this._firedOnly;

    if (!kind && !name && !firedOnly) {
      this._baseGraphView.setFilter(null);
      return;
    }

    const renderer = this.graphRenderer;
    this._baseGraphView.setFilter(node => {
      if (kind && node.kind !== kind) return false;
      if (name && !(node.name ?? '').toLowerCase().includes(name)) return false;
      if (firedOnly && !renderer.getExecState(node.id)?.fired) return false;
      return true;
    });
  }
}
