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
 * bootstrap-start-ui.test.mjs — design 133's UI follow-ups.
 *
 *   1. A replay writes the path's params onto the plan; Clear puts back what the plan had.
 *   2. The compile's window/start warnings (and refusals) show under their Parameters rows,
 *      and the Monte Carlo line names pre-1951 pinned years and a refused year.
 *   3. A rolling batch's run list tags each path's start year, sorts by it, and a strip tile
 *      opens that year's runs.
 *   4. The return-paths line offers the start-year count as the iterations.
 *
 * Run with: npm run test:viz
 */

import { McRunsPanel }      from '../../src/visualization/monte-carlo/mc-runs-panel.js';
import { McResultsPanel }   from '../../src/visualization/monte-carlo/mc-results-panel.js';
import { McConfigPanel, formatReturnPaths } from '../../src/visualization/monte-carlo/mc-config-panel.js';
import { ScenarioTabView }  from '../../src/visualization/scenario/scenario-tab-view.js';
import { paramAdvisory }    from '../../src/visualization/scenario/param-advisories.js';
import { applyParamBagToConfig, snapshotParamStores, restoreParamStores }
  from '../../src/scenarios/scenario-param-apply.js';

global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

const host = () => { const el = document.createElement('div'); document.body.appendChild(el); return el; };

const run = (seed, startYear, failed = false) => ({
  seed, params: { equityReturnBootstrapStartYear: startYear },
  finalNetWorthUsd: failed ? 0 : 2e6, finalNetLiquidity: 5e5, scenarioFailed: failed,
  outOfFundsDate: failed ? new Date(Date.UTC(2050, 0, 1)) : null,
  timeSeries: [{ date: new Date(Date.UTC(2026, 0, 1)), netWorthUsd: 1e6 },
               { date: new Date(Date.UTC(2027, 0, 1)), netWorthUsd: 2e6 }],
  pathShape: { netWorthCagr: 0.03, minRealNetLiquidity: 1e5 },
});
const ROLLING = { p50: 2e6, pairing: { equityStart: 'ROLLING' } };
const RANDOM  = { p50: 2e6, pairing: { equityStart: null } };

describe('1. Clear undoes what the replay wrote', () => {
  const plan = () => ({
    params: [
      { name: 'equityReturnBootstrapStartYear', value: null },
      { name: 'primeRateMode', value: 'FIXED' },
      { name: 'inflationRate', value: 0.03 },
    ],
    parameters: { equityReturnBootstrapStartYear: null, primeRateMode: 'FIXED', inflationRate: 0.03 },
  });
  const path = { equityReturnBootstrapStartYear: 1966, primeRateMode: 'FOLLOW_INFLATION',
                 inflationRate: 0.041, mcEquityBootstrapStarts: 'ROLLING' };

  test('every param the replay changed goes back; a key it added goes away', () => {
    const cfg = plan();
    const before = snapshotParamStores(cfg);
    applyParamBagToConfig(cfg, path);
    const after = snapshotParamStores(cfg);
    expect(cfg.params.find(p => p.name === 'primeRateMode').value).toBe('FOLLOW_INFLATION');

    expect(restoreParamStores(cfg, before, after).sort())
      .toEqual(['equityReturnBootstrapStartYear', 'inflationRate', 'mcEquityBootstrapStarts', 'primeRateMode']);
    expect(Object.fromEntries(cfg.params.map(p => [p.name, p.value])))
      .toEqual({ equityReturnBootstrapStartYear: null, primeRateMode: 'FIXED', inflationRate: 0.03 });
    expect(cfg.parameters).toEqual(plan().parameters);
  });

  test('a param edited while replaying keeps the edit', () => {
    const cfg = plan();
    const before = snapshotParamStores(cfg);
    applyParamBagToConfig(cfg, path);
    const after = snapshotParamStores(cfg);
    cfg.params.find(p => p.name === 'inflationRate').value = 0.025;
    cfg.parameters.inflationRate = 0.025;
    restoreParamStores(cfg, before, after);
    expect(cfg.params.find(p => p.name === 'inflationRate').value).toBe(0.025);
    expect(cfg.params.find(p => p.name === 'primeRateMode').value).toBe('FIXED');
  });

  test('the replay badge says history is pinned, and that Clear unpins it', () => {
    const panel = new McRunsPanel(host());
    panel.showResults(ROLLING, [run(1, 1951), run(2, 1952)]);
    panel.setReplaySeed(2);
    const badge = panel._container.querySelector('.mc-replay-badge');
    expect(badge.textContent).toMatch(/History is pinned to open in 1952 while it replays\. Clear puts your plan's own settings back/);
    expect(badge.querySelector('button').title).toMatch(/the start year 1952 among them/);

    panel.showResults(RANDOM, [run(1, 1951)]);
    panel.setReplaySeed(1);
    expect(panel._container.querySelector('.mc-replay-pin')).toBeNull();
  });
});

describe('2. warnings where they are acted on', () => {
  const JOINT = { equityReturnStochastic: true, equityReturnModel: 'HISTORICAL_BOOTSTRAP',
                  inflationStochastic: true, inflationModel: 'HISTORICAL_JOINT' };

  test('paramAdvisory: the compile\'s own warnings and refusals', () => {
    expect(paramAdvisory('equityReturnBootstrapFromYear', { ...JOINT, equityReturnBootstrapFromYear: 1926 }).text)
      .toMatch(/Sample From Year 1926 runs from 1951/);
    expect(paramAdvisory('equityReturnBootstrapStartYear', { ...JOINT, equityReturnBootstrapStartYear: 1929 }).text)
      .toMatch(/1929–1950 have no inflation history/);
    const bad = paramAdvisory('equityReturnBootstrapFromYear', { ...JOINT, equityReturnBootstrapFromYear: 1990 });
    expect(bad.refused).toBe(true);
    expect(bad.text).toMatch(/1990 is not allowed/);
    expect(paramAdvisory('equityReturnBootstrapStartYear', { ...JOINT, equityReturnBootstrapStartYear: 1966 })).toBeNull();
    expect(paramAdvisory('inflationRate', JOINT)).toBeNull();
  });

  test('the Parameters row shows it, and redraws when an input changes', () => {
    document.body.innerHTML = '<div id="paramsList"></div>';
    const view = new ScenarioTabView();
    const p = (name, type, value, extra = {}) => ({ name, label: name, type, value, group: 'Economic Shocks', ...extra });
    const scenario = { params: [
      p('equityReturnStochastic', 'Boolean', true),
      p('equityReturnModel', 'Enum', 'HISTORICAL_BOOTSTRAP', { options: ['WHITE_NOISE', 'HISTORICAL_BOOTSTRAP'] }),
      p('inflationStochastic', 'Boolean', true),
      p('inflationModel', 'Enum', 'HISTORICAL_JOINT', { options: ['GAUSSIAN', 'HISTORICAL_JOINT'] }),
      p('equityReturnBootstrapStartYear', 'Number', 1929),
    ] };
    view._groupFold = { isExpanded: () => true };
    view._renderParamsList(scenario);
    const note = () => document.querySelector('[data-id="advisory-equityReturnBootstrapStartYear"]');
    expect(note().hidden).toBe(false);
    expect(note().textContent).toMatch(/1929–1950 have no inflation history/);

    const yearInput = document.querySelector('[data-param-name="equityReturnBootstrapStartYear"] input');
    yearInput.value = '1966';
    yearInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(note().hidden).toBe(true);
  });

  test('the Monte Carlo line: pre-1951 pinned years, and a refused year', () => {
    const info = { equityModel: 'HISTORICAL_BOOTSTRAP', inflationModel: 'HISTORICAL_JOINT',
      window: { name: 'POSTWAR', fromYear: 1951, toYear: 2023, automatic: true, reason: 'joint inflation' },
      start: { startYear: 1929, toYear: 1943, years: 15 } };
    expect(formatReturnPaths(info)).toMatch(/every path opens with 1929–1943 in order \(1929–1943 draw inflation at random: its history starts in 1951\)/);
    expect(formatReturnPaths({ ...info, inflationModel: 'GAUSSIAN' })).not.toMatch(/at random/);
    expect(formatReturnPaths({ error: 'Historical Bootstrap — Sample From Year: 1990 is not allowed.' }))
      .toBe('Every path would fail: Historical Bootstrap — Sample From Year: 1990 is not allowed.');
  });
});

describe('3. the run list under a rolling batch', () => {
  test('each row carries its start year; the sort is offered only when the batch rolled', () => {
    const panel = new McRunsPanel(host());
    panel.showResults(ROLLING, [run(1, 1953), run(2, 1951), run(3, 1952)]);
    const tags = () => [...panel._container.querySelectorAll('.mc-run-line .mc-run-start')].map(e => e.textContent);
    expect(tags().sort()).toEqual(['1951', '1952', '1953']);
    const sorts = [...panel._container.querySelectorAll('.mc-run-sort option')].map(o => o.value);
    expect(sorts).toContain('startYear');

    panel.showResults(RANDOM, [run(1, 1953)]);
    expect(tags()).toEqual([]);
    expect([...panel._container.querySelectorAll('.mc-run-sort option')].map(o => o.value)).not.toContain('startYear');
  });

  test('focusStartYear sorts by start year and marks that year\'s runs', () => {
    const panel = new McRunsPanel(host());
    panel.showResults(ROLLING, [run(1, 1953), run(2, 1951), run(3, 1952), run(4, 1951)]);
    panel.focusStartYear(1951);
    expect(panel._container.querySelector('.mc-run-sort').value).toBe('startYear');
    expect([...panel._container.querySelectorAll('.mc-run-line .mc-run-start')].map(e => e.textContent))
      .toEqual(['1951', '1951', '1952', '1953']);
    expect([...panel._container.querySelectorAll('.mc-run-line--focus .mc-run-line-seed')].map(e => e.textContent))
      .toEqual(['#2', '#4']);
  });

  test('a strip tile opens its start year', () => {
    const panel = new McResultsPanel(host());
    const picked = [];
    panel.onStartYearSelected = (y) => picked.push(y);
    panel.showResults({ successRate: 1, p10: 1, p50: 1, p90: 1, pairing: { equityStart: 'ROLLING' } },
      [run(1, 1965), run(2, 1966, true)]);
    panel._container.querySelector('.mc-start-tile[data-start-year="1966"]').click();
    expect(picked).toEqual([1966]);
    panel.destroy();
  });
});

describe('4. the iterations a rolling batch needs', () => {
  const info = { equityModel: 'HISTORICAL_BOOTSTRAP', inflationModel: 'HISTORICAL_JOINT',
    window: { name: 'POSTWAR', fromYear: 1951, toYear: 2023, automatic: true, reason: 'joint inflation' },
    start: { rolling: true, fromYear: 1951, toYear: 2023, count: 73 } };

  test('offered when the iterations miss a multiple of the start years; one click sets them', () => {
    const panel = new McConfigPanel(host());
    panel.setReturnPaths(info);   // default 100 iterations
    const btn = () => panel._pathsEl.querySelector('.mc-set-iters-btn');
    expect(btn().textContent).toBe('Set iterations to 73');
    btn().click();
    expect(panel._iterEl.value).toBe('73');
    expect(btn()).toBeNull();

    panel._iterEl.value = '146';
    panel._iterEl.dispatchEvent(new Event('input'));
    expect(btn()).toBeNull();
    panel._iterEl.value = '50';
    panel._iterEl.dispatchEvent(new Event('input'));
    expect(btn()).not.toBeNull();
  });

  test('not offered for a random batch', () => {
    const panel = new McConfigPanel(host());
    panel.setReturnPaths({ ...info, start: null });
    expect(panel._pathsEl.querySelector('.mc-set-iters-btn')).toBeNull();
  });
});

describe('follow-ups: real money where starts are compared, and controls that survive a rebuild', () => {
  // A 1970s start: high nominal wealth, eaten by the inflation it carried.
  const priced = (seed, startYear, nw, level) => ({ ...run(seed, startYear), finalNetWorthUsd: nw,
    terminalRates: { priceLevels: { US: level }, usdAud: 1.5 } });

  test('a rolling batch\'s run list ranks and shows today\'s dollars, and says so', () => {
    const panel = new McRunsPanel(host());
    panel.showResults(ROLLING, [priced(1, 1966, 3e6, 3), priced(2, 1977, 5e6, 10), priced(3, 1990, 2e6, 1)]);
    const card = (label) => [...panel._container.querySelectorAll('.mc-run-card')]
      .find(c => c.querySelector('.mc-run-label').textContent === label);
    // Real: 1966 → 1M, 1977 → 0.5M, 1990 → 2M. Nominal would have made 1977 the best.
    expect(card('Best').querySelector('.mc-run-start').textContent).toBe('1990');
    expect(card('Worst').querySelector('.mc-run-start').textContent).toBe('1977');
    expect(card('Worst').querySelector('.mc-run-nw').textContent).toMatch(/500/);
    expect(panel._container.querySelector('.mc-runs-basis').textContent).toMatch(/today's USD/);
    expect([...panel._container.querySelectorAll('.mc-run-line .mc-run-start')].map(e => e.textContent))
      .toEqual(['1977', '1966', '1990']);

    // A random batch under a nominal basis stays nominal.
    panel.showResults(RANDOM, [priced(1, null, 3e6, 3), priced(2, null, 5e6, 10)]);
    expect(panel._container.querySelector('.mc-runs-basis')).toBeNull();
  });

  test('the strip tints each start by its rank of terminal wealth, and names the poorest', () => {
    const panel = new McResultsPanel(host());
    panel.showResults({ successRate: 1, p10: 1, p50: 1, p90: 1, pairing: { equityStart: 'ROLLING' } },
      [priced(1, 1966, 3e6, 3), priced(2, 1977, 5e6, 10), priced(3, 1990, 2e6, 1), priced(4, 1995, 9e6, 1)]);
    const shade = (y) => panel._container.querySelector(`.mc-start-tile[data-start-year="${y}"]`)
      .style.getPropertyValue('--shade');
    expect([1977, 1966, 1990, 1995].map(shade)).toEqual(['60%', '40%', '20%', '0%']);
    expect(panel._container.querySelector('.mc-start-summary').textContent).toBe('Survives all 4 start years.');
    panel.destroy();

    // Of ten or more starts, the three poorest are named.
    const many = new McResultsPanel(host());
    many.showResults({ successRate: 1, p10: 1, p50: 1, p90: 1, pairing: { equityStart: 'ROLLING' } },
      Array.from({ length: 10 }, (_, i) => priced(i + 1, 1960 + i, 1e6 * (10 - Math.abs(i - 6)), 1)));
    expect(many._container.querySelector('.mc-start-summary').textContent)
      .toMatch(/Least wealth at the end \(in today's dollars\): 1960, 1961, 1962\./);
    many.destroy();
  });

  test('the iterations and telemetry options carry from one panel to the next', () => {
    const a = new McConfigPanel(host());
    a._iterEl.value = '73';
    a._mixCb.checked = true;
    const b = new McConfigPanel(host());
    b.setRunControls(a.getRunControls());
    expect(b._iterEl.value).toBe('73');
    expect(b._mixCb.checked).toBe(true);
    expect(b._spendingCb.checked).toBe(false);
  });
});
