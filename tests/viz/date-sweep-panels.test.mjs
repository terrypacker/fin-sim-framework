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
 * date-sweep-panels.test.mjs — design 117 phase 1, the panel half.
 *
 * The Opt panel's DATE row (date bounds, a step in months or anchored years), the MC
 * panel's NORMAL_DATE row (a mean date, σ in days), and an MC grid DATE axis. Each
 * returns ISO days, never the month counts the solvers search.
 *
 * Run with: npm run test:viz
 */

import { OptConfigPanel }     from '../../src/visualization/optimization/opt-config-panel.js';
import { McConfigPanel }      from '../../src/visualization/monte-carlo/mc-config-panel.js';
import { OPT_PARAM_TYPES }    from '../../src/finance/optimization/optimization-objectives.js';
import { DISTRIBUTION_TYPES } from '../../src/simulation-framework/distributions.js';

global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
global.requestAnimationFrame ??= (cb) => setTimeout(cb, 0);

const mount = () => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
};

// Keys deliberately not in the MC/Opt default lists.
const SALE = { paramKey: 'd117SaleDate', label: 'Sale date', group: 'G', type: OPT_PARAM_TYPES.DATE,
  min: '2030-01-15', max: '2031-12-15', step: 1, enabled: true };
const MOVE = { paramKey: 'd117MoveDate', label: 'Move date', group: 'G', type: OPT_PARAM_TYPES.DATE,
  min: '2028-07-01', max: '2034-07-01', step: 1, anchor: '07-01', enabled: true };

const rowOf = (container, label) => [...container.querySelectorAll('.opt-var-row')]
  .find(r => r.querySelector('.opt-var-label')?.textContent === label);

describe('OptConfigPanel — a DATE row (design 117 §5.2)', () => {
  test('date bounds and a month step; getConfig returns ISO days and counts months', () => {
    const container = mount();
    const panel = new OptConfigPanel(container);
    panel.setVariables([SALE]);
    const row = rowOf(container, 'Sale date');
    const dates = row.querySelectorAll('input[type="date"]');
    expect([...dates].map(d => d.value)).toEqual(['2030-01-15', '2031-12-15']);
    expect(row.querySelector('.opt-var-count').textContent).toBe('24v');

    dates[1].value = '2030-12-15';
    dates[1].dispatchEvent(new Event('input'));
    const cfg = panel.getConfig();
    const out = cfg.optimizationConfigs.find(c => c.paramKey === SALE.paramKey);
    expect([out.min, out.max, out.step]).toEqual(['2030-01-15', '2030-12-15', 1]);
    expect(cfg.candidateCount).toBe(12);
    panel.destroy();
  });

  test('an anchored DATE steps whole years and shows its anchor', () => {
    const container = mount();
    const panel = new OptConfigPanel(container);
    panel.setVariables([MOVE]);
    const row = rowOf(container, 'Move date');
    expect(row.querySelector('[data-id="opt-date-anchor"]').textContent).toBe('on 07-01');
    expect(row.querySelector('.opt-var-count').textContent).toBe('7v');
    panel.destroy();
  });

  test('a typed bound survives a re-render (setVariables keeps the user state)', () => {
    const container = mount();
    const panel = new OptConfigPanel(container);
    panel.setVariables([SALE]);
    const min = rowOf(container, 'Sale date').querySelector('input[type="date"]');
    min.value = '2030-06-15';
    panel.setVariables([SALE]);
    expect(rowOf(container, 'Sale date').querySelector('input[type="date"]').value).toBe('2030-06-15');
    panel.destroy();
  });
});

describe('McConfigPanel — a NORMAL_DATE row (design 117 D10)', () => {
  const ROW = { paramKey: 'd117Buy', label: 'Buy date', group: 'G',
    type: DISTRIBUTION_TYPES.NORMAL_DATE, mean: '2035-03-01', stdDev: 90, enabled: true };

  test('shows a mean date and σ in days; getConfig returns them', () => {
    const container = mount();
    const panel = new McConfigPanel(container);
    panel.setVariables([ROW]);
    const meanDate = container.querySelector('[data-id="mc-mean-date"]');
    expect(meanDate.style.display).toBe('block');
    expect(meanDate.value).toBe('2035-03-01');
    const out = panel.getConfig().variableConfigs.find(c => c.paramKey === ROW.paramKey);
    expect([out.type, out.mean, out.stdDev]).toEqual([DISTRIBUTION_TYPES.NORMAL_DATE, '2035-03-01', 90]);
    panel.destroy();
  });

  test('Copy from Scenario writes a date center as a day', () => {
    const container = mount();
    const panel = new McConfigPanel(container);
    panel.setVariables([ROW]);
    panel.applyScenarioValues(new Map([[ROW.paramKey, '2036-09-15T00:00:00.000Z']]));
    expect(panel.getConfig().variableConfigs.find(c => c.paramKey === ROW.paramKey).mean).toBe('2036-09-15');
    panel.destroy();
  });

  test('switching to NORMAL_DATE swaps the number mean for the date mean', () => {
    const container = mount();
    const panel = new McConfigPanel(container);
    panel.setVariables([{ ...ROW, type: DISTRIBUTION_TYPES.UNIFORM_DATE, min: '2030-01-01', max: '2032-01-01' }]);
    const meanDate = container.querySelector('[data-id="mc-mean-date"]');
    expect(meanDate.style.display).toBe('none');
    const sel = container.querySelector('.mc-var-input-row select');
    sel.value = DISTRIBUTION_TYPES.NORMAL_DATE;
    sel.dispatchEvent(new Event('change'));
    expect(meanDate.style.display).toBe('block');
    panel.destroy();
  });
});

describe('McConfigPanel — a DATE grid axis', () => {
  test('values are ISO days at the month step; the plan value is shown', () => {
    const container = mount();
    const panel = new McConfigPanel(container);
    panel.setGridAxes([{ ...SALE, step: 6, enabled: false, planValue: '2030-07-15' }]);
    const sel = container.querySelectorAll('.mc-grid-axis')[0];
    sel.value = SALE.paramKey;
    sel.dispatchEvent(new Event('change'));
    const cfg = panel.getGridConfig();
    expect(cfg.axes[0].values).toEqual(['2030-01-15', '2030-07-15', '2031-01-15', '2031-07-15']);
    expect(container.querySelector('.mc-grid-plan').textContent).toBe('plan: 2030-07-15');
    panel.destroy();
  });
});
