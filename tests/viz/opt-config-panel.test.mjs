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
 * opt-config-panel.test.mjs
 *
 * Covers the design-38 Solver selector + per-solver option block on the
 * Optimization panel: solver list, dynamic option rendering from optionSchema,
 * getConfig() returning solverKey/solverOptions, and the candidate badge that
 * reads "exhaustive" for GRID and "≤ N evaluations" for budgeted solvers.
 *
 * Run with: npm run test:viz
 */

import { OptConfigPanel } from '../../src/visualization/optimization/opt-config-panel.js';

function makePanel() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return { container, panel: new OptConfigPanel(container) };
}

function selectSolver(container, key) {
  const sel = container.querySelector('.opt-solver-select');
  sel.value = key;
  sel.dispatchEvent(new Event('change'));
  return sel;
}

describe('OptConfigPanel — Objective grouping (Die-With-Target family)', () => {
  test('collapses the family into one option with Basis/Terminal sub-selects', () => {
    const { container, panel } = makePanel();
    const objSel = container.querySelector('.opt-objective-select');
    const keys = [...objSel.options].map(o => o.value);
    expect(keys).toEqual(expect.arrayContaining(['family:DIE_WITH_TARGET', 'MAX_NET_WORTH']));
    expect(keys).not.toContain('CRRA_DIE_WITH_TARGET');     // grouped, not flat
    panel.destroy();
  });

  test('getConfig resolves the family + axes to the concrete objective key', () => {
    const { container, panel } = makePanel();
    const objSel = container.querySelector('.opt-objective-select');
    objSel.value = 'family:DIE_WITH_TARGET';
    objSel.dispatchEvent(new Event('change'));

    const axes = container.querySelector('.opt-objective-axes');
    expect(axes.style.display).not.toBe('none');           // shown for a family goal
    container.querySelector('.opt-axis-running').value = 'crra';
    container.querySelector('.opt-axis-scope').value   = 'liquid';
    container.querySelector('.opt-axis-basis').value   = 'nominal';

    expect(panel.getConfig().objectiveKey).toBe('CRRA_DIE_WITH_TARGET_LIQUID');

    // Tax-basis → after-tax resolves to the after-tax variant.
    container.querySelector('.opt-axis-basis').value = 'afterTax';
    expect(panel.getConfig().objectiveKey).toBe('CRRA_DIE_WITH_TARGET_AFTERTAX_LIQUID');

    // A standalone goal hides the axes and resolves directly.
    objSel.value = 'MAX_NET_WORTH';
    objSel.dispatchEvent(new Event('change'));
    expect(axes.style.display).toBe('none');
    expect(panel.getConfig().objectiveKey).toBe('MAX_NET_WORTH');
    panel.destroy();
  });
});

describe('OptConfigPanel — Solver selector', () => {
  test('renders a Solver select populated from SOLVER_REGISTRY', () => {
    const { container, panel } = makePanel();
    const sel = container.querySelector('.opt-solver-select');
    expect(sel).toBeTruthy();
    const keys = [...sel.options].map(o => o.value);
    expect(keys).toEqual(expect.arrayContaining(['GRID', 'PATTERN_SEARCH', 'RANDOM', 'SIMULATED_ANNEALING']));
    panel.destroy();
  });

  test('GRID has no option knobs and an exhaustive candidate badge', () => {
    const { container, panel } = makePanel();
    expect(container.querySelectorAll('.opt-solver-options .node-field').length).toBe(0);
    expect(container.querySelector('.opt-count-label').textContent).toMatch(/exhaustive/);
    expect(panel.getConfig().solverKey).toBe('GRID');
    panel.destroy();
  });

  test('selecting a budgeted solver renders its option knobs and a budget badge', () => {
    const { container, panel } = makePanel();
    selectSolver(container, 'RANDOM');

    const fields = container.querySelectorAll('.opt-solver-options .node-field');
    expect(fields.length).toBeGreaterThan(0);

    const cfg = panel.getConfig();
    expect(cfg.solverKey).toBe('RANDOM');
    expect(cfg.solverOptions.budget).toBe(64);     // schema default, coerced to Number
    expect(cfg.solverOptions.seed).toBe(1);
    expect(cfg.solverOptions.sampling).toBe('lhs'); // Enum default
    expect(container.querySelector('.opt-count-label').textContent).toMatch(/evaluation/);
    panel.destroy();
  });

  test('editing a numeric option updates the budget badge', () => {
    const { container, panel } = makePanel();
    selectSolver(container, 'SIMULATED_ANNEALING');

    // Enable a wide variable (unique paramKey so no saved-state collision with a
    // default config) so the exhaustive grid exceeds the budget.
    panel.setVariables([
      { paramKey: 'zzzWideVar', label: 'Wide Var', group: 'Test',
        type: 'integer', min: 0, max: 199, step: 1, enabled: true },
    ]);

    // Find the budget input and set it small.
    const budgetField = [...container.querySelectorAll('.opt-solver-options .node-field')]
      .find(f => /Max Evaluations/.test(f.querySelector('label').textContent));
    const input = budgetField.querySelector('input');
    input.value = '25';
    input.dispatchEvent(new Event('input'));

    expect(panel.getConfig().solverOptions.budget).toBe(25);
    expect(container.querySelector('.opt-count-label').textContent).toMatch(/≤ 25 evaluations/);
    panel.destroy();
  });

  test('getConfig still returns the objective and search-space configs', () => {
    const { panel } = makePanel();
    const cfg = panel.getConfig();
    expect(cfg.objectiveKey).toBeTruthy();
    expect(Array.isArray(cfg.optimizationConfigs)).toBe(true);
    expect(cfg).toHaveProperty('candidateCount');
    panel.destroy();
  });
});
