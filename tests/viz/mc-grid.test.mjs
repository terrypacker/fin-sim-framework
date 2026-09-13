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
  const rows = fails.map((failed, i) => ({
    seed: i + 1, failed, nw: failed ? 0 : 100, afterTaxNW: failed ? 0 : 100, netWorthCagr: 0.05,
    // A failed path troughs at zero, as a real one does (design 100 §10.3.4).
    troughRealNetLiq: failed ? 0 : 500 + i * 10,
  }));
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

const vals   = (root) => [...root.querySelectorAll('.mc-grid-cell')].map(c => c.querySelector('.mc-grid-val').textContent);
const rankOf = (root) => [...root.querySelectorAll('.mc-grid-cell')].map(c => c.querySelector('.mc-grid-rank')?.textContent ?? null);
function pick(root, cls, value) {
  const s = root.querySelector(cls);
  s.value = value;
  s.dispatchEvent(new Event('change'));
}

describe('McResultsPanel — grid', () => {
  test('one cell per combination, each carrying its number and rank, the reference outlined', () => {
    const container = mount();
    const panel = new McResultsPanel(container);
    panel.showGrid(GRID);
    const cells = [...container.querySelectorAll('.mc-grid-cell')];
    expect(vals(container)).toEqual(['0.0%', '25.0%', '0.0%', '50.0%']);
    expect(container.querySelector('.mc-grid-cell--ref').dataset.cell).toBe('3');
    // Darker is better for every metric (design 100 §10.3.5): no failures → darkest.
    expect(cells.map(c => c.style.getPropertyValue('--shade'))).toEqual(['60%', '35%', '60%', '10%']);
    // Dense ranks, ties shared; the best cells are outlined because something ranks below them.
    expect(rankOf(container)).toEqual(['#1', '#2', '#1', '#3']);
    expect([...container.querySelectorAll('.mc-grid-cell--best')].map(c => c.dataset.cell)).toEqual(['0', '2']);
    expect(container.querySelector('.mc-grid-metric').value).toBe('failureRate');
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
    // (Each also carries the ranking, pinned in the §10 tests below.)
    expect(seen.map(({ rank: _rank, ...v }) => v)).toEqual([{ ref: 3, sel: null, shown: 3 }, { ref: 3, sel: 1, shown: 1 }]);

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
    expect(container.querySelector('.mc-grid-table thead').textContent).toContain('After-tax net worth');
    expect(container.textContent).toContain('because they are axes: inflationRate');
    expect(container.textContent).toContain('reference starts at the nearest one');
    // One path per cell: the metric is the only control.
    expect(container.querySelector('.mc-grid-stat')).toBeNull();
    expect(container.querySelector('.mc-grid-reading')).toBeNull();
    panel.destroy();
  });
});

describe('McResultsPanel — ranking grid cells (design 100 §10)', () => {
  test('changing the metric re-ranks without a re-run, and a caveat names its trap', () => {
    const container = mount();
    const panel = new McResultsPanel(container);
    const seen = [];
    panel.onGridCellSelected = (v) => seen.push(v);
    panel.showGrid(GRID);
    pick(container, '.mc-grid-metric', 'nw');
    // P50 nominal NW: 100, 100, 100, and 50 on the cell where half the paths failed.
    expect(rankOf(container)).toEqual(['#1', '#1', '#1', '#2']);
    expect(container.querySelector('.mc-grid-caveat').textContent).toContain('pre-tax dollar');
    expect(container.querySelector('.mc-grid-stat').value).toBe('p50');
    // The presenter hears the choice, so a re-render keeps it.
    expect(seen.at(-1).rank).toMatchObject({ metric: 'nw', stat: 'p50', reading: 'level' });
    panel.destroy();
  });

  test('a trough percentile inside the failures reads "fails" and ranks last; survivors-only reads past it', () => {
    const container = mount();
    const panel = new McResultsPanel(container);
    panel.showGrid(GRID, { rank: { metric: 'troughRealNetLiq', stat: 'p10' } });
    expect(vals(container)[1]).toBe('fails');
    expect(vals(container)[3]).toBe('fails');
    // The two valid cells tie at the top; the degenerate ones follow, fewer failures first.
    expect(rankOf(container)).toEqual(['#1', '#2', '#1', '#3']);
    expect(container.querySelector('.mc-grid-cell--degenerate')).not.toBeNull();

    const box = container.querySelector('.mc-grid-survivors');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(vals(container)).not.toContain('fails');
    expect(container.querySelector('.mc-grid-cell[data-cell="1"] .mc-grid-sub').textContent).toBe('3');
    panel.destroy();
  });

  test('the paired reading: rescue counts for failure, green and red differences for money', () => {
    const container = mount();
    const panel = new McResultsPanel(container);
    panel.showGrid(GRID);
    pick(container, '.mc-grid-reading', 'paired');
    // Reference (cell 3) fails seeds 1–2.
    expect(vals(container)).toEqual(['+2 / 0', '+1 / 0', '+2 / 0', 'ref']);
    expect(container.textContent).toContain('Ranked against the reference: Retire year 2032, Spend 4%');
    expect(container.querySelector('.mc-grid-cell[data-cell="0"]').classList.contains('mc-grid-cell--gain')).toBe(true);

    pick(container, '.mc-grid-metric', 'afterTaxNW');
    expect([...container.querySelectorAll('.mc-grid-stat option')].map(o => o.value)).toContain('winRate');
    // Cell 0 is ahead by 100 in the two worlds the reference failed: P50 of the Δ is +100.
    expect(container.querySelector('.mc-grid-cell[data-cell="0"]').classList.contains('mc-grid-cell--gain')).toBe(true);
    expect(vals(container)[3]).toBe('ref');
    panel.destroy();
  });

  test('a cell that fails a world the reference survives carries the harm mark', () => {
    const container = mount();
    const panel = new McResultsPanel(container);
    // Reference cell 1 fails seed 1 only; cell 3 fails seeds 1–2.
    panel.showGrid(GRID, { ref: 1, rank: { reading: 'paired' } });
    const harmed = container.querySelector('.mc-grid-cell[data-cell="3"]');
    expect(harmed.querySelector('.mc-grid-val').textContent).toBe('0 / −1 ⚠');
    expect(harmed.classList.contains('mc-grid-cell--harm')).toBe(true);
    expect(harmed.classList.contains('mc-grid-cell--loss')).toBe(true);
    panel.destroy();
  });

  test('a grid whose cells are not paired shows levels and says why', () => {
    const container = mount();
    const panel = new McResultsPanel(container);
    const cells = GRID.cells.map((c, k) => (k === 0
      ? { ...c, summary: { ...c.summary, pairing: { ...pairing, mcSequenceRisk: false } } } : c));
    panel.showGrid({ ...GRID, cells }, { rank: { reading: 'paired' } });
    expect(container.querySelector('.mc-grid-results > .mc-ab-banner').textContent).toContain('Not paired with the reference');
    expect(vals(container)).toEqual(['0.0%', '25.0%', '0.0%', '50.0%']);
    panel.destroy();
  });
});

const keysOf    = (root) => [...root.querySelectorAll('.mc-grid-list thead th')].map(th => th.dataset.key);
const listOrder = (root) => [...root.querySelectorAll('.mc-grid-list-row')].map(tr => tr.dataset.cell);

describe('McResultsPanel — constraints and the ranked list (design 100 §10.10)', () => {
  test('a constraint greys the cells that miss it and ranks only the rest', () => {
    const container = mount();
    const panel = new McResultsPanel(container);
    const seen = [];
    panel.onGridCellSelected = (v) => seen.push(v);
    panel.showGrid(GRID);
    expect(container.querySelector('.mc-grid-qualify')).toBeNull();
    expect(container.querySelector('.mc-grid-constraints').open).toBe(false);

    // "+ Constraint" starts as failure rate ≤ 10%: cells 1 (25%) and 3 (50%) miss it.
    container.querySelector('.mc-grid-constraints [data-id="addRow"]').click();
    expect([...container.querySelectorAll('.mc-grid-cell--excluded')].map(c => c.dataset.cell)).toEqual(['1', '3']);
    expect(rankOf(container)).toEqual(['#1', null, '#1', null]);
    expect(container.querySelector('.mc-grid-qualify').textContent).toContain('2 of 4 cells meet the constraints');
    expect(container.querySelector('.mc-grid-cell[data-cell="3"]').title).toContain('misses: Failure rate ≤ 10% (50.0%)');
    expect(container.querySelector('.mc-grid-constraints summary').textContent).toBe('Constraints (1 active)');
    expect(seen.at(-1).rank.constraints).toEqual([{ metric: 'failureRate', stat: 'p50', op: '<=', threshold: 10 }]);

    // The threshold is typed in percent. A blank one leaves the row inactive, not deleted.
    const threshold = () => container.querySelector('.mc-grid-constraints input[data-id="threshold"]');
    threshold().value = '30';
    threshold().dispatchEvent(new Event('change'));
    expect(container.querySelector('.mc-grid-qualify').textContent).toContain('3 of 4');
    threshold().value = '';
    threshold().dispatchEvent(new Event('change'));
    expect(container.querySelector('.mc-grid-qualify')).toBeNull();
    expect(container.querySelectorAll('.mc-grid-constraints .age-band-row:not(.age-band-header)')).toHaveLength(1);
    panel.destroy();
  });

  test('picking a metric takes its better direction; when nothing qualifies, nothing ranks', () => {
    const container = mount();
    const panel = new McResultsPanel(container);
    panel.showGrid(GRID, { rank: { constraints: [{ metric: 'failureRate', op: '<=', threshold: 10 }] } });
    expect(container.querySelector('.mc-grid-constraints').open).toBe(true);

    pick(container, '.mc-grid-constraints select[data-id="metric"]', 'troughRealNetLiq');
    expect(container.querySelector('.mc-grid-constraints select[data-id="op"]').value).toBe('>=');
    // P50 trough ≥ $10: every cell clears it, even the one with two failed paths.
    expect(container.querySelector('.mc-grid-qualify').textContent).toContain('4 of 4');

    const threshold = container.querySelector('.mc-grid-constraints input[data-id="threshold"]');
    threshold.value = '100000';
    threshold.dispatchEvent(new Event('change'));
    expect(container.querySelector('.mc-grid-qualify').textContent).toBe('No cell meets every constraint, so nothing is ranked.');
    expect(rankOf(container)).toEqual([null, null, null, null]);
    panel.destroy();
  });

  test('the ranked list: one row per cell, sortable, and a row click selects the cell', () => {
    const container = mount();
    const panel = new McResultsPanel(container);
    panel.showGrid(GRID);
    // The failure-rate column repeats the ranking column, so only the other two defaults show.
    expect(keysOf(container)).toEqual(['rank', 'cell', 'objective', 'col:afterTaxNW:p50', 'col:troughRealNetLiq:p10']);
    // Ranks #1, #2, #1, #3; ties keep grid order.
    expect(listOrder(container)).toEqual(['0', '2', '1', '3']);
    // The header names the axes once; a row carries its values, with the full label on hover.
    expect(container.querySelector('.mc-grid-list th[data-key="cell"]').textContent).toBe('Retire year · Spend');
    const refName = container.querySelector('.mc-grid-list-row--ref .mc-shape-name');
    expect(refName.textContent).toBe('2032 · 4% (ref)');
    expect(refName.title).toBe('Retire year 2032, Spend 4%');

    const head = (key) => container.querySelector(`.mc-grid-list th[data-key="${key}"]`);
    head('cell').click();
    expect(listOrder(container)).toEqual(['0', '1', '2', '3']);
    head('cell').click();
    expect(listOrder(container)).toEqual(['3', '2', '1', '0']);
    expect(head('cell').textContent).toBe('Retire year · Spend ↑');
    // A value column sorts best first, and a "fails" (degenerate) value sorts last.
    head('col:troughRealNetLiq:p10').click();
    expect(listOrder(container)).toEqual(['0', '2', '1', '3']);
    expect(container.querySelector('.mc-grid-list-row[data-cell="1"]').textContent).toContain('fails');

    container.querySelector('.mc-grid-list-row[data-cell="1"]').click();
    expect(container.querySelector('.mc-grid-cell--sel').dataset.cell).toBe('1');
    expect(container.querySelector('.mc-grid-list-row--sel').dataset.cell).toBe('1');

    // With a constraint the list gains a Meets column naming what each cell missed.
    container.querySelector('.mc-grid-constraints [data-id="addRow"]').click();
    expect(keysOf(container).at(-1)).toBe('meets');
    expect(container.querySelector('.mc-grid-list-row[data-cell="3"]').textContent).toContain('✗ Failure rate ≤ 10% (50.0%)');
    expect([...container.querySelectorAll('.mc-grid-list-row--excluded')].map(r => r.dataset.cell).sort()).toEqual(['1', '3']);
    panel.destroy();
  });

  test('the columns are the user\'s: a new ranking metric frees the failure-rate column, and a removal sticks', () => {
    const container = mount();
    const panel = new McResultsPanel(container);
    const seen = [];
    panel.onGridCellSelected = (v) => seen.push(v);
    panel.showGrid(GRID);
    pick(container, '.mc-grid-metric', 'nw');
    expect(keysOf(container)).toContain('col:failureRate:p50');

    container.querySelector('.mc-grid-columns [data-id="removeRow"]').click();
    expect(keysOf(container)).not.toContain('col:failureRate:p50');
    expect(seen.at(-1).rank.columns).toEqual([{ metric: 'afterTaxNW', stat: 'p50' }, { metric: 'troughRealNetLiq', stat: 'p10' }]);
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

    // What the cells are ranked on is part of how the grid is being read (design 100 §10.3.8).
    const metricSel = view.resultsPane.querySelector('.mc-grid-metric');
    metricSel.value = 'afterTaxNW';
    metricSel.dispatchEvent(new Event('change'));
    // So are the constraints (design 100 §10.10): session state, beside the ranking.
    view.resultsPane.querySelector('.mc-grid-constraints [data-id="addRow"]').click();

    // Carried across a rebuild with how it was being read.
    const state = presenter.getGridState();
    expect(state).toMatchObject({ showing: 'grid', ref: 3, sel: 0, rank: { metric: 'afterTaxNW' } });
    expect(state.rank.constraints).toEqual([{ metric: 'failureRate', stat: 'p50', op: '<=', threshold: 10 }]);
    presenter.destroy();

    const view2 = { configPane: mount(), resultsPane: mount(), runsPane: mount(), destroy() {} };
    const again = new MonteCarloPresenter({
      controller: { runMonteCarlo: () => Promise.resolve({ runs: [], summary: {} }) },
      view: view2,
      scenario: { simStart: new Date(Date.UTC(2026, 0, 1)), simEnd: new Date(Date.UTC(2041, 0, 1)), params: {} },
    });
    again.restoreGrid(state);
    expect(view2.resultsPane.querySelector('.mc-grid-cell--sel').dataset.cell).toBe('0');
    expect(view2.resultsPane.querySelector('.mc-grid-metric').value).toBe('afterTaxNW');
    expect([...view2.resultsPane.querySelectorAll('.mc-grid-cell--excluded')].map(c => c.dataset.cell)).toEqual(['1', '3']);
    expect(view2.runsPane.querySelector('.mc-runs-context').textContent).toContain('Retire year 2030');
    again.destroy();
  });
});
