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
import { readThemeColor, CHART_PALETTE } from '../theme.js';

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

    this._seriesConfig = new Map((series ?? []).map(s => [s.key, s]));
    this._seriesKinds  = new Map(); // key → ParameterValueType.kind string
    this._backfilledSeries = new Set(); // keys shown at snapshot resolution → dashed (R10.1)
  }

  // ── Resize ────────────────────────────────────────────────────────────────────

  resize() {
    this._chart?.resize();
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

  /**
   * Remove a series entirely (its data and bookkeeping) and re-render so it is
   * dropped from the chart. Uses replaceMerge so ECharts actually discards the
   * stale series rather than index-merging it back. (Design 31 / R1.3.)
   */
  removeSeries(key) {
    this._seriesMap.delete(key);
    this._seriesKinds.delete(key);
    this._hiddenSeries.delete(key);
    this._backfilledSeries.delete(key);
    if (!this._chart) return;
    const { series, selected } = this._buildSeriesAndLegend();
    this._chart.setOption(
      { series, legend: { selected }, yAxis: this._buildYAxes() },
      { replaceMerge: ['series'] }
    );
  }

  /**
   * Record the ParameterValueType.kind for a series so it can be bucketed
   * onto the correct Y-axis (rate/percentage → right; currency/other → left).
   */
  setSeriesKind(key, kind) {
    this._seriesKinds.set(key, kind ?? 'unknown');
  }

  /** Mark a series as backfilled (snapshot resolution) → rendered dashed (R10.1). */
  setSeriesBackfilled(key, on) {
    if (on) this._backfilledSeries.add(key);
    else    this._backfilledSeries.delete(key);
    if (this._chart) this.scheduleRender(() => this._doChartUpdate());
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

  addAnnotation(id, { label, date, color = readThemeColor('--amber'), position = 'start' }) {
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
    this._seriesKinds.clear();
    this._backfilledSeries.clear();
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
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  _colorFor(idx) {
    return CHART_PALETTE[idx % CHART_PALETTE.length];
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

  _kindToAxisIndex(kind) {
    return (kind === 'rate' || kind === 'percentage') ? 1 : 0;
  }

  _buildSeriesOption(key, dataArr) {
    const { colorIdx } = this._seriesMap.get(key);
    const cfg        = this._seriesConfig.get(key);
    const color      = cfg?.color ?? this._colorFor(colorIdx);
    const kind       = this._seriesKinds.get(key) ?? 'unknown';
    const yAxisIndex = this._kindToAxisIndex(kind);
    const backfilled = this._backfilledSeries.has(key);
    return {
      type:           'line',
      id:             key,
      name:           this._labelFor(key),  // keep stable for legend.selected matching
      data:           dataArr,
      yAxisIndex,
      smooth:         true,
      smoothMonotone: 'x',
      symbol:         'circle',
      symbolSize:     6,
      sampling:       'lttb',
      emphasis:       { focus: 'series' },
      lineStyle:      { color, width: 2, type: backfilled ? 'dashed' : 'solid' },
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

  _buildYAxes() {
    // Determine which axis indices are actually in use
    const activeKinds = new Set([...this._seriesKinds.values()]);
    const hasRateAxis = [...activeKinds].some(k => k === 'rate' || k === 'percentage');

    const leftAxis = {
      type:      'value',
      position:  'left',
      axisLabel: {
        color:      readThemeColor('--text-dim'),
        fontSize:   11,
        fontFamily: 'monospace',
        formatter:  (val) => Number(val).toLocaleString(),
      },
      splitLine: { lineStyle: { color: readThemeColor('--border-light'), width: 1 } },
      axisLine:  { show: false },
      axisTick:  { show: false },
    };

    if (!hasRateAxis) return leftAxis; // single axis — keep existing shape for ECharts

    const rightAxis = {
      type:      'value',
      position:  'right',
      axisLabel: {
        color:      readThemeColor('--text-dim'),
        fontSize:   11,
        fontFamily: 'monospace',
        formatter:  (val) => Number(val).toLocaleString('en-US', { maximumFractionDigits: 4 }),
      },
      splitLine: { show: false },
      axisLine:  { show: false },
      axisTick:  { show: false },
    };

    return [leftAxis, rightAxis];
  }

  _buildSeriesAndLegend() {
    const series = [];
    const selected = {};
    for (const [key, { dataArr }] of this._seriesMap) {
      series.push(this._buildSeriesOption(key, dataArr));
      selected[this._labelFor(key)] = !this._hiddenSeries.has(key);
    }
    const annSeries = this._buildAnnotationSeries();
    if (annSeries) series.push(annSeries);
    return { series, selected };
  }

  _doChartUpdate() {
    if (!this._chart) return;
    const { series, selected } = this._buildSeriesAndLegend();
    this._chart.setOption({ series, legend: { selected }, yAxis: this._buildYAxes() });
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
            brushStyle: { color: readThemeColor('--cyan-glow'), borderColor: readThemeColor('--blue-muted'), borderWidth: 1 },
          },
          restore: { title: 'Reset View' },
        },
        iconStyle: { borderColor: readThemeColor('--text-muted') },
        emphasis:  { iconStyle: { borderColor: readThemeColor('--text-dim') } },
      },
      xAxis: {
        type:  'time',
        axisLabel: {
          color:      readThemeColor('--text-dim'),
          fontSize:   11,
          fontFamily: 'monospace',
        },
        splitLine: { show: false },
        axisLine:  { lineStyle: { color: readThemeColor('--border') } },
        axisTick:  { lineStyle: { color: readThemeColor('--border') } },
      },
      yAxis: this._buildYAxes(),
      tooltip: {
        trigger:     'item',
        axisPointer: {
          type:       'cross',
          lineStyle:  { color: readThemeColor('--border-hi') },
          crossStyle: { color: readThemeColor('--border-hi') },
        },
        backgroundColor: readThemeColor('--bg-panel2'),
        borderColor:     readThemeColor('--border-hi'),
        borderWidth:     1,
        textStyle:       { color: readThemeColor('--text-primary'), fontSize: 11, fontFamily: 'monospace' },
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

    if (this.container.clientWidth === 0 && this.container.clientHeight === 0) {
      this._ro = new ResizeObserver((entries) => {
        const r = entries[0]?.contentRect;
        if (r?.width > 0 || r?.height > 0) {
          this._ro.disconnect();
          this._ro = null;
          this._initChart();
        }
      });
      this._ro.observe(this.container);
      return;
    }

    this._chart = echarts.init(this.container, null, { renderer: 'canvas' });

    // Auto-resize when the container's dimensions change (covers tab-switch and pane-resize).
    this._ro = new ResizeObserver(() => this._chart?.resize());
    this._ro.observe(this.container);

    this._applyBaseOptions();
    if (this._seriesMap.size > 0) this._doChartUpdate();
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
          `<span style="font-size:10px;color:${readThemeColor('--text-muted')}">${dateStr}</span>`
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
