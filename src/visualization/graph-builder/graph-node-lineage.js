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

const KIND_ICON = { event: '⚡', handler: '⚙', action: '▶', reducer: '⬡' };
const KIND_COLOR = { event: '#6af', handler: '#fa6', action: '#af6', reducer: '#f6a' };

/**
 * GraphNodeLineage — LINEAGE right-panel tab.
 *
 * When a config node is selected, finds its most recent execution instance
 * and renders the full causal chain via GraphQueryApi.traceCausality().
 * Each step in the chain shows kind, name, timestamp, and state-change count.
 *
 * Subscribes to the sim bus so it stays live during playback.
 */
export class GraphNodeLineage extends BaseComponent {
  /**
   * @param {{
   *   container:     HTMLElement,
   *   graphQueryApi: import('../../graph/graph-query-api.js').GraphQueryApi | null,
   * }}
   */
  constructor({ container, graphQueryApi }) {
    super();
    this._container    = container;
    this._graphQueryApi = graphQueryApi;
    this._selectedNode  = null;
    this._drainBegin    = () => [];
    this._drainEnd      = () => [];
    this._render();
  }

  setGraphQueryApi(api) {
    this._graphQueryApi = api;
    this._render();
  }

  showNode(node) {
    this._selectedNode = node ?? null;
    this._render();
  }

  wireSimBus(bus) {
    this._drainBegin = this.busQueue(bus, 'EXECUTION_BEGIN', () => this._render());
    this._drainEnd   = this.busQueue(bus, 'EXECUTION_END',   () => this._render());
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _render() {
    this._drainBegin();
    this._drainEnd();

    const node = this._selectedNode;
    const api  = this._graphQueryApi;

    if (!node || !api) {
      this._container.innerHTML =
        '<div style="padding:12px;color:var(--color-text-dim,#888);font-size:12px">Select a node to trace its lineage</div>';
      return;
    }

    // Only config-layer nodes have instances to trace.
    if (node.layer === 'execution') {
      this._renderChain(api.traceCausality(node.id), node.id);
      return;
    }

    const instances = api.getInstances(node.id);
    if (!instances.length) {
      this._container.innerHTML =
        '<div style="padding:12px;color:var(--color-text-dim,#888);font-size:12px">No execution instances — run the simulation.</div>';
      return;
    }

    // Most recent instance by timestamp.
    const latest = instances.reduce((a, b) =>
      (b.timestamp ?? 0) > (a.timestamp ?? 0) ? b : a
    );

    const chain = api.traceCausality(latest.id);
    this._renderChain(chain, latest.id);
  }

  _renderChain(chain, selectedInstanceId) {
    if (!chain.length) {
      this._container.innerHTML =
        '<div style="padding:12px;color:var(--color-text-dim,#888);font-size:12px">No causal chain found.</div>';
      return;
    }

    const parts = [];
    parts.push('<div class="node-header" style="margin-top:0">Causal Chain</div>');

    chain.forEach((n, i) => {
      const icon    = KIND_ICON[n.kind]  ?? '●';
      const color   = KIND_COLOR[n.kind] ?? '#888';
      const diff    = n.meta?.stateDiff ?? [];
      const changes = diff.length;
      const ts      = n.timestamp ? this._fmtTs(n.timestamp) : null;
      const isSel   = n.id === selectedInstanceId;
      const defName = n.name ?? n.definitionId ?? n.id;

      parts.push(`
        <div style="
          display:flex;align-items:flex-start;gap:8px;
          padding:6px 10px;
          background:${isSel ? 'rgba(255,255,255,0.06)' : 'transparent'};
          border-left:2px solid ${isSel ? color : 'transparent'};
        ">
          <div style="font-size:14px;color:${color};margin-top:1px;flex-shrink:0">${icon}</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:11px;font-weight:600;color:${color};text-transform:uppercase;letter-spacing:0.05em">${n.kind}</div>
            <div style="font-size:12px;color:#ddd;margin-top:1px;word-break:break-all">${this._esc(defName)}</div>
            ${ts ? `<div style="font-size:10px;color:#666;margin-top:2px">${ts}</div>` : ''}
            ${changes > 0 ? `<div style="font-size:10px;color:#8fa;margin-top:2px">${changes} state change${changes !== 1 ? 's' : ''}</div>` : ''}
          </div>
        </div>`);

      if (i < chain.length - 1) {
        parts.push(`<div style="padding-left:18px;color:#444;font-size:10px;line-height:1">│</div>`);
      }
    });

    this._container.innerHTML = parts.join('');
  }

  _fmtTs(ts) {
    if (!ts) return null;
    const d = ts instanceof Date ? ts : new Date(ts);
    if (isNaN(d)) return null;
    return d.toISOString().slice(0, 10);
  }

  _esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
