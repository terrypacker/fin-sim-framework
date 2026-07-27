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
import { readThemeColor } from '../theme.js';
import { initEChartWhenReady } from '../components/echarts-init.js';
import { fmtCompact, fmtWhole } from '../money-format.js';

const HIST_BUCKETS = 20;

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const idx = q * (sorted.length - 1);
  const lo  = Math.floor(idx);
  const hi  = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (hi - idx) + sorted[hi] * (idx - lo);
}

const fmtK      = (v) => fmtCompact(v);
const fmtDollar = (v) => fmtWhole(v);

function fmtPct(v) { return v == null ? '—' : (v * 100).toFixed(1) + '%'; }
function fmtDate(v) { return v instanceof Date ? v.toISOString().slice(0, 7) : '—'; }

const METRIC_LABELS = {
  netWorthUsd:  'Net Worth',
  netLiquidity: 'Net Liquidity',
};

/**
 * McResultsPanel — center pane of the MC tab.
 *
 * Displays:
 *   1. Metric toggle + badges (success rate, failure count, P10/P50/P90)
 *   2. Fan chart — P10/P25/P50/P75/P90 confidence bands over time
 *   3. Histogram — terminal value distribution
 *
 * Public API:
 *   showResults(summary, runs) — populate all three components
 *   clearResults()             — restore idle placeholder
 *   onMetricChange             — callback(metric) fired when the user switches metrics
 */
export class McResultsPanel extends BaseComponent {
  constructor(containerEl) {
    super();
    this._container       = containerEl;
    this._fanChart        = null;
    this._fanChartRo      = null;
    this._histChart       = null;
    this._histChartRo     = null;
    this._wrapperEl       = null;
    this._metric          = 'netWorthUsd';
    this._fanDataByMetric = {};
    this._histDataByMetric = {};
    this._runs            = null;
    this._summary         = null;
    this._badgeGridEl     = null;
    this._fanLabelEl      = null;
    this._histLabelEl     = null;
    this._fanDiv          = null;
    this._histDiv         = null;

    /** Callback fired when the user toggles metrics: onMetricChange(metric) */
    this.onMetricChange = null;

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
    this._fanDataByMetric  = {};
    this._histDataByMetric = {};
    this._runs             = null;
    this._summary          = null;
    this._badgeGridEl      = null;
    this._fanLabelEl       = null;
    this._histLabelEl      = null;
    this._fanDiv           = null;
    this._histDiv          = null;
    this._container.innerHTML = '';
  }

  _renderIdle() {
    this._container.innerHTML =
      '<div class="mc-idle-msg"><span>Configure and run Monte Carlo to see results.</span></div>';
  }

  /**
   * A badge stating, positively, which world these results describe.
   *
   * The banner below only appears when something is wrong, and silence is ambiguous:
   * it reads the same whether the run was verified against the plan or nobody ever
   * checked. This says which — so "on scenario" is a claim the panel makes, not an
   * assumption the reader brings. Absent only when the runner reported no provenance
   * at all (an older result, or a caller that doesn't produce one).
   */
  _buildProvenanceBadge(provenance) {
    if (!provenance) return null;
    const off = (provenance.syntheticCenters?.length ?? 0) + (provenance.divergentCenters?.length ?? 0);
    const el = document.createElement('span');
    el.className   = `mc-provenance-badge${provenance.fromScenario ? '' : ' mc-provenance-badge--off'}`;
    el.textContent = provenance.fromScenario ? 'on scenario' : `⚠ off-plan (${off})`;
    el.title       = provenance.fromScenario
      ? 'Every sampled variable was centered on this scenario\'s own values.'
      : 'Some variables were centered away from this scenario — see the note below.';
    return el;
  }

  /**
   * A banner naming the world these results describe, when it is NOT simply the
   * plan as written (see summarizeProvenance). A failure rate sampled around
   * framework defaults or user-set centers is an answer about a different plan, and
   * charts alone can't show that — so it is labelled on the results themselves
   * rather than left to the reader's assumption. Returns null when nothing to say.
   */
  _buildProvenanceBanner(provenance) {
    if (!provenance || provenance.fromScenario) return null;
    const notes = [];
    if (provenance.syntheticCenters?.length) {
      notes.push(`${provenance.syntheticCenters.length} variable(s) sampled around FRAMEWORK DEFAULTS `
        + `(not in this scenario): ${provenance.syntheticCenters.join(', ')}`);
    }
    if (provenance.divergentCenters?.length) {
      notes.push('centers set away from the scenario value: '
        + provenance.divergentCenters.map(d => `${d.paramKey} (${d.center} vs ${d.scenarioValue})`).join(', '));
    }
    if (notes.length === 0) return null;

    const el = document.createElement('div');
    el.className = 'mc-provenance-banner';
    el.textContent = `⚠ Not centered on the plan as written — ${notes.join('; ')}.`;
    el.title = notes.join('\n');
    return el;
  }

  _renderResults(summary, runs) {
    this._runs    = runs;
    this._summary = summary;

    this._fanDataByMetric  = {
      netWorthUsd:  this._buildFanData(runs, 'netWorthUsd'),
      netLiquidity: this._buildFanData(runs, 'netLiquidity'),
    };
    this._histDataByMetric = {
      netWorthUsd:  this._buildHistData(runs, 'netWorthUsd'),
      netLiquidity: this._buildHistData(runs, 'netLiquidity'),
    };

    const wrapper = document.createElement('div');
    wrapper.className = 'mc-results-wrapper';
    this._wrapperEl = wrapper;

    // ── Header row: "Results — N runs" + metric toggle ────────────────────────
    const headerRow = document.createElement('div');
    headerRow.className = 'mc-results-header-row';

    const header = document.createElement('div');
    header.className = 'mc-results-header';
    header.textContent = `Results — ${runs.length} runs`;

    const toggle = this._buildToggle();
    const badge  = this._buildProvenanceBadge(summary?.provenance);
    headerRow.append(header, ...(badge ? [badge] : []), toggle);
    wrapper.appendChild(headerRow);

    const provenance = this._buildProvenanceBanner(summary?.provenance);
    if (provenance) wrapper.appendChild(provenance);

    // ── Badge grid ─────────────────────────────────────────────────────────────
    const badgeGrid = document.createElement('div');
    badgeGrid.className = 'mc-badge-grid';
    this._badgeGridEl = badgeGrid;
    this._populateBadgeGrid(badgeGrid);
    wrapper.appendChild(badgeGrid);

    // ── Fan chart ──────────────────────────────────────────────────────────────
    const hasFan = this._fanDataByMetric.netWorthUsd || this._fanDataByMetric.netLiquidity;
    if (hasFan) {
      const fanLabel = document.createElement('div');
      fanLabel.className = 'mc-section-label';
      fanLabel.textContent = `${METRIC_LABELS[this._metric]} — Confidence Bands`;
      this._fanLabelEl = fanLabel;
      wrapper.appendChild(fanLabel);

      const fanWrap = document.createElement('div');
      fanWrap.className = 'mc-fan-wrap';
      const fanDiv = document.createElement('div');
      fanDiv.className = 'mc-chart-fill';
      this._fanDiv = fanDiv;
      fanWrap.appendChild(fanDiv);
      wrapper.appendChild(fanWrap);
    }

    // ── Histogram ──────────────────────────────────────────────────────────────
    const histData = this._histDataByMetric[this._metric];
    if (histData?.data.length) {
      const histLabel = document.createElement('div');
      histLabel.className = 'mc-section-label';
      histLabel.textContent = `Terminal ${METRIC_LABELS[this._metric]} Distribution`;
      this._histLabelEl = histLabel;
      wrapper.appendChild(histLabel);

      const histWrap = document.createElement('div');
      histWrap.className = 'mc-hist-wrap';
      const histDiv = document.createElement('div');
      histDiv.className = 'mc-chart-fill';
      this._histDiv = histDiv;
      histWrap.appendChild(histDiv);
      wrapper.appendChild(histWrap);
    }

    this._container.appendChild(wrapper);

    if (this._fanDiv) {
      this._fanChartRo = initEChartWhenReady(this._fanDiv, () => {
        const data = this._fanDataByMetric[this._metric];
        if (data) this._fanChart = this._createFanChart(this._fanDiv, data);
        const ro = new ResizeObserver(() => this._fanChart?.resize());
        ro.observe(this._fanDiv);
        this._fanChartRo = ro;
      });
    }
    if (this._histDiv) {
      this._histChartRo = initEChartWhenReady(this._histDiv, () => {
        const data = this._histDataByMetric[this._metric];
        if (data) this._histChart = this._createHistChart(this._histDiv, data);
        const ro = new ResizeObserver(() => this._histChart?.resize());
        ro.observe(this._histDiv);
        this._histChartRo = ro;
      });
    }
  }

  _buildToggle() {
    const toggle = document.createElement('div');
    toggle.className = 'mc-metric-toggle';

    for (const [metric, label] of Object.entries(METRIC_LABELS)) {
      const btn = document.createElement('button');
      btn.className = 'mc-metric-btn' + (metric === this._metric ? ' mc-metric-btn--active' : '');
      btn.textContent = label;
      btn.dataset.metric = metric;
      btn.addEventListener('click', () => this._switchMetric(metric, toggle));
      toggle.appendChild(btn);
    }
    return toggle;
  }

  _switchMetric(metric, toggleEl) {
    if (metric === this._metric) return;
    this._metric = metric;

    // Update toggle button states
    for (const btn of toggleEl.querySelectorAll('.mc-metric-btn')) {
      btn.classList.toggle('mc-metric-btn--active', btn.dataset.metric === metric);
    }

    // Update section labels
    if (this._fanLabelEl)  this._fanLabelEl.textContent  = `${METRIC_LABELS[metric]} — Confidence Bands`;
    if (this._histLabelEl) this._histLabelEl.textContent = `Terminal ${METRIC_LABELS[metric]} Distribution`;

    // Update badge grid
    if (this._badgeGridEl) this._populateBadgeGrid(this._badgeGridEl);

    // Refresh charts
    this._refreshFanChart();
    this._refreshHistChart();

    if (this.onMetricChange) this.onMetricChange(metric);
  }

  _populateBadgeGrid(grid) {
    const metric  = this._metric;
    const summary = this._summary;
    const runs    = this._runs;

    let p10, p50, p90;
    if (metric === 'netLiquidity') {
      const vals = (runs ?? [])
        .map(r => r.finalNetLiquidity)
        .filter(v => v != null && isFinite(v))
        .sort((a, b) => a - b);
      p10 = quantile(vals, 0.10);
      p50 = quantile(vals, 0.50);
      p90 = quantile(vals, 0.90);
    } else {
      p10 = summary?.p10;
      p50 = summary?.p50;
      p90 = summary?.p90;
    }

    const metricLabel = METRIC_LABELS[metric];
    const badges = [
      { label: 'Success Rate',              value: fmtPct(summary?.successRate),           cls: 'mc-badge-value--success' },
      { label: 'Failures',                  value: String(summary?.failureCount ?? 0),     cls: 'mc-badge-value--failure' },
      { label: 'Median Failure',            value: fmtDate(summary?.medianOutOfFundsDate), cls: 'mc-badge-value--warning' },
      { label: `P90 ${metricLabel}`,        value: fmtDollar(p90),                         cls: 'mc-badge-value--muted'   },
      { label: `P50 ${metricLabel}`,        value: fmtDollar(p50),                         cls: 'mc-badge-value--muted'   },
      { label: `P10 ${metricLabel}`,        value: fmtDollar(p10),                         cls: 'mc-badge-value--muted'   },
    ];

    grid.innerHTML = '';
    for (const b of badges) {
      const card = document.createElement('div');
      card.className = 'mc-badge-card';
      card.innerHTML =
        `<div class="mc-badge-label">${b.label}</div>` +
        `<div class="mc-badge-value ${b.cls}">${b.value}</div>`;
      grid.appendChild(card);
    }
  }

  _refreshFanChart() {
    if (!this._fanDiv) return;
    const data = this._fanDataByMetric[this._metric];
    if (!data) return;
    if (this._fanChart) { this._fanChart.dispose(); this._fanChart = null; }
    this._fanChart = this._createFanChart(this._fanDiv, data);
  }

  _refreshHistChart() {
    if (!this._histDiv) return;
    const data = this._histDataByMetric[this._metric];
    if (!data) return;
    if (this._histChart) { this._histChart.dispose(); this._histChart = null; }
    this._histChart = this._createHistChart(this._histDiv, data);
  }

  _buildFanData(runs, metric) {
    const dateMap = new Map();
    for (const run of runs) {
      if (!run.timeSeries?.length) continue;
      for (const pt of run.timeSeries) {
        const val = pt[metric];
        if (val == null) continue;
        const ts = pt.date.getTime();
        if (!dateMap.has(ts)) dateMap.set(ts, []);
        dateMap.get(ts).push(val);
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

  _buildHistData(runs, metric) {
    const field = metric === 'netLiquidity' ? 'finalNetLiquidity' : 'finalNetWorthUsd';
    const values = runs
      .map(r => r[field])
      .filter(v => v != null && isFinite(v));
    if (!values.length) return { labels: [], data: [], min: 0, bucketSize: 0 };

    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const bucketSize = range / HIST_BUCKETS;

    const counts     = new Array(HIST_BUCKETS).fill(0);
    const bucketMins = counts.map((_, i) => min + i * bucketSize);
    for (const v of values) {
      const idx = Math.min(Math.floor((v - min) / bucketSize), HIST_BUCKETS - 1);
      counts[idx]++;
    }

    return { labels: bucketMins.map(v => fmtK(v)), data: counts, bucketMins };
  }

  _createFanChart(container, { p10, p25, p50, p75, p90 }) {
    const outerBase = p10;
    const outerFill = p10.map(([ts, lo], i) => [ts, p90[i][1] - lo]);
    const innerBase = p25;
    const innerFill = p25.map(([ts, lo], i) => [ts, p75[i][1] - lo]);

    const tipMap = new Map(p50.map(([ts, v], i) => [ts, {
      p10: p10[i][1], p25: p25[i][1], p50: v, p75: p75[i][1], p90: p90[i][1]
    }]));

    const baseSeriesOpts = {
      type: 'line', symbol: 'none', smooth: true,
      lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 },
      emphasis: { disabled: true }, tooltip: { show: false },
    };

    const blueMuted  = readThemeColor('--blue-muted');
    const textDim    = readThemeColor('--text-dim');
    const border     = readThemeColor('--border');
    const borderHi   = readThemeColor('--border-hi');
    const textPrim   = readThemeColor('--text-primary');
    const textMuted  = readThemeColor('--text-muted');
    const bgPanel2   = readThemeColor('--bg-panel2');

    const chart = echarts.init(container, null, { renderer: 'canvas' });
    chart.setOption({
      backgroundColor: 'transparent',
      animation: false,
      grid: { top: 24, right: 16, bottom: 36, left: 16, containLabel: true },
      xAxis: {
        type: 'time',
        axisLabel: { color: textDim, fontSize: 10, fontFamily: 'monospace' },
        splitLine: { show: false },
        axisLine: { lineStyle: { color: border } },
        axisTick: { lineStyle: { color: border } },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: textDim, fontSize: 10, fontFamily: 'monospace', formatter: v => fmtK(v) },
        splitLine: { lineStyle: { color: border } },
        axisLine: { show: false },
        axisTick: { show: false },
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: bgPanel2,
        borderColor: borderHi,
        borderWidth: 1,
        textStyle: { color: textPrim, fontSize: 10, fontFamily: 'monospace' },
        axisPointer: { lineStyle: { color: textMuted + '4d' } },
        formatter: params => {
          const p50param = params.find(p => p.seriesId === 'p50');
          if (!p50param) return '';
          const pt = tipMap.get(p50param.value[0]);
          if (!pt) return '';
          const d  = new Date(p50param.value[0]);
          const ds = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
          return `<span style="font-size:10px;color:${textMuted}">${ds}</span><br/>` +
            `P90: <b>${fmtK(pt.p90)}</b><br/>P75: <b>${fmtK(pt.p75)}</b><br/>` +
            `P50: <b>${fmtK(pt.p50)}</b><br/>P25: <b>${fmtK(pt.p25)}</b><br/>` +
            `P10: <b>${fmtK(pt.p10)}</b>`;
        },
      },
      series: [
        { ...baseSeriesOpts, id: 'outer-base', data: outerBase, stack: 'outer' },
        { ...baseSeriesOpts, id: 'outer-fill', data: outerFill, stack: 'outer',
          lineStyle: { opacity: 0 }, areaStyle: { color: blueMuted + '17', opacity: 1 } },
        { ...baseSeriesOpts, id: 'inner-base', data: innerBase, stack: 'inner' },
        { ...baseSeriesOpts, id: 'inner-fill', data: innerFill, stack: 'inner',
          lineStyle: { opacity: 0 }, areaStyle: { color: blueMuted + '29', opacity: 1 } },
        { id: 'p90-line', type: 'line', data: p90, symbol: 'none', smooth: true,
          lineStyle: { color: blueMuted + '47', width: 1 }, tooltip: { show: false } },
        { id: 'p10-line', type: 'line', data: p10, symbol: 'none', smooth: true,
          lineStyle: { color: blueMuted + '47', width: 1 }, tooltip: { show: false } },
        { id: 'p50', name: 'Median (P50)', type: 'line', data: p50, symbol: 'none', smooth: true,
          lineStyle: { color: blueMuted, width: 2.5 } },
      ],
    });
    return chart;
  }

  _createHistChart(container, { labels, data, bucketMins }) {
    const textDim   = readThemeColor('--text-dim');
    const border    = readThemeColor('--border');
    const borderHi  = readThemeColor('--border-hi');
    const textPrim  = readThemeColor('--text-primary');
    const bgPanel2  = readThemeColor('--bg-panel2');
    const red       = readThemeColor('--red');
    const blueMuted = readThemeColor('--blue-muted');

    const chart = echarts.init(container, null, { renderer: 'canvas' });
    chart.setOption({
      backgroundColor: 'transparent',
      animation: false,
      grid: { top: 10, right: 16, bottom: 60, left: 16, containLabel: true },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: {
          color: textDim, fontSize: 9, fontFamily: 'monospace',
          rotate: 45,
          interval: Math.max(0, Math.floor(labels.length / 10) - 1),
        },
        splitLine: { show: false },
        axisLine: { lineStyle: { color: border } },
        axisTick: { lineStyle: { color: border } },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: textDim, fontSize: 10, fontFamily: 'monospace' },
        splitLine: { lineStyle: { color: border } },
        axisLine: { show: false },
        axisTick: { show: false },
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: bgPanel2,
        borderColor: borderHi,
        borderWidth: 1,
        textStyle: { color: textPrim, fontSize: 10, fontFamily: 'monospace' },
        formatter: params => {
          const n = params[0]?.value;
          return `${params[0]?.name}: <b>${n} run${n !== 1 ? 's' : ''}</b>`;
        },
      },
      series: [{
        type: 'bar',
        data: data.map((v, i) => ({
          value: v,
          itemStyle: { color: bucketMins[i] < 0 ? red + 'bf' : blueMuted + 'bf' },
        })),
        barMaxWidth: 40,
        itemStyle: { borderRadius: [2, 2, 0, 0] },
      }],
    });
    return chart;
  }
}
