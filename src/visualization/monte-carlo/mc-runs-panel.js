/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseComponent } from '../components/base-component.js';

function stddev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
}

function fmtK(v) {
  if (v == null) return '—';
  const abs  = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1_000_000) return sign + '$' + (abs / 1_000_000).toFixed(1) + 'M';
  return sign + '$' + (abs / 1000).toFixed(0) + 'k';
}

/**
 * Select at most 6 representative runs from the full MC results.
 * Deduplicates by seed so the same run doesn't appear twice.
 *
 * @param {Array}  runs    - Full runs array from IntlRetirementMcRunner.
 * @param {object} summary - Summary from ScenarioRunner.summarize().
 * @returns {Array<{ label: string, run: object }>}
 */
function selectRepresentativeRuns(runs, summary) {
  if (!runs.length) return [];

  const sorted = [...runs].sort((a, b) => a.finalNetWorthUsd - b.finalNetWorthUsd);
  const best   = sorted.at(-1);
  const worst  = sorted[0];

  const p50    = summary.p50 ?? 0;
  const median = runs.reduce((c, r) =>
    Math.abs(r.finalNetWorthUsd - p50) < Math.abs(c.finalNetWorthUsd - p50) ? r : c
  );

  const mostVolatile = runs.reduce((most, r) => {
    const a = stddev((r.timeSeries    ?? []).map(p => p.netWorthUsd));
    const b = stddev((most.timeSeries ?? []).map(p => p.netWorthUsd));
    return a > b ? r : most;
  });

  const failures    = runs.filter(r => r.scenarioFailed && r.outOfFundsDate);
  const earlyFail   = failures.length
    ? failures.reduce((e, r) => r.outOfFundsDate < e.outOfFundsDate ? r : e)
    : null;

  const candidates = [
    { label: 'Best',          run: best          },
    { label: 'Worst',         run: worst         },
    { label: 'Median',        run: median        },
    { label: 'Most Volatile', run: mostVolatile  },
  ];
  if (earlyFail) candidates.push({ label: 'Early Failure', run: earlyFail });

  const seen = new Set();
  return candidates.filter(({ run }) => {
    if (!run || seen.has(run.seed)) return false;
    seen.add(run.seed);
    return true;
  });
}

/**
 * McRunsPanel — right pane of the MC tab.
 *
 * Displays up to 6 representative runs (Best, Worst, Median, Most Volatile,
 * Early Failure). Each row has a Replay button that fires onRunSelected(run).
 *
 * Callbacks:
 *   onRunSelected(run) — fired when the user clicks Replay on a row.
 */
export class McRunsPanel extends BaseComponent {
  constructor(containerEl) {
    super();
    this._container    = containerEl;
    this.onRunSelected = null;

    this._renderIdle();
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  clearResults() {
    this._container.innerHTML = '';
    this._renderIdle();
  }

  showResults(summary, runs) {
    this._container.innerHTML = '';
    const reps = selectRepresentativeRuns(runs, summary);

    const wrapper = document.createElement('div');
    wrapper.className = 'mc-runs-wrapper';

    const header = document.createElement('div');
    header.className = 'node-header';
    header.textContent = 'Representative Runs';
    wrapper.appendChild(header);

    if (!reps.length) {
      const empty = document.createElement('div');
      empty.className = 'mc-runs-empty';
      empty.textContent = 'No runs to display.';
      wrapper.appendChild(empty);
    } else {
      for (const { label, run } of reps) {
        wrapper.appendChild(this._buildRow(label, run));
      }
    }

    this.append(this._container, wrapper);
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  _renderIdle() {
    this._container.innerHTML =
      '<div class="mc-idle-msg"><span>Run Monte Carlo to see representative scenarios.</span></div>';
  }

  _buildRow(label, run) {
    const card = document.createElement('div');
    card.className = 'mc-run-card';

    const topRow = document.createElement('div');
    topRow.className = 'mc-run-top-row';

    const labelEl = document.createElement('span');
    labelEl.className = 'mc-run-label';
    labelEl.textContent = label;

    const failBadge = document.createElement('span');
    failBadge.className = run.scenarioFailed
      ? 'mc-run-badge mc-run-badge--fail'
      : 'mc-run-badge mc-run-badge--ok';
    failBadge.textContent = run.scenarioFailed ? 'FAILED' : 'OK';

    topRow.append(labelEl, failBadge);
    card.appendChild(topRow);

    const metricsRow = document.createElement('div');
    metricsRow.className = 'mc-run-metrics';

    const seedEl = document.createElement('span');
    seedEl.textContent = `seed ${run.seed}`;

    const nwEl = document.createElement('span');
    nwEl.className = run.scenarioFailed ? 'mc-run-nw mc-run-nw--fail' : 'mc-run-nw';
    nwEl.textContent = fmtK(run.finalNetWorthUsd);

    metricsRow.append(seedEl, nwEl);

    if (run.outOfFundsDate instanceof Date) {
      const failDate = document.createElement('span');
      failDate.className = 'mc-run-date';
      failDate.textContent = '⊘ ' + run.outOfFundsDate.toISOString().slice(0, 7);
      metricsRow.appendChild(failDate);
    }

    card.appendChild(metricsRow);

    const replayBtn = document.createElement('button');
    replayBtn.className = 'btn btn-primary mc-replay-btn';
    replayBtn.textContent = '▶ Replay This Run';
    this.listen(replayBtn, 'click', () => {
      if (this.onRunSelected) this.onRunSelected(run);
    });
    card.appendChild(replayBtn);

    return card;
  }
}
