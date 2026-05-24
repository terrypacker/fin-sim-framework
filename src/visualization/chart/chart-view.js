/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import * as echarts from 'echarts';
import { BaseComponent } from '../components/base-component.js';

const COLOR_PALETTE = [
  '#60a5fa', '#34d399', '#f59e0b', '#f87171', '#a78bfa',
  '#38bdf8', '#fb923c', '#4ade80', '#e879f9', '#fbbf24',
  '#94a3b8', '#f472b6'
];

/**
 * ECharts rendering layer. Extends BaseComponent so it participates in
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
   * @param {Element} opts.container  - div element for ECharts to own
   * @param {Date}    opts.simStart
   * @param {Date}    opts.simEnd
   * @param {Array}   [opts.series]   - optional [{key, color, label}] overrides
   */
  constructor({ container, simStart, simEnd, series }) {
    super();
    this.container = container;
    this.simStart  = simStart;
    this.simEnd    = simEnd;
    this.running   = false;

    this._chart        = null;
    this._ro           = null;
    this._seriesMap    = new Map();  // key → { colorIdx, dataArr }
    this._colorIdx     = 0;
    this._annotations  = {};         // id → { date, label, color, position }
    this._hiddenSeries = new Set();
    this._filterBarEl  = null;

    this._seriesConfig = new Map((series ?? []).map(s => [s.key, s]));
  }

  // ── Resize ────────────────────────────────────────────────────────────────────

  resize() {
    this._chart?.resize();
  }

  // ── Filter bar ────────────────────────────────────────────────────────────────

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

  setDatasetVisible(key, visible) {
    if (visible) {
      this._hiddenSeries.delete(key);
    } else {
      this._hiddenSeries.add(key);
    }
    if (this._chart) {
      this._chart.setOption({
        legend: { selected: { [this._labelFor(key)]: visible } }
      });
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
        this._seriesMap.set(key, { colorIdx: this._colorIdx++, dataArr: [] });
      }
      const { dataArr } = this._seriesMap.get(key);
      if (dataArr.length > 0 && dataArr[dataArr.length - 1][0] === t) {
        dataArr[dataArr.length - 1][1] = num;
      } else {
        dataArr.push([t, num]);
      }
      didAdd = true;
    }

    if (didAdd && this._chart) {
      this.scheduleRender(() => this._doChartUpdate());
    }
  }

  addAnnotation(id, { label, date, color = '#f59e0b', position = 'start' }) {
    this._annotations[id] = { label, date: new Date(date), color, position };
    if (this._chart) {
      this.scheduleRender(() => this._doChartUpdate());
    }
  }

  removeAnnotation(id) {
    delete this._annotations[id];
    if (this._chart) {
      this.scheduleRender(() => this._doChartUpdate());
    }
  }

  resetHistory() {
    this._seriesMap.clear();
    this._colorIdx    = 0;
    this._annotations = {};
    this._hiddenSeries.clear();
    if (this._chart) {
      this._chart.clear();
      this._applyBaseOptions();
    }
  }

  startViz() {
    this.running = true;
    if (!this._chart) this._initChart();
  }

  stopViz() {
    this.running = false;
    this._ro?.disconnect();
    this._ro = null;
    if (this._chart) {
      this._chart.dispose();
      this._chart = null;
    }
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

  _buildSeriesOption(key, dataArr) {
    const { colorIdx } = this._seriesMap.get(key);
    const cfg   = this._seriesConfig.get(key);
    const color = cfg?.color ?? this._colorFor(colorIdx);
    return {
      type:           'line',
      id:             key,
      name:           this._labelFor(key),
      data:           dataArr,
      smooth:         true,
      smoothMonotone: 'x',
      symbol:         'circle',
      symbolSize:     6,
      sampling:       'lttb',
      emphasis:       { focus: 'series' },
      lineStyle:      { color, width: 2 },
      itemStyle:      { color },
    };
  }

  _buildAnnotationSeries() {
    const annList = Object.values(this._annotations);
    if (annList.length === 0) return null;
    return {
      type:            'line',
      id:              '__annotations__',
      name:            '__annotations__',
      data:            [],
      silent:          false,
      legendHoverLink: false,
      tooltip:         { show: false },
      lineStyle:       { opacity: 0 },
      symbol:          'none',
      markLine: {
        symbol:  ['none', 'none'],
        silent:  false,
        data: annList.map(ann => ({
          name:      ann.label,
          xAxis:     ann.date.getTime(),
          lineStyle: { color: ann.color, width: 2, type: 'dashed' },
          label: {
            show:            true,
            position:        ann.position === 'end' ? 'insideEndTop' : 'insideStartTop',
            formatter:       ann.label,
            color:           ann.color,
            fontSize:        11,
            fontFamily:      'monospace',
            backgroundColor: ann.color + '22',
            padding:         [2, 4],
          }
        }))
      }
    };
  }

  _doChartUpdate() {
    if (!this._chart) return;

    const series = [];
    const selected = {};

    for (const [key, { dataArr }] of this._seriesMap) {
      series.push(this._buildSeriesOption(key, dataArr));
      selected[this._labelFor(key)] = !this._hiddenSeries.has(key);
    }

    const annSeries = this._buildAnnotationSeries();
    if (annSeries) series.push(annSeries);

    this._chart.setOption({ series, legend: { selected } });
  }

  _applyBaseOptions() {
    this._chart.setOption({
      backgroundColor: 'transparent',
      animation:       false,
      grid: {
        top:          40,
        right:        16,
        bottom:       24,
        left:         16,
        containLabel: true,
      },
      legend: {
        show:     false,
        selected: {},
      },
      toolbox: {
        right: 12,
        top:    6,
        feature: {
          dataZoom: {
            yAxisIndex: 'none',
            title:      { zoom: 'Select Zoom', back: 'Undo Zoom' },
            brushStyle: { color: 'rgba(96,165,250,0.08)', borderColor: '#60a5fa', borderWidth: 1 },
          },
          restore: { title: 'Reset View' },
        },
        iconStyle: { borderColor: '#475569' },
        emphasis:  { iconStyle: { borderColor: '#94a3b8' } },
      },
      xAxis: {
        type:  'time',
        axisLabel: {
          color:      '#94a3b8',
          fontSize:   11,
          fontFamily: 'monospace',
        },
        splitLine: { show: false },
        axisLine:  { lineStyle: { color: 'rgba(148,163,184,0.15)' } },
        axisTick:  { lineStyle: { color: 'rgba(148,163,184,0.15)' } },
      },
      yAxis: {
        type: 'value',
        axisLabel: {
          color:      '#94a3b8',
          fontSize:   11,
          fontFamily: 'monospace',
          formatter:  (val) => Number(val).toLocaleString(),
        },
        splitLine: { lineStyle: { color: 'rgba(148,163,184,0.08)', width: 1 } },
        axisLine:  { show: false },
        axisTick:  { show: false },
      },
      tooltip: {
        trigger:     'item',
        axisPointer: {
          type:       'cross',
          lineStyle:  { color: 'rgba(148,163,184,0.35)' },
          crossStyle: { color: 'rgba(148,163,184,0.35)' },
        },
        backgroundColor: '#1e293b',
        borderColor:     '#334155',
        borderWidth:     1,
        textStyle:       { color: '#e2e8f0', fontSize: 11, fontFamily: 'monospace' },
        formatter:       (params) => this._fmtTooltip(params),
      },
      dataZoom: [
        { type: 'inside', xAxisIndex: 0, filterMode: 'filter' },
      ],
      series: [],
    });
  }

  _initChart() {
    if (!this.container) return;

    this._chart = echarts.init(this.container, null, { renderer: 'canvas' });

    // Auto-resize when the container's dimensions change (covers tab-switch and pane-resize).
    this._ro = new ResizeObserver(() => this._chart?.resize());
    this._ro.observe(this.container);

    this._applyBaseOptions();
  }

  _fmtTooltip(params) {
    if (!params || params.length === 0) return '';

    // Normalize both:
    // trigger: 'axis' => array
    // trigger: 'item' => single object
    const list = Array.isArray(params) ? params : [params];

    if (!list || list.length === 0) {
      return '';
    }

    // Filter out hidden/internal series
    const filtered = list.filter(p =>
        p &&
        p.seriesName &&
        p.seriesName !== '__annotations__'
    );

    if (filtered.length === 0) {
      return '';
    }

    // Timestamp extraction
    const first = filtered[0];
    let ts = null;
    if (Array.isArray(first.value)) {
      ts = first.value[0];
    } else {
      ts = first.axisValue;
    }

    // Date formatting
    let dateStr = '';
    if (ts != null) {
      const d = new Date(ts);
      dateStr =
          d.getUTCFullYear() +
          '-' +
          String(d.getUTCMonth() + 1).padStart(2, '0');
    }

    const lines = [];
    if (dateStr) {
      lines.push(
          `<span style="font-size:10px;color:#64748b">${dateStr}</span>`
      );
    }

    // Series lines
    for (const p of filtered) {
      let rawVal;
      if (Array.isArray(p.value)) {
        rawVal = p.value[1];
      } else {
        rawVal = p.value;
      }
      const formattedVal =
          typeof rawVal === 'number'
              ? rawVal.toLocaleString()
              : rawVal;
      lines.push(
          `${p.marker}${p.seriesName}: <b>${formattedVal}</b>`
      );
    }

    return lines.join('<br/>');
  }
}
