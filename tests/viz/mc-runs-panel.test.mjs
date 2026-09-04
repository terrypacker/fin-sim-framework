/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * mc-runs-panel.test.mjs
 *
 * Covers what the runs panel exists to answer: WHICH runs happened, and what was
 * different about the one you are looking at.
 *
 *   - the full run list (every iteration, not just the five representatives)
 *   - per-run params, expanded on demand, split into sampled vs fixed and ranked
 *     by distance from the batch median
 *   - the replay-seed badge, so a pinned scenario is never a silent mode
 *
 * Run with: npm run test:viz
 */

import { McRunsPanel } from '../../src/visualization/monte-carlo/mc-runs-panel.js';
import { buildParamStats, paramRowsForRun, flattenParams, fmtParamValue }
  from '../../src/visualization/monte-carlo/mc-run-params.js';

/** A batch where `inflationRate` and one shock severity vary and the rest do not. */
function makeRuns() {
  const mk = (seed, inflation, severity, nw, failed) => ({
    seed,
    params: {
      inflationRate: inflation,
      monthlyExpenses: 9_000,                       // fixed across the batch
      shocks: [{ preset: 'GFC', severity }],        // nested + varying
    },
    finalNetWorthUsd:  nw,
    finalNetLiquidity: nw / 2,
    scenarioFailed:    failed,
    outOfFundsDate:    failed ? new Date(Date.UTC(2044, 5, 1)) : null,
    timeSeries: [{ netWorthUsd: nw / 2 }, { netWorthUsd: nw }],
  });
  return [
    mk(1, 0.03, 0.40, 3_000_000, false),
    mk(2, 0.031, 0.41, 2_800_000, false),
    mk(3, 0.09, 0.85,   -50_000, true),   // the outlier, and the failure
    mk(4, 0.029, 0.39, 3_200_000, false),
  ];
}

const SUMMARY = { p50: 2_900_000 };

function makePanel() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return { container, panel: new McRunsPanel(container) };
}

// ─── Param statistics ─────────────────────────────────────────────────────────

describe('mc-run-params', () => {
  test('flattenParams uses bracketed array paths', () => {
    const flat = flattenParams({ shocks: [{ severity: 0.4 }], top: 1 });
    expect(flat.get('shocks[0].severity')).toBe(0.4);
    expect(flat.get('top')).toBe(1);
  });

  test('splits params into varying and fixed across the batch', () => {
    const stats = buildParamStats(makeRuns());
    expect(stats.get('inflationRate').varying).toBe(true);
    expect(stats.get('shocks[0].severity').varying).toBe(true);
    expect(stats.get('monthlyExpenses').varying).toBe(false);
  });

  test('ranks a run\'s varying params by distance from the batch median', () => {
    const runs  = makeRuns();
    const stats = buildParamStats(runs);
    const { varying, fixed } = paramRowsForRun(runs[2], stats);

    // The outlier run's rows are both far from the median, and the fixed param is
    // not among them — that separation IS the feature.
    expect(varying.map(r => r.path).sort())
      .toEqual(['inflationRate', 'shocks[0].severity']);
    // `shocks[0].preset` is a string that never changes — fixed, exactly like a number
    // that never changes. Varying-ness is about the batch, not about the type.
    expect(fixed.map(r => r.path)).toEqual(['monthlyExpenses', 'shocks[0].preset']);

    // Ranked by |z| descending, so the top row is the run's most unusual draw.
    expect(Math.abs(varying[0].z)).toBeGreaterThanOrEqual(Math.abs(varying[1].z));
    expect(varying.every(r => r.delta > 0)).toBe(true);
  });

  test('a typical run sits near the median', () => {
    const runs  = makeRuns();
    const stats = buildParamStats(runs);
    const { varying } = paramRowsForRun(runs[0], stats);
    expect(Math.abs(varying[0].z)).toBeLessThan(1);
  });

  test('fmtParamValue keeps rate precision and compacts large numbers', () => {
    expect(fmtParamValue(0.0713)).toBe('0.0713');
    expect(fmtParamValue(3_100_000)).toBe('3,100,000');
    expect(fmtParamValue(2031)).toBe('2031');
    expect(fmtParamValue(new Date(Date.UTC(2031, 0, 2)))).toBe('2031-01-02');
    expect(fmtParamValue(null)).toBe('—');
  });
});

// ─── Panel ────────────────────────────────────────────────────────────────────

describe('McRunsPanel — full run list', () => {
  test('lists every run, not just the representatives', () => {
    const { panel, container } = makePanel();
    panel.showResults(SUMMARY, makeRuns());

    expect(container.querySelectorAll('.mc-run-line').length).toBe(4);
    expect(container.querySelector('.mc-all-runs-header').textContent)
      .toContain('All Runs (4, 1 failed)');

    panel.destroy();
  });

  test('failed-only filter narrows the list', () => {
    const { panel, container } = makePanel();
    panel.showResults(SUMMARY, makeRuns());

    container.querySelector('.mc-run-filter input').click();
    const lines = container.querySelectorAll('.mc-run-line');
    expect(lines.length).toBe(1);
    expect(lines[0].textContent).toContain('#3');

    panel.destroy();
  });

  test('sort order is applied to the list', () => {
    const { panel, container } = makePanel();
    panel.showResults(SUMMARY, makeRuns());

    const seeds = () => [...container.querySelectorAll('.mc-run-line-seed')].map(e => e.textContent);
    expect(seeds()[0]).toBe('#3');            // value ascending → the failure first

    const sel = container.querySelector('.mc-run-sort');
    sel.value = 'metricDesc';
    sel.dispatchEvent(new Event('change'));
    expect(seeds()[0]).toBe('#4');            // highest net worth

    panel.destroy();
  });

  test('a row replays its own run', () => {
    const { panel, container } = makePanel();
    const runs = makeRuns();
    panel.showResults(SUMMARY, runs);

    let replayed = null;
    panel.onRunSelected = (run) => { replayed = run; };
    container.querySelector('.mc-run-line-replay').click();
    expect(replayed.seed).toBe(3);            // first row under the default sort

    panel.destroy();
  });
});

describe('McRunsPanel — per-run params', () => {
  test('params are built on expand, not on render', () => {
    const { panel, container } = makePanel();
    panel.showResults(SUMMARY, makeRuns());

    expect(container.querySelector('.mc-params-table')).toBeNull();

    container.querySelector('.mc-run-expand').click();
    const rows = [...container.querySelectorAll('.mc-params-table tbody tr')];
    expect(rows.length).toBeGreaterThan(0);

    panel.destroy();
  });

  test('columns are labelled, and the delta column says what it compares to', () => {
    const { panel, container } = makePanel();
    panel.showResults(SUMMARY, makeRuns());
    container.querySelector('.mc-run-expand').click();

    // The first table in the box is the sampled one; the fixed table is the second.
    const heads = [...container.querySelector('.mc-params-table').querySelectorAll('thead th')];
    expect(heads.map(h => h.textContent)).toEqual(['Parameter', 'Value', 'Δ vs median']);

    // "▲0.0848 2.2σ" reads as a change from a default unless something says otherwise,
    // and it is not one — the comparison is against the batch.
    const deltaHead = heads[2];
    expect(deltaHead.title).toContain('across every run in this batch');
    expect(deltaHead.title).toContain('NOT from the scenario value or a default');

    // The fixed table has nothing to compare against, so it carries only two columns.
    const fixedHeads = [...container.querySelectorAll('.mc-params-fixed thead th')];
    expect(fixedHeads.map(h => h.textContent)).toEqual(['Parameter', 'Value']);

    panel.destroy();
  });

  test('the expanded table leads with the run\'s most unusual draw', () => {
    const { panel, container } = makePanel();
    panel.showResults(SUMMARY, makeRuns());

    // Default sort puts the failing run (#3) first.
    container.querySelector('.mc-run-expand').click();
    const first = container.querySelector('.mc-params-table tbody tr');
    expect(first.querySelector('.mc-params-name').textContent)
      .toMatch(/inflationRate|shocks\[0\]\.severity/);
    expect(first.querySelector('.mc-params-delta').textContent).toContain('σ');

    // Fixed params are present but tucked behind their own disclosure.
    const fixed = container.querySelector('.mc-params-fixed');
    expect(fixed.textContent).toContain('Fixed (2)');

    panel.destroy();
  });

  test('expanding twice collapses', () => {
    const { panel, container } = makePanel();
    panel.showResults(SUMMARY, makeRuns());

    const toggle = container.querySelector('.mc-run-expand');
    toggle.click();
    expect(container.querySelector('.mc-params-box').hidden).toBe(false);
    toggle.click();
    expect(container.querySelector('.mc-params-box').hidden).toBe(true);

    panel.destroy();
  });

  test('representative cards expand their params too', () => {
    const { panel, container } = makePanel();
    panel.showResults(SUMMARY, makeRuns());

    const btn = container.querySelector('.mc-run-params-btn');
    expect(btn.textContent).toBe('▸ Params');
    btn.click();
    expect(btn.textContent).toBe('▾ Params');
    expect(container.querySelector('.mc-run-card .mc-params-box')).toBeTruthy();

    panel.destroy();
  });
});

describe('McRunsPanel — replay seed badge', () => {
  test('no badge until a seed is pinned', () => {
    const { panel, container } = makePanel();
    panel.showResults(SUMMARY, makeRuns());
    expect(container.querySelector('.mc-replay-badge')).toBeNull();

    panel.setReplaySeed(3);
    const badge = container.querySelector('.mc-replay-badge');
    expect(badge.textContent).toContain('seed 3');

    let cleared = 0;
    panel.onClearReplaySeed = () => { cleared++; };
    badge.querySelector('button').click();
    expect(cleared).toBe(1);

    panel.destroy();
  });

  test('setReplaySeed before results does not throw', () => {
    const { panel, container } = makePanel();
    expect(() => panel.setReplaySeed(7)).not.toThrow();
    panel.showResults(SUMMARY, makeRuns());
    expect(container.querySelector('.mc-replay-badge').textContent).toContain('seed 7');

    panel.destroy();
  });
});
