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
 * monte-carlo-presenter.test.mjs
 *
 * Covers where the MC panel gets its variable CENTERS from. The scenario INSTANCE
 * carries a param bag frozen at the last Rebuild; the ACTIVE CFG is the live record
 * the scenario editor writes into. Reading the frozen one is how a run ends up
 * describing a plan the user has already edited away from, so the presenter must
 * prefer the active cfg — including its typed `params` list, which is the store the
 * editor actually mutates.
 *
 * Run with: npm run test:viz
 */

import { MonteCarloPresenter } from '../../src/visualization/monte-carlo/monte-carlo-presenter.js';
import { ServiceRegistry }     from '../../src/services/service-registry.js';

global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

function makeView() {
  const pane = () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    return el;
  };
  return { configPane: pane(), resultsPane: pane(), runsPane: pane(), destroy() {} };
}

/** Point the singleton's scenarioService at a fixed active cfg. */
function setActiveCfg(cfg) {
  ServiceRegistry.resetAll();
  ServiceRegistry.getInstance().scenarioService.getActive = () => cfg;
}

function makePresenter(scenario) {
  return new MonteCarloPresenter({
    controller: { runMonteCarlo: () => Promise.resolve({ runs: [], summary: {} }) },
    view:       makeView(),
    scenario:   { simStart: new Date(Date.UTC(2026, 0, 1)), simEnd: new Date(Date.UTC(2041, 0, 1)), ...scenario },
  });
}

describe('MonteCarloPresenter — variable centers follow the live scenario', () => {
  afterEach(() => ServiceRegistry.resetAll());

  test('reads the active cfg typed params list, not just the instance bag', () => {
    setActiveCfg({ params: [{ name: 'usEquityGrowthRate', value: 0.11 }], accounts: [] });
    const presenter = makePresenter({ params: { usEquityGrowthRate: 0.04 } });

    expect(presenter._scenarioCenters().get('usEquityGrowthRate')).toBeCloseTo(0.11);

    presenter.destroy();
  });

  test('falls back to the scenario instance bag when there is no active cfg', () => {
    setActiveCfg(null);
    const presenter = makePresenter({ params: { usEquityGrowthRate: 0.04 } });

    expect(presenter._scenarioCenters().get('usEquityGrowthRate')).toBeCloseTo(0.04);

    presenter.destroy();
  });

  test('tags each variable with the layer its center came from', () => {
    // `usEquityGrowthRate` is on the cfg; `equityReturnVol` is a schema key the
    // cfg doesn't carry, so its center is the schema default — the value the sim will
    // run at, which is why it must resolve rather than fall through to the MC
    // template's own mean. (`spouseRothGrowthRate` was the exemplar until it was
    // retired — design/inconsistencies §4.10.)
    setActiveCfg({ params: [{ name: 'usEquityGrowthRate', value: 0.11 }], accounts: [] });
    const presenter = makePresenter({ params: {} });

    const bySource = new Map(presenter._resolveVariables().map(v => [v.paramKey, v.centerSource]));
    expect(bySource.get('usEquityGrowthRate')).toBe('scenario');
    expect(bySource.get('equityReturnVol')).toBe('schema');
    // A balance lever's value lives on the ACCOUNT, and this cfg has none — so its
    // center really is a framework default and says so.
    expect(bySource.get('stockBalance')).toBe('default');
    // A wage lever's value lives on the PERSON record, which is in neither param
    // store nor the schema — so these read `default` even for a complete plan.
    expect(bySource.get('primaryMonthlyWage')).toBe('default');

    presenter.destroy();
  });

  test('wiring the account moves its balance lever from default to scenario', () => {
    setActiveCfg({ params: [], accounts: [{ stateKey: 'usStockAccount', balance: 750_000 }] });
    const presenter = makePresenter({ params: {} });

    const v = presenter._resolveVariables().find(x => x.paramKey === 'stockBalance');
    expect(v.centerSource).toBe('scenario');
    expect(v.defaultValue).toBe(750_000);

    presenter.destroy();
  });

  test('an account balance beats the params bag (a holdings-bearing balance is derived)', () => {
    setActiveCfg({
      params:   [{ name: 'stockBalance', value: 111_111 }],
      accounts: [{ stateKey: 'usStockAccount', balance: 750_000 }],
    });
    const presenter = makePresenter({ params: {} });

    expect(presenter._scenarioCenters().get('stockBalance')).toBe(750_000);

    presenter.destroy();
  });
});

describe('MonteCarloPresenter — baseline slot (design 100 §5)', () => {
  afterEach(() => ServiceRegistry.resetAll());

  const pairing = { n: 1, seeds: [1], mcSequenceRisk: true, sampled: [] };
  const result = (failed) => ({
    runs:    [{ seed: 1, scenarioFailed: failed, finalNetWorthUsd: 1, afterTaxNetWorthUsd: 1, timeSeries: [] }],
    summary: { successRate: failed ? 0 : 1, p10: 1, p50: 1, p90: 1, pairing },
  });

  test('keepBaseline pins the current result; the next result renders against it', () => {
    setActiveCfg(null);
    const presenter = makePresenter({ params: {} });
    const pane = presenter._view.resultsPane;

    presenter.keepBaseline();                        // nothing to keep yet
    expect(presenter.getBaseline()).toBeNull();

    presenter.restoreResult(result(true));
    presenter.keepBaseline();
    expect(presenter.getBaseline().result.summary.successRate).toBe(0);
    expect(pane.querySelector('.mc-ab-section')).toBeNull();

    presenter.restoreResult(result(false));
    expect(pane.querySelector('.mc-ab-section .mc-ab-rescues')).not.toBeNull();

    pane.querySelector('.mc-ab-clear').click();
    expect(presenter.getBaseline()).toBeNull();
    expect(pane.querySelector('.mc-ab-section')).toBeNull();

    presenter.destroy();
  });

  test('restoreBaseline re-installs a carried baseline on a new presenter', () => {
    setActiveCfg(null);
    const first = makePresenter({ params: {} });
    first.restoreResult(result(true));
    first.keepBaseline();
    const carried = first.getBaseline();
    first.destroy();

    const second = makePresenter({ params: {} });
    second.restoreBaseline(carried);
    second.restoreResult(result(false));
    expect(second._view.resultsPane.querySelector('.mc-ab-section')).not.toBeNull();
    second.destroy();
  });
});

// ── design 110 §6.5 — the hygiene rides on the pool axis rows (phase 7) ────────────────

describe('MonteCarloPresenter — pool axis hygiene', () => {
  afterEach(() => ServiceRegistry.resetAll());

  const POOL_AXIS = 'pool.reserve.targetScale';
  const GRAPH = { pools: [
    { id: 'cash',    spendOrder: 10, claims: [{ key: 'usSavingsAccount' }] },
    { id: 'reserve', spendOrder: 20, claims: [{ key: 'usStockAccount', sleeves: ['BOND'] }],
      target: { mode: 'YEARS_OF_SPEND', value: 4 } },
  ] };

  test('a pool axis carries the plan\'s hygiene problems; no other lever does', () => {
    // A glidepath beside a pool target is legal and silent: the pool governs the classes it
    // claims and the schedule governs the residual, so the mix MOVES as the axis is swept.
    setActiveCfg({ params: [
      { name: 'liquidityGraph',     value: GRAPH },
      { name: 'allocationSchedule', value: 'GLIDEPATH' },
    ], accounts: [] });
    const presenter = makePresenter({ params: {} });

    const axes = presenter._resolveGridAxes();
    const pool = axes.find(v => v.paramKey === POOL_AXIS);
    expect(pool).toBeTruthy();
    expect(pool.planValue).toBe(1);
    expect(pool.problems.map(p => p.param)).toContain('allocationSchedule');

    // Every other axis is silent. Attaching a plan-level warning to an inflation axis would
    // train the author to ignore the row that matters.
    for (const v of axes.filter(x => x.paramKey !== POOL_AXIS)) {
      expect(v.problems).toBeUndefined();
    }
    presenter.destroy();
  });

  test('a hygienic plan attaches no problems at all', () => {
    setActiveCfg({ params: [
      { name: 'liquidityGraph',       value: GRAPH },
      { name: 'allocationSchedule',   value: 'STATIC' },
      { name: 'shocks',               value: [] },
      { name: 'behavioralStrategies', value: ['LIQUIDITY_POOLS', 'TARGET_ALLOCATION'] },
    ], accounts: [] });
    const presenter = makePresenter({ params: {} });

    const pool = presenter._resolveGridAxes().find(v => v.paramKey === POOL_AXIS);
    expect(pool).toBeTruthy();
    expect(pool.problems).toBeUndefined();

    presenter.destroy();
  });
});
