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
 * mc-results-path-shape.test.mjs — design 100 §3.
 *
 * The runner computed `summary.pathShape` and a per-run `pathShape` for months and nothing
 * displayed them. These pin the section that does: the badges, the failure-by-realized-
 * return table, the failing-path contrast — and that each is ABSENT, not zeroed, when the
 * result has nothing to say.
 *
 * Run with: npm run test:viz
 */

import { McResultsPanel } from '../../src/visualization/monte-carlo/mc-results-panel.js';

global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

function makePanel() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return { container, panel: new McResultsPanel(container) };
}

const run = (seed, cagr, failed, extra = {}) => ({
  seed, finalNetWorthUsd: 1e6, finalNetLiquidity: 5e5, scenarioFailed: failed,
  outOfFundsDate: failed ? new Date(Date.UTC(2050 + seed, 0, 1)) : null,
  timeSeries: [],
  pathShape: { netWorthCagr: cagr, worst5yrCagr: cagr - 0.05, maxDrawdown: failed ? 0.5 : 0.2 },
  ...extra,
});

const PATH_SHAPE = {
  medianNetWorthCagr: 0.03, medianWorst5yrCagr: -0.02, medianMaxDrawdown: 0.25,
  failureRateBelowMedianDecade: 0.4, failureRateAboveMedianDecade: 0.05,
  medianTroughRealNetLiquidity: 1_200_000, p10TroughRealNetLiquidity: 100_000,
  medianHouseCagr: null, medianHouseMaxDrawdown: null,
  medianRepairSpend: 0, p90RepairSpend: 0, p10RepairSpend: 0,
};
const summary = (pathShape) => ({ successRate: 0.5, failureCount: 2, p10: 1e6, p50: 1e6, p90: 1e6, pathShape });

const badgeLabels = (container) =>
  [...container.querySelectorAll('.mc-shape-section .mc-badge-label')].map(e => e.textContent);

describe('McResultsPanel — path shape section (design 100 §3)', () => {
  test('renders the sequence-risk and liquidity badges from summary.pathShape', () => {
    const { panel, container } = makePanel();
    panel.showResults(summary(PATH_SHAPE), [run(1, 0.05, false), run(2, 0.01, true)]);

    const labels = badgeLabels(container);
    expect(labels).toContain('Median NW CAGR');
    expect(labels).toContain('Fail | Weak 1st Decade');
    expect(labels).toContain('Liquidity Trough P10');
    const values = [...container.querySelectorAll('.mc-shape-section .mc-badge-value')].map(e => e.textContent);
    expect(values).toContain('40.0%');
    expect(values).toContain('5.0%');
    panel.destroy();
  });

  test('house and repair badges appear only when the plan has them', () => {
    const { panel, container } = makePanel();
    panel.showResults(summary(PATH_SHAPE), [run(1, 0.05, false)]);
    expect(badgeLabels(container)).not.toContain('Median House CAGR');
    expect(badgeLabels(container)).not.toContain('Repair Spend P90');
    panel.destroy();

    const b = makePanel();
    b.panel.showResults(summary({ ...PATH_SHAPE, medianHouseCagr: 0.02, medianHouseMaxDrawdown: 0.3,
      medianRepairSpend: 1000, p90RepairSpend: 50_000 }), [run(1, 0.05, false)]);
    expect(badgeLabels(b.container)).toContain('Median House CAGR');
    expect(badgeLabels(b.container)).toContain('Repair Spend P90');
    b.panel.destroy();
  });

  test('bands failures by realized CAGR, counts negative growth, omits empty bands', () => {
    const { panel, container } = makePanel();
    panel.showResults(summary(PATH_SHAPE), [
      run(1, -0.01, true), run(2, 0.02, true), run(3, 0.03, false), run(4, 0.09, false),
    ]);
    const rows = [...container.querySelectorAll('.mc-band-table tbody tr')]
      .map(tr => [...tr.children].map(td => td.textContent));
    expect(rows).toEqual([
      ['< 0%',   '1', '100.0%'],
      ['0%–4%',  '2', '50.0%'],
      ['8%–10%', '1', '0.0%'],
    ]);
    panel.destroy();
  });

  test('says how many paths could not be banded (net worth reached zero)', () => {
    const { panel, container } = makePanel();
    panel.showResults(summary(PATH_SHAPE), [run(1, null, true), run(2, 0.05, false)]);
    expect(container.querySelector('.mc-band-block .mc-shape-note').textContent)
      .toContain('1 path(s) had no computable CAGR');
    panel.destroy();
  });

  test('contrasts failed vs surviving paths, with out-of-funds years', () => {
    const { panel, container } = makePanel();
    panel.showResults(summary(PATH_SHAPE), [run(1, 0.01, true), run(3, 0.01, true), run(2, 0.06, false)]);
    const label = container.querySelector('.mc-drivers-block .mc-section-label').textContent;
    expect(label).toContain('2 failed / 1 survived');
    // Both years describe FAILED paths, so both sit in the Failed column. They once split
    // across Failed/Survived, which read as a surviving path running out of money.
    const oofRow = [...container.querySelectorAll('.mc-drivers-table tbody tr')]
      .map(tr => [...tr.children].map(td => td.textContent))
      .find(cells => cells[0] === 'Out-of-funds year');
    expect(oofRow).toEqual(['Out-of-funds year', 'median 2051 · earliest 2051', '—']);
    panel.destroy();
  });

  test('omits the failing-path contrast when nothing failed', () => {
    const { panel, container } = makePanel();
    panel.showResults(summary(PATH_SHAPE), [run(1, 0.05, false), run(2, 0.06, false)]);
    expect(container.querySelector('.mc-drivers-block')).toBeNull();
    expect(container.querySelector('.mc-band-table')).not.toBeNull();
    panel.destroy();
  });

  test('a result without pathShape (older or restored) renders no section at all', () => {
    const { panel, container } = makePanel();
    panel.showResults(summary(undefined), [run(1, 0.05, false)]);
    expect(container.querySelector('.mc-shape-section')).toBeNull();
    panel.destroy();
  });
});
