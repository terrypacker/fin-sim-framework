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
 * mc-results-mix-spending.test.mjs — design 100 §4.
 *
 * The asset-mix and spending sections of the MC results panel. Each appears only for a run
 * made with its opt-in flag; these pin that, the one-class-at-a-time chips (bands are
 * marginal, never stacked), the threshold and failed-vs-survived tables, and the spending
 * cross-checks design 89 §21.4 asked for.
 *
 * Run with: npm run test:viz
 */

import { McResultsPanel } from '../../src/visualization/monte-carlo/mc-results-panel.js';
import { DEFAULT_MIX_THRESHOLDS } from '../../src/finance/allocation-reporting/mix-distribution.js';

global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

function makePanel() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return { container, panel: new McResultsPanel(container) };
}

const pt = (year, gross, mix) => ({ date: new Date(Date.UTC(year, 0, 1)), netWorthUsd: gross, grossAssetsUsd: gross, mix });

// Survivors hold equity; the failed path ends all house.
const mixRun = (seed, failed, endMix) => ({
  seed, scenarioFailed: failed, finalNetWorthUsd: 1e6, finalNetLiquidity: 1e5,
  timeSeries: [pt(2030, 100, { EQUITY: 0.6, REAL_ESTATE: 0.4 }), pt(2031, 100, endMix)],
});
const MIX_RUNS = [
  mixRun(1, false, { EQUITY: 0.7, REAL_ESTATE: 0.3 }),
  mixRun(2, false, { EQUITY: 0.5, REAL_ESTATE: 0.5 }),
  mixRun(3, true,  { REAL_ESTATE: 1 }),
];

const spendRec = (over) => ({
  spendingReal: 1_000_000, spendingNominal: 1_500_000, totalReal: 1_200_000, taxReal: 300_000,
  taxShare: 0.3, overstatement: 1, inflationFactor: 1.5, shortfallReal: 0, wentShort: false,
  byCategoryReal: { HOUSING: 400_000, TAX_INCOME: 300_000 }, unclassifiedTypes: [], ...over,
});
const summary = { successRate: 0.5, failureCount: 1, p10: 1e6, p50: 1e6, p90: 1e6 };

describe('McResultsPanel — asset mix section', () => {
  test('absent for a run made without mix', () => {
    const { panel, container } = makePanel();
    panel.showResults(summary, [{ seed: 1, finalNetWorthUsd: 1, timeSeries: [pt(2030, 1, undefined)] }]);
    expect(container.querySelector('.mc-mix-section')).toBeNull();
    panel.destroy();
  });

  test('one chip per class some path held, EQUITY selected first', () => {
    const { panel, container } = makePanel();
    panel.showResults(summary, MIX_RUNS);
    const chips = [...container.querySelectorAll('.mc-mix-chip')];
    expect(chips.map(c => c.dataset.cls).sort()).toEqual(['EQUITY', 'REAL_ESTATE']);
    expect(container.querySelector('.mc-mix-chip--active').dataset.cls).toBe('EQUITY');
    panel.destroy();
  });

  test('clicking a chip selects that class', () => {
    const { panel, container } = makePanel();
    panel.showResults(summary, MIX_RUNS);
    container.querySelector('.mc-mix-chip[data-cls="REAL_ESTATE"]').click();
    expect(container.querySelector('.mc-mix-chip--active').dataset.cls).toBe('REAL_ESTATE');
    expect(panel._mixChartOption().series.find(s => s.id === 'p50').data).toBeDefined();
    panel.destroy();
  });

  test('the chart option carries the failed-path median only when something failed', () => {
    const { panel } = makePanel();
    panel.showResults(summary, MIX_RUNS);
    expect(panel._mixChartOption().series.map(s => s.id)).toContain('failed');
    panel.destroy();

    const b = makePanel();
    b.panel.showResults(summary, MIX_RUNS.filter(r => !r.scenarioFailed));
    expect(b.panel._mixChartOption().series.map(s => s.id)).not.toContain('failed');
    b.panel.destroy();
  });

  test('threshold table has one row per default threshold', () => {
    const { panel, container } = makePanel();
    panel.showResults(summary, MIX_RUNS);
    expect(container.querySelectorAll('.mc-threshold-table tbody tr')).toHaveLength(DEFAULT_MIX_THRESHOLDS.length);
    panel.destroy();
  });

  test('failed-vs-survived table leads with the widest gap', () => {
    const { panel, container } = makePanel();
    panel.showResults(summary, MIX_RUNS);
    const rows = [...container.querySelectorAll('.mc-gap-table tbody tr')].map(tr => [...tr.children].map(td => td.textContent));
    expect(rows[0][0]).toMatch(/EQUITY|REAL_ESTATE/);
    expect(rows[0][3].startsWith('+') || rows[0][3].startsWith('-')).toBe(true);
    expect(container.querySelector('.mc-gap-block .mc-section-label').textContent).toContain('1 failed / 2 survived');
    panel.destroy();
  });
});

describe('McResultsPanel — spending section', () => {
  const run = (seed, failed, spending) => ({ seed, scenarioFailed: failed, finalNetWorthUsd: 1, timeSeries: [], spending });

  test('absent for a run made without spending', () => {
    const { panel, container } = makePanel();
    panel.showResults(summary, [run(1, false, null)]);
    expect(container.querySelector('.mc-spend-section')).toBeNull();
    panel.destroy();
  });

  test('shows went-short beside the failure rate, and the category table', () => {
    const { panel, container } = makePanel();
    panel.showResults(summary, [
      run(1, false, spendRec()),
      run(2, true,  spendRec({ wentShort: true, taxShare: 0.6, shortfallReal: 5000 })),
    ]);
    const cards = Object.fromEntries([...container.querySelectorAll('.mc-spend-section .mc-badge-card')]
      .map(c => [c.querySelector('.mc-badge-label').textContent, c.querySelector('.mc-badge-value').textContent]));
    expect(cards['Went Short']).toBe('50.0%');
    expect(cards['Failure Rate']).toBe('50.0%');
    expect(cards['Tax > 50% of Spending']).toBe('50.0%');
    const cats = [...container.querySelectorAll('.mc-spend-table tbody tr')].map(tr => tr.children[0].textContent);
    expect(cats).toEqual(['HOUSING', 'TAX_INCOME']);
    // The tier travels with each row, so a non-spending category cannot read as cost.
    const heads = [...container.querySelectorAll('.mc-spend-table thead th')].map(th => th.textContent);
    expect(heads).toEqual(['Category', 'Tier', 'P10', 'P50', 'P90', 'Fired']);
    const firstRow = container.querySelector('.mc-spend-table tbody tr');
    expect(firstRow.children).toHaveLength(6);
    expect(container.querySelector('.mc-spend-banner')).toBeNull();
    panel.destroy();
  });

  test('names unclassified action types in a banner', () => {
    const { panel, container } = makePanel();
    panel.showResults(summary, [run(1, false, spendRec({ unclassifiedTypes: ['MYSTERY_DEBIT'] }))]);
    expect(container.querySelector('.mc-spend-banner').textContent).toContain('MYSTERY_DEBIT (1 path)');
    panel.destroy();
  });
});
