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

Chart.register(...registerables, annotationPlugin, zoomPlugin);

const COLOR_PALETTE = [
  '#60a5fa', '#34d399', '#f59e0b', '#f87171', '#a78bfa',
  '#38bdf8', '#fb923c', '#4ade80', '#e879f9', '#fbbf24',
  '#94a3b8', '#f472b6'
];

/**
 * Chart view backed by Chart.js. Requires Chart.js (and optionally
 * chartjs-plugin-annotation and chartjs-plugin-zoom) to be loaded as
 * globals before this class is instantiated.
 *
 * Series are discovered automatically from the data keys passed to
 * addSnapshot(). Non-primitive values are skipped by default; override
 * serializePrimitive() to extract a number from them instead.
 */
export class ChartView {
  /**
   * @param {object}  opts
   * @param {Element} opts.canvas    - <canvas> element
   * @param {Date}    opts.simStart
   * @param {Date}    opts.simEnd
   * @param {Array}   [opts.series]  - optional [{key, color, label}] overrides
   */
  constructor({ canvas, simStart, simEnd, series }) {
    this.canvas   = canvas;
    this.simStart = simStart;
    this.simEnd   = simEnd;
    this.running  = false;

    this._chart      = null;
    this._seriesMap  = new Map();  // key → { colorIdx: number, dataArr: [{x,y}] }
    this._colorIdx   = 0;
    this._annotations = {};

    // Optional pre-configured color/label overrides keyed by series key
    this._seriesConfig = new Map((series ?? []).map(s => [s.key, s]));
  }

  // ── Hook ─────────────────────────────────────────────────────────────────────

  /**
   * Override to handle non-primitive values in a snapshot.
   * Return a number to plot it, or null/undefined to skip the key entirely.
   * @param {string} key
   * @param {*}      value  - the raw (non-primitive) value
   * @returns {number|null|undefined}
   */
  serializePrimitive(key, value) {  // eslint-disable-line no-unused-vars
    return undefined;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Record a snapshot of values at a point in time.
   * Iterates all keys in data; skips non-primitives unless serializePrimitive()
   * returns a number. Series are created automatically on first encounter.
   *
   * @param {string}       type - action type (e.g. 'RECORD_BALANCE')
   * @param {Date|number}  date
   * @param {object}       data - flat map of { seriesKey: number }
   */
  addSnapshot(type, date, data) {
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
      this._seriesMap.get(key).dataArr.push({ x: t, y: num });
      didAdd = true;
    }

    if (didAdd && this._chart) {
      this._chart.update('none');
    }
  }

  /**
   * Add a vertical-line annotation to the chart.
   *
   * @param {string}       id       - unique key; use the same key to overwrite
   * @param {object}       opts
   * @param {string}       opts.label
   * @param {Date|number}  opts.date
   * @param {string}       [opts.color='#f59e0b']
   * @param {string}       [opts.position='start']  - 'start'|'center'|'end'
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

  /**
   * Remove a previously added annotation by id.
   * @param {string} id
   */
  removeAnnotation(id) {
    delete this._annotations[id];
    if (this._chart) {
      this._chart.options.plugins.annotation.annotations = { ...this._annotations };
      this._chart.update();
    }
  }

  /**
   * Clear all series data and annotations (called on rewind).
   */
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

  /**
   * Create the Chart.js instance. Must be called after Chart.js is loaded.
   */
  startViz() {
    this.running = true;
    if (!this._chart) this._initChart();
  }

  /**
   * Destroy the Chart.js instance (called when the scenario is rebuilt so the
   * canvas can be reused by the next ChartView).
   */
  stopViz() {
    this.running = false;
    if (this._chart) {
      this._chart.destroy();
      this._chart = null;
    }
    this._controlsEl?.remove();
    this._controlsEl = null;
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
      label:           this._labelFor(key),
      data:            dataArr,          // same array reference — push updates it live
      borderColor:     color,
      backgroundColor: color + '22',
      borderWidth:     2,
      pointRadius:     0,
      tension:         0.1,
      fill:            false,
      _seriesKey:      key
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

    const minX = this.simStart?.getTime() ?? Date.now();
    const maxX = this.simEnd?.getTime()   ?? (Date.now() + 1);

    this._chart = new Chart(this.canvas, {
      type: 'line',
      data: { datasets: [] },
      options: {
        responsive:          true,
        maintainAspectRatio: false,
        animation:           true,
        layout: { padding: { top: 10, right: 30, bottom: 10, left: 10 } },
        scales: {
          x: {
            type: 'linear',
            min:  minX,
            max:  maxX,
            ticks: {
              color:        '#94a3b8',
              maxTicksLimit: 10,
              font:         { family: 'monospace', size: 11 },
              callback:     (val) => this._fmtDateTick(val)
            },
            grid: { color: '#1e293b' }
          },
          y: {
            ticks: {
              color: '#94a3b8',
              font:  { family: 'monospace', size: 11 },
              callback: (val) => Number(val).toLocaleString()
            },
            grid: { color: '#1e293b' }
          }
        },
        plugins: {
          legend: {
            labels: {
              color: '#94a3b8',
              font:  { family: 'monospace', size: 11 }
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
          zoom: {
            zoom: {
              wheel: { enabled: true },
              pinch: { enabled: true },
              mode:  'x'
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
