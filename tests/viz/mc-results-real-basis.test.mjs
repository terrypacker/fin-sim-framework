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
 * mc-results-real-basis.test.mjs — design 79 §9: under a real basis the MC panel
 * restates EACH PATH by its own recorded rates before ranking, all or nothing.
 */

import { McResultsPanel }  from '../../src/visualization/monte-carlo/mc-results-panel.js';
import { ServiceRegistry } from '../../src/services/service-registry.js';

global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

const Y = (y) => new Date(Date.UTC(y, 0, 1));
const rates = (US, usdAud = 1.5, AU = US) => ({ priceLevels: { US, AU }, usdAud });

/** A path: nominal net worth at 2026 and 2040, and the level its world reached. */
const path = (seed, nw2040, level2040) => ({
  seed, scenarioFailed: false, outOfFundsDate: null,
  finalNetWorthUsd: nw2040, finalNetLiquidity: nw2040 / 2,
  terminalRates: rates(level2040),
  timeSeries: [
    { date: Y(2026), netWorthUsd: 1000, netLiquidity: 500, rates: rates(1) },
    { date: Y(2040), netWorthUsd: nw2040, netLiquidity: nw2040 / 2, rates: rates(level2040) },
  ],
  pathShape: {},
});

// Nominal ranks 3000 > 2000 > 1000; real (÷ own level) is 3000, 500, 500.
const RUNS = [path(1, 3000, 1), path(2, 2000, 4), path(3, 1000, 2)];

function panelWith(basis, display = 'USD') {
  ServiceRegistry.resetAll();
  ServiceRegistry.getInstance().schemaRegistry.displaySettings = { displayCurrency: display, valueBasis: basis };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const panel = new McResultsPanel(container);
  panel.showResults({ successRate: 1, failureCount: 0, p10: 1000, p50: 2000, p90: 3000, pathShape: {} }, RUNS);
  return { panel, container };
}

const badge = (container, label) =>
  [...container.querySelectorAll('.mc-badge-card')]
    .find(c => c.querySelector('.mc-badge-label')?.textContent === label)
    ?.querySelector('.mc-badge-value')?.textContent;

afterEach(() => ServiceRegistry.resetAll());

describe('McResultsPanel — real value basis (design 79 §9)', () => {
  test('P50 is the median of restated paths, not the nominal summary', () => {
    const { panel, container } = panelWith('real');
    expect(panel._real).toEqual({ currency: 'USD' });
    expect(badge(container, 'P50 Net Worth')).toBe('$500');
    expect(badge(container, 'P90 Net Worth')).toMatch(/^\$2,500$/);   // interpolated 500..3000
    expect(container.querySelector('[data-basis-note="real"]')).not.toBeNull();
  });

  test('the fan restates every point by that path\'s own level', () => {
    const { panel } = panelWith('real');
    const fan = panel._fanDataByMetric.netWorthUsd;
    expect(fan.p50.map(([, v]) => v)).toEqual([1000, 500]);
  });

  test('an AUD view converts each path at its own FX and divides by AU', () => {
    const { panel } = panelWith('real', 'AUD');
    expect(panel._terminalValues(RUNS, 'netWorthUsd')).toEqual([3000 * 1.5 / 1, 2000 * 1.5 / 4, 1000 * 1.5 / 2]);
  });

  test('one path without recorded rates ⇒ the whole panel stays nominal and says why', () => {
    ServiceRegistry.resetAll();
    ServiceRegistry.getInstance().schemaRegistry.displaySettings = { displayCurrency: 'USD', valueBasis: 'real' };
    const container = document.createElement('div');
    const panel = new McResultsPanel(container);
    const legacy = { ...RUNS[0], terminalRates: undefined };
    panel.showResults({ successRate: 1, failureCount: 0, p10: 1000, p50: 2000, p90: 3000, pathShape: {} },
      [legacy, RUNS[1], RUNS[2]]);
    expect(panel._real).toBeNull();
    expect(badge(container, 'P50 Net Worth')).toBe('$2,000');
    expect(container.querySelector('[data-basis-note="nominal"]')).not.toBeNull();
  });

  test('nominal basis: exactly the pre-design-79 panel, no note', () => {
    const { panel, container } = panelWith('nominal');
    expect(panel._real).toBeNull();
    expect(badge(container, 'P50 Net Worth')).toBe('$2,000');
    expect(container.querySelector('[data-basis-note]')).toBeNull();
  });
});
