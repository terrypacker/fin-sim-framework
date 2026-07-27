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
 * mc-results-provenance.test.mjs
 *
 * The results panel states which world a run describes. The banner alone was not
 * enough: it only appears when something is wrong, so its absence read the same
 * whether the run was verified against the plan or nobody ever checked. The badge
 * makes that a positive claim.
 *
 * Run with: npm run test:viz
 */

import { McResultsPanel } from '../../src/visualization/monte-carlo/mc-results-panel.js';

// eCharts uses ResizeObserver for auto-resize; jsdom doesn't provide it.
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

function makePanel() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return { container, panel: new McResultsPanel(container) };
}

const RUNS = [
  { finalNetWorthUsd: 1_000_000, finalNetLiquidity: 500_000, scenarioFailed: false, timeSeries: [] },
  { finalNetWorthUsd: 2_000_000, finalNetLiquidity: 900_000, scenarioFailed: false, timeSeries: [] },
];
const summaryWith = (provenance) => ({ successRate: 1, failureCount: 0, p10: 1e6, p50: 1.5e6, p90: 2e6, provenance });

describe('McResultsPanel — provenance badge', () => {
  test('states "on scenario" when every center traced to the plan', () => {
    const { panel, container } = makePanel();
    panel.showResults(summaryWith({
      centersBySource: { scenario: ['a'], schema: [], override: [], default: [] },
      syntheticCenters: [], divergentCenters: [], fromScenario: true,
    }), RUNS);

    const badge = container.querySelector('.mc-provenance-badge');
    expect(badge.textContent).toBe('on scenario');
    expect(badge.classList.contains('mc-provenance-badge--off')).toBe(false);
    expect(container.querySelector('.mc-provenance-banner')).toBeNull();

    panel.destroy();
  });

  test('counts the off-plan centers and shows the banner', () => {
    const { panel, container } = makePanel();
    panel.showResults(summaryWith({
      centersBySource: { scenario: [], schema: [], override: ['x'], default: ['y'] },
      syntheticCenters: ['y'],
      divergentCenters: [{ paramKey: 'x', center: 0.04, scenarioValue: 0.10 }],
      fromScenario: false,
    }), RUNS);

    const badge = container.querySelector('.mc-provenance-badge');
    expect(badge.textContent).toBe('⚠ off-plan (2)');
    expect(badge.classList.contains('mc-provenance-badge--off')).toBe(true);

    const banner = container.querySelector('.mc-provenance-banner');
    expect(banner.textContent).toContain('y');
    expect(banner.textContent).toContain('0.04');

    panel.destroy();
  });

  test('omits the badge entirely for a result with no provenance (older run)', () => {
    const { panel, container } = makePanel();
    panel.showResults(summaryWith(undefined), RUNS);

    expect(container.querySelector('.mc-provenance-badge')).toBeNull();

    panel.destroy();
  });
});
