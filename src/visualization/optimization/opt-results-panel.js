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
    if (this._barChart) { this._barChart.dispose(); this._barChart = null; }
    if (this._wrapperEl) { this._wrapperEl.remove(); this._wrapperEl = null; }
    this._container.innerHTML = '';
  }

  _renderIdle() {
    this._container.innerHTML =
      '<div style="display:flex;height:100%;align-items:center;justify-content:center">' +
      '<span style="color:#475569;font-size:13px;font-family:monospace">' +
      'Configure and run Optimization to see results.' +
      '</span></div>';
  }

  _renderResults(result) {
    const { candidates, totalRuns, objective, objectiveKey } = result;
    const objFn = (OPTIMIZATION_OBJECTIVES[objectiveKey] ?? OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH).evaluate;

    const wrapper = document.createElement('div');
    wrapper.style.cssText =
      'height:100%;display:flex;flex-direction:column;padding:8px;gap:8px;overflow-y:auto;overflow-x:hidden';
    this._wrapperEl = wrapper;

    wrapper.appendChild(this._buildBadges(candidates, totalRuns, objective, objFn));

    const chartLabel = document.createElement('div');
    chartLabel.style.cssText =
      'font-size:11px;color:#475569;font-family:monospace;padding:2px 0;flex-shrink:0';
    chartLabel.textContent = `Candidate Scores (top ${Math.min(candidates.length, MAX_CHART_BARS)})`;
    wrapper.appendChild(chartLabel);

    const chartWrap = document.createElement('div');
    chartWrap.style.cssText = 'height:220px;flex-shrink:0';
    const chartDiv = document.createElement('div');
    chartDiv.style.cssText = 'width:100%;height:100%';
    chartWrap.appendChild(chartDiv);
    wrapper.appendChild(chartWrap);

    const tableLabel = document.createElement('div');
    tableLabel.style.cssText =
      'font-size:11px;color:#475569;font-family:monospace;padding:2px 0;flex-shrink:0';
    tableLabel.textContent = `All ${candidates.length} Candidates`;
    wrapper.appendChild(tableLabel);

    wrapper.appendChild(this._buildTable(candidates, objFn));

    // Append to DOM first so ECharts can measure real container dimensions.
    this._container.appendChild(wrapper);

    this._barChart = this._createBarChart(chartDiv, candidates, objFn);
  }

  _buildBadges(candidates, totalRuns, objectiveLabel, objFn) {
    const best    = candidates[0];
    const worst   = candidates[candidates.length - 1];
    const failures = candidates.filter(c => c.result.scenarioFailed).length;

    const badges = [
      { label: 'Best Score',     value: best  ? fmtDollar(objFn(best.result))  : '—', color: '#fbbf24' },
      { label: 'Worst Score',    value: worst ? fmtDollar(objFn(worst.result)) : '—', color: '#94a3b8' },
      { label: 'Candidates',     value: String(totalRuns),                              color: '#a78bfa' },
      { label: 'Failures',       value: String(failures),                               color: failures ? '#f87171' : '#4ade80' },
      { label: 'Best Net Worth', value: best  ? fmtDollar(best.result.finalNetWorthUsd) : '—', color: '#60a5fa' },
      { label: 'Best Roth Bal',  value: best  ? fmtDollar(best.result.rothFinalBalance)  : '—', color: '#34d399' },
    ];

    const header = document.createElement('div');
    header.style.cssText =
      'font-size:10px;color:#475569;font-family:monospace;margin-bottom:2px;flex-shrink:0';
    header.textContent = `Results — ${objectiveLabel}`;

    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;flex-shrink:0';

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
        axisLabel: { color: '#475569', fontSize: 9, fontFamily: 'monospace' },
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
            color: c.result.scenarioFailed ? 'rgba(248,113,113,0.8)'
              : i === 0                    ? 'rgba(251,191,36,0.85)'
                                           : 'rgba(167,139,250,0.7)',
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
    table.style.cssText =
      'width:100%;border-collapse:collapse;font-family:monospace;font-size:11px;flex-shrink:0';

    const thead = document.createElement('thead');
    thead.innerHTML = `
      <tr style="border-bottom:1px solid #334155">
        <th style="padding:4px 6px;color:#64748b;text-align:center;font-weight:400;width:32px">#</th>
        <th style="padding:4px 6px;color:#64748b;text-align:left;font-weight:400">Parameters</th>
        <th style="padding:4px 6px;color:#64748b;text-align:right;font-weight:400">Score</th>
        <th style="padding:4px 6px;color:#64748b;text-align:right;font-weight:400">Net Worth</th>
        <th style="padding:4px 6px;color:#64748b;text-align:right;font-weight:400">Roth</th>
        <th style="padding:4px 6px;color:#64748b;text-align:center;font-weight:400">OK?</th>
      </tr>`;
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    candidates.forEach((c, i) => {
      const rank   = i + 1;
      const isBest = rank === 1;
      const failed = c.result.scenarioFailed;

      const tr = document.createElement('tr');
      tr.style.cssText =
        `border-bottom:1px solid #0f172a;` +
        `background:${isBest ? '#1a1a2e' : i % 2 === 0 ? 'transparent' : '#0f172a'}`;

      const rankColor = isBest ? '#fbbf24' : '#64748b';
      const rankTxt   = isBest ? '🥇' : String(rank);

      tr.innerHTML = `
        <td style="padding:3px 6px;text-align:center;color:${rankColor};font-weight:${isBest ? 600 : 400}">${rankTxt}</td>
        <td style="padding:3px 6px;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;
                   white-space:nowrap;max-width:200px" title="${fmtCandidate(c.candidate)}">
          ${fmtCandidate(c.candidate)}
        </td>
        <td style="padding:3px 6px;text-align:right;color:${isBest ? '#fbbf24' : '#a78bfa'}">${fmtDollar(objFn(c.result))}</td>
        <td style="padding:3px 6px;text-align:right;color:#60a5fa">${fmtK(c.result.finalNetWorthUsd)}</td>
        <td style="padding:3px 6px;text-align:right;color:#34d399">${fmtK(c.result.rothFinalBalance)}</td>
        <td style="padding:3px 6px;text-align:center;color:${failed ? '#f87171' : '#4ade80'}">${failed ? 'FAIL' : 'OK'}</td>`;

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    const wrap = document.createElement('div');
    wrap.style.cssText = 'overflow-x:auto;flex-shrink:0';
    wrap.appendChild(table);
    return wrap;
  }
}
