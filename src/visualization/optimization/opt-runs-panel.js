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
      '<div style="display:flex;height:100%;align-items:center;justify-content:center;padding:16px">' +
      '<span style="color:#475569;font-size:12px;font-family:monospace;text-align:center">' +
      'Run optimization to see top candidates here.' +
      '</span></div>';
  }

  _renderResults(result) {
    const { candidates, objectiveKey } = result;
    const objFn = (OPTIMIZATION_OBJECTIVES[objectiveKey] ?? OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH).evaluate;

    const header = document.createElement('div');
    header.style.cssText =
      'font-size:11px;color:#475569;font-family:monospace;padding:6px 8px;' +
      'border-bottom:1px solid #1e293b;text-transform:uppercase;letter-spacing:0.05em';
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
    row.style.cssText =
      `padding:8px;border-bottom:1px solid #1e293b;` +
      `background:${isBest ? '#1a1a2e' : 'transparent'}`;

    // Rank + status header
    const rowHeader = document.createElement('div');
    rowHeader.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px';
    rowHeader.innerHTML = `
      <span style="font-size:12px;font-weight:600;color:${isBest?'#fbbf24':'#64748b'}">
        ${isBest ? '🥇' : `#${rank}`}
      </span>
      <span style="font-size:10px;padding:1px 5px;border-radius:3px;font-family:monospace;
                   background:${failed?'#7f1d1d':'#14532d'};color:${failed?'#f87171':'#4ade80'}">
        ${failed ? 'FAILED' : 'OK'}
      </span>`;
    row.appendChild(rowHeader);

    // Param list
    const paramDiv = document.createElement('div');
    paramDiv.style.cssText =
      'font-size:11px;color:#94a3b8;font-family:monospace;white-space:pre;' +
      'margin-bottom:6px;line-height:1.5';
    paramDiv.textContent = params || '(no overrides)';
    row.appendChild(paramDiv);

    // Metrics
    const metrics = document.createElement('div');
    metrics.style.cssText =
      'display:grid;grid-template-columns:1fr 1fr;gap:3px;margin-bottom:6px';
    metrics.innerHTML = `
      <div style="font-size:10px;color:#64748b;font-family:monospace">Score</div>
      <div style="font-size:11px;color:${isBest?'#fbbf24':'#a78bfa'};font-family:monospace;
                  font-weight:${isBest?600:400};text-align:right">${score}</div>
      <div style="font-size:10px;color:#64748b;font-family:monospace">Net Worth</div>
      <div style="font-size:11px;color:#60a5fa;font-family:monospace;text-align:right">${nw}</div>
      <div style="font-size:10px;color:#64748b;font-family:monospace">Roth Balance</div>
      <div style="font-size:11px;color:#34d399;font-family:monospace;text-align:right">${roth}</div>`;
    row.appendChild(metrics);

    // Apply button
    const applyBtn = document.createElement('button');
    applyBtn.className   = 'btn btn-sm';
    applyBtn.style.cssText =
      `width:100%;font-family:monospace;font-size:11px;` +
      `${isBest ? 'border-color:#fbbf24;color:#fbbf24' : ''}`;
    applyBtn.textContent = isBest ? '★ Apply Best' : '↺ Apply This';

    this.listen(applyBtn, 'click', () => {
      this.onCandidateSelected?.(c);
    });
    row.appendChild(applyBtn);

    return row;
  }
}
