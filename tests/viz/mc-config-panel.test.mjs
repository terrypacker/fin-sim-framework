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
 * mc-config-panel.test.mjs
 *
 * Covers the "Copy from Scenario" feature: applyScenarioValues() writes the
 * current scenario parameter value into each variable row's distribution center
 * (mean for distributions, value for CONSTANT) while leaving the enabled flag,
 * distribution type, and stdDev untouched. The mechanism is keyed purely by
 * paramKey, so it is generic across present and future MC variables.
 *
 * Run with: npm run test:viz
 */

import { McConfigPanel }     from '../../src/visualization/monte-carlo/mc-config-panel.js';
import { DISTRIBUTION_TYPES } from '../../src/simulation-framework/distributions.js';

function makePanel() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const panel = new McConfigPanel(container);
  return { container, panel };
}

describe('McConfigPanel — Copy from Scenario', () => {
  test('renders a Copy from Scenario button wired to onCopyFromScenario', () => {
    const { panel, container } = makePanel();
    const btn = container.querySelector('.mc-copy-scenario-btn');
    expect(btn).toBeTruthy();

    let fired = 0;
    panel.onCopyFromScenario = () => { fired++; };
    btn.click();
    expect(fired).toBe(1);

    panel.destroy();
  });

  test('applyScenarioValues writes the mean for a NORMAL variable', () => {
    const { panel } = makePanel();
    panel.setVariables([
      { paramKey: 'rothGrowthRate', label: 'Roth', group: 'G',
        type: DISTRIBUTION_TYPES.NORMAL, mean: 0.07, stdDev: 0.03, enabled: true },
    ]);

    const count = panel.applyScenarioValues(new Map([['rothGrowthRate', 0.123]]));
    expect(count).toBe(1);

    const cfg = panel.getConfig().variableConfigs.find(c => c.paramKey === 'rothGrowthRate');
    expect(cfg.mean).toBeCloseTo(0.123);
    // stdDev / enabled / type preserved
    expect(cfg.stdDev).toBeCloseTo(0.03);
    expect(cfg.enabled).toBe(true);
    expect(cfg.type).toBe(DISTRIBUTION_TYPES.NORMAL);

    panel.destroy();
  });

  test('applyScenarioValues writes the value for a CONSTANT variable', () => {
    const { panel } = makePanel();
    panel.setVariables([
      { paramKey: 'rothBalance', label: 'Roth Balance', group: 'G',
        type: DISTRIBUTION_TYPES.CONSTANT, value: 100000, enabled: false },
    ]);

    panel.applyScenarioValues(new Map([['rothBalance', 250000]]));

    const cfg = panel.getConfig().variableConfigs.find(c => c.paramKey === 'rothBalance');
    expect(cfg.value).toBeCloseTo(250000);
    expect(cfg.enabled).toBe(false);

    panel.destroy();
  });

  test('leaves rows absent from the values map untouched', () => {
    const { panel } = makePanel();
    panel.setVariables([
      { paramKey: 'a', label: 'A', group: 'G', type: DISTRIBUTION_TYPES.NORMAL, mean: 1, stdDev: 0.5 },
      { paramKey: 'b', label: 'B', group: 'G', type: DISTRIBUTION_TYPES.NORMAL, mean: 2, stdDev: 0.5 },
    ]);

    const count = panel.applyScenarioValues(new Map([['a', 9]]));
    expect(count).toBe(1);

    const out = panel.getConfig().variableConfigs;
    expect(out.find(c => c.paramKey === 'a').mean).toBeCloseTo(9);
    expect(out.find(c => c.paramKey === 'b').mean).toBeCloseTo(2);

    panel.destroy();
  });

  test('skips UNIFORM_DATE variables (no numeric center)', () => {
    const { panel } = makePanel();
    panel.setVariables([
      { paramKey: 'shocks[0].startDate', label: 'Shock start', group: 'G',
        type: DISTRIBUTION_TYPES.UNIFORM_DATE, min: '2028-01-01', max: '2035-01-01' },
    ]);

    const count = panel.applyScenarioValues(new Map([['shocks[0].startDate', '2030-06-01']]));
    expect(count).toBe(0);

    const cfg = panel.getConfig().variableConfigs.find(c => c.paramKey === 'shocks[0].startDate');
    expect(cfg.min).toBe('2028-01-01');
    expect(cfg.max).toBe('2035-01-01');

    panel.destroy();
  });
});

/**
 * Automatic re-centring. The panel is built once per scenario load, so a param
 * edited afterwards would leave its MC center behind and the run would silently
 * describe the previous plan. syncScenarioCenters() closes that gap on every run,
 * while never overwriting a center the user typed — those are flagged instead.
 */
describe('McConfigPanel — automatic re-centring', () => {
  const VARS = [
    { paramKey: 'a', label: 'A', group: 'G', type: DISTRIBUTION_TYPES.NORMAL, mean: 1, stdDev: 0.5 },
    { paramKey: 'b', label: 'B', group: 'G', type: DISTRIBUTION_TYPES.NORMAL, mean: 2, stdDev: 0.5 },
  ];

  /** Type `value` into a row's mean input the way a user would. */
  function typeMean(container, index, value) {
    const inp = container.querySelectorAll('.mc-var-row')[index].querySelector('input[placeholder="mean"]');
    inp.value = String(value);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  }

  test('re-centres untouched rows on the live scenario', () => {
    const { panel } = makePanel();
    panel.setVariables(VARS);
    panel.onResolveScenarioCenters = () => new Map([['a', 0.11], ['b', 0.22]]);

    const { updated, diverged } = panel.syncScenarioCenters();
    expect(updated).toBe(2);
    expect(diverged).toEqual([]);

    const out = panel.getConfig().variableConfigs;
    expect(out.find(c => c.paramKey === 'a').mean).toBeCloseTo(0.11);
    expect(out.find(c => c.paramKey === 'b').mean).toBeCloseTo(0.22);

    panel.destroy();
  });

  test('keeps a user-typed center and reports it as diverged', () => {
    const { panel, container } = makePanel();
    panel.setVariables(VARS);
    typeMean(container, 0, 0.5);
    panel.onResolveScenarioCenters = () => new Map([['a', 0.11], ['b', 0.22]]);

    const { updated, diverged } = panel.syncScenarioCenters();
    expect(updated).toBe(1);                       // only the untouched row moved
    expect(diverged).toEqual([{ paramKey: 'a', center: 0.5, scenarioValue: 0.11 }]);
    expect(container.querySelectorAll('.mc-var-diverged').length).toBe(1);

    const out = panel.getConfig().variableConfigs;
    expect(out.find(c => c.paramKey === 'a').mean).toBeCloseTo(0.5);
    expect(out.find(c => c.paramKey === 'b').mean).toBeCloseTo(0.22);

    panel.destroy();
  });

  test('Copy from Scenario clears the user-set flag, so the row re-centres again', () => {
    const { panel, container } = makePanel();
    panel.setVariables(VARS);
    typeMean(container, 0, 0.5);
    panel.onResolveScenarioCenters = () => new Map([['a', 0.11]]);

    panel.applyScenarioValues(new Map([['a', 0.11]]));
    expect(container.querySelectorAll('.mc-var-diverged').length).toBe(0);

    panel.onResolveScenarioCenters = () => new Map([['a', 0.33]]);
    expect(panel.syncScenarioCenters().updated).toBe(1);
    expect(panel.getConfig().variableConfigs.find(c => c.paramKey === 'a').mean).toBeCloseTo(0.33);

    panel.destroy();
  });

  test('the Run button re-centres before emitting the config', () => {
    const { panel, container } = makePanel();
    panel.setVariables(VARS);
    panel.onResolveScenarioCenters = () => new Map([['a', 0.44], ['b', 0.55]]);

    let emitted = null;
    panel.onRun = (config) => { emitted = config; };
    container.querySelector('.btn-primary').click();

    expect(emitted.variableConfigs.find(c => c.paramKey === 'a').mean).toBeCloseTo(0.44);
    expect(emitted.variableConfigs.find(c => c.paramKey === 'b').mean).toBeCloseTo(0.55);

    panel.destroy();
  });

  test('tags each row with where its center came from, before any run', () => {
    const { panel, container } = makePanel();
    panel.setVariables([
      { ...VARS[0], paramKey: 'plan',  centerSource: 'scenario' },
      { ...VARS[0], paramKey: 'sch',   centerSource: 'schema'   },
      { ...VARS[0], paramKey: 'synth', centerSource: 'default'  },
    ]);

    const tags = [...container.querySelectorAll('.mc-var-source')];
    // `scenario` is the normal case and renders nothing — 40-odd rows all saying
    // "scenario" would bury the one that doesn't.
    expect(tags.map(t => t.textContent)).toEqual(['', 'schema', 'default']);
    expect(tags[2].classList.contains('mc-var-source--default')).toBe(true);
    expect(tags[2].title).toContain('framework default');

    panel.destroy();
  });

  test('typing a center flips its tag to "user", and re-syncing flips it back', () => {
    const { panel, container } = makePanel();
    panel.setVariables([{ ...VARS[0], paramKey: 'a', centerSource: 'scenario' }]);
    const tag = container.querySelector('.mc-var-source');

    typeMean(container, 0, 0.5);
    expect(tag.textContent).toBe('user');

    panel.applyScenarioValues(new Map([['a', 0.11]]));
    expect(tag.textContent).toBe('');

    panel.destroy();
  });

  test('user-set centers survive a setVariables rebuild', () => {
    const { panel, container } = makePanel();
    panel.setVariables(VARS);
    typeMean(container, 0, 0.5);
    panel.setVariables(VARS);                      // e.g. a shock added to the scenario
    panel.onResolveScenarioCenters = () => new Map([['a', 0.11], ['b', 0.22]]);

    const { diverged } = panel.syncScenarioCenters();
    expect(diverged).toEqual([{ paramKey: 'a', center: 0.5, scenarioValue: 0.11 }]);

    panel.destroy();
  });
});
