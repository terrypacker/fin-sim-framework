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
 * mc-results-start-years.test.mjs — design 133 §4.3, the rolling-start strip.
 *
 * One tile per start year, marked when it failed and faded when its pinned run is under
 * 15 years; the table carries the same numbers; absent for a batch that did not roll.
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

// A 30-year plan: the time series' length is the horizon.
const SERIES = Array.from({ length: 30 }, (_, i) => ({ date: new Date(Date.UTC(2026 + i, 0, 1)), netWorthUsd: 1e6, netLiquidity: 5e5 }));
const run = (seed, startYear, failed) => ({
  seed, params: { equityReturnBootstrapStartYear: startYear },
  finalNetWorthUsd: failed ? 0 : 2e6, finalNetLiquidity: 5e5, scenarioFailed: failed,
  outOfFundsDate: failed ? new Date(Date.UTC(2050, 0, 1)) : null,
  timeSeries: SERIES,
  terminalRates: { priceLevels: { US: 2 }, usdAud: 1.5 },
  pathShape: { netWorthCagr: 0.03, minRealNetLiquidity: failed ? 0 : 400_000 },
});
const summary = (equityStart) => ({ successRate: 0.67, failureCount: 1, p10: 1e6, p50: 1e6, p90: 1e6,
  pairing: { equityStart } });

describe('McResultsPanel — by start year (design 133 §4.3)', () => {
  test('a rolling batch gets one tile per start year, failures marked, short runs faded', () => {
    const { panel, container } = makePanel();
    panel.showResults(summary('ROLLING'), [run(1, 1965, false), run(2, 1966, true), run(3, 2015, false)]);

    const tiles = [...container.querySelectorAll('.mc-start-tile')];
    expect(tiles.map(t => t.dataset.startYear)).toEqual(['1965', '1966', '2015']);
    expect(tiles[1].classList.contains('mc-start-tile--fails')).toBe(true);
    expect(tiles[0].classList.contains('mc-start-tile--fails')).toBe(false);
    expect(tiles[2].classList.contains('mc-start-tile--short')).toBe(true);   // 9 years of history
    expect(tiles[1].textContent).toBe('1966 ✗');
    expect(tiles[1].title).toMatch(/success 0\.0%/);
    expect(container.querySelector('.mc-start-summary').textContent).toBe('Fails in 1 of 3 start years: 1966.');
    expect(container.querySelector('.mc-start-section .mc-shape-note').textContent)
      .toMatch(/1 faded start year replay fewer than 15 years/);

    const cells = [...container.querySelectorAll('.mc-start-table tbody tr')].map(tr =>
      [...tr.children].map(td => td.textContent));
    expect(cells[1][0]).toBe('1966');
    expect(cells[1][2]).toBe('0.0%');
    expect(cells[0][5]).toBe('30');   // a 30-year plan replays 30 years from 1965
    expect(cells[2][5]).toBe('9');
    expect(cells[0][4]).toBe('$1,000,000');   // 2e6 at a price level of 2: today's dollars
    expect(container.querySelector('.mc-start-table thead').textContent).toMatch(/today's USD/);
    panel.destroy();
  });

  test('absent for a random or pinned batch', () => {
    for (const s of [null, '1966+15']) {
      const { panel, container } = makePanel();
      panel.showResults(summary(s), [run(1, 1966, false)]);
      expect(container.querySelector('.mc-start-section')).toBeNull();
      panel.destroy();
    }
  });
});
