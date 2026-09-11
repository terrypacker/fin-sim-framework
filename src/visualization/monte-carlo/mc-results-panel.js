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
import {
  runsToRows, failureByBand, failureDrivers, RETURN_BAND_EDGES,
} from '../../finance/monte-carlo/mc-analysis.js';
import {
  mixSeriesFromRuns, mixBands, mixByOutcome, thresholdProbabilities, outcomeGapAt,
  DEFAULT_MIX_THRESHOLDS,
} from '../../finance/allocation-reporting/mix-distribution.js';
import { colorForSeriesKey } from '../../finance/allocation-reporting/allocation-palette.js';
import {
  aggregateSpendingRuns, exceedanceRate, describeSpendingDistribution,
} from '../../finance/spending-reporting/spending-distribution.js';

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
function fmtMoneyOrDash(v) { return v == null || !isFinite(v) ? '—' : fmtWhole(v); }

/** Same rule as the Allocation panel: an explicit theme wins; the workbench ships dark. */
function isDarkTheme() {
  const theme = typeof document !== 'undefined' ? document.documentElement?.dataset?.theme : null;
  return theme ? theme !== 'light' : true;
}

/** "< 0%", "4%–5%", "12%+" — the first and last edges are sentinels, not real bounds. */
function bandLabel({ lo, hi }) {
  const p = (v) => `${Math.round(v * 100)}%`;
  if (lo <= -1) return `< ${p(hi)}`;
  if (hi >= 1)  return `${p(lo)}+`;
  return `${p(lo)}–${p(hi)}`;
}

function cell(text, cls) {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.textContent = text;
  return td;
}

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
 *   4. Path shape — sequence-risk and liquidity readouts, failure by realized return,
 *      and what separates a failing path (design 100 §3)
 *   5. Asset mix — per-class share bands, threshold probabilities, failed vs survived
 *      (only for a run made with `mix: true`; design 100 §4, design 82 §8)
 *   6. Spending — lifetime cost by category (only for a run made with `spending: true`;
 *      design 100 §4, design 89 §21)
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
    this._mixChart        = null;
    this._mixChartRo      = null;
    this._mixDiv          = null;
    this._mixData         = null;
    this._mixClass        = null;

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
    if (this._mixChartRo)  { this._mixChartRo.disconnect();  this._mixChartRo  = null; }
    if (this._mixChart)    { this._mixChart.dispose();       this._mixChart    = null; }
    this._mixDiv  = null;
    this._mixData = null;
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

    // ── Path shape (design 100 §3) ─────────────────────────────────────────────
    const shape = this._buildPathShapeSection(summary, runs);
    if (shape) wrapper.appendChild(shape);

    // ── Opt-in telemetry sections (design 100 §4) ─────────────────────────────
    const mixSection = this._buildMixSection(runs);
    if (mixSection) wrapper.appendChild(mixSection);
    const spendSection = this._buildSpendingSection(summary, runs);
    if (spendSection) wrapper.appendChild(spendSection);

    this._container.appendChild(wrapper);

    if (this._mixDiv) {
      this._mixChartRo = initEChartWhenReady(this._mixDiv, () => {
        this._mixChart = echarts.init(this._mixDiv, null, { renderer: 'canvas' });
        this._mixChart.setOption(this._mixChartOption());
        const ro = new ResizeObserver(() => this._mixChart?.resize());
        ro.observe(this._mixDiv);
        this._mixChartRo = ro;
      });
    }

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

  /**
   * Path shape, failure by realized return, and what separates a failing path (design 100
   * §3). All of it was already on the result — `summary.pathShape` and each run's own
   * `pathShape` — and nothing displayed it.
   *
   * Absent, not zero, for a result without `pathShape` (an older or restored result): a
   * row of 0% badges would read as a measurement.
   */
  _buildPathShapeSection(summary, runs) {
    const ps = summary?.pathShape;
    if (!ps) return null;

    const section = document.createElement('div');
    section.className = 'mc-shape-section';

    const label = document.createElement('div');
    label.className = 'mc-section-label';
    label.textContent = 'Path Shape — sequence risk and liquidity';
    section.appendChild(label);

    const badges = [
      { label: 'Median NW CAGR',          value: fmtPct(ps.medianNetWorthCagr) },
      { label: 'Median Worst 5-yr',       value: fmtPct(ps.medianWorst5yrCagr) },
      { label: 'Median Max Drawdown',     value: fmtPct(ps.medianMaxDrawdown) },
      { label: 'Fail | Weak 1st Decade',  value: fmtPct(ps.failureRateBelowMedianDecade),
        cls: 'mc-badge-value--failure',
        title: 'Failure rate among paths whose net worth at ~10 years was below the cross-path median.' },
      // Muted, not green: it is still a FAILURE rate, and green reads as "good".
      { label: 'Fail | Strong 1st Decade', value: fmtPct(ps.failureRateAboveMedianDecade),
        title: 'Failure rate among paths whose net worth at ~10 years was at or above the median. '
          + 'A wide gap to the weak-decade rate is sequence-of-returns risk stated directly.' },
      { label: 'Liquidity Trough P50',    value: fmtMoneyOrDash(ps.medianTroughRealNetLiquidity),
        title: 'Real (base-year) spendable wealth at its deepest fall from peak. Excludes the house and company equity.' },
      { label: 'Liquidity Trough P10',    value: fmtMoneyOrDash(ps.p10TroughRealNetLiquidity) },
    ];
    // Plan-dependent readouts appear only when the plan has the thing they describe.
    if (ps.medianHouseCagr != null) {
      badges.push(
        { label: 'Median House CAGR',     value: fmtPct(ps.medianHouseCagr) },
        { label: 'Median House Drawdown', value: fmtPct(ps.medianHouseMaxDrawdown) },
      );
    }
    if ((ps.p90RepairSpend ?? 0) > 0) {
      badges.push(
        { label: 'Repair Spend P50', value: fmtMoneyOrDash(ps.medianRepairSpend) },
        { label: 'Repair Spend P90', value: fmtMoneyOrDash(ps.p90RepairSpend) },
      );
    }

    const grid = document.createElement('div');
    grid.className = 'mc-badge-grid';
    for (const b of badges) {
      const card = document.createElement('div');
      card.className = 'mc-badge-card';
      if (b.title) card.title = b.title;
      const l = document.createElement('div');
      l.className = 'mc-badge-label';
      l.textContent = b.label;
      const v = document.createElement('div');
      v.className = `mc-badge-value ${b.cls ?? 'mc-badge-value--muted'}`;
      v.textContent = b.value;
      card.append(l, v);
      grid.appendChild(card);
    }
    section.appendChild(grid);

    const rows = runsToRows(runs);
    const bandTable = this._buildReturnBandTable(rows);
    if (bandTable) section.appendChild(bandTable);
    const drivers = this._buildDriversTable(rows);
    if (drivers) section.appendChild(drivers);
    return section;
  }

  /**
   * Failure rate by realized net-worth CAGR (design 100 §3). Realized, not the sampled
   * mean: since design 98 M3 every path draws its own year-by-year returns, so the
   * sampled mean no longer says which paths fail.
   */
  _buildReturnBandTable(rows) {
    const bands = failureByBand(rows, 'netWorthCagr', RETURN_BAND_EDGES).filter(b => b.n > 0);
    if (!bands.length) return null;
    const unbanded = rows.filter(r => typeof r.netWorthCagr !== 'number').length;

    const wrap = document.createElement('div');
    wrap.className = 'mc-shape-block mc-band-block';
    const label = document.createElement('div');
    label.className = 'mc-section-label';
    label.textContent = 'Failure Rate by Realized Return';
    wrap.appendChild(label);

    const table = document.createElement('table');
    table.className = 'mc-shape-table mc-band-table';
    table.innerHTML = '<thead><tr><th class="mc-shape-name">Realized NW CAGR</th>'
      + '<th>Paths</th><th>Failure Rate</th></tr></thead>';
    const body = document.createElement('tbody');
    for (const b of bands) {
      const tr = document.createElement('tr');
      if (b.rate > 0) tr.className = 'mc-band-row--fails';
      tr.append(
        cell(bandLabel(b), 'mc-shape-name'),
        cell(String(b.n)),
        cell(fmtPct(b.rate)),
      );
      body.appendChild(tr);
    }
    table.appendChild(body);
    wrap.appendChild(table);

    const note = document.createElement('div');
    note.className = 'mc-shape-note';
    note.textContent = 'Turns "N% of paths fail" into a return threshold: the realized growth below which '
      + 'this plan fails.'
      + (unbanded ? ` ${unbanded} path(s) had no computable CAGR (net worth reached zero) and are not banded.` : '');
    wrap.appendChild(note);
    return wrap;
  }

  /** Failed vs surviving paths on the explanatory fields. Omitted when nothing failed. */
  _buildDriversTable(rows) {
    const d = failureDrivers(rows, ['netWorthCagr', 'worst5yrCagr', 'maxDrawdown']);
    if (!d.nFailed || !d.nSurvived) return null;

    const wrap = document.createElement('div');
    wrap.className = 'mc-shape-block mc-drivers-block';
    const label = document.createElement('div');
    label.className = 'mc-section-label';
    label.textContent = `What Separates a Failing Path — ${d.nFailed} failed / ${d.nSurvived} survived`;
    wrap.appendChild(label);

    const table = document.createElement('table');
    table.className = 'mc-shape-table mc-drivers-table';
    table.innerHTML = '<thead><tr><th class="mc-shape-name">Mean of</th>'
      + '<th>Failed</th><th>Survived</th></tr></thead>';
    const body = document.createElement('tbody');
    const NAMES = { netWorthCagr: 'Realized NW CAGR', worst5yrCagr: 'Worst 5-yr window', maxDrawdown: 'Max drawdown' };
    for (const f of d.fields) {
      if (f.failed == null && f.survived == null) continue;
      const tr = document.createElement('tr');
      tr.append(cell(NAMES[f.key], 'mc-shape-name'), cell(fmtPct(f.failed)), cell(fmtPct(f.survived)));
      body.appendChild(tr);
    }
    if (d.oofYears.length) {
      const tr = document.createElement('tr');
      const mid = d.oofYears[Math.floor((d.oofYears.length - 1) / 2)];
      // Both years describe FAILED paths — a survivor has no out-of-funds year — so they
      // share the Failed column; splitting them across the two columns read as a survivor
      // running out of money.
      tr.append(cell('Out-of-funds year', 'mc-shape-name'),
        cell(`median ${mid} · earliest ${d.oofYears[0]}`), cell('—'));
      body.appendChild(tr);
    }
    table.appendChild(body);
    wrap.appendChild(table);
    return wrap;
  }

  /**
   * The asset mix as a distribution (design 82 §8, design 100 §4). Present only for a run
   * made with `mix: true`.
   *
   * One class at a time, picked by chip: per-class bands are MARGINAL — the p90 of one class
   * and of another come from different paths — so they are never stacked, and six overlaid
   * bands are unreadable. The failed paths' median rides on the same chart as a dashed line,
   * because "is the shape the failure mechanism?" is the question this view exists for.
   */
  _buildMixSection(runs) {
    const ms = mixSeriesFromRuns(runs);
    if (!ms) return null;

    const all      = mixBands(ms);
    const byOut    = mixByOutcome(ms, { percentiles: [0.5] });
    // A class no path ever held is a chip that draws nothing — drop it.
    const classes  = ms.classes.filter(c => (all.bands[c]?.[0.9] ?? []).some(v => v > 0));
    if (!classes.length) return null;
    this._mixData  = { years: ms.years, bands: all.bands, failed: byOut.failed.bands, nFailed: byOut.nFailed };
    this._mixClass = classes.includes('EQUITY') ? 'EQUITY' : classes[0];

    const section = document.createElement('div');
    section.className = 'mc-shape-section mc-mix-section';
    const label = document.createElement('div');
    label.className = 'mc-section-label';
    label.textContent = 'Asset Mix — share of gross assets, P10–P90 per class';
    section.appendChild(label);

    const dark  = isDarkTheme();
    const chips = document.createElement('div');
    chips.className = 'mc-mix-chips';
    classes.forEach((cls, i) => {
      const chip = document.createElement('button');
      chip.className = 'mc-mix-chip' + (cls === this._mixClass ? ' mc-mix-chip--active' : '');
      chip.dataset.cls = cls;
      const swatch = document.createElement('i');
      swatch.style.background = colorForSeriesKey(cls, i, { dark });
      chip.append(swatch, document.createTextNode(cls));
      chip.addEventListener('click', () => {
        this._mixClass = cls;
        for (const c of chips.children) c.classList.toggle('mc-mix-chip--active', c.dataset.cls === cls);
        this._mixChart?.setOption(this._mixChartOption(), true);
      });
      chips.appendChild(chip);
    });
    section.appendChild(chips);

    const wrap = document.createElement('div');
    wrap.className = 'mc-mix-wrap';
    const div = document.createElement('div');
    div.className = 'mc-chart-fill';
    this._mixDiv = div;
    wrap.appendChild(div);
    section.appendChild(wrap);

    const note = document.createElement('div');
    note.className = 'mc-shape-note';
    note.textContent = 'Bands are marginal: the P90 of one class and of another come from different paths, '
      + 'so they do not sum to 100%. Dashed = median share on paths that failed.';
    section.appendChild(note);

    section.appendChild(this._buildThresholdTable(ms));
    const gap = this._buildOutcomeGapTable(ms);
    if (gap) section.appendChild(gap);
    return section;
  }

  /** eCharts option for the selected class: P10–P90 band, P50 line, failed-path median. */
  _mixChartOption() {
    const { years, bands, failed, nFailed } = this._mixData;
    const cls   = this._mixClass;
    const b     = bands[cls] ?? {};
    const color = colorForSeriesKey(cls, 0, { dark: isDarkTheme() });
    const p10   = b[0.1] ?? [];
    const p90   = b[0.9] ?? [];
    const textDim = readThemeColor('--text-dim');
    const border  = readThemeColor('--border');
    const red     = readThemeColor('--red');
    const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);

    const series = [
      { id: 'lo', type: 'line', stack: 'band', data: p10, symbol: 'none', lineStyle: { opacity: 0 },
        tooltip: { show: false }, emphasis: { disabled: true } },
      { id: 'band', type: 'line', stack: 'band', data: p90.map((v, i) => (v == null || p10[i] == null ? null : v - p10[i])),
        symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { color, opacity: 0.25 },
        tooltip: { show: false }, emphasis: { disabled: true } },
      { id: 'p50', name: 'P50', type: 'line', data: b[0.5] ?? [], symbol: 'none', lineStyle: { color, width: 2 } },
    ];
    if (nFailed > 0) {
      series.push({ id: 'failed', name: 'Failed P50', type: 'line', data: failed[cls]?.[0.5] ?? [],
        symbol: 'none', lineStyle: { color: red, width: 1.5, type: 'dashed' } });
    }
    return {
      backgroundColor: 'transparent',
      animation: false,
      grid: { top: 12, right: 16, bottom: 28, left: 16, containLabel: true },
      xAxis: { type: 'category', data: years, axisLabel: { color: textDim, fontSize: 10, fontFamily: 'monospace' },
        axisLine: { lineStyle: { color: border } } },
      yAxis: { type: 'value', min: 0, max: 1, axisLabel: { color: textDim, fontSize: 10, fontFamily: 'monospace', formatter: pct },
        splitLine: { lineStyle: { color: border } } },
      tooltip: {
        trigger: 'axis',
        formatter: (params) => {
          const i = params[0]?.dataIndex;
          if (i == null) return '';
          const lines = [`${years[i]} · ${cls}`, `P10 ${pct(p10[i])} · P50 ${pct(b[0.5]?.[i])} · P90 ${pct(p90[i])}`];
          if (nFailed > 0) lines.push(`failed paths P50 ${pct(failed[cls]?.[0.5]?.[i])}`);
          return lines.join('<br>');
        },
      },
      series,
    };
  }

  /** P(threshold) over the paths — the readouts worth quoting (design 82 §8.2). */
  _buildThresholdTable(ms) {
    const rows = thresholdProbabilities(ms, DEFAULT_MIX_THRESHOLDS);
    const wrap = document.createElement('div');
    wrap.className = 'mc-shape-block mc-threshold-block';
    const label = document.createElement('div');
    label.className = 'mc-section-label';
    label.textContent = 'Share of Paths Meeting Each Condition';
    wrap.appendChild(label);

    const table = document.createElement('table');
    table.className = 'mc-shape-table mc-threshold-table';
    table.innerHTML = '<thead><tr><th class="mc-shape-name">Condition</th><th>Paths</th><th>Probability</th></tr></thead>';
    const body = document.createElement('tbody');
    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.title = r.excluded ? `${r.excluded} path(s) had no assets left in the window and are excluded.` : '';
      tr.append(cell(r.label, 'mc-shape-name'), cell(`${r.hits} / ${r.n}`), cell(fmtPct(r.rate)));
      body.appendChild(tr);
    }
    table.appendChild(body);
    wrap.appendChild(table);
    return wrap;
  }

  /** Median share at the horizon, failed vs survived, sorted by gap. Omitted without both. */
  _buildOutcomeGapTable(ms) {
    const g = outcomeGapAt(ms);
    if (!g.nFailed || !g.nSurvived) return null;
    const rows = g.rows
      .filter(r => (r.failed ?? 0) > 0.005 || (r.survived ?? 0) > 0.005)
      .sort((a, b) => Math.abs(b.gap ?? 0) - Math.abs(a.gap ?? 0));
    if (!rows.length) return null;

    const wrap = document.createElement('div');
    wrap.className = 'mc-shape-block mc-gap-block';
    const label = document.createElement('div');
    label.className = 'mc-section-label';
    label.textContent = `Mix at ${g.year} — ${g.nFailed} failed / ${g.nSurvived} survived (median share)`;
    wrap.appendChild(label);

    const table = document.createElement('table');
    table.className = 'mc-shape-table mc-gap-table';
    table.innerHTML = '<thead><tr><th class="mc-shape-name">Class</th><th>Failed</th><th>Survived</th><th>Gap</th></tr></thead>';
    const body = document.createElement('tbody');
    for (const r of rows) {
      const tr = document.createElement('tr');
      const gapTxt = r.gap == null ? '—' : `${r.gap > 0 ? '+' : ''}${(r.gap * 100).toFixed(1)}%`;
      tr.append(cell(r.key, 'mc-shape-name'), cell(fmtPct(r.failed)), cell(fmtPct(r.survived)), cell(gapTxt));
      body.appendChild(tr);
    }
    table.appendChild(body);
    wrap.appendChild(table);

    const note = document.createElement('div');
    note.className = 'mc-shape-note';
    note.textContent = 'A large positive gap on an illiquid class means the paths that ran out of money '
      + 'were the paths that ended holding it — the shape is the failure mechanism.';
    wrap.appendChild(note);
    return wrap;
  }

  /**
   * Lifetime spending across paths (design 89 §21.4, design 100 §4). Present only for a run
   * made with `spending: true`. A table rather than §21.4's stacked percentile bar — the same
   * numbers, and the bar is a later option.
   */
  _buildSpendingSection(summary, runs) {
    const records = (runs ?? []).map(r => r.spending ?? null);
    if (!records.some(Boolean)) return null;
    const agg = aggregateSpendingRuns(records);

    const section = document.createElement('div');
    section.className = 'mc-shape-section mc-spend-section';
    const label = document.createElement('div');
    label.className = 'mc-section-label';
    label.textContent = 'Spending — lifetime, real base-year dollars';
    section.appendChild(label);

    const header = document.createElement('div');
    header.className = 'mc-shape-note';
    header.textContent = describeSpendingDistribution(agg);
    section.appendChild(header);

    const failRate = summary?.successRate != null ? 1 - summary.successRate : null;
    const badges = [
      { label: 'Real Cost P50',        value: fmtMoneyOrDash(agg.spendingReal?.p50) },
      { label: 'Tax > 50% of Spending', value: fmtPct(exceedanceRate(records, 'taxShare', 0.5)),
        title: 'Share of paths where tax was more than half of lifetime spending.' },
      { label: 'Went Short',           value: fmtPct(agg.wentShortRate), cls: 'mc-badge-value--failure',
        title: 'Paths that could not fund what they intended at some point. An independent check on the failure rate.' },
      { label: 'Failure Rate',         value: fmtPct(failRate), cls: 'mc-badge-value--failure',
        title: 'From the run summary. Should match Went Short; a gap is a real signal about one of the two.' },
    ];
    const grid = document.createElement('div');
    grid.className = 'mc-badge-grid';
    for (const b of badges) {
      const card = document.createElement('div');
      card.className = 'mc-badge-card';
      if (b.title) card.title = b.title;
      const l = document.createElement('div');
      l.className = 'mc-badge-label';
      l.textContent = b.label;
      const v = document.createElement('div');
      v.className = `mc-badge-value ${b.cls ?? 'mc-badge-value--muted'}`;
      v.textContent = b.value;
      card.append(l, v);
      grid.appendChild(card);
    }
    section.appendChild(grid);

    if (agg.unclassifiedTypes?.length) {
      const banner = document.createElement('div');
      banner.className = 'mc-spend-banner';
      banner.textContent = '⚠ Unclassified spending — action types with no category: '
        + agg.unclassifiedTypes.map(t => `${t.actionType} (${t.paths} path${t.paths === 1 ? '' : 's'})`).join(', ');
      section.appendChild(banner);
    }

    const table = document.createElement('table');
    table.className = 'mc-shape-table mc-spend-table';
    // Tier travels with each row: roughly half of "all debits" is not spending (internal
    // moves, revaluation, principal — design 89), and a table without the tier reads those
    // rows as cost next to a header that excludes them.
    table.innerHTML = '<thead><tr><th class="mc-shape-name">Category</th>'
      + '<th title="Design 89 spend tier — only spending tiers count toward Real Cost">Tier</th>'
      + '<th>P10</th><th>P50</th><th>P90</th>'
      + '<th title="Share of paths in which this category moved any money">Fired</th></tr></thead>';
    const body = document.createElement('tbody');
    for (const key of agg.categories) {
      const c = agg.byCategoryReal[key];
      const tr = document.createElement('tr');
      tr.append(cell(key, 'mc-shape-name'), cell(c.tier ?? '—'), cell(fmtMoneyOrDash(c.p10)),
        cell(fmtMoneyOrDash(c.p50)), cell(fmtMoneyOrDash(c.p90)), cell(fmtPct(c.firedRate)));
      body.appendChild(tr);
    }
    table.appendChild(body);
    section.appendChild(table);
    return section;
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
