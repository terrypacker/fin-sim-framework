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

const HIST_BUCKETS = 20;

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const idx = q * (sorted.length - 1);
  const lo  = Math.floor(idx);
  const hi  = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (hi - idx) + sorted[hi] * (idx - lo);
}

function fmtK(v) {
  const abs  = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1_000_000) return sign + '$' + (abs / 1_000_000).toFixed(1) + 'M';
  return sign + '$' + (abs / 1000).toFixed(0) + 'k';
}

function fmtDollar(v) {
  if (v == null) return '—';
  return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function fmtPct(v) { return v == null ? '—' : (v * 100).toFixed(1) + '%'; }
function fmtDate(v) { return v instanceof Date ? v.toISOString().slice(0, 7) : '—'; }

/**
 * McResultsPanel — center pane of the MC tab.
 *
 * Displays:
 *   1. Metric badges (success rate, failure count, P10/P50/P90 net worth)
 *   2. Fan chart — P10/P25/P50/P75/P90 confidence bands over time
 *   3. Histogram — terminal net worth distribution
 *
 * Public API:
 *   showResults(summary, runs) — populate all three components
 *   clearResults()             — restore idle placeholder
 */
export class McResultsPanel extends BaseComponent {
  constructor(containerEl) {
    super();
    this._container  = containerEl;
    this._fanChart   = null;
    this._fanChartRo = null;
    this._histChart  = null;
    this._histChartRo = null;
    this._wrapperEl  = null;

    this._renderIdle();
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  clearResults() {
    this._destroyCharts();
    this._renderIdle();
  }

  showResults(summary, runs) {
    this._destroyCharts();
    this._renderResults(summary, runs);
  }

  destroy() {
    this._destroyCharts();
    super.destroy();
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  _destroyCharts() {
    if (this._fanChartRo)  { this._fanChartRo.disconnect();  this._fanChartRo  = null; }
    if (this._histChartRo) { this._histChartRo.disconnect(); this._histChartRo = null; }
    if (this._fanChart)    { this._fanChart.dispose();       this._fanChart    = null; }
    if (this._histChart)   { this._histChart.dispose();      this._histChart   = null; }
    if (this._wrapperEl)   { this._wrapperEl.remove();       this._wrapperEl   = null; }
    this._container.innerHTML = '';
  }

  _renderIdle() {
    this._container.innerHTML =
      '<div style="display:flex;height:100%;align-items:center;justify-content:center">' +
      '<span style="color:#475569;font-size:13px;font-family:monospace">' +
      'Configure and run Monte Carlo to see results.' +
      '</span></div>';
  }

  _renderResults(summary, runs) {
    const wrapper = document.createElement('div');
    wrapper.style.cssText =
      'height:100%;display:flex;flex-direction:column;padding:8px;gap:8px;overflow-y:auto;overflow-x:hidden';
    this._wrapperEl = wrapper;

    wrapper.appendChild(this._buildBadges(summary, runs.length));

    const fanData = this._buildFanData(runs);
    let fanDiv = null;
    if (fanData) {
      const label = document.createElement('div');
      label.style.cssText =
        'font-size:11px;color:#475569;font-family:monospace;padding:2px 0;flex-shrink:0';
      label.textContent = 'Net Worth — Confidence Bands';
      wrapper.appendChild(label);

      const fanWrap = document.createElement('div');
      fanWrap.style.cssText = 'height:260px;flex-shrink:0';
      fanDiv = document.createElement('div');
      fanDiv.style.cssText = 'width:100%;height:100%';
      fanWrap.appendChild(fanDiv);
      wrapper.appendChild(fanWrap);
    }

    const histData = this._buildHistData(runs);
    let histDiv = null;
    if (histData.data.length) {
      const label = document.createElement('div');
      label.style.cssText =
        'font-size:11px;color:#475569;font-family:monospace;padding:2px 0;flex-shrink:0';
      label.textContent = 'Terminal Net Worth Distribution';
      wrapper.appendChild(label);

      const histWrap = document.createElement('div');
      histWrap.style.cssText = 'height:160px;flex-shrink:0';
      histDiv = document.createElement('div');
      histDiv.style.cssText = 'width:100%;height:100%';
      histWrap.appendChild(histDiv);
      wrapper.appendChild(histWrap);
    }

    // Append to DOM first so ECharts can measure real container dimensions.
    this._container.appendChild(wrapper);

    if (fanDiv) {
      this._fanChart   = this._createFanChart(fanDiv, fanData);
      this._fanChartRo = new ResizeObserver(() => this._fanChart?.resize());
      this._fanChartRo.observe(fanDiv);
    }
    if (histDiv) {
      this._histChart   = this._createHistChart(histDiv, histData);
      this._histChartRo = new ResizeObserver(() => this._histChart?.resize());
      this._histChartRo.observe(histDiv);
    }
  }

  _buildBadges(summary, n) {
    const badges = [
      { label: 'Success Rate',   value: fmtPct(summary.successRate),           color: '#4ade80' },
      { label: 'Failures',       value: String(summary.failureCount ?? 0),     color: '#f87171' },
      { label: 'Median Failure', value: fmtDate(summary.medianOutOfFundsDate), color: '#fbbf24' },
      { label: 'P90 Net Worth',  value: fmtDollar(summary.p90),                color: '#94a3b8' },
      { label: 'P50 Net Worth',  value: fmtDollar(summary.p50),                color: '#94a3b8' },
      { label: 'P10 Net Worth',  value: fmtDollar(summary.p10),                color: '#94a3b8' },
    ];

    const header = document.createElement('div');
    header.style.cssText =
      'font-size:10px;color:#475569;font-family:monospace;margin-bottom:2px;flex-shrink:0';
    header.textContent = `Results — ${n} runs`;

    const grid = document.createElement('div');
    grid.style.cssText =
      'display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;flex-shrink:0';

    for (const b of badges) {
      const card = document.createElement('div');
      card.style.cssText =
        'background:#0f172a;border:1px solid #1e293b;border-radius:4px;' +
        'padding:6px 8px;text-align:center;min-width:0';
      card.innerHTML =
        `<div style="font-size:9px;color:#475569;font-family:monospace;margin-bottom:2px;` +
        `overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${b.label}</div>` +
        `<div style="font-size:12px;font-weight:600;color:${b.color};font-family:monospace;` +
        `overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${b.value}</div>`;
      grid.appendChild(card);
    }

    const wrap = document.createElement('div');
    wrap.appendChild(header);
    wrap.appendChild(grid);
    return wrap;
  }

  _buildFanData(runs) {
    const dateMap = new Map();
    for (const run of runs) {
      if (!run.timeSeries?.length) continue;
      for (const pt of run.timeSeries) {
        const ts = pt.date.getTime();
        if (!dateMap.has(ts)) dateMap.set(ts, []);
        dateMap.get(ts).push(pt.netWorthUsd);
      }
    }
    if (!dateMap.size) return null;

    const sortedTs = [...dateMap.keys()].sort((a, b) => a - b);
    const p10 = [], p25 = [], p50 = [], p75 = [], p90 = [];

    for (const ts of sortedTs) {
      const vals = dateMap.get(ts).slice().sort((a, b) => a - b);
      p10.push([ts, quantile(vals, 0.10)]);
      p25.push([ts, quantile(vals, 0.25)]);
      p50.push([ts, quantile(vals, 0.50)]);
      p75.push([ts, quantile(vals, 0.75)]);
      p90.push([ts, quantile(vals, 0.90)]);
    }
    return { p10, p25, p50, p75, p90 };
  }

  _buildHistData(runs) {
    const values = runs
      .map(r => r.finalNetWorthUsd)
      .filter(v => v != null && isFinite(v));
    if (!values.length) return { labels: [], data: [], min: 0, bucketSize: 0 };

    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const bucketSize = range / HIST_BUCKETS;

    const counts    = new Array(HIST_BUCKETS).fill(0);
    const bucketMins = counts.map((_, i) => min + i * bucketSize);
    for (const v of values) {
      const idx = Math.min(Math.floor((v - min) / bucketSize), HIST_BUCKETS - 1);
      counts[idx]++;
    }

    return {
      labels:    bucketMins.map(v => fmtK(v)),
      data:      counts,
      bucketMins,
    };
  }

  _createFanChart(container, { p10, p25, p50, p75, p90 }) {
    // Confidence band data uses the stacking trick: base (invisible) + delta fill
    const outerBase = p10;
    const outerFill = p10.map(([ts, lo], i) => [ts, p90[i][1] - lo]);
    const innerBase = p25;
    const innerFill = p25.map(([ts, lo], i) => [ts, p75[i][1] - lo]);

    // Tooltip lookup by exact timestamp from P50 series
    const tipMap = new Map(p50.map(([ts, v], i) => [ts, {
      p10: p10[i][1], p25: p25[i][1], p50: v, p75: p75[i][1], p90: p90[i][1]
    }]));

    const baseSeriesOpts = {
      type: 'line', symbol: 'none', smooth: true,
      lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 },
      emphasis: { disabled: true }, tooltip: { show: false },
    };

    const chart = echarts.init(container, null, { renderer: 'canvas' });
    chart.setOption({
      backgroundColor: 'transparent',
      animation: false,
      grid: { top: 24, right: 16, bottom: 36, left: 16, containLabel: true },
      xAxis: {
        type: 'time',
        axisLabel: { color: '#475569', fontSize: 10, fontFamily: 'monospace' },
        splitLine: { show: false },
        axisLine: { lineStyle: { color: '#1e293b' } },
        axisTick: { lineStyle: { color: '#1e293b' } },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: '#475569', fontSize: 10, fontFamily: 'monospace', formatter: v => fmtK(v) },
        splitLine: { lineStyle: { color: '#1e293b' } },
        axisLine: { show: false },
        axisTick: { show: false },
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#1e293b',
        borderColor: '#334155',
        borderWidth: 1,
        textStyle: { color: '#e2e8f0', fontSize: 10, fontFamily: 'monospace' },
        axisPointer: { lineStyle: { color: 'rgba(148,163,184,0.3)' } },
        formatter: params => {
          const p50param = params.find(p => p.seriesId === 'p50');
          if (!p50param) return '';
          const pt = tipMap.get(p50param.value[0]);
          if (!pt) return '';
          const d  = new Date(p50param.value[0]);
          const ds = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
          return `<span style="font-size:10px;color:#64748b">${ds}</span><br/>` +
            `P90: <b>${fmtK(pt.p90)}</b><br/>P75: <b>${fmtK(pt.p75)}</b><br/>` +
            `P50: <b>${fmtK(pt.p50)}</b><br/>P25: <b>${fmtK(pt.p25)}</b><br/>` +
            `P10: <b>${fmtK(pt.p10)}</b>`;
        },
      },
      series: [
        // Outer band P10→P90
        { ...baseSeriesOpts, id: 'outer-base', data: outerBase, stack: 'outer' },
        { ...baseSeriesOpts, id: 'outer-fill', data: outerFill, stack: 'outer',
          lineStyle: { opacity: 0 }, areaStyle: { color: 'rgba(59,130,246,0.09)', opacity: 1 } },
        // Inner band P25→P75
        { ...baseSeriesOpts, id: 'inner-base', data: innerBase, stack: 'inner' },
        { ...baseSeriesOpts, id: 'inner-fill', data: innerFill, stack: 'inner',
          lineStyle: { opacity: 0 }, areaStyle: { color: 'rgba(59,130,246,0.16)', opacity: 1 } },
        // Outer edge lines
        { id: 'p90-line', type: 'line', data: p90, symbol: 'none', smooth: true,
          lineStyle: { color: 'rgba(96,165,250,0.28)', width: 1 }, tooltip: { show: false } },
        { id: 'p10-line', type: 'line', data: p10, symbol: 'none', smooth: true,
          lineStyle: { color: 'rgba(96,165,250,0.28)', width: 1 }, tooltip: { show: false } },
        // P50 median
        { id: 'p50', name: 'Median (P50)', type: 'line', data: p50, symbol: 'none', smooth: true,
          lineStyle: { color: '#60a5fa', width: 2.5 } },
      ],
    });
    return chart;
  }

  _createHistChart(container, { labels, data, bucketMins }) {
    const chart = echarts.init(container, null, { renderer: 'canvas' });
    chart.setOption({
      backgroundColor: 'transparent',
      animation: false,
      grid: { top: 10, right: 16, bottom: 60, left: 16, containLabel: true },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: {
          color: '#475569', fontSize: 9, fontFamily: 'monospace',
          rotate: 45,
          interval: Math.max(0, Math.floor(labels.length / 10) - 1),
        },
        splitLine: { show: false },
        axisLine: { lineStyle: { color: '#1e293b' } },
        axisTick: { lineStyle: { color: '#1e293b' } },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: '#475569', fontSize: 10, fontFamily: 'monospace' },
        splitLine: { lineStyle: { color: '#1e293b' } },
        axisLine: { show: false },
        axisTick: { show: false },
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#1e293b',
        borderColor: '#334155',
        borderWidth: 1,
        textStyle: { color: '#e2e8f0', fontSize: 10, fontFamily: 'monospace' },
        formatter: params => {
          const n = params[0]?.value;
          return `${params[0]?.name}: <b>${n} run${n !== 1 ? 's' : ''}</b>`;
        },
      },
      series: [{
        type: 'bar',
        data: data.map((v, i) => ({
          value: v,
          itemStyle: {
            color: bucketMins[i] < 0 ? 'rgba(248,113,113,0.75)' : 'rgba(96,165,250,0.75)',
          },
        })),
        barMaxWidth: 40,
        itemStyle: { borderRadius: [2, 2, 0, 0] },
      }],
    });
    return chart;
  }
}
