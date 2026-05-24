/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Chart, registerables } from 'chart.js';
import annotationPlugin from 'chartjs-plugin-annotation';
import zoomPlugin from 'chartjs-plugin-zoom';
import 'chartjs-adapter-date-fns';
import { BaseComponent } from '../components/base-component.js';

Chart.register(...registerables, annotationPlugin, zoomPlugin);

const COLOR_PALETTE = [
  '#60a5fa', '#34d399', '#f59e0b', '#f87171', '#a78bfa',
  '#38bdf8', '#fb923c', '#4ade80', '#e879f9', '#fbbf24',
  '#94a3b8', '#f472b6'
];

/**
 * Pure Chart.js rendering layer. Extends BaseComponent so it participates in
 * the parent→child destroy lifecycle (e.g. MapFilterMultiSelect cleanup).
 *
 * Series are discovered automatically from keys passed to addSnapshot().
 * Non-primitive values are skipped unless serializePrimitive() returns a number.
 *
 * Use setDatasetVisible(key, visible) to show/hide a series without losing data.
 */
export class ChartView extends BaseComponent {
  /**
   * @param {object}  opts
   * @param {Element} opts.canvas    - <canvas> element
   * @param {Date}    opts.simStart
   * @param {Date}    opts.simEnd
   * @param {Array}   [opts.series]  - optional [{key, color, label}] overrides
   */
  constructor({ canvas, simStart, simEnd, series }) {
    super();
    this.canvas   = canvas;
    this.simStart = simStart;
    this.simEnd   = simEnd;
    this.running  = false;

    this._chart       = null;
    this._seriesMap   = new Map();  // key → { colorIdx, dataArr }
    this._colorIdx    = 0;
    this._annotations = {};
    this._filterBarEl = null;
    this._controlsEl  = null;

    this._seriesConfig = new Map((series ?? []).map(s => [s.key, s]));

    this._renderThrottleMs = 0;
    this._chartDirty       = false;
    this._chartPending     = false;
    this._chartLastRender  = 0;
  }

  // ── Filter bar ────────────────────────────────────────────────────────────────

  /**
   * Instantiate and mount the chart filter bar template into #chartFilterContainer.
   * Safe to call multiple times; returns the existing element after the first mount.
   * @returns {Element|null}
   */
  mountFilterBar() {
    if (this._filterBarEl) return this._filterBarEl;
    const container = document.getElementById('chartFilterContainer');
    if (!container) return null;
    container.innerHTML = '';
    this._filterBarEl = this._getTemplate('tpl-chart-filter-bar');
    container.appendChild(this._filterBarEl);
    return this._filterBarEl;
  }

  // ── Dataset visibility ────────────────────────────────────────────────────────

  /**
   * Show or hide a series by key without discarding its data.
   */
  setDatasetVisible(key, visible) {
    if (!this._chart) return;
    const ds = this._chart.data.datasets.find(d => d._seriesKey === key);
    if (ds && ds.hidden !== !visible) {
      ds.hidden = !visible;
      this._scheduleChartUpdate();
    }
  }

  // ── Throttle ──────────────────────────────────────────────────────────────────

  setRenderThrottle(ms) {
    this._renderThrottleMs = ms ?? 0;
  }

  _scheduleChartUpdate() {
    this._chartDirty = true;
    if (this._chartPending) return;
    this._chartPending = true;

    const fire = () => {
      this._chartPending = false;
      if (!this._chartDirty) return;
      this._chartDirty = false;
      this._chartLastRender = performance.now();
      this._chart?.update('none');
    };

    if (this._renderThrottleMs > 0) {
      const elapsed = performance.now() - this._chartLastRender;
      setTimeout(fire, Math.max(0, this._renderThrottleMs - elapsed));
    } else {
      requestAnimationFrame(fire);
    }
  }

  // ── Hook ─────────────────────────────────────────────────────────────────────

  /**
   * Override to handle non-primitive values in a snapshot.
   * Return a number to plot it, or null/undefined to skip the key entirely.
   */
  serializePrimitive(key, value) {  // eslint-disable-line no-unused-vars
    return undefined;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Record a snapshot of values at a point in time.
   * All keys are stored regardless of current visibility state; call
   * setDatasetVisible() after to apply the filter.
   */
  addSnapshot(date, data) {
    if (!data || typeof data !== 'object') return;
    const t = new Date(date).getTime();
    let didAdd = false;

    for (const [key, raw] of Object.entries(data)) {
      let value = raw;
      if (typeof value === 'object' && value !== null) {
        value = this.serializePrimitive(key, raw);
        if (value == null) continue;
      }
      if (typeof value !== 'number' && typeof value !== 'boolean') continue;
      const num = Number(value);

      if (!this._seriesMap.has(key)) {
        const dataArr = [];
        this._seriesMap.set(key, { colorIdx: this._colorIdx++, dataArr });
        if (this._chart) this._appendDataset(key, dataArr);
      }
      const dataArr = this._seriesMap.get(key).dataArr;
      if (dataArr.length > 0 && dataArr[dataArr.length - 1].x === t) {
        dataArr[dataArr.length - 1].y = num;
      } else {
        dataArr.push({ x: t, y: num });
      }
      didAdd = true;
    }

    if (didAdd && this._chart) {
      this._scheduleChartUpdate();
    }
  }

  /**
   * Add a vertical-line annotation to the chart.
   */
  addAnnotation(id, { label, date, color = '#f59e0b', position = 'start' }) {
    this._annotations[id] = {
      type: 'line',
      xMin: new Date(date).getTime(),
      xMax: new Date(date).getTime(),
      borderColor: color,
      borderWidth: 2,
      borderDash: [4, 4],
      label: {
        display:         true,
        content:         label,
        position,
        backgroundColor: color + '33',
        color:           '#f8fafc',
        font:            { size: 11, family: 'monospace' },
        padding:         4
      }
    };
    if (this._chart) {
      this._chart.options.plugins.annotation.annotations = { ...this._annotations };
      this._chart.update();
    }
  }

  removeAnnotation(id) {
    delete this._annotations[id];
    if (this._chart) {
      this._chart.options.plugins.annotation.annotations = { ...this._annotations };
      this._chart.update();
    }
  }

  /** Clear all series data and annotations (called on rewind). */
  resetHistory() {
    this._seriesMap.clear();
    this._colorIdx = 0;
    this._annotations = {};
    if (this._chart) {
      this._chart.data.datasets = [];
      this._chart.options.plugins.annotation.annotations = {};
      this._chart.update();
    }
  }

  startViz() {
    this.running = true;
    if (!this._chart) this._initChart();
  }

  stopViz() {
    this.running = false;
    if (this._chart) {
      this._chart.destroy();
      this._chart = null;
    }
    this._controlsEl?.remove();
    this._controlsEl = null;
    this._filterBarEl?.remove();
    this._filterBarEl = null;
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  _colorFor(idx) {
    return COLOR_PALETTE[idx % COLOR_PALETTE.length];
  }

  _labelFor(key) {
    const cfg = this._seriesConfig.get(key);
    if (cfg?.label) return cfg.label;
    return key
      .replace(/([A-Z])/g, ' $1')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase())
      .trim();
  }

  _appendDataset(key, dataArr) {
    const { colorIdx } = this._seriesMap.get(key);
    const cfg   = this._seriesConfig.get(key);
    const color = cfg?.color ?? this._colorFor(colorIdx);
    this._chart.data.datasets.push({
      label:                  this._labelFor(key),
      data:                   dataArr,
      parsing:                false,
      normalized:             true,
      borderColor:            color,
      backgroundColor:        color + '22',
      borderWidth:            2.5,
      pointRadius:            0,
      pointHitRadius:         12,
      tension:                0.35,
      cubicInterpolationMode: 'monotone',
      borderCapStyle:         'round',
      borderJoinStyle:        'round',
      fill:                   false,
      _seriesKey:             key
    });
  }

  _fmtDateTick(ts) {
    const d = new Date(ts);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
  }

  _buildControls() {
    const wrapper = this.canvas.parentElement;
    if (!wrapper || this._controlsEl) return;

    wrapper.style.position = 'relative';

    this._controlsEl = document.createElement('div');
    this._controlsEl.className = 'chart-controls';
    this._controlsEl.style.cssText =
      'position:absolute;top:8px;right:8px;z-index:10;display:flex;gap:6px;';

    const resetBtn = document.createElement('button');
    resetBtn.className = 'btn btn-sm';
    resetBtn.title = 'Reset zoom and pan';
    resetBtn.textContent = '⊙ RESET ZOOM';
    resetBtn.addEventListener('click', () => this._chart?.resetZoom());

    this._controlsEl.appendChild(resetBtn);
    wrapper.appendChild(this._controlsEl);
  }

  _initChart() {
    if (!this.canvas) return;

    this._buildControls();

    this._chart = new Chart(this.canvas, {
      type: 'line',
      data: { datasets: [] },
      options: {
        devicePixelRatio:    window.devicePixelRatio || 1,
        responsive:          true,
        maintainAspectRatio: false,
        animation:           false,
        transitions: {
          active: { animation: { duration: 0 } }
        },
        layout: { padding: { top: 10, right: 30, bottom: 10, left: 10 } },
        scales: {
          x: {
            type: 'time',
            time: { unit: 'month' }
          },
          y: {
            ticks: {
              color: '#94a3b8',
              font:  { family: 'monospace', size: 11 },
              callback: (val) => Number(val).toLocaleString()
            },
            grid: {
              color:       'rgba(148,163,184,0.08)',
              lineWidth:   1,
              drawBorder:  false
            }
          }
        },
        plugins: {
          legend: {
            labels: {
              color: '#94a3b8',
              font:  { family: 'Inter, system-ui, sans-serif', size: 11 }
            }
          },
          tooltip: {
            callbacks: {
              title: (items) => items.length ? this._fmtDateTick(items[0].parsed.x) : '',
              label: (item)  =>
                `${item.dataset.label}: ${Number(item.parsed.y).toLocaleString()}`
            }
          },
          annotation: {
            annotations: this._annotations
          },
          decimation: {
            enabled:   true,
            algorithm: 'lttb',
            samples:   500
          },
          zoom: {
            zoom: {
              wheel:  { enabled: true },
              pinch:  { enabled: true },
              mode:   'x'
            },
            pan: {
              enabled: true,
              mode:    'x'
            }
          }
        }
      }
    });
  }
}
