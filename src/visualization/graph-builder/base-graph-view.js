/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * BaseGraphView — controller layer between a filter state and GraphRenderer.
 *
 * Owns:
 *   - The active filter function that decides which nodes are visible
 *   - getVisibleNodes() / getVisibleEdges() based on that filter
 *   - The data provider hook injected into GraphRenderer
 *
 * No DOM.  Delegates all rendering to the GraphRenderer it receives.
 * ConfigGraphView builds on top of this to add the filter-bar UI.
 *
 * Usage:
 *   const view = new BaseGraphView({ graphRenderer, graphQueryApi });
 *   view.setFilter(node => node.kind === 'event');
 */
export class BaseGraphView {

  /**
   * @param {{
   *   graphRenderer: import('../components/echarts-graph-renderer.js').EChartsGraphRenderer,
   *   graphQueryApi: import('../../graph/graph-query-api.js').GraphQueryApi,
   *   layer?:        string,   // graph layer to query — defaults to 'config'
   * }}
   */
  constructor({ graphRenderer, graphQueryApi, layer = 'config' }) {
    this._graphRenderer = graphRenderer;
    this._graphQueryApi = graphQueryApi;
    this._layer         = layer;
    this._filterFn      = () => true;

    graphRenderer.setGraphDataProvider(() => this._getFilteredData());
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Replace the active filter and trigger a relayout + render.
   * Pass null to show all nodes.
   * @param {function(node: object): boolean | null} fn
   */
  setFilter(fn) {
    this._filterFn = fn ?? (() => true);
    this._graphRenderer._relayoutAll();
    this._graphRenderer.render();
  }

  /**
   * All nodes on the configured layer that pass the current filter.
   * @returns {object[]}
   */
  getVisibleNodes() {
    return this._graphQueryApi.getByLayer(this._layer).filter(this._filterFn);
  }

  /**
   * All edges whose both endpoints are currently visible.
   * @returns {object[]}
   */
  getVisibleEdges() {
    const visibleIds = new Set(this.getVisibleNodes().map(n => n.id));
    const { edges }  = this._graphQueryApi.getGraphView(this._layer);
    return edges.filter(e => visibleIds.has(e.from) && visibleIds.has(e.to));
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _getFilteredData() {
    const nodes      = this.getVisibleNodes();
    const visibleIds = new Set(nodes.map(n => n.id));
    const { edges }  = this._graphQueryApi.getGraphView(this._layer);
    return {
      nodes,
      edges: edges.filter(e => visibleIds.has(e.from) && visibleIds.has(e.to)),
    };
  }
}
