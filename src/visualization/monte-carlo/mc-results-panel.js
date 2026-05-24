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
import 'chartjs-adapter-date-fns';
import { BaseComponent } from '../components/base-component.js';

Chart.register(...registerables);

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
    this._histChart  = null;
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
    if (this._fanChart)  { this._fanChart.destroy();  this._fanChart  = null; }
    if (this._histChart) { this._histChart.destroy(); this._histChart = null; }
    if (this._wrapperEl) { this._wrapperEl.remove();  this._wrapperEl = null; }
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
    if (fanData) {
      const label = document.createElement('div');
      label.style.cssText =
        'font-size:11px;color:#475569;font-family:monospace;padding:2px 0;flex-shrink:0';
      label.textContent = 'Net Worth — Confidence Bands';
      wrapper.appendChild(label);

      const fanWrap = document.createElement('div');
      fanWrap.style.cssText = 'position:relative;height:260px;flex-shrink:0';
      const fanCanvas = document.createElement('canvas');
      fanWrap.appendChild(fanCanvas);
      wrapper.appendChild(fanWrap);
      this._fanChart = this._createFanChart(fanCanvas, fanData);
    }

    const histData = this._buildHistData(runs);
    if (histData.data.length) {
      const label = document.createElement('div');
      label.style.cssText =
        'font-size:11px;color:#475569;font-family:monospace;padding:2px 0;flex-shrink:0';
      label.textContent = 'Terminal Net Worth Distribution';
      wrapper.appendChild(label);

      const histWrap = document.createElement('div');
      histWrap.style.cssText = 'position:relative;height:160px;flex-shrink:0';
      const histCanvas = document.createElement('canvas');
      histWrap.appendChild(histCanvas);
      wrapper.appendChild(histWrap);
      this._histChart = this._createHistChart(histCanvas, histData);
    }

    this._container.appendChild(wrapper);
  }

  _buildBadges(summary, n) {
    const badges = [
      { label: 'Success Rate',   value: fmtPct(summary.successRate),          color: '#4ade80' },
      { label: 'Failures',       value: String(summary.failureCount ?? 0),    color: '#f87171' },
      { label: 'Median Failure', value: fmtDate(summary.medianOutOfFundsDate), color: '#fbbf24' },
      { label: 'P90 Net Worth',  value: fmtDollar(summary.p90),               color: '#94a3b8' },
      { label: 'P50 Net Worth',  value: fmtDollar(summary.p50),               color: '#94a3b8' },
      { label: 'P10 Net Worth',  value: fmtDollar(summary.p10),               color: '#94a3b8' },
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
      const date = new Date(ts);
      p10.push({ x: date, y: quantile(vals, 0.10) });
      p25.push({ x: date, y: quantile(vals, 0.25) });
      p50.push({ x: date, y: quantile(vals, 0.50) });
      p75.push({ x: date, y: quantile(vals, 0.75) });
      p90.push({ x: date, y: quantile(vals, 0.90) });
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

    const counts  = new Array(HIST_BUCKETS).fill(0);
    const bucketMins = counts.map((_, i) => min + i * bucketSize);
    for (const v of values) {
      const idx = Math.min(Math.floor((v - min) / bucketSize), HIST_BUCKETS - 1);
      counts[idx]++;
    }

    return {
      labels:    bucketMins.map(v => fmtK(v)),
      data:      counts,
      bucketMins,
      min,
      bucketSize,
    };
  }

  _createFanChart(canvas, { p10, p25, p50, p75, p90 }) {
    return new Chart(canvas, {
      type: 'line',
      data: {
        datasets: [
          {
            label: 'P90',
            data: p90,
            fill: 1,
            borderColor: 'rgba(96,165,250,0.25)',
            borderWidth: 1,
            backgroundColor: 'rgba(59,130,246,0.07)',
            pointRadius: 0,
            tension: 0.3,
          },
          {
            label: 'P75',
            data: p75,
            fill: 2,
            borderColor: 'rgba(96,165,250,0.35)',
            borderWidth: 1,
            backgroundColor: 'rgba(59,130,246,0.12)',
            pointRadius: 0,
            tension: 0.3,
          },
          {
            label: 'P25',
            data: p25,
            fill: 3,
            borderColor: 'rgba(96,165,250,0.35)',
            borderWidth: 1,
            backgroundColor: 'rgba(59,130,246,0.12)',
            pointRadius: 0,
            tension: 0.3,
          },
          {
            label: 'P10',
            data: p10,
            fill: false,
            borderColor: 'rgba(96,165,250,0.25)',
            borderWidth: 1,
            pointRadius: 0,
            tension: 0.3,
          },
          {
            label: 'Median (P50)',
            data: p50,
            fill: false,
            borderColor: '#60a5fa',
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            labels: { color: '#64748b', font: { size: 10, family: 'monospace' }, boxWidth: 12 },
          },
          tooltip: {
            callbacks: {
              label: ctx => `${ctx.dataset.label}: ${fmtK(ctx.parsed.y)}`,
            },
          },
        },
        scales: {
          x: {
            type: 'time',
            time: { unit: 'year', displayFormats: { year: 'yyyy' } },
            grid: { color: '#1e293b' },
            ticks: { color: '#475569', font: { size: 10, family: 'monospace' } },
          },
          y: {
            grid: { color: '#1e293b' },
            ticks: {
              color: '#475569',
              font: { size: 10, family: 'monospace' },
              callback: v => fmtK(v),
            },
          },
        },
      },
    });
  }

  _createHistChart(canvas, { labels, data, bucketMins }) {
    const colors = bucketMins.map(lo =>
      lo < 0 ? 'rgba(248,113,113,0.7)' : 'rgba(96,165,250,0.7)'
    );
    const borderColors = bucketMins.map(lo =>
      lo < 0 ? 'rgba(248,113,113,0.9)' : 'rgba(96,165,250,0.9)'
    );

    return new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Runs',
          data,
          backgroundColor: colors,
          borderColor:      borderColors,
          borderWidth: 1,
          borderRadius: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => `${ctx.parsed.y} run${ctx.parsed.y !== 1 ? 's' : ''}`,
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              color: '#475569',
              font: { size: 9, family: 'monospace' },
              maxRotation: 45,
              autoSkip: true,
              maxTicksLimit: 10,
            },
          },
          y: {
            grid: { color: '#1e293b' },
            ticks: { color: '#475569', font: { size: 10, family: 'monospace' } },
          },
        },
      },
    });
  }
}
