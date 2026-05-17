/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { WorkbenchComponent } from '../../component.js';
import { WB_EVENTS } from '../../workbench-runtime.js';

const MAX_SAMPLES   = 300;
const HIST_BUCKETS  = 20;

export class PerfPlugin extends WorkbenchComponent {
  constructor(runtime) {
    super();
    this._runtime  = runtime;
    this._samples  = [];       // { kind, duration, nodeId }
    this._frames   = [];       // frame durations in ms
    this._pending  = new Map(); // executionId → performance.now() start
    this._rafId    = null;
    this._dirty    = false;
  }

  render() {
    const root = document.createElement('div');
    root.className = 'wb-plugin-fill perf-plugin';
    root.innerHTML = `
      <div class="perf-header">
        <span class="perf-title">Performance</span>
        <button class="perf-clear wb-btn">Clear</button>
      </div>
      <div class="perf-metrics">
        <div class="perf-metric">
          <span class="perf-lbl">Frame p50</span>
          <span class="perf-val" data-id="frameTime">—</span>
        </div>
        <div class="perf-metric">
          <span class="perf-lbl">Event avg</span>
          <span class="perf-val" data-id="avgEvent">—</span>
        </div>
        <div class="perf-metric">
          <span class="perf-lbl">Handler avg</span>
          <span class="perf-val" data-id="avgHandler">—</span>
        </div>
        <div class="perf-metric">
          <span class="perf-lbl">Action avg</span>
          <span class="perf-val" data-id="avgAction">—</span>
        </div>
        <div class="perf-metric">
          <span class="perf-lbl">Heap</span>
          <span class="perf-val" data-id="heapUsed">—</span>
        </div>
      </div>
      <div class="perf-section-lbl">Event duration histogram (ms)</div>
      <canvas class="perf-hist" data-id="hist" height="60"></canvas>
      <div class="perf-section-lbl">Slowest events (last ${MAX_SAMPLES})</div>
      <div class="perf-slow" data-id="slow"></div>
    `;
    return root;
  }

  onInit() {
    this._runtime.bus.subscribe(WB_EVENTS.SCENARIO_READY, ({ scenario }) => {
      this._wireScenario(scenario);
    });
    // Refresh display whenever the simulation ticks.
    this._runtime.bus.subscribe(WB_EVENTS.RUNTIME_TICK, () => {
      this._dirty = true;
    });
  }

  onMount() {
    this.el.querySelector('.perf-clear').addEventListener('click', () => {
      this._samples = [];
      this._frames  = [];
      this._dirty   = true;
    });
    this._startFrameTimer();
    this._dirty = true;
  }

  onUnmount() {
    if (this._rafId != null) cancelAnimationFrame(this._rafId);
    this._rafId = null;
  }

  _wireScenario(scenario) {
    if (!scenario?.sim?.bus) return;
    const bus = scenario.sim.bus;
    bus.subscribe('EXECUTION_BEGIN', (msg) => {
      this._pending.set(msg.executionId, performance.now());
    });
    bus.subscribe('EXECUTION_END', (msg) => {
      const t0 = this._pending.get(msg.executionId);
      if (t0 == null) return;
      this._pending.delete(msg.executionId);
      this._samples.push({ kind: msg.kind, duration: performance.now() - t0, nodeId: msg.nodeId });
      if (this._samples.length > MAX_SAMPLES) this._samples.shift();
      this._dirty = true;
    });
  }

  _startFrameTimer() {
    let last = performance.now();
    const tick = (now) => {
      this._frames.push(now - last);
      if (this._frames.length > MAX_SAMPLES) this._frames.shift();
      last = now;

      if (this._dirty && this._mounted) {
        this._dirty = false;
        this._updateDisplay();
      }
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  _updateDisplay() {
    if (!this.el) return;
    const $ = (id) => this.el.querySelector(`[data-id="${id}"]`);

    // Frame time p50
    if (this._frames.length > 0) {
      const sorted = [...this._frames].sort((a, b) => a - b);
      $('frameTime').textContent = sorted[Math.floor(sorted.length * 0.5)].toFixed(1) + ' ms';
    }

    // Per-kind averages
    for (const [kind, key] of [['EVENT', 'avgEvent'], ['HANDLER', 'avgHandler'], ['ACTION', 'avgAction']]) {
      const ks = this._samples.filter(s => s.kind === kind);
      if (ks.length > 0) {
        const avg = ks.reduce((a, s) => a + s.duration, 0) / ks.length;
        $(key).textContent = avg.toFixed(2) + ' ms';
      }
    }

    // Heap usage (Chrome only)
    if (typeof performance !== 'undefined' && performance.memory) {
      const mb = (performance.memory.usedJSHeapSize / 1_048_576).toFixed(1);
      $('heapUsed').textContent = mb + ' MB';
    }

    this._drawHistogram($('hist'));
    this._renderSlowest($('slow'));
  }

  _drawHistogram(canvas) {
    if (!canvas) return;
    const events = this._samples.filter(s => s.kind === 'EVENT').map(s => s.duration);
    const W = canvas.clientWidth || 220;
    const H = canvas.height || 60;
    canvas.width = W;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    if (!events.length) return;

    const max = Math.max(...events);
    const counts = new Array(HIST_BUCKETS).fill(0);
    for (const d of events) {
      counts[Math.min(HIST_BUCKETS - 1, Math.floor((d / max) * HIST_BUCKETS))]++;
    }
    const maxC = Math.max(...counts);
    const bw = W / HIST_BUCKETS;

    ctx.fillStyle = '#5aa2ff';
    for (let i = 0; i < HIST_BUCKETS; i++) {
      if (!counts[i]) continue;
      const h = Math.max(2, (counts[i] / maxC) * (H - 4));
      ctx.fillRect(i * bw + 1, H - h, bw - 2, h);
    }

    // Axis labels: 0 and max
    ctx.fillStyle = '#91a0b4';
    ctx.font = '9px system-ui';
    ctx.fillText('0', 2, H - 2);
    ctx.fillText(max.toFixed(1) + 'ms', W - 36, H - 2);
  }

  _renderSlowest(el) {
    if (!el) return;
    const events = this._samples
      .filter(s => s.kind === 'EVENT')
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 8);
    if (!events.length) {
      el.innerHTML = '<span class="perf-empty">No data yet — run the simulation.</span>';
      return;
    }
    el.innerHTML = events.map(s =>
      `<div class="perf-slow-row">
        <span class="perf-slow-node">${s.nodeId ?? '—'}</span>
        <span class="perf-slow-dur">${s.duration.toFixed(2)} ms</span>
      </div>`
    ).join('');
  }
}
