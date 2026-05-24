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
 * GraphNodeExecHistory — NODE HISTORY right-panel tab.
 *
 * For a selected config node shows:
 *   - Live fired/idle status from _execOverlay (updates every event cycle)
 *   - Execution instance count accumulated in the ExecutionGraph
 *   - Most-recent instance state diff (from GraphRecorder.endNode data)
 *   - diffExecution coverage: config nodes missing from or extra in the chain
 *
 * Subscribes to the sim bus to stay live during playback.
 */
export class GraphNodeExecHistory extends BaseComponent {
  /**
   * @param {{
   *   container:     HTMLElement,
   *   graphRenderer: import('../components/graph-renderer.js').GraphRenderer | null,
   *   graphQueryApi: import('../../graph/graph-query-api.js').GraphQueryApi | null,
   * }}
   */
  constructor({ container, graphRenderer, graphQueryApi }) {
    super();
    this._container     = container;
    this._graphRenderer = graphRenderer;
    this._graphQueryApi = graphQueryApi;
    this._selectedNode  = null;
    this._drainBegin    = () => [];
    this._drainEnd      = () => [];
    this._render();
  }

  setGraphRenderer(renderer) {
    this._graphRenderer = renderer;
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
    if (!node) {
      this._container.innerHTML =
        '<div style="padding:12px;color:var(--color-text-dim,#888);font-size:12px">Select a node to inspect</div>';
      return;
    }

    const parts = [];

    parts.push(`<div class="node-header" style="margin-top:0">${this._esc(node.name ?? node.id)}</div>`);

    const kindLabel = this._kindLabel(node);
    if (kindLabel) parts.push(this._field('KIND', this._esc(kindLabel)));

    const hasBreakpoint = !!node.data?.breakpoint;
    parts.push(this._field('BREAKPOINT', hasBreakpoint ? '⏸ Active' : '—'));

    // ── Live status from _execOverlay ────────────────────────────────────────
    const exec = this._graphRenderer?.getExecState(node.id) ?? null;
    if (exec) {
      const firedHtml = exec.fired
        ? '<span class="badge-green" style="padding:1px 6px;border-radius:3px;font-size:10px">Fired</span>'
        : '<span class="badge-cyan"  style="padding:1px 6px;border-radius:3px;font-size:10px">Idle</span>';
      parts.push(this._field('LIVE STATUS', firedHtml));

      if (exec.breakpointHit) {
        parts.push(this._field('HIT',
          '<span class="badge-red" style="padding:1px 6px;border-radius:3px;font-size:10px">⏸ Paused</span>'
        ));
      }
    }

    // ── ExecutionGraph instances ─────────────────────────────────────────────
    const api = this._graphQueryApi;
    const instances = api ? api.getInstances(node.id) : [];

    if (!instances.length) {
      if (!exec) {
        parts.push(
          '<div style="padding:8px 12px;color:var(--color-text-dim,#888);font-size:11px">No execution data — run the simulation.</div>'
        );
      }
      this._container.innerHTML = parts.join('');
      return;
    }

    // Sort ascending by timestamp so most-recent is last.
    const sorted = [...instances].sort((a, b) => {
      const ta = a.timestamp instanceof Date ? a.timestamp.getTime() : (a.timestamp ?? 0);
      const tb = b.timestamp instanceof Date ? b.timestamp.getTime() : (b.timestamp ?? 0);
      return ta - tb;
    });
    const latest = sorted[sorted.length - 1];

    parts.push(this._field('EXECUTIONS',
      `<span style="font-size:12px;font-weight:600">${instances.length}</span>`
    ));

    // ── Most-recent instance state diff ──────────────────────────────────────
    const diff = latest.meta?.stateDiff ?? [];
    if (diff.length) {
      parts.push('<div class="node-header" style="margin-top:8px">Last State Changes</div>');
      for (const ch of diff) {
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
    } else if (exec?.stateChanges?.length > 0) {
      // Fall back to live overlay diff when graph node has no persisted diff yet.
      parts.push('<div class="node-header" style="margin-top:8px">State Changes (live)</div>');
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
    }

    // ── diffExecution: config coverage ───────────────────────────────────────
    try {
      const { missing, extra } = api.diffExecution(node.id, latest.id);
      if (missing.length || extra.length) {
        parts.push('<div class="node-header" style="margin-top:8px">Config Coverage</div>');
        if (missing.length) {
          const chips = missing.map(id =>
            `<span style="padding:1px 6px;border-radius:3px;font-size:10px;background:#622;color:#faa;margin:1px 2px;display:inline-block">${this._esc(id)}</span>`
          ).join('');
          parts.push(`<div class="node-field" style="flex-wrap:wrap"><label>MISSING</label><div>${chips}</div></div>`);
        }
        if (extra.length) {
          const chips = extra.map(id =>
            `<span style="padding:1px 6px;border-radius:3px;font-size:10px;background:#262;color:#afa;margin:1px 2px;display:inline-block">${this._esc(id)}</span>`
          ).join('');
          parts.push(`<div class="node-field" style="flex-wrap:wrap"><label>EXTRA</label><div>${chips}</div></div>`);
        }
      } else if (instances.length) {
        parts.push('<div class="node-header" style="margin-top:8px">Config Coverage</div>');
        parts.push('<div style="padding:4px 12px;color:#8fa;font-size:11px">✓ Matches config path</div>');
      }
    } catch (_) {
      // diffExecution is best-effort; skip on any error.
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
