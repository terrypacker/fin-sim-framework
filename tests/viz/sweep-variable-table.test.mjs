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
 * sweep-variable-table.test.mjs — design 98 W4: the MC and Opt config panels share a
 * grouped variable table with a live filter, collapsible groups and enabled/total
 * counts. Every row is built; collapse and filter only hide.
 *
 * Run with: npm run test:viz
 */

import { McConfigPanel }      from '../../src/visualization/monte-carlo/mc-config-panel.js';
import { OptConfigPanel }     from '../../src/visualization/optimization/opt-config-panel.js';
import { DISTRIBUTION_TYPES } from '../../src/simulation-framework/distributions.js';
import { OPT_PARAM_TYPES }    from '../../src/finance/optimization/optimization-objectives.js';

const N = DISTRIBUTION_TYPES.NORMAL;
// Keys that are NOT enabled in DEFAULT_MC_VARIABLE_CONFIGS: the panel carries a row's
// enabled state across setVariables() by paramKey, and its constructor renders the
// defaults first, so a default-enabled key would arrive enabled whatever the fixture says.
const MC_VARS = [
  { paramKey: 'rothGrowthRate', label: 'Roth Growth', group: 'Rates', type: N, mean: 0.07, stdDev: 0.03, enabled: true },
  { paramKey: 'testIraRate',    label: 'IRA Growth',  group: 'Rates', type: N, mean: 0.07, stdDev: 0.03, enabled: false },
  { paramKey: 'goldGrowthRate', label: 'Gold Growth', group: 'Commodities', type: N, mean: 0.05, stdDev: 0.01, enabled: false },
  { paramKey: 'prop.usHouseProperty.value', label: 'US House — Value', group: 'US · US House', type: N, mean: 1e6, stdDev: 1e5, enabled: false },
];

function makeMc(vars = MC_VARS) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const panel = new McConfigPanel(container);
  panel.setVariables(vars);
  return { container, panel };
}

const header = (container, name) => [...container.querySelectorAll('.sweep-group-header')]
  .find(h => h.querySelector('.sweep-group-label').textContent === name);
const bodyOf = h => h.nextElementSibling;
const typeFilter = (container, text) => {
  const inp = container.querySelector('.sweep-var-filter');
  inp.value = text;
  inp.dispatchEvent(new Event('input'));
};

describe('SweepVariableTable (design 98 W4)', () => {
  test('a group holding an enabled row starts expanded; the others start collapsed', () => {
    const { container, panel } = makeMc();
    expect(bodyOf(header(container, 'Rates')).hidden).toBe(false);
    expect(bodyOf(header(container, 'Commodities')).hidden).toBe(true);
    expect(header(container, 'Rates').querySelector('.sweep-group-count').textContent).toBe('1 / 2');
    panel.destroy();
  });

  test('every row is built, collapsed or not', () => {
    const { container, panel } = makeMc();
    expect(container.querySelectorAll('.mc-var-row').length).toBe(MC_VARS.length);
    panel.destroy();
  });

  test('collapsing a group keeps its enabled row enabled in getConfig()', () => {
    const { container, panel } = makeMc();
    header(container, 'Rates').click();
    expect(bodyOf(header(container, 'Rates')).hidden).toBe(true);
    const roth = panel.getConfig().variableConfigs.find(c => c.paramKey === 'rothGrowthRate');
    expect(roth.enabled).toBe(true);
    panel.destroy();
  });

  test('a row enabled inside a collapsed group is carried by getConfig(), and the count follows', () => {
    const { container, panel } = makeMc();
    const goldCb = bodyOf(header(container, 'Commodities')).querySelector('input[type="checkbox"]');
    goldCb.checked = true;
    goldCb.dispatchEvent(new Event('change', { bubbles: true }));
    expect(panel.getConfig().variableConfigs.find(c => c.paramKey === 'goldGrowthRate').enabled).toBe(true);
    expect(header(container, 'Commodities').querySelector('.sweep-group-count').textContent).toBe('1 / 1');
    panel.destroy();
  });

  test('the filter force-expands matching groups and hides the rest', () => {
    const { container, panel } = makeMc();
    typeFilter(container, 'gold');
    expect(bodyOf(header(container, 'Commodities')).hidden).toBe(false);
    expect(header(container, 'Rates').hidden).toBe(true);
    typeFilter(container, '');
    expect(bodyOf(header(container, 'Commodities')).hidden).toBe(true);   // back to collapsed
    panel.destroy();
  });

  test('the filter matches label, paramKey and group', () => {
    const { container, panel } = makeMc();
    const visibleRows = () => [...container.querySelectorAll('.mc-var-row')]
      .filter(r => !r.hidden && !r.parentElement.hidden).length;
    typeFilter(container, 'IRA Growth');             // label
    expect(visibleRows()).toBe(1);
    typeFilter(container, 'prop.usHouseProperty');   // paramKey
    expect(visibleRows()).toBe(1);
    typeFilter(container, 'rates');                  // group
    expect(visibleRows()).toBe(2);
    panel.destroy();
  });

  test('a user collapse survives a setVariables() rebuild', () => {
    const { container, panel } = makeMc();
    header(container, 'Rates').click();
    panel.setVariables(MC_VARS);
    expect(bodyOf(header(container, 'Rates')).hidden).toBe(true);
    panel.destroy();
  });

  test('the Opt panel shares it: collapse keeps an enabled axis in the search space', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new OptConfigPanel(container);
    // A key absent from DEFAULT_OPTIMIZATION_CONFIGS (where monthlyExpenses is disabled
    // and would carry that state over the fixture's, as MC_VARS notes).
    panel.setVariables([
      { paramKey: 'testExpenses', label: 'Monthly Expenses', group: 'Spending',
        type: OPT_PARAM_TYPES.INTEGER, min: 3000, max: 8000, step: 500, enabled: true },
      { paramKey: 'dividendReinvest', label: 'Reinvest Dividends', group: 'US Retirement',
        type: OPT_PARAM_TYPES.ENUM, values: [false, true], enabled: false },
    ]);
    expect(bodyOf(header(container, 'Spending')).hidden).toBe(false);
    expect(bodyOf(header(container, 'US Retirement')).hidden).toBe(true);
    header(container, 'Spending').click();
    const cfg = panel.getConfig().optimizationConfigs.find(c => c.paramKey === 'testExpenses');
    expect(cfg.enabled).toBe(true);
    expect(panel.getConfig().candidateCount).toBe(11);
    panel.destroy();
  });
});
