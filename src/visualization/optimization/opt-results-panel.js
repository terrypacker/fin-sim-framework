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
import { BaseComponent }        from '../components/base-component.js';
import { OPTIMIZATION_OBJECTIVES } from '../../finance/optimization/optimization-objectives.js';
import { readThemeColor }       from '../theme.js';

const MAX_CHART_BARS = 30;

function fmtDollar(v) {
  if (v == null || !isFinite(v)) return '—';
  return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function fmtK(v) {
  if (!isFinite(v)) return '—';
  const abs  = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1_000_000) return sign + '$' + (abs / 1_000_000).toFixed(1) + 'M';
  return sign + '$' + (abs / 1000).toFixed(0) + 'k';
}

function fmtVal(v) {
  if (typeof v === 'number' && v > 0 && v < 1) return `${(v * 100).toFixed(0)}%`;
  return String(v);
}

function fmtCandidate(candidate) {
  const entries = Object.entries(candidate);
  if (!entries.length) return '(baseline)';
  return entries
    .map(([k, v]) => {
      const shortKey = k
        .replace(/^rothConversion/, '')
        .replace(/([A-Z])/g, m => ` ${m.toLowerCase()}`)
        .trim();
      return `${shortKey}=${fmtVal(v)}`;
    })
    .join(' · ');
}

/**
 * OptResultsPanel — center pane of the Optimization tab.
 *
 * Displays:
 *   1. Summary badges (best score, total runs, failures)
 *   2. Bar chart — candidate scores (top MAX_CHART_BARS)
 *   3. Ranked table — all candidates with metrics
 *
 * Public API:
 *   showResults(result)  — { candidates, best, totalRuns, objective, objectiveKey }
 *   clearResults()       — restore idle placeholder
 */
export class OptResultsPanel extends BaseComponent {
  constructor(containerEl) {
    super();
    this._container  = containerEl;
    this._barChart   = null;
    this._barChartRo = null;
    this._wrapperEl  = null;

    this._renderIdle();
  }

  clearResults() {
    this._destroyChart();
    this._renderIdle();
  }

  showResults(result) {
    this._destroyChart();
    this._renderResults(result);
  }

  destroy() {
    this._destroyChart();
    super.destroy();
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  _destroyChart() {
    if (this._barChartRo) { this._barChartRo.disconnect(); this._barChartRo = null; }
    if (this._barChart)   { this._barChart.dispose();      this._barChart   = null; }
    if (this._wrapperEl)  { this._wrapperEl.remove();      this._wrapperEl  = null; }
    this._container.innerHTML = '';
  }

  _renderIdle() {
    this._container.innerHTML =
      '<div class="opt-idle-msg"><span>Configure and run Optimization to see results.</span></div>';
  }

  _renderResults(result) {
    const { candidates, totalRuns, objective, objectiveKey } = result;
    const objFn = (OPTIMIZATION_OBJECTIVES[objectiveKey] ?? OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH).evaluate;

    const wrapper = document.createElement('div');
    wrapper.className = 'opt-results-wrapper';
    this._wrapperEl = wrapper;

    wrapper.appendChild(this._buildBadges(candidates, totalRuns, objective, objFn));

    const chartLabel = document.createElement('div');
    chartLabel.className = 'opt-section-label';
    chartLabel.textContent = `Candidate Scores (top ${Math.min(candidates.length, MAX_CHART_BARS)})`;
    wrapper.appendChild(chartLabel);

    const chartWrap = document.createElement('div');
    chartWrap.style.cssText = 'height:220px;flex-shrink:0';
    const chartDiv = document.createElement('div');
    chartDiv.style.cssText = 'width:100%;height:100%';
    chartWrap.appendChild(chartDiv);
    wrapper.appendChild(chartWrap);

    const tableLabel = document.createElement('div');
    tableLabel.className = 'opt-section-label';
    tableLabel.textContent = `All ${candidates.length} Candidates`;
    wrapper.appendChild(tableLabel);

    wrapper.appendChild(this._buildTable(candidates, objFn));

    // Append to DOM first so ECharts can measure real container dimensions.
    this._container.appendChild(wrapper);

    this._barChart   = this._createBarChart(chartDiv, candidates, objFn);
    this._barChartRo = new ResizeObserver(() => this._barChart?.resize());
    this._barChartRo.observe(chartDiv);
  }

  _buildBadges(candidates, totalRuns, objectiveLabel, objFn) {
    const best    = candidates[0];
    const worst   = candidates[candidates.length - 1];
    const failures = candidates.filter(c => c.result.scenarioFailed).length;

    const badges = [
      { label: 'Best Score',     value: best  ? fmtDollar(objFn(best.result))  : '—', cls: 'opt-badge-value--best-score' },
      { label: 'Worst Score',    value: worst ? fmtDollar(objFn(worst.result)) : '—', cls: 'opt-badge-value--worst-score' },
      { label: 'Candidates',     value: String(totalRuns),                              cls: 'opt-badge-value--candidates' },
      { label: 'Failures',       value: String(failures),                               cls: failures ? 'opt-badge-value--failures' : 'opt-badge-value--failures-ok' },
      { label: 'Best Net Worth', value: best  ? fmtDollar(best.result.finalNetWorthUsd) : '—', cls: 'opt-badge-value--nw' },
      { label: 'Best Roth Bal',  value: best  ? fmtDollar(best.result.rothFinalBalance)  : '—', cls: 'opt-badge-value--roth' },
    ];

    const header = document.createElement('div');
    header.className = 'opt-section-label';
    header.textContent = `Results — ${objectiveLabel}`;

    const grid = document.createElement('div');
    grid.className = 'opt-badge-grid';

    for (const b of badges) {
      const card = document.createElement('div');
      card.className = 'opt-badge-card';
      card.innerHTML =
        `<div class="opt-badge-label">${b.label}</div>` +
        `<div class="opt-badge-value ${b.cls}">${b.value}</div>`;
      grid.appendChild(card);
    }

    const wrap = document.createElement('div');
    wrap.appendChild(header);
    wrap.appendChild(grid);
    return wrap;
  }

  _createBarChart(container, candidates, objFn) {
    const top        = candidates.slice(0, MAX_CHART_BARS);
    const labels     = top.map((_, i) => `#${i + 1}`);
    const fullLabels = top.map(c => fmtCandidate(c.candidate));
    const data       = top.map(c => objFn(c.result));

    const chart = echarts.init(container, null, { renderer: 'canvas' });
    chart.setOption({
      backgroundColor: 'transparent',
      animation: false,
      grid: { top: 10, right: 16, bottom: 50, left: 16, containLabel: true },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: { color: readThemeColor('--text-muted'), fontSize: 9, fontFamily: 'monospace' },
        splitLine: { show: false },
        axisLine: { lineStyle: { color: readThemeColor('--border') } },
        axisTick: { lineStyle: { color: readThemeColor('--border') } },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: readThemeColor('--text-muted'), fontSize: 10, fontFamily: 'monospace', formatter: v => fmtK(v) },
        splitLine: { lineStyle: { color: readThemeColor('--border-light') } },
        axisLine: { show: false },
        axisTick: { show: false },
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: readThemeColor('--bg-panel2'),
        borderColor: readThemeColor('--border-hi'),
        borderWidth: 1,
        textStyle: { color: readThemeColor('--text-primary'), fontSize: 10, fontFamily: 'monospace' },
        formatter: params => {
          const idx = params[0]?.dataIndex;
          if (idx == null) return '';
          return `${fullLabels[idx]}<br/><b>${fmtDollar(params[0].value)}</b>`;
        },
      },
      series: [{
        type: 'bar',
        data: top.map((c, i) => ({
          value: data[i],
          itemStyle: {
            color: c.result.scenarioFailed ? `${readThemeColor('--red')}cc`
              : i === 0                    ? `${readThemeColor('--amber')}d9`
                                           : `${readThemeColor('--purple')}b3`,
          },
        })),
        barMaxWidth: 40,
        itemStyle: { borderRadius: [2, 2, 0, 0] },
      }],
    });
    return chart;
  }

  _buildTable(candidates, objFn) {
    const table = document.createElement('table');
    table.className = 'opt-table-wrap';

    const thead = document.createElement('thead');
    thead.innerHTML = `
      <tr class="opt-table-thead-row">
        <th class="opt-table-th opt-table-th--center" style="width:32px">#</th>
        <th class="opt-table-th opt-table-th--left">Parameters</th>
        <th class="opt-table-th opt-table-th--right">Score</th>
        <th class="opt-table-th opt-table-th--right">Net Worth</th>
        <th class="opt-table-th opt-table-th--right">Roth</th>
        <th class="opt-table-th opt-table-th--center">OK?</th>
      </tr>`;
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    candidates.forEach((c, i) => {
      const rank   = i + 1;
      const isBest = rank === 1;
      const failed = c.result.scenarioFailed;

      const tr = document.createElement('tr');
      tr.className = isBest ? 'opt-table-row opt-table-row--best'
                   : i % 2 !== 0 ? 'opt-table-row opt-table-row--alt'
                   : 'opt-table-row';

      tr.innerHTML = `
        <td class="opt-table-td ${isBest ? 'opt-table-td--rank-best' : 'opt-table-td--rank'}">${isBest ? '🥇' : String(rank)}</td>
        <td class="opt-table-td opt-table-td--params" title="${fmtCandidate(c.candidate)}">${fmtCandidate(c.candidate)}</td>
        <td class="opt-table-td ${isBest ? 'opt-table-td--score-best' : 'opt-table-td--score'}">${fmtDollar(objFn(c.result))}</td>
        <td class="opt-table-td opt-table-td--nw">${fmtK(c.result.finalNetWorthUsd)}</td>
        <td class="opt-table-td opt-table-td--roth">${fmtK(c.result.rothFinalBalance)}</td>
        <td class="opt-table-td ${failed ? 'opt-table-td--fail' : 'opt-table-td--ok'}">${failed ? 'FAIL' : 'OK'}</td>`;

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    const wrap = document.createElement('div');
    wrap.style.cssText = 'overflow-x:auto;flex-shrink:0';
    wrap.appendChild(table);
    return wrap;
  }
}
