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
 * mc-grid.test.mjs — the lever grid in the MC tab (design 100 §7).
 *
 * The config panel's Grid mode (typed axis editors, the cost line shown before a run,
 * the errors that stop one), the results panel's heatmap (a table: every cell carries its
 * number, the reference is outlined, a click reads a cell against it with step 3's paired
 * blocks), and the presenter wiring between them.
 *
 * Run with: npm run test:viz
 */

import { McConfigPanel }       from '../../src/visualization/monte-carlo/mc-config-panel.js';
import { McResultsPanel }      from '../../src/visualization/monte-carlo/mc-results-panel.js';
import { MonteCarloPresenter } from '../../src/visualization/monte-carlo/monte-carlo-presenter.js';
import { ServiceRegistry }     from '../../src/services/service-registry.js';
import { OPT_PARAM_TYPES }     from '../../src/finance/optimization/optimization-objectives.js';

global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
global.requestAnimationFrame ??= (cb) => setTimeout(cb, 0);

const mount = () => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
};

// Keys deliberately not in the MC default list (see the SweepVariableTable test trap).
const AXES = [
  { paramKey: 'gridTestYear', label: 'Retire year', type: OPT_PARAM_TYPES.INTEGER,
    min: 2030, max: 2034, step: 2, group: 'People', planValue: 2032 },
  { paramKey: 'gridTestBracket', label: 'Bracket', type: OPT_PARAM_TYPES.ENUM,
    values: [0.22, 0.24, 0.32], group: 'Roth', planValue: 0.24 },
];

function choose(container, axis, paramKey) {
  const sel = container.querySelectorAll('.mc-grid-axis')[axis];
  sel.value = paramKey;
  sel.dispatchEvent(new Event('change'));
}

describe('McConfigPanel — Grid mode', () => {
  test('Grid mode hides the batch run and telemetry and shows the grid controls', () => {
    const container = mount();
    const panel = new McConfigPanel(container);
    container.querySelector('.mc-mode-btn[data-mode="grid"]').click();
    expect(container.querySelector('.mc-batch-run').hidden).toBe(true);
    expect(container.querySelector('.mc-telemetry').hidden).toBe(true);
    expect(container.querySelector('.mc-grid-body').hidden).toBe(false);
    expect(container.querySelector('.mc-iters-label').textContent).toBe('Paths per cell');
    panel.destroy();
  });

  test('axes give their value lists, and the cost line counts runs before launch', () => {
    const container = mount();
    const panel = new McConfigPanel(container);
    panel.setGridAxes(AXES);
    choose(container, 0, 'gridTestYear');
    choose(container, 1, 'gridTestBracket');

    const cfg = panel.getGridConfig();
    expect(cfg.error).toBeNull();
    expect(cfg.axes.map(a => a.values)).toEqual([[2030, 2032, 2034], [0.22, 0.24, 0.32]]);
    expect(cfg.runs).toBe(900);
    const cost = () => container.querySelector('.mc-grid-cost').textContent;
    expect(cost()).toContain('9 cells × 100 paths = 900 runs');
    expect(cost()).toContain('time is measured once it starts');
    expect(container.querySelector('.mc-grid-plan').textContent).toBe('plan: 2032');

    const mode = container.querySelector('.mc-grid-mode');
    mode.value = 'deterministic';
    mode.dispatchEvent(new Event('change'));
    panel.setMsPerPath(1000);
    expect(cost()).toContain('9 cells × 1 path = 9 runs · about 9s');
    panel.destroy();
  });

  test('unchecking an enum value drops it from the axis', () => {
    const container = mount();
    const panel = new McConfigPanel(container);
    panel.setGridAxes(AXES);
    choose(container, 0, 'gridTestBracket');
    const first = container.querySelector('.mc-grid-enum input');
    first.checked = false;
    first.dispatchEvent(new Event('change', { bubbles: true }));
    expect(panel.getGridConfig().axes[0].values).toEqual([0.24, 0.32]);
    panel.destroy();
  });

  test('a grid that cannot run says why, and Run Grid only sets the status', () => {
    const container = mount();
    const panel = new McConfigPanel(container);
    panel.setGridAxes(AXES);
    let fired = 0;
    panel.onRunGrid = () => { fired++; };

    expect(panel.getGridConfig().error).toBe('Choose a lever for the rows.');
    choose(container, 0, 'gridTestYear');
    const max = container.querySelector('.mc-grid-max');
    max.value = '2100';
    max.dispatchEvent(new Event('input', { bubbles: true }));
    expect(panel.getGridConfig().error).toMatch(/36 values; at most 15/);

    container.querySelector('.mc-grid-run').click();
    expect(fired).toBe(0);
    expect(container.querySelector('.mc-status-el').textContent).toMatch(/at most 15/);

    max.value = '2034';
    max.dispatchEvent(new Event('input', { bubbles: true }));
    container.querySelector('.mc-grid-run').click();
    expect(fired).toBe(1);
    panel.destroy();
  });
});

// ── Results ────────────────────────────────────────────────────────────────────

const pairing = { n: 4, seeds: [1, 2, 3, 4], sampled: [], mcSequenceRisk: true };
const t = true, f = false;
function mcCell(values, fails) {
  const rows = fails.map((failed, i) => ({ seed: i + 1, failed, nw: failed ? 0 : 100, afterTaxNW: failed ? 0 : 100, netWorthCagr: 0.05 }));
  const failures = fails.filter(Boolean).length;
  return { values, rows, summary: {
    n: 4, failures, failureRate: failures / 4, p10: 0, p50: 100, p90: 100, medianAfterTaxNW: 100,
    pathShape: { medianNetWorthCagr: 0.05 }, pairing,
  } };
}
const GRID = {
  mode: 'mc', n: 4,
  axes: [{ paramKey: 'gridTestYear', label: 'Retire year', values: [2030, 2032] },
         { paramKey: 'gridTestSpend', label: 'Spend', values: [0.03, 0.04] }],
  planValues: [2032, 0.04],
  referenceCell: { index: 3, idx: [1, 1], exact: true },
  removedFromSampling: [],
  cells: [
    mcCell([2030, 0.03], [f, f, f, f]),
    mcCell([2030, 0.04], [t, f, f, f]),
    mcCell([2032, 0.03], [f, f, f, f]),
    mcCell([2032, 0.04], [t, t, f, f]),
  ],
};

const cardsIn = (root) => Object.fromEntries([...root.querySelectorAll('.mc-badge-card')]
  .map(c => [c.querySelector('.mc-badge-label').textContent, c.querySelector('.mc-badge-value').textContent]));

describe('McResultsPanel — grid', () => {
  test('one cell per combination, each carrying its number, the reference outlined', () => {
    const container = mount();
    const panel = new McResultsPanel(container);
    panel.showGrid(GRID);
    const cells = [...container.querySelectorAll('.mc-grid-cell')];
    expect(cells.map(c => c.textContent)).toEqual(['0.0%', '25.0%', '0.0%', '50.0%']);
    expect(container.querySelector('.mc-grid-cell--ref').dataset.cell).toBe('3');
    // A failure rate shades from zero: nothing failed → no shade; the worst cell → darkest.
    expect(cells.map(c => c.style.getPropertyValue('--shade'))).toEqual(['0%', '35%', '0%', '60%']);
    expect([...container.querySelectorAll('th.mc-grid-plan')].map(th => th.textContent)).toEqual(['4%', '2032']);
    // Each axis names itself in its own place: the column axis in a spanning row, the row
    // axis alone in the corner (both in one corner made the row-header column too wide).
    expect(container.querySelector('.mc-grid-axis-title').textContent).toBe('Spend →');
    expect(container.querySelector('.mc-grid-axis-title').colSpan).toBe(2);
    expect(container.querySelector('.mc-grid-corner').textContent).toBe('Retire year ↓');
    expect(container.querySelector('.mc-grid-detail .mc-section-label').textContent)
      .toBe('Reference — Retire year 2032, Spend 4%');
    panel.destroy();
  });

  test('clicking a cell reads it against the reference, paired', () => {
    const container = mount();
    const panel = new McResultsPanel(container);
    const seen = [];
    panel.onGridCellSelected = (v) => seen.push(v);
    panel.showGrid(GRID);
    container.querySelector('.mc-grid-cell[data-cell="1"]').click();
    // The presenter hears which cell is read: the reference first, then the click.
    expect(seen).toEqual([{ ref: 3, sel: null, shown: 3 }, { ref: 3, sel: 1, shown: 1 }]);

    expect(container.querySelector('.mc-grid-cell--sel').dataset.cell).toBe('1');
    const detail = container.querySelector('.mc-grid-detail');
    expect(detail.querySelector('.mc-ab-banner')).toBeNull();
    const c = cardsIn(detail);
    // Reference fails seeds 1–2; this cell fails seed 1 only → seed 2 rescued.
    expect(c['Rescues']).toBe('1');
    expect(c['Reverse Rescues']).toBe('0');
    expect(c['Fail in Both']).toBe('1');
    const heads = [...detail.querySelectorAll('.mc-ab-table thead th')].map(th => th.textContent);
    expect(heads).toEqual(['Side by side', 'Reference', 'This cell', 'Change']);
    expect(container.querySelector('.mc-grid-cell[data-cell="1"]').title).toContain('1 rescued, 0 reverse');

    detail.querySelector('.mc-grid-make-ref').click();
    expect(container.querySelector('.mc-grid-cell--ref').dataset.cell).toBe('1');
    expect(container.querySelector('.mc-grid-cell--sel')).toBeNull();
    panel.destroy();
  });

  test('a deterministic one-axis grid shows wealth, marks a failed run, and names removed axes', () => {
    const container = mount();
    const panel = new McResultsPanel(container);
    const detCell = (v, nw, failed) => ({
      values: [v], rows: [{ seed: 1, failed, nw, afterTaxNW: nw }],
      summary: { n: 1, failures: failed ? 1 : 0, failureRate: failed ? 1 : 0, p10: nw, p50: nw, p90: nw,
        medianAfterTaxNW: nw, pathShape: {}, pairing: { ...pairing, n: 1, seeds: [1], mcSequenceRisk: false } },
    });
    panel.showGrid({
      mode: 'deterministic', n: 1,
      axes: [{ paramKey: 'gridTestYear', label: 'Retire year', values: [2030, 2032] }],
      planValues: [2031], referenceCell: { index: 0, idx: [0], exact: false },
      removedFromSampling: ['inflationRate'],
      cells: [detCell(2030, 0, true), detCell(2032, 2_000_000, false)],
    });
    const cells = [...container.querySelectorAll('.mc-grid-cell')];
    expect(cells).toHaveLength(2);
    expect(cells[0].textContent).toContain('✗');
    expect(cells[0].classList.contains('mc-grid-cell--failed')).toBe(true);
    expect(container.querySelector('.mc-grid-table thead').textContent).toContain('After-tax NW');
    expect(container.textContent).toContain('because they are axes: inflationRate');
    expect(container.textContent).toContain('reference starts at the nearest one');
    panel.destroy();
  });
});

describe('MonteCarloPresenter — grid wiring', () => {
  afterEach(() => ServiceRegistry.resetAll());

  test('Run Grid goes to the controller and the grid lands in the results pane', async () => {
    ServiceRegistry.resetAll();
    ServiceRegistry.getInstance().scenarioService.getActive = () => null;
    const view = { configPane: mount(), resultsPane: mount(), runsPane: mount(), destroy() {} };
    let asked = null;
    const presenter = new MonteCarloPresenter({
      controller: {
        runMonteCarlo: () => Promise.resolve({ runs: [], summary: {} }),
        runGrid: (opts) => { asked = opts; return Promise.resolve(GRID); },
      },
      view,
      scenario: { simStart: new Date(Date.UTC(2026, 0, 1)), simEnd: new Date(Date.UTC(2041, 0, 1)), params: {} },
    });

    // The axis list is the Opt harvest, handed to the panel at construction.
    expect(view.configPane.querySelectorAll('.mc-grid-axis option').length).toBeGreaterThan(2);

    presenter._onRunGrid({ n: 4, variableConfigs: [], axes: GRID.axes, mode: 'mc', runs: 16 });
    await new Promise(r => setTimeout(r, 50));

    expect(asked.axes).toBe(GRID.axes);
    expect(asked.mode).toBe('mc');
    expect(view.resultsPane.querySelectorAll('.mc-grid-cell')).toHaveLength(4);
    expect(view.configPane.querySelector('.mc-status-el').textContent).toBe('Completed grid: 4 cells, 16 runs');

    // The Runs panel lists the cell being read (the reference, until a cell is clicked).
    expect(view.runsPane.querySelector('.mc-runs-context').textContent)
      .toBe('Grid cell — Retire year 2032, Spend 4% (reference) · 4 paths');
    expect(view.runsPane.querySelectorAll('.mc-run-line')).toHaveLength(4);
    view.resultsPane.querySelector('.mc-grid-cell[data-cell="0"]').click();
    expect(view.runsPane.querySelector('.mc-runs-context').textContent)
      .toBe('Grid cell — Retire year 2030, Spend 3% · 4 paths');

    // Carried across a rebuild with how it was being read.
    const state = presenter.getGridState();
    expect(state).toMatchObject({ showing: 'grid', ref: 3, sel: 0 });
    presenter.destroy();

    const view2 = { configPane: mount(), resultsPane: mount(), runsPane: mount(), destroy() {} };
    const again = new MonteCarloPresenter({
      controller: { runMonteCarlo: () => Promise.resolve({ runs: [], summary: {} }) },
      view: view2,
      scenario: { simStart: new Date(Date.UTC(2026, 0, 1)), simEnd: new Date(Date.UTC(2041, 0, 1)), params: {} },
    });
    again.restoreGrid(state);
    expect(view2.resultsPane.querySelector('.mc-grid-cell--sel').dataset.cell).toBe('0');
    expect(view2.runsPane.querySelector('.mc-runs-context').textContent).toContain('Retire year 2030');
    again.destroy();
  });
});
