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

/**
 * GraphNodeExecHistory — shows execution overlay data (fired status, state
 * changes, breakpoint hits) for the currently-selected graph node.
 *
 * Renders into a fixed right-column pane. Subscribes to the sim bus and
 * re-renders on every EXECUTION_BEGIN / EXECUTION_END so the display stays
 * live while the simulation runs.
 *
 * Phase 2 (TODO #126): once ExecutionGraph instance nodes are wired during
 * simulation runs, this panel can show full causal chains and per-instance
 * diffs instead of just the per-definition overlay.
 */
export class GraphNodeExecHistory extends BaseComponent {
  /**
   * @param {{
   *   container:     HTMLElement,
   *   graphRenderer: import('../components/graph-renderer.js').GraphRenderer | null,
   * }}
   */
  constructor({ container, graphRenderer }) {
    super();
    this._container    = container;
    this._graphRenderer = graphRenderer;
    this._selectedNode  = null;
    this._drainBegin    = () => [];
    this._drainEnd      = () => [];
    this._render();
  }

  /** Point at a fresh renderer after each scenario rebuild. */
  setGraphRenderer(renderer) {
    this._graphRenderer = renderer;
    this._render();
  }

  /** Called when a graph node is clicked. Pass null to clear. */
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
    // Drain queued messages so the overlay in GraphRenderer is already updated.
    this._drainBegin();
    this._drainEnd();

    const node = this._selectedNode;
    if (!node) {
      this._container.innerHTML =
        '<div style="padding:12px;color:var(--color-text-dim,#888);font-size:12px">Select a node to inspect</div>';
      return;
    }

    const exec         = this._graphRenderer?.getExecState(node.id) ?? null;
    const hasBreakpoint = !!node.data?.breakpoint;

    const parts = [];

    parts.push(`<div class="node-header" style="margin-top:0">${this._esc(node.name ?? node.id)}</div>`);

    const kindLabel = this._kindLabel(node);
    if (kindLabel) {
      parts.push(this._field('KIND', this._esc(kindLabel)));
    }

    parts.push(this._field('BREAKPOINT', hasBreakpoint ? '⏸ Active' : '—'));

    if (!exec) {
      parts.push(
        '<div style="padding:8px 12px;color:var(--color-text-dim,#888);font-size:11px">No execution data — run the simulation.</div>'
      );
    } else {
      const firedHtml = exec.fired
        ? '<span class="badge-green" style="padding:1px 6px;border-radius:3px;font-size:10px">Fired</span>'
        : '<span class="badge-cyan"  style="padding:1px 6px;border-radius:3px;font-size:10px">Idle</span>';
      parts.push(this._field('STATUS', firedHtml));

      if (exec.breakpointHit) {
        parts.push(this._field('HIT',
          '<span class="badge-red" style="padding:1px 6px;border-radius:3px;font-size:10px">⏸ Paused</span>'
        ));
      }

      if (exec.stateChanges?.length > 0) {
        parts.push('<div class="node-header" style="margin-top:8px">State Changes</div>');
        for (const ch of exec.stateChanges) {
          const delta = ch.delta != null
            ? `<span style="color:#8fa">(${ch.delta > 0 ? '+' : ''}${this._fmt(ch.delta)})</span>`
            : '';
          parts.push(`
            <div class="node-field" style="flex-direction:column;align-items:flex-start;gap:2px;padding:4px 8px">
              <label style="font-weight:600;font-size:10px">${this._esc(ch.field)}</label>
              <div style="display:flex;gap:6px;font-size:11px;font-family:monospace;align-items:center">
                <span style="color:#888">${this._fmt(ch.before)}</span>
                <span style="color:#666">→</span>
                <span style="color:#aef">${this._fmt(ch.after)}</span>
                ${delta}
              </div>
            </div>`);
        }
      } else if (exec.fired) {
        parts.push(
          '<div style="padding:4px 12px;color:var(--color-text-dim,#888);font-size:11px">No state changes recorded</div>'
        );
      }
    }

    this._container.innerHTML = parts.join('');
  }

  _field(label, valueHtml) {
    return `<div class="node-field"><label>${label}</label>${valueHtml}</div>`;
  }

  _kindLabel(node) {
    switch (node.kind) {
      case 'event':   return node.eventType   ?? 'Event';
      case 'handler': return node.handlerClass ?? 'Handler';
      case 'action':  return node.actionClass  ?? 'Action';
      case 'reducer': return node.reducerType  ?? 'Reducer';
      default:        return node.kind ?? null;
    }
  }

  _fmt(v) {
    if (v == null) return '—';
    if (typeof v === 'object') return this._esc(JSON.stringify(v));
    if (typeof v === 'number') {
      return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2);
    }
    return this._esc(String(v));
  }

  _esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
