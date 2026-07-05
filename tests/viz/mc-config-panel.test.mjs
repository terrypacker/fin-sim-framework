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
