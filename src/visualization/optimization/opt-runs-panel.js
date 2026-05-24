/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseComponent }        from '../components/base-component.js';
import { OPTIMIZATION_OBJECTIVES } from '../../finance/optimization/optimization-objectives.js';

const TOP_N = 5;

function fmtDollar(v) {
  if (v == null || !isFinite(v)) return '—';
  return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function fmtPct(v) {
  if (typeof v === 'number' && v > 0 && v < 1) return `${(v * 100).toFixed(0)}%`;
  return String(v);
}

function fmtCandidateLong(candidate) {
  const entries = Object.entries(candidate);
  if (!entries.length) return '(baseline)';
  return entries.map(([k, v]) => {
    const shortKey = k
      .replace(/^rothConversion/, '')
      .replace(/([A-Z])/g, m => ` ${m.toLowerCase()}`)
      .trim();
    return `${shortKey} = ${fmtPct(v)}`;
  }).join('\n');
}

/**
 * OptRunsPanel — right pane of the Optimization tab.
 *
 * Shows the top N candidates with an "Apply" button that fires
 * onCandidateSelected(candidateEntry) so the caller can replay the
 * scenario with those parameter overrides.
 *
 * Callbacks:
 *   onCandidateSelected(candidateEntry) — fired when "Apply" is clicked.
 *     candidateEntry = { candidate, result, score }
 */
export class OptRunsPanel extends BaseComponent {
  constructor(containerEl) {
    super();
    this._container = containerEl;
    this.onCandidateSelected = null;

    this._renderIdle();
  }

  clearResults() {
    this._renderIdle();
  }

  showResults(result) {
    this._container.innerHTML = '';
    this._renderResults(result);
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  _renderIdle() {
    this._container.innerHTML =
      '<div class="opt-idle-msg"><span>Run optimization to see top candidates here.</span></div>';
  }

  _renderResults(result) {
    const { candidates, objectiveKey } = result;
    const objFn = (OPTIMIZATION_OBJECTIVES[objectiveKey] ?? OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH).evaluate;

    const header = document.createElement('div');
    header.className = 'opt-runs-header';
    header.textContent = `Top ${Math.min(TOP_N, candidates.length)} Candidates`;
    this._container.appendChild(header);

    const top = candidates.slice(0, TOP_N);
    top.forEach((c, i) => {
      this._container.appendChild(this._buildRow(c, i + 1, objFn));
    });
  }

  _buildRow(c, rank, objFn) {
    const isBest  = rank === 1;
    const failed  = c.result.scenarioFailed;
    const params  = fmtCandidateLong(c.candidate);
    const score   = fmtDollar(objFn(c.result));
    const nw      = fmtDollar(c.result.finalNetWorthUsd);
    const roth    = fmtDollar(c.result.rothFinalBalance);

    const row = document.createElement('div');
    row.className = isBest ? 'opt-run-row opt-run-row--best' : 'opt-run-row';

    // Rank + status header
    const rowHeader = document.createElement('div');
    rowHeader.className = 'opt-run-rank-row';
    rowHeader.innerHTML = `
      <span class="opt-run-rank ${isBest ? 'opt-run-rank--best' : ''}">
        ${isBest ? '🥇' : `#${rank}`}
      </span>
      <span class="opt-run-status ${failed ? 'opt-run-status--failed' : 'opt-run-status--ok'}">
        ${failed ? 'FAILED' : 'OK'}
      </span>`;
    row.appendChild(rowHeader);

    // Param list
    const paramDiv = document.createElement('div');
    paramDiv.className = 'opt-run-params';
    paramDiv.textContent = params || '(no overrides)';
    row.appendChild(paramDiv);

    // Metrics
    const metrics = document.createElement('div');
    metrics.className = 'opt-run-metrics';
    metrics.innerHTML = `
      <div class="opt-run-metric-label">Score</div>
      <div class="opt-run-metric-value ${isBest ? 'opt-run-metric-value--score-best' : 'opt-run-metric-value--score'}">${score}</div>
      <div class="opt-run-metric-label">Net Worth</div>
      <div class="opt-run-metric-value opt-run-metric-value--nw">${nw}</div>
      <div class="opt-run-metric-label">Roth Balance</div>
      <div class="opt-run-metric-value opt-run-metric-value--roth">${roth}</div>`;
    row.appendChild(metrics);

    // Apply button
    const applyBtn = document.createElement('button');
    applyBtn.className = isBest ? 'btn btn-sm opt-apply-btn--best' : 'btn btn-sm';
    applyBtn.style.width = '100%';
    applyBtn.textContent = isBest ? '★ Apply Best' : '↺ Apply This';

    this.listen(applyBtn, 'click', () => {
      this.onCandidateSelected?.(c);
    });
    row.appendChild(applyBtn);

    return row;
  }
}
