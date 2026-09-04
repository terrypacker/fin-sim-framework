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
import { fmtCompact } from '../money-format.js';
import { buildParamStats, paramRowsForRun, fmtParamValue, fmtParamDelta } from './mc-run-params.js';

function stddev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
}

const fmtK = (v) => fmtCompact(v);

const METRIC_FIELD = {
  netWorthUsd:  'finalNetWorthUsd',
  netLiquidity: 'finalNetLiquidity',
};

const METRIC_SERIES_FIELD = {
  netWorthUsd:  'netWorthUsd',
  netLiquidity: 'netLiquidity',
};

/** Sort orders offered over the full run list. */
const SORTS = {
  metricAsc:  { label: 'value ↑', cmp: (f) => (a, b) => (a[f] ?? 0) - (b[f] ?? 0) },
  metricDesc: { label: 'value ↓', cmp: (f) => (a, b) => (b[f] ?? 0) - (a[f] ?? 0) },
  seed:       { label: 'seed',    cmp: ()  => (a, b) => a.seed - b.seed },
};

/**
 * Select at most 6 representative runs from the full MC results.
 * Deduplicates by seed so the same run doesn't appear twice.
 * Representatives are chosen relative to the active metric.
 */
function selectRepresentativeRuns(runs, summary, metric) {
  if (!runs.length) return [];

  const field = METRIC_FIELD[metric] ?? 'finalNetWorthUsd';
  const sorted = [...runs].sort((a, b) => (a[field] ?? 0) - (b[field] ?? 0));
  const best   = sorted.at(-1);
  const worst  = sorted[0];

  const p50 = summary.p50 ?? 0;
  const median = runs.reduce((c, r) =>
    Math.abs((r[field] ?? 0) - p50) < Math.abs((c[field] ?? 0) - p50) ? r : c
  );

  const seriesField = METRIC_SERIES_FIELD[metric] ?? 'netWorthUsd';
  const mostVolatile = runs.reduce((most, r) => {
    const a = stddev((r.timeSeries    ?? []).map(p => p[seriesField] ?? 0));
    const b = stddev((most.timeSeries ?? []).map(p => p[seriesField] ?? 0));
    return a > b ? r : most;
  });

  const failures  = runs.filter(r => r.scenarioFailed && r.outOfFundsDate);
  const earlyFail = failures.length
    ? failures.reduce((e, r) => r.outOfFundsDate < e.outOfFundsDate ? r : e)
    : null;

  const candidates = [
    { label: 'Best',          run: best         },
    { label: 'Worst',         run: worst        },
    { label: 'Median',        run: median       },
    { label: 'Most Volatile', run: mostVolatile },
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
 * Two sections over the same runs:
 *
 *   - REPRESENTATIVE RUNS. Best, Worst, Median, Most Volatile, Early Failure. A fast
 *     read of the shape of the batch.
 *   - ALL RUNS. Every iteration, sortable and filterable to failures. The
 *     representatives answer "how bad does it get"; only the full list answers "how
 *     many of them look like that", and a panel that shows five of a thousand runs
 *     with no way to reach the rest sends people back to re-running the batch.
 *
 * Every run in either section expands to its PARAMS, ranked by how far each one sits
 * from the batch median (see mc-run-params.js) — the difference between knowing a run
 * failed and knowing what failed it.
 *
 * Params tables are built on expand, not on render: a thousand runs times a hundred
 * params is 100k rows that nobody has asked to see yet.
 *
 * Callbacks:
 *   onRunSelected(run)   — fired when the user clicks Replay on a row.
 *   onClearReplaySeed()  — fired by the replay badge's Clear button.
 */
export class McRunsPanel extends BaseComponent {
  constructor(containerEl) {
    super();
    this._container    = containerEl;
    this.onRunSelected = null;
    this.onClearReplaySeed = null;

    this._runs        = [];
    this._summary     = null;
    this._metric      = 'netWorthUsd';
    this._paramStats  = new Map();
    this._sort        = 'metricAsc';
    this._failsOnly   = false;
    this._replaySeed  = null;

    this._renderIdle();
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  clearResults() {
    this._runs    = [];
    this._summary = null;
    this._container.innerHTML = '';
    this._renderIdle();
  }

  /**
   * Mark which run (if any) the live scenario is currently pinned to.
   * Rendered as a badge with a Clear button so a pinned seed is never a hidden mode.
   */
  setReplaySeed(seed) {
    this._replaySeed = seed ?? null;
    if (this._runs.length) this.showResults(this._summary, this._runs, this._metric);
  }

  showResults(summary, runs, metric = 'netWorthUsd') {
    this._summary = summary;
    this._metric  = metric;
    // Recompute only when the batch itself changes — a metric switch or a re-render
    // reuses the stats, which are a property of the runs and not of the view.
    if (runs !== this._runs) {
      this._runs       = runs ?? [];
      this._paramStats = buildParamStats(this._runs);
    }
    this._render();
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  _renderIdle() {
    this._container.innerHTML =
      '<div class="mc-idle-msg"><span>Run Monte Carlo to see representative scenarios.</span></div>';
  }

  _render() {
    this._container.innerHTML = '';
    const runs = this._runs;
    const reps = selectRepresentativeRuns(runs, this._summary ?? {}, this._metric);

    const wrapper = document.createElement('div');
    wrapper.className = 'mc-runs-wrapper';

    if (this._replaySeed != null) wrapper.appendChild(this._buildReplayBadge());

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
      for (const { label, run } of reps) wrapper.appendChild(this._buildRow(label, run));
    }

    if (runs.length) wrapper.appendChild(this._buildAllRunsSection(runs));

    this.append(this._container, wrapper);
  }

  /** "Scenario pinned to seed N" + Clear. */
  _buildReplayBadge() {
    const badge = document.createElement('div');
    badge.className = 'mc-replay-badge';

    const text = document.createElement('span');
    text.textContent = `▶ Scenario is replaying seed ${this._replaySeed} — params and RNG path pinned to that run.`;
    badge.appendChild(text);

    const clear = document.createElement('button');
    clear.className = 'btn btn-xs btn-ghost';
    clear.textContent = 'Clear';
    clear.title = 'Rebuild at the scenario\'s own seed. Params applied by the replay are NOT reverted.';
    this.listen(clear, 'click', () => this.onClearReplaySeed?.());
    badge.appendChild(clear);

    return badge;
  }

  // ── All runs ──────────────────────────────────────────────────────────────────

  _buildAllRunsSection(runs) {
    const field = METRIC_FIELD[this._metric] ?? 'finalNetWorthUsd';
    const failCount = runs.filter(r => r.scenarioFailed).length;

    const section = document.createElement('div');
    section.className = 'mc-all-runs';

    const header = document.createElement('div');
    header.className = 'node-header mc-all-runs-header';

    const title = document.createElement('span');
    title.textContent = `All Runs (${runs.length}${failCount ? `, ${failCount} failed` : ''})`;
    header.appendChild(title);

    const controls = document.createElement('div');
    controls.className = 'mc-all-runs-controls';

    const sortSel = document.createElement('select');
    sortSel.className = 'mc-run-sort';
    sortSel.title = 'Sort order';
    for (const [key, { label }] of Object.entries(SORTS)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = label;
      sortSel.appendChild(opt);
    }
    sortSel.value = this._sort;
    this.listen(sortSel, 'change', () => { this._sort = sortSel.value; this._render(); });
    controls.appendChild(sortSel);

    if (failCount) {
      const filterLabel = document.createElement('label');
      filterLabel.className = 'mc-run-filter';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = this._failsOnly;
      this.listen(cb, 'change', () => { this._failsOnly = cb.checked; this._render(); });
      filterLabel.append(cb, document.createTextNode('failed only'));
      controls.appendChild(filterLabel);
    }

    header.appendChild(controls);
    section.appendChild(header);

    const shown = (this._failsOnly ? runs.filter(r => r.scenarioFailed) : [...runs])
      .sort(SORTS[this._sort].cmp(field));

    const list = document.createElement('div');
    list.className = 'mc-run-list';
    for (const run of shown) list.appendChild(this._buildCompactRow(run, field));
    section.appendChild(list);

    return section;
  }

  /** One line in the full list: seed, value, status, expand, replay. */
  _buildCompactRow(run, field) {
    const row = document.createElement('div');
    row.className = 'mc-run-line';
    if (run.scenarioFailed) row.classList.add('mc-run-line--fail');

    const toggle = document.createElement('button');
    toggle.className = 'mc-run-expand';
    toggle.textContent = '▸';
    toggle.title = 'Show the parameters this run used';

    const seedEl = document.createElement('span');
    seedEl.className = 'mc-run-line-seed';
    seedEl.textContent = `#${run.seed}`;

    const valEl = document.createElement('span');
    valEl.className = run.scenarioFailed ? 'mc-run-nw mc-run-nw--fail' : 'mc-run-nw';
    valEl.textContent = fmtK(run[field]);

    const statusEl = document.createElement('span');
    statusEl.className = 'mc-run-line-status';
    statusEl.textContent = run.outOfFundsDate instanceof Date
      ? `⊘ ${run.outOfFundsDate.toISOString().slice(0, 7)}`
      : '';

    const replayBtn = document.createElement('button');
    replayBtn.className = 'btn btn-xs mc-run-line-replay';
    replayBtn.textContent = '▶';
    replayBtn.title = 'Replay this run';
    this.listen(replayBtn, 'click', () => this.onRunSelected?.(run));

    row.append(toggle, seedEl, valEl, statusEl, replayBtn);

    const wrap = document.createElement('div');
    wrap.className = 'mc-run-line-wrap';
    wrap.appendChild(row);

    this._wireParamsToggle(toggle, wrap, run);
    return wrap;
  }

  // ── Representative cards ──────────────────────────────────────────────────────

  _buildRow(label, run) {
    const field = METRIC_FIELD[this._metric] ?? 'finalNetWorthUsd';

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

    const valEl = document.createElement('span');
    valEl.className = run.scenarioFailed ? 'mc-run-nw mc-run-nw--fail' : 'mc-run-nw';
    valEl.textContent = fmtK(run[field]);

    metricsRow.append(seedEl, valEl);

    if (run.outOfFundsDate instanceof Date) {
      const failDate = document.createElement('span');
      failDate.className = 'mc-run-date';
      failDate.textContent = '⊘ ' + run.outOfFundsDate.toISOString().slice(0, 7);
      metricsRow.appendChild(failDate);
    }

    card.appendChild(metricsRow);

    const btnRow = document.createElement('div');
    btnRow.className = 'mc-run-btn-row';

    const paramsBtn = document.createElement('button');
    paramsBtn.className = 'btn btn-xs btn-ghost mc-run-params-btn';
    paramsBtn.textContent = '▸ Params';

    const replayBtn = document.createElement('button');
    replayBtn.className = 'btn btn-primary mc-replay-btn';
    replayBtn.textContent = '▶ Replay This Run';
    this.listen(replayBtn, 'click', () => this.onRunSelected?.(run));

    btnRow.append(paramsBtn, replayBtn);
    card.appendChild(btnRow);

    this._wireParamsToggle(paramsBtn, card, run, '▸ Params', '▾ Params');
    return card;
  }

  // ── Params table ──────────────────────────────────────────────────────────────

  /**
   * Wire an expand control to a lazily-built params table appended to `host`.
   * The table is built once, on first expand, then shown/hidden.
   */
  _wireParamsToggle(btn, host, run, collapsedText = '▸', expandedText = '▾') {
    let table = null;
    this.listen(btn, 'click', () => {
      if (!table) {
        table = this._buildParamsTable(run);
        host.appendChild(table);
      } else {
        table.hidden = !table.hidden;
      }
      btn.textContent = table.hidden ? collapsedText : expandedText;
    });
  }

  _buildParamsTable(run) {
    const { varying, fixed } = paramRowsForRun(run, this._paramStats);

    const box = document.createElement('div');
    box.className = 'mc-params-box';

    if (!varying.length && !fixed.length) {
      const empty = document.createElement('div');
      empty.className = 'mc-runs-empty';
      empty.textContent = 'This run carries no parameters.';
      box.appendChild(empty);
      return box;
    }

    if (varying.length) {
      box.appendChild(this._paramsSubhead(
        `Sampled (${varying.length}) — params that differ across the batch`,
        'The largest σ is this run\'s most unusual draw, and the first place to look for '
        + 'what made it good or bad.'));
      box.appendChild(this._paramsTable(varying, true));
    }

    if (fixed.length) {
      const details = document.createElement('details');
      details.className = 'mc-params-fixed';
      const sum = document.createElement('summary');
      sum.textContent = `Fixed (${fixed.length}) — identical in every run`;
      details.appendChild(sum);
      details.appendChild(this._paramsTable(fixed, false));
      box.appendChild(details);
    }

    return box;
  }

  _paramsSubhead(text, title) {
    const el = document.createElement('div');
    el.className = 'mc-params-subhead';
    el.textContent = text;
    el.title = title;
    return el;
  }

  /**
   * @param {Array}   rows
   * @param {boolean} withDelta  include the comparison column (sampled params only —
   *   a param that is identical in every run has nothing to be compared against).
   */
  _paramsTable(rows, withDelta) {
    const table = document.createElement('table');
    table.className = 'mc-params-table';

    // Headers, because none of these three columns announces itself. The third one
    // especially: "▲0.0848 2.2σ" reads as a change from some default unless the header
    // says otherwise, and the comparison is against the BATCH — the median of this
    // param across the runs just executed — not against the scenario's own value.
    const thead = document.createElement('thead');
    const htr   = document.createElement('tr');
    const cols  = [
      { text: 'Parameter', cls: 'mc-params-name',
        title: 'Parameter key, as the MC variable list addresses it' },
      { text: 'Value', cls: 'mc-params-value',
        title: 'The value this run actually used' },
    ];
    if (withDelta) {
      cols.push({ text: 'Δ vs median', cls: 'mc-params-delta',
        title: 'How far this run\'s draw sits from the median of the same parameter '
             + 'across every run in this batch — NOT from the scenario value or a default. '
             + '▲ above, ▼ below, and σ is that distance in batch standard deviations, '
             + 'so 2σ or more is an unusual draw.' });
    }
    for (const c of cols) {
      const th = document.createElement('th');
      th.className = c.cls;
      th.textContent = c.text;
      th.title = c.title;
      htr.appendChild(th);
    }
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const row of rows) {
      const tr = document.createElement('tr');

      const nameTd = document.createElement('td');
      nameTd.className = 'mc-params-name';
      nameTd.textContent = row.path;
      nameTd.title = row.path;

      const valTd = document.createElement('td');
      valTd.className = 'mc-params-value';
      valTd.textContent = fmtParamValue(row.value);

      tr.append(nameTd, valTd);

      if (withDelta) {
        const dTd = document.createElement('td');
        dTd.className = 'mc-params-delta';
        dTd.textContent = fmtParamDelta(row);
        // Two sigma is the conventional "this one is unusual" line and it is the only
        // thing worth colouring: direction is not signal here, because a high draw is
        // good for a return rate and bad for an inflation rate.
        if (row.z != null && Math.abs(row.z) >= 2) dTd.classList.add('mc-params-delta--far');
        tr.appendChild(dTd);
      }

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    return table;
  }
}
