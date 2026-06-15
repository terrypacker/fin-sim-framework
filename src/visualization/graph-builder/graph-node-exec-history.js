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
import { readThemeColor } from '../theme.js';
import { APP_EVENTS } from '../app-display-settings.js';

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
   *   graphRenderer: import('../components/echarts-graph-renderer.js').EChartsGraphRenderer | null,
   *   graphQueryApi: import('../../graph/graph-query-api.js').GraphQueryApi | null,
   * }}
   */
  constructor({ container, graphRenderer, graphQueryApi, schemaRegistry = null, appBus = null }) {
    super();
    this._container     = container;
    this._graphRenderer = graphRenderer;
    this._graphQueryApi = graphQueryApi;
    this._schemaRegistry = schemaRegistry;
    this._selectedNode  = null;
    this._drainBegin    = () => [];
    this._drainEnd      = () => [];
    // Re-render state-change values in the active display currency on change (design 10 §Phase 4).
    if (appBus) {
      this.onCleanup?.(appBus.subscribe(APP_EVENTS.DISPLAY_SETTINGS_CHANGED, () => this._render()));
    }
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
        '<div style="padding:12px;color:var(--text-dim);font-size:12px">Select a node to inspect</div>';
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
          '<div style="padding:8px 12px;color:var(--text-dim);font-size:11px">No execution data — run the simulation.</div>'
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

    if (this._graphQueryApi && this._graphRenderer) {
      parts.push(`
        <div style="padding:4px 8px">
          <button data-action="highlight-lineage" class="btn btn-primary btn-xs" style="width:100%">
            ⬡ Highlight Lineage
          </button>
        </div>`);
    }

    // ── Most-recent instance state diff ──────────────────────────────────────
    const diff = latest.meta?.stateDiff ?? [];
    if (diff.length) {
      parts.push('<div class="node-header" style="margin-top:8px">Last State Changes</div>');
      for (const ch of diff) {
        const delta = ch.delta != null
          ? `<span class="diff-pos">(${ch.delta > 0 ? '+' : ''}${this._fmtField(ch.field, ch.delta)})</span>`
          : '';
        parts.push(`
          <div class="node-field" style="flex-direction:column;align-items:flex-start;gap:2px;padding:4px 8px">
            <label style="font-weight:600;font-size:10px">${this._esc(ch.field)}</label>
            <div style="display:flex;gap:6px;font-size:11px;font-family:monospace;align-items:center">
              <span class="diff-before">${this._fmtField(ch.field, ch.before)}</span>
              <span class="diff-field">→</span>
              <span class="diff-after">${this._fmtField(ch.field, ch.after)}</span>
              ${delta}
            </div>
          </div>`);
      }
    } else if (exec?.stateChanges?.length > 0) {
      // Fall back to live overlay diff when graph node has no persisted diff yet.
      parts.push('<div class="node-header" style="margin-top:8px">State Changes (live)</div>');
      for (const ch of exec.stateChanges) {
        const delta = ch.delta != null
          ? `<span class="diff-pos">(${ch.delta > 0 ? '+' : ''}${this._fmtField(ch.field, ch.delta)})</span>`
          : '';
        parts.push(`
          <div class="node-field" style="flex-direction:column;align-items:flex-start;gap:2px;padding:4px 8px">
            <label style="font-weight:600;font-size:10px">${this._esc(ch.field)}</label>
            <div style="display:flex;gap:6px;font-size:11px;font-family:monospace;align-items:center">
              <span class="diff-before">${this._fmtField(ch.field, ch.before)}</span>
              <span class="diff-field">→</span>
              <span class="diff-after">${this._fmtField(ch.field, ch.after)}</span>
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
            `<span class="badge-red" style="margin:1px 2px;display:inline-block">${this._esc(id)}</span>`
          ).join('');
          parts.push(`<div class="node-field" style="flex-wrap:wrap"><label>MISSING</label><div>${chips}</div></div>`);
        }
        if (extra.length) {
          const chips = extra.map(id =>
            `<span class="badge-green" style="margin:1px 2px;display:inline-block">${this._esc(id)}</span>`
          ).join('');
          parts.push(`<div class="node-field" style="flex-wrap:wrap"><label>EXTRA</label><div>${chips}</div></div>`);
        }
      } else if (instances.length) {
        parts.push('<div class="node-header" style="margin-top:8px">Config Coverage</div>');
        parts.push('<div class="diff-pos" style="padding:4px 12px;font-size:11px">✓ Matches config path</div>');
      }
    } catch (_) {
      // diffExecution is best-effort; skip on any error.
    }

    this._container.innerHTML = parts.join('');

    const hlBtn = this._container.querySelector('[data-action="highlight-lineage"]');
    if (hlBtn) {
      hlBtn.addEventListener('click', () => this._highlightLineage(latest));
    }
  }

  _highlightLineage(latest) {
    if (!this._graphQueryApi || !this._graphRenderer) return;
    const chain     = this._graphQueryApi.traceCausality(latest.id);
    const configIds = chain.map(n => n.definitionId).filter(Boolean);
    this._graphRenderer.setHighlight(configIds);
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

  /**
   * Format a state-change value using the schema registry (currency conversion +
   * symbol, design 10 §Phase 4), falling back to the plain formatter for
   * unregistered / non-money fields.
   */
  _fmtField(field, v) {
    // Only route currency fields through the registry (conversion + symbol);
    // everything else keeps the plain formatter so integers stay integers.
    if (this._schemaRegistry?.resolve?.(field)?.kind === 'currency') {
      const s = this._schemaRegistry.format(field, v);
      if (s != null) return this._esc(s);
    }
    return this._fmt(v);
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
